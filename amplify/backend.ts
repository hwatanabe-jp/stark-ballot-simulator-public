import { defineBackend } from '@aws-amplify/backend';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { auth } from './auth/resource.js';
import { resolveRequiredAsyncProverArns } from './lib/async-prover-env.js';
import { data } from './data/resource.js';
import { resolveProofBundleBucketName } from './lib/bucket-name-resolver.js';
import { resolveDeploymentEnv } from './lib/deployment-env-resolver.js';
import {
  addFunctionEnvironments,
  resolveSecretBackedEnv,
  type AmplifyFunctionEnvironmentValue,
} from './lib/function-environment.js';
import { assertVerifierLayerBinaryExists } from './lib/verifier-layer-asset.js';
import { proverDispatchProxy } from './functions/prover-dispatch-proxy/resource.js';
import { verifierServiceRunner } from './functions/verifier-service-runner/resource.js';
import { finalizeCallbackRunner } from './functions/finalize-callback-runner/resource.js';
import { honoApi } from './functions/hono-api/resource.js';

/**
 * Amplify Gen 2 Backend Definition
 *
 * This file defines the backend resources for the STARK Ballot Simulator application.
 * Currently includes:
 * - Auth: Cognito User Pool (Identity Pool unauth disabled)
 * - Data: GraphQL API with VotingSession and Vote models (DynamoDB backend)
 * - Lambda Functions: prover-dispatch-proxy, verifier-service-runner
 */
export const backend = defineBackend({
  auth,
  data,
  proverDispatchProxy,
  verifierServiceRunner,
  finalizeCallbackRunner,
  honoApi,
});

const authCfnResources = (
  backend.auth.resources as {
    cfnResources?: {
      cfnIdentityPool?: {
        allowUnauthenticatedIdentities?: boolean;
      };
    };
  }
).cfnResources;

if (authCfnResources?.cfnIdentityPool) {
  authCfnResources.cfnIdentityPool.allowUnauthenticatedIdentities = false;
}

export const PROOF_BUNDLE_BUCKET_NAME = resolveProofBundleBucketName();
const proofPrefix = normalizeS3Prefix(process.env.S3_PROOF_PREFIX ?? 'sessions/');

const lambdaFunction = backend.proverDispatchProxy.resources.lambda;
const lambdaCfn = backend.proverDispatchProxy.resources.cfnResources.cfnFunction;
const verifierLambda = backend.verifierServiceRunner.resources.lambda;
const callbackLambda = backend.finalizeCallbackRunner.resources.lambda;
const honoLambda = backend.honoApi.resources.lambda;

const { stateMachineArn: defaultStateMachineArn, queueArn } = resolveRequiredAsyncProverArns();
const stateMachineExecutionArn = `${defaultStateMachineArn.replace(':stateMachine:', ':execution:')}:*`;
const concurrency = Number.isFinite(Number(process.env.PROVER_LAMBDA_CONCURRENCY))
  ? Number(process.env.PROVER_LAMBDA_CONCURRENCY)
  : 2;
const deploymentEnv = resolveDeploymentEnv();
const runtimeEnvName = deploymentEnv === 'main' ? 'production' : 'develop';
const runtimeBranchName = deploymentEnv === 'main' ? 'main' : 'develop';
const logRetention = resolveLogRetentionDays(deploymentEnv);
const turnstileBypassEnabled = readBooleanEnv('TURNSTILE_BYPASS');
const useMockStore = process.env.USE_MOCK_STORE === 'true';

if (deploymentEnv === 'main' && turnstileBypassEnabled) {
  throw new Error('TURNSTILE_BYPASS must be disabled for main/production deployments.');
}

const honoApiStack = backend.createStack('hono-api-stack');
const honoIntegration = new apigwv2Integrations.HttpLambdaIntegration('HonoLambdaIntegration', honoLambda);
const honoCorsOrigins = buildHonoCorsOrigins();
const apiDomainName = normalizeOptionalEnv(process.env.API_DOMAIN_NAME);
const apiCertArn = normalizeOptionalEnv(process.env.API_DOMAIN_CERT_ARN);
const disableExecuteApiEndpoint = readBooleanEnv('DISABLE_EXECUTE_API_ENDPOINT');
const throttleBurstLimit = readNumberEnv('API_THROTTLE_BURST_LIMIT');
const throttleRateLimit = readNumberEnv('API_THROTTLE_RATE_LIMIT');
if ((apiDomainName && !apiCertArn) || (!apiDomainName && apiCertArn)) {
  throw new Error('API_DOMAIN_NAME and API_DOMAIN_CERT_ARN must be set together to enable the API custom domain.');
}
if ((throttleBurstLimit && !throttleRateLimit) || (!throttleBurstLimit && throttleRateLimit)) {
  throw new Error('API_THROTTLE_BURST_LIMIT and API_THROTTLE_RATE_LIMIT must be set together.');
}
const honoHttpApi = new apigwv2.HttpApi(honoApiStack, 'HonoHttpApi', {
  apiName: 'stark-ballot-simulator-hono-api',
  disableExecuteApiEndpoint,
  corsPreflight: {
    allowOrigins: honoCorsOrigins,
    allowMethods: [apigwv2.CorsHttpMethod.ANY],
    allowHeaders: ['Content-Type', 'X-Session-ID', 'X-Session-Capability'],
  },
});
const defaultStage = honoHttpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
if (!defaultStage) {
  throw new Error('Default HTTP API stage not found; cannot configure access logs.');
}

const honoApiAccessLogGroup = new logs.LogGroup(honoApiStack, 'HonoApiAccessLogGroup', {
  logGroupName: `/aws/apigateway/stark-ballot-simulator-hono-api-${deploymentEnv}`,
  retention: logRetention,
});
honoApiAccessLogGroup.grantWrite(new iam.ServicePrincipal('apigateway.amazonaws.com'));

const honoApiAccessLogFormat = JSON.stringify({
  requestId: '$context.requestId',
  ip: '$context.identity.sourceIp',
  requestTime: '$context.requestTime',
  httpMethod: '$context.httpMethod',
  routeKey: '$context.routeKey',
  status: '$context.status',
  responseLength: '$context.responseLength',
  integrationError: '$context.integrationErrorMessage',
  userAgent: '$context.identity.userAgent',
});
defaultStage.addPropertyOverride('AccessLogSettings', {
  DestinationArn: honoApiAccessLogGroup.logGroupArn,
  Format: honoApiAccessLogFormat,
});

const rateLimitEventsTable = new dynamodb.Table(honoLambda.stack, 'RateLimitEventsTable', {
  partitionKey: { name: 'scope', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'expiresAt',
});

const rateLimitCountersTable = new dynamodb.Table(honoLambda.stack, 'RateLimitCountersTable', {
  partitionKey: { name: 'key', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'expiresAt',
});

rateLimitEventsTable.grantReadWriteData(honoLambda);
rateLimitCountersTable.grantReadWriteData(honoLambda);
if (throttleBurstLimit && throttleRateLimit) {
  defaultStage.addPropertyOverride('DefaultRouteSettings.ThrottlingBurstLimit', throttleBurstLimit);
  defaultStage.addPropertyOverride('DefaultRouteSettings.ThrottlingRateLimit', throttleRateLimit);
}

const customOutputs: Record<string, string> = {};
if (disableExecuteApiEndpoint) {
  if (!apiDomainName) {
    throw new Error('API_DOMAIN_NAME must be set when DISABLE_EXECUTE_API_ENDPOINT is true.');
  }
  customOutputs.HonoApiUrl = `https://${apiDomainName}`;
} else {
  customOutputs.HonoApiUrl = honoHttpApi.apiEndpoint;
}

if (apiDomainName && apiCertArn) {
  const apiDomain = new apigwv2.DomainName(honoApiStack, 'HonoCustomDomain', {
    domainName: apiDomainName,
    certificate: acm.Certificate.fromCertificateArn(honoApiStack, 'ApiDomainCert', apiCertArn),
  });

  new apigwv2.ApiMapping(honoApiStack, 'HonoApiMapping', {
    api: honoHttpApi,
    domainName: apiDomain,
  });

  customOutputs.HonoApiCustomDomainName = apiDomainName;
  customOutputs.HonoApiCustomDomainTarget = apiDomain.regionalDomainName;
}

honoHttpApi.addRoutes({
  path: '/api',
  methods: [apigwv2.HttpMethod.ANY],
  integration: honoIntegration,
});
honoHttpApi.addRoutes({
  path: '/api/{proxy+}',
  methods: [apigwv2.HttpMethod.ANY],
  integration: honoIntegration,
});
honoHttpApi.addRoutes({
  path: '/api',
  methods: [apigwv2.HttpMethod.OPTIONS],
  integration: honoIntegration,
});
honoHttpApi.addRoutes({
  path: '/api/{proxy+}',
  methods: [apigwv2.HttpMethod.OPTIONS],
  integration: honoIntegration,
});

backend.addOutput({
  custom: customOutputs,
});

applyLambdaLogRetention(honoLambda, 'HonoApi', logRetention);
applyLambdaLogRetention(lambdaFunction, 'ProverDispatchProxy', logRetention);
applyLambdaLogRetention(verifierLambda, 'VerifierServiceRunner', logRetention);
applyLambdaLogRetention(callbackLambda, 'FinalizeCallbackRunner', logRetention);

backend.proverDispatchProxy.addEnvironment('PROVER_STATE_MACHINE_ARN', defaultStateMachineArn);

const envMappings: Record<string, string | undefined> = {
  AMPLIFY_DATA_ENDPOINT: process.env.AMPLIFY_DATA_ENDPOINT,
  AMPLIFY_DATA_API_ID: process.env.AMPLIFY_DATA_API_ID,
  AMPLIFY_DATA_TTL_SECONDS: process.env.AMPLIFY_DATA_TTL_SECONDS,
  AMPLIFY_DATA_VERIFICATION_TTL_SECONDS: process.env.AMPLIFY_DATA_VERIFICATION_TTL_SECONDS,
  S3_PROOF_BUCKET: PROOF_BUNDLE_BUCKET_NAME,
  S3_PROOF_PREFIX: proofPrefix,
  ENV_NAME: runtimeEnvName,
  AWS_BRANCH: runtimeBranchName,
  AMPLIFY_BRANCH: runtimeBranchName,
};

addFunctionEnvironments(backend.proverDispatchProxy, envMappings);
addFunctionEnvironments(backend.finalizeCallbackRunner, envMappings);

const verifierEnvMappings: Record<string, string | undefined> = {
  USE_S3: process.env.USE_S3 ?? 'false',
  S3_PROOF_BUCKET: PROOF_BUNDLE_BUCKET_NAME,
  S3_PROOF_PREFIX: proofPrefix,
  ENV_NAME: runtimeEnvName,
  AWS_BRANCH: runtimeBranchName,
  AMPLIFY_BRANCH: runtimeBranchName,
  VERIFIER_SERVICE_BIN: '/opt/bin/verifier-service',
  EXPECTED_IMAGE_ID: process.env.EXPECTED_IMAGE_ID,
};

addFunctionEnvironments(backend.verifierServiceRunner, verifierEnvMappings);

const resolvedVerifierBaseUrl =
  process.env.VERIFIER_PUBLIC_BASE_URL && process.env.VERIFIER_PUBLIC_BASE_URL.trim().length > 0
    ? process.env.VERIFIER_PUBLIC_BASE_URL.trim()
    : undefined;

const honoEnvMappings: Record<string, AmplifyFunctionEnvironmentValue> = {
  USE_AMPLIFY_DATA: process.env.USE_AMPLIFY_DATA ?? 'true',
  USE_MOCK_STORE: process.env.USE_MOCK_STORE,
  AMPLIFY_DATA_ENDPOINT: process.env.AMPLIFY_DATA_ENDPOINT,
  AMPLIFY_DATA_API_ID: process.env.AMPLIFY_DATA_API_ID,
  AMPLIFY_DATA_TTL_SECONDS: process.env.AMPLIFY_DATA_TTL_SECONDS,
  AMPLIFY_DATA_VERIFICATION_TTL_SECONDS: process.env.AMPLIFY_DATA_VERIFICATION_TTL_SECONDS,
  AMPLIFY_DATA_REGION: process.env.AMPLIFY_DATA_REGION,
  USE_S3: process.env.USE_S3 ?? 'true',
  VOTE_SECRET_ENCRYPTION_KEY: resolveSecretBackedEnv('VOTE_SECRET_ENCRYPTION_KEY', {
    required: !useMockStore,
  }),
  S3_PROOF_BUCKET: PROOF_BUNDLE_BUCKET_NAME,
  S3_PROOF_PREFIX: proofPrefix,
  PROVER_WORK_QUEUE_URL: process.env.PROVER_WORK_QUEUE_URL,
  PROVER_STATE_MACHINE_ARN: defaultStateMachineArn,
  PROVER_LAMBDA_CONCURRENCY: process.env.PROVER_LAMBDA_CONCURRENCY ?? String(concurrency),
  FINALIZE_ASYNC_MODE: process.env.FINALIZE_ASYNC_MODE ?? 'true',
  PROVER_STEP_FUNCTIONS_ENABLED: process.env.PROVER_STEP_FUNCTIONS_ENABLED ?? 'true',
  TURNSTILE_SECRET_KEY: resolveSecretBackedEnv('TURNSTILE_SECRET_KEY', {
    required: !turnstileBypassEnabled,
  }),
  TURNSTILE_BYPASS: process.env.TURNSTILE_BYPASS,
  SESSION_CREATE_TURNSTILE_REQUIRED: process.env.SESSION_CREATE_TURNSTILE_REQUIRED,
  MAX_SESSIONS: process.env.MAX_SESSIONS,
  TRUSTED_PROXY: process.env.TRUSTED_PROXY,
  RATE_LIMIT_STORE: process.env.RATE_LIMIT_STORE ?? 'dynamo',
  RATE_LIMIT_EVENTS_TABLE: rateLimitEventsTable.tableName,
  RATE_LIMIT_COUNTERS_TABLE: rateLimitCountersTable.tableName,
  SESSION_CREATE_RATE_LIMIT: process.env.SESSION_CREATE_RATE_LIMIT,
  SESSION_CREATE_RATE_LIMIT_WINDOW_MS: process.env.SESSION_CREATE_RATE_LIMIT_WINDOW_MS,
  SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS: process.env.SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS,
  FINALIZE_CANCEL_RATE_LIMIT: process.env.FINALIZE_CANCEL_RATE_LIMIT,
  FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS: process.env.FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS,
  FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS: process.env.FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS,
  ZKVM_RATE_LIMIT_PER_IP: process.env.ZKVM_RATE_LIMIT_PER_IP,
  ZKVM_RATE_LIMIT_WINDOW_MS: process.env.ZKVM_RATE_LIMIT_WINDOW_MS,
  ZKVM_GLOBAL_DAILY_LIMIT: process.env.ZKVM_GLOBAL_DAILY_LIMIT,
  ZKVM_GLOBAL_HOURLY_LIMIT: process.env.ZKVM_GLOBAL_HOURLY_LIMIT,
  VERIFIER_PUBLIC_BASE_URL: resolvedVerifierBaseUrl,
  // Standard Amplify async finalization updates AppSync via finalize-callback-runner directly.
  // `/api/finalize/callback` is excluded from Hono Lambda registration, so this secret is only
  // needed when the direct Next.js callback route is intentionally operated outside the standard flow.
  FINALIZE_CALLBACK_SECRET: resolveSecretBackedEnv('FINALIZE_CALLBACK_SECRET', {
    required: false,
  }),
  FINALIZE_CALLBACK_MAX_SKEW_MS: process.env.FINALIZE_CALLBACK_MAX_SKEW_MS,
  FINALIZE_CALLBACK_BODY_LIMIT_BYTES: process.env.FINALIZE_CALLBACK_BODY_LIMIT_BYTES,
  SESSION_CAPABILITY_SECRET: resolveSecretBackedEnv('SESSION_CAPABILITY_SECRET'),
  SESSION_CAPABILITY_TTL_SECONDS: process.env.SESSION_CAPABILITY_TTL_SECONDS,
  EXPECTED_IMAGE_ID: process.env.EXPECTED_IMAGE_ID,
  VERIFIER_SERVICE_RUNNER_FUNCTION_NAME: verifierLambda.functionName,
  NEXT_PUBLIC_STH_SOURCES: process.env.NEXT_PUBLIC_STH_SOURCES,
  NEXT_PUBLIC_STH_MIN_MATCHES: process.env.NEXT_PUBLIC_STH_MIN_MATCHES,
  ENV_NAME: runtimeEnvName,
  AWS_BRANCH: runtimeBranchName,
  AMPLIFY_BRANCH: runtimeBranchName,
};

addFunctionEnvironments(backend.honoApi, honoEnvMappings);

const verifierLayerAsset = assertVerifierLayerBinaryExists();
const verifierLayer = new lambda.LayerVersion(verifierLambda.stack, 'VerifierServiceLayer', {
  code: lambda.Code.fromAsset(verifierLayerAsset.assetPath),
  compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
  compatibleArchitectures: [lambda.Architecture.X86_64],
  description: 'Rust verifier-service binary layer',
});
verifierLambda.addLayers(verifierLayer);

lambdaCfn.addPropertyOverride('ReservedConcurrentExecutions', concurrency);

const queue = sqs.Queue.fromQueueArn(lambdaFunction, 'ProverWorkQueue', queueArn);
lambdaFunction.addEventSource(
  new SqsEventSource(queue, {
    batchSize: 1,
    reportBatchItemFailures: true,
  }),
);

lambdaFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['states:StartExecution'],
    resources: [defaultStateMachineArn],
  }),
);

lambdaFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:PutObject'],
    resources: [`arn:aws:s3:::${PROOF_BUNDLE_BUCKET_NAME}/${proofPrefix}*`],
  }),
);

function normalizeS3Prefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function normalizeOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  if (['null', 'none', 'undefined', 'nil'].includes(lowered)) {
    return undefined;
  }
  return trimmed;
}

function readBooleanEnv(key: string): boolean {
  const raw = process.env[key];
  if (!raw) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function readNumberEnv(key: string): number | undefined {
  const raw = normalizeOptionalEnv(process.env[key]);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number.`);
  }
  return value;
}

function resolveLogRetentionDays(env: 'develop' | 'main'): logs.RetentionDays {
  return env === 'main' ? logs.RetentionDays.TWO_WEEKS : logs.RetentionDays.ONE_WEEK;
}

function applyLambdaLogRetention(target: lambda.Function, idPrefix: string, retention: logs.RetentionDays): void {
  new logs.LogRetention(target.stack, `${idPrefix}LogRetention`, {
    logGroupName: `/aws/lambda/${target.functionName}`,
    retention,
  });
}

function buildHonoCorsOrigins(): string[] {
  const raw = process.env.HONO_CORS_ALLOW_ORIGINS ?? '';
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error('HONO_CORS_ALLOW_ORIGINS must be set (comma-separated list of allowed origins).');
  }

  return Array.from(new Set(origins));
}

// CLI / verifier-service IAM access (S3 proof bundles)
const cliStack = backend.createStack('cli-iam-stack');

const cliManagedPolicy = new iam.ManagedPolicy(cliStack, 'HybridCliAccessPolicy', {
  description: 'Allows the STARK Ballot Simulator CLI and verifier-service to manage verification bundles in S3.',
});

const proofBundleBucketArn = `arn:aws:s3:::${PROOF_BUNDLE_BUCKET_NAME}`;

cliManagedPolicy.addStatements(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
    resources: [`${proofBundleBucketArn}/sessions/*`],
  }),
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:ListBucket'],
    resources: [proofBundleBucketArn],
    conditions: {
      StringLike: {
        's3:prefix': ['sessions/*'],
      },
    },
  }),
);

verifierLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
    resources: [`${proofBundleBucketArn}/sessions/*`],
  }),
);

verifierLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:ListBucket'],
    resources: [proofBundleBucketArn],
    conditions: {
      StringLike: {
        's3:prefix': ['sessions/*'],
      },
    },
  }),
);

honoLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['sqs:SendMessage', 'sqs:GetQueueAttributes'],
    resources: [queueArn],
  }),
);

honoLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['states:DescribeExecution', 'states:StopExecution'],
    resources: [stateMachineExecutionArn],
  }),
);

honoLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['lambda:InvokeFunction'],
    resources: [verifierLambda.functionArn, `${verifierLambda.functionArn}:*`],
  }),
);

honoLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:GetObject', 's3:GetObjectVersion'],
    resources: [`${proofBundleBucketArn}/${proofPrefix}*`],
  }),
);

honoLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:ListBucket'],
    resources: [proofBundleBucketArn],
    conditions: {
      StringLike: {
        's3:prefix': [proofPrefix ? `${proofPrefix}*` : '*'],
      },
    },
  }),
);

callbackLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:GetObject', 's3:GetObjectVersion'],
    resources: [`${proofBundleBucketArn}/${proofPrefix}*`],
  }),
);

callbackLambda.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:ListBucket'],
    resources: [proofBundleBucketArn],
    conditions: {
      StringLike: {
        's3:prefix': [proofPrefix ? `${proofPrefix}*` : '*'],
      },
    },
  }),
);

new cdk.CfnOutput(cliStack, 'HybridCliAccessPolicyArn', {
  value: cliManagedPolicy.managedPolicyArn,
  description:
    'Attach this managed policy to the IAM user/role that runs the STARK Ballot Simulator CLI and verifier-service.',
});

new cdk.CfnOutput(cliStack, 'ProofBundleBucketName', {
  value: PROOF_BUNDLE_BUCKET_NAME,
  description: 'S3 bucket name for verification proof bundles.',
});
