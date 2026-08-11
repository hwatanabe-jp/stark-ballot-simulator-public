import {
  RuntimeConfigValidationError,
  type RuntimeConfigName,
} from '@stark-ballot/runtime-config/env/configValidationError';
import { resolveDynamoDbRegion } from '@stark-ballot/runtime-config/env/dynamodbConfig';
import {
  validateRuntimeConfigReferenceSource,
  type RuntimeConfigReferenceName,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import { validateTargetRuntimeReferences } from '@stark-ballot/runtime-config/env/targetRuntimeReferences';

export const SUPPORTED_RUNTIME_PROFILES = Object.freeze([
  'local-demo',
  'static-mock-e2e',
  'local-proof-development',
  'local-proof-production',
  'target-aws-async',
  'target-aws-async-quiesced',
] as const);

export type RuntimeProfileSelector = (typeof SUPPORTED_RUNTIME_PROFILES)[number];
type TargetAwsRuntimeProfileSelector = Extract<RuntimeProfileSelector, `target-aws-${string}`>;
type LocalRuntimeProfileSelector = Exclude<RuntimeProfileSelector, TargetAwsRuntimeProfileSelector>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer TEntry)[]
    ? readonly DeepReadonly<TEntry>[]
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

interface LocalRuntimeProfile {
  name: LocalRuntimeProfileSelector;
  target: { kind: 'local' };
  sessionStore: { kind: 'memory' | 'file' };
  proof: { executor: 'mock'; evidence: 'mock' } | { executor: 'risc0'; evidence: 'development' | 'production' };
  finalization: { mode: 'sync' };
  artifacts: { kind: 'local' };
  runtimeAdapters: {
    api: 'node';
    prover: 'in-process' | 'child-process';
    verification: 'local-process';
    browserApi: 'mock' | 'same-origin';
  };
  rateLimit: { store: 'memory'; allowUnknownClientIp: true };
  turnstile: { mode: 'bypass'; bypassEligible: true; publicSessionCreate: true };
  external: { kind: 'none' };
}

interface TargetAwsExternalReferences {
  kind: 'aws';
  accountId: string;
  region: string;
  dynamo: {
    sessionsTable: string;
    votesTable: string;
    rateLimitEventsTable: string;
    rateLimitCountersTable: string;
  };
  asyncRuntime: {
    proverWorkQueueUrl: string;
    verificationWorkQueueUrl: string;
    proverStateMachineArn: string;
    verificationWorkerFunctionName: string;
  };
  artifactStorage: {
    bucket: string;
    prefix: string;
  };
  verifierPublicBaseUrl: string;
  expectedImageId: string;
  turnstileAllowedHostnames: string[];
  trustedProxy: string;
  secretReferences: {
    sessionCapabilitySecret: string;
    voteSecretEncryptionKey: string;
    sessionCapabilityTtlSeconds: string;
    turnstileSecretKey: string;
    expectedOriginVerifyHeader: string;
    logIpHashSalt: string;
  };
}

interface TargetAwsRuntimeProfileBase {
  target: { kind: 'aws'; deploymentEnvironment: 'develop' | 'main' };
  sessionStore: { kind: 'dynamo' };
  proof: { executor: 'risc0'; evidence: 'production' };
  finalization: { mode: 'async'; queue: 'sqs'; orchestrator: 'step-functions' };
  artifacts: { kind: 's3' };
  runtimeAdapters: {
    api: 'lambda';
    prover: 'ecs';
    verification: 'lambda';
    browserApi: 'same-origin';
  };
  rateLimit: { store: 'dynamo'; allowUnknownClientIp: false };
  external: TargetAwsExternalReferences;
}

interface ActiveTargetAwsRuntimeProfile extends TargetAwsRuntimeProfileBase {
  name: 'target-aws-async';
  turnstile:
    | { mode: 'operator-gated'; bypassEligible: false; publicSessionCreate: true }
    | { mode: 'required'; bypassEligible: false; publicSessionCreate: false };
}

interface QuiescedTargetAwsRuntimeProfile extends TargetAwsRuntimeProfileBase {
  name: 'target-aws-async-quiesced';
  target: { kind: 'aws'; deploymentEnvironment: 'develop' };
  turnstile: { mode: 'operator-gated'; bypassEligible: false; publicSessionCreate: false };
}

type TargetAwsRuntimeProfile = ActiveTargetAwsRuntimeProfile | QuiescedTargetAwsRuntimeProfile;

type RuntimeProfile = LocalRuntimeProfile | TargetAwsRuntimeProfile;

export type ResolvedRuntimeProfile = DeepReadonly<RuntimeProfile>;

export const REPLACED_RUNTIME_SELECTOR_NAMES = [
  'USE_MOCK_STORE',
  'PERSIST_MOCK_STORE',
  'USE_AMPLIFY_DATA',
  'USE_MOCK_ZKVM',
  'USE_REAL_ZKVM',
  'RISC0_DEV_MODE',
  'FORCE_DEV_MODE',
  'ALLOW_INSECURE_ZKVM',
  'ALLOW_DEV_MODE_VERIFICATION',
  'FINALIZE_ASYNC_MODE',
  'PROVER_STEP_FUNCTIONS_ENABLED',
  'USE_S3',
  'TARGET_AWS_RUNTIME',
  'RATE_LIMIT_STORE',
  'RATE_LIMIT_STORE_ALLOW_TEST_DYNAMO',
  'TURNSTILE_BYPASS',
  'ALLOW_UNKNOWN_CLIENT_IP',
  'SESSION_CREATE_TURNSTILE_REQUIRED',
  'TARGET_PUBLIC_SESSION_CREATE_ENABLED',
  'TARGET_DEVELOP_OPERATOR_GATE_ENABLED',
  'VITE_USE_MOCK_API',
  'VITE_TURNSTILE_BYPASS',
  'VITE_SESSION_CREATE_TURNSTILE_REQUIRED',
] as const satisfies readonly RuntimeConfigName[];

const TARGET_REQUIRED_ENV_NAMES = [
  'AWS_ACCOUNT_ID',
  'DYNAMODB_SESSIONS_TABLE',
  'DYNAMODB_VOTES_TABLE',
  'RATE_LIMIT_EVENTS_TABLE',
  'RATE_LIMIT_COUNTERS_TABLE',
  'PROVER_WORK_QUEUE_URL',
  'VERIFICATION_WORK_QUEUE_URL',
  'PROVER_STATE_MACHINE_ARN',
  'VERIFICATION_WORKER_FUNCTION_NAME',
  'S3_PROOF_BUCKET',
  'S3_PROOF_PREFIX',
  'VERIFIER_PUBLIC_BASE_URL',
  'EXPECTED_IMAGE_ID',
  'TURNSTILE_ALLOWED_HOSTNAMES',
  'TRUSTED_PROXY',
  'SESSION_CAPABILITY_SECRET_REF',
  'VOTE_SECRET_ENCRYPTION_KEY_REF',
  'SESSION_CAPABILITY_TTL_SECONDS_REF',
  'TURNSTILE_SECRET_KEY_REF',
  'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
  'LOG_IP_HASH_SALT_REF',
] as const satisfies readonly RuntimeConfigName[];

const TARGET_DIRECT_SECRET_NAMES = [
  'SESSION_CAPABILITY_SECRET',
  'VOTE_SECRET_ENCRYPTION_KEY',
  'SESSION_CAPABILITY_TTL_SECONDS',
  'TURNSTILE_SECRET_KEY',
  'EXPECTED_ORIGIN_VERIFY_HEADER',
  'LOG_IP_HASH_SALT',
  'FINALIZE_CALLBACK_SECRET',
] as const satisfies readonly RuntimeConfigName[];

export const TARGET_RUNTIME_EXTERNAL_INPUT_NAMES = Object.freeze([
  'DYNAMODB_SESSIONS_TABLE',
  'DYNAMODB_VOTES_TABLE',
  'RATE_LIMIT_EVENTS_TABLE',
  'RATE_LIMIT_COUNTERS_TABLE',
  'PROVER_WORK_QUEUE_URL',
  'VERIFICATION_WORK_QUEUE_URL',
  'PROVER_STATE_MACHINE_ARN',
  'VERIFICATION_WORKER_FUNCTION_NAME',
  'S3_PROOF_BUCKET',
  'S3_PROOF_PREFIX',
  'SESSION_CAPABILITY_SECRET_REF',
  'VOTE_SECRET_ENCRYPTION_KEY_REF',
  'SESSION_CAPABILITY_TTL_SECONDS_REF',
  'TURNSTILE_SECRET_KEY_REF',
  'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
  'LOG_IP_HASH_SALT_REF',
] as const satisfies readonly RuntimeConfigName[]);

const TARGET_SECRET_REFERENCE_DESCRIPTORS = [
  {
    envName: 'SESSION_CAPABILITY_SECRET_REF',
    name: 'SESSION_CAPABILITY_SECRET',
  },
  {
    envName: 'VOTE_SECRET_ENCRYPTION_KEY_REF',
    name: 'VOTE_SECRET_ENCRYPTION_KEY',
  },
  {
    envName: 'SESSION_CAPABILITY_TTL_SECONDS_REF',
    name: 'SESSION_CAPABILITY_TTL_SECONDS',
  },
  {
    envName: 'TURNSTILE_SECRET_KEY_REF',
    name: 'TURNSTILE_SECRET_KEY',
  },
  {
    envName: 'EXPECTED_ORIGIN_VERIFY_HEADER_REF',
    name: 'EXPECTED_ORIGIN_VERIFY_HEADER',
  },
  {
    envName: 'LOG_IP_HASH_SALT_REF',
    name: 'LOG_IP_HASH_SALT',
  },
] as const satisfies readonly {
  envName: RuntimeConfigName;
  name: RuntimeConfigReferenceName;
}[];

function configError(invalidNames: readonly RuntimeConfigName[], message: string): RuntimeConfigValidationError {
  return new RuntimeConfigValidationError(invalidNames, undefined, message);
}

function readTrimmedEnv(env: NodeJS.ProcessEnv, name: RuntimeConfigName): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function collectPresentNames(env: NodeJS.ProcessEnv, names: readonly RuntimeConfigName[]): RuntimeConfigName[] {
  return names.filter((name) => readTrimmedEnv(env, name) !== undefined);
}

function requireEnv(env: NodeJS.ProcessEnv, name: RuntimeConfigName): string {
  const value = readTrimmedEnv(env, name);
  if (!value) {
    throw configError([name], `${name} is required for the selected runtime profile.`);
  }
  return value;
}

function isRuntimeProfileSelector(value: string): value is RuntimeProfileSelector {
  return SUPPORTED_RUNTIME_PROFILES.some((profile) => profile === value);
}

function resolveSelector(env: NodeJS.ProcessEnv): RuntimeProfileSelector {
  const value = readTrimmedEnv(env, 'RUNTIME_PROFILE');
  if (!value || !isRuntimeProfileSelector(value)) {
    throw configError(['RUNTIME_PROFILE'], 'RUNTIME_PROFILE must select a supported semantic runtime profile.');
  }
  return value;
}

function freezeRecursively(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    freezeRecursively(child, seen);
  }
  Object.freeze(value);
}

function deeplyFreeze<TValue extends object>(value: TValue): DeepReadonly<TValue> {
  freezeRecursively(value, new WeakSet<object>());
  return value as DeepReadonly<TValue>;
}

function createLocalProfile(selector: LocalRuntimeProfileSelector): LocalRuntimeProfile {
  const common = {
    name: selector,
    target: { kind: 'local' as const },
    finalization: { mode: 'sync' as const },
    artifacts: { kind: 'local' as const },
    rateLimit: { store: 'memory' as const, allowUnknownClientIp: true as const },
    turnstile: {
      mode: 'bypass' as const,
      bypassEligible: true as const,
      publicSessionCreate: true as const,
    },
    external: { kind: 'none' as const },
  };

  switch (selector) {
    case 'local-demo':
      return {
        ...common,
        sessionStore: { kind: 'memory' },
        proof: { executor: 'mock', evidence: 'mock' },
        runtimeAdapters: {
          api: 'node',
          prover: 'in-process',
          verification: 'local-process',
          browserApi: 'mock',
        },
      };
    case 'static-mock-e2e':
      return {
        ...common,
        sessionStore: { kind: 'file' },
        proof: { executor: 'mock', evidence: 'mock' },
        runtimeAdapters: {
          api: 'node',
          prover: 'in-process',
          verification: 'local-process',
          browserApi: 'same-origin',
        },
      };
    case 'local-proof-development':
      return {
        ...common,
        sessionStore: { kind: 'memory' },
        proof: { executor: 'risc0', evidence: 'development' },
        runtimeAdapters: {
          api: 'node',
          prover: 'child-process',
          verification: 'local-process',
          browserApi: 'same-origin',
        },
      };
    case 'local-proof-production':
      return {
        ...common,
        sessionStore: { kind: 'memory' },
        proof: { executor: 'risc0', evidence: 'production' },
        runtimeAdapters: {
          api: 'node',
          prover: 'child-process',
          verification: 'local-process',
          browserApi: 'same-origin',
        },
      };
  }
}

function resolveTargetDeploymentEnvironment(env: NodeJS.ProcessEnv): 'develop' | 'main' {
  const value = readTrimmedEnv(env, 'RUNTIME_DEPLOYMENT_ENV');
  if (value !== 'develop' && value !== 'main') {
    throw configError(
      ['RUNTIME_DEPLOYMENT_ENV'],
      'RUNTIME_DEPLOYMENT_ENV must be develop or main for target-aws-async.',
    );
  }
  return value;
}

function isTargetAwsProfileSelector(selector: RuntimeProfileSelector): selector is TargetAwsRuntimeProfileSelector {
  return selector === 'target-aws-async' || selector === 'target-aws-async-quiesced';
}

function assertRequiredTargetValues(env: NodeJS.ProcessEnv): void {
  const missing: RuntimeConfigName[] = TARGET_REQUIRED_ENV_NAMES.filter(
    (name) => readTrimmedEnv(env, name) === undefined,
  );
  if (!resolveDynamoDbRegion(env)) {
    missing.splice(1, 0, 'AWS_REGION', 'AWS_DEFAULT_REGION');
  }
  if (missing.length > 0) {
    throw configError(missing, 'Target AWS runtime profile is missing required external references.');
  }
}

function collectUnsafeTargetInputNames(env: NodeJS.ProcessEnv): RuntimeConfigName[] {
  return [
    ...collectPresentNames(env, TARGET_DIRECT_SECRET_NAMES),
    ...(readTrimmedEnv(env, 'DYNAMODB_ENDPOINT') ? (['DYNAMODB_ENDPOINT'] as const) : []),
    ...(readTrimmedEnv(env, 'DYNAMODB_ENDPOINT_ALLOW_LOCAL') ? (['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] as const) : []),
  ];
}

function validateAccountId(accountId: string): void {
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw configError(['AWS_ACCOUNT_ID'], 'AWS_ACCOUNT_ID must be a 12-digit AWS account ID.');
  }
}

function validateDynamoTableReference(
  name: 'DYNAMODB_SESSIONS_TABLE' | 'DYNAMODB_VOTES_TABLE' | 'RATE_LIMIT_EVENTS_TABLE' | 'RATE_LIMIT_COUNTERS_TABLE',
  value: string,
  accountId: string,
  region: string,
): void {
  if (value.toLowerCase().includes('amplify')) {
    throw configError([name], `${name} must not reference legacy Amplify tables.`);
  }
  const match = /^arn:aws:dynamodb:([^:]+):([0-9]{12}):table\/([A-Za-z0-9_.-]{3,255})$/.exec(value);
  if (!match) {
    throw configError([name], `${name} must be a DynamoDB table ARN for target-aws-async.`);
  }
  if (match[1] !== region) {
    throw configError([name], `${name} region must match AWS_REGION/AWS_DEFAULT_REGION.`);
  }
  if (match[2] !== accountId) {
    throw configError([name], `${name} account must match AWS_ACCOUNT_ID.`);
  }
}

function validateVerifierPublicBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new RuntimeConfigValidationError(
      ['VERIFIER_PUBLIC_BASE_URL'],
      cause,
      'VERIFIER_PUBLIC_BASE_URL must be a valid HTTPS origin.',
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw configError(['VERIFIER_PUBLIC_BASE_URL'], 'VERIFIER_PUBLIC_BASE_URL must be a valid HTTPS origin.');
  }
}

function validateExpectedImageId(value: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw configError(['EXPECTED_IMAGE_ID'], 'EXPECTED_IMAGE_ID must be a 32-byte 0x-prefixed hex string.');
  }
}

function validateTargetSecretReferences(
  env: NodeJS.ProcessEnv,
  deploymentEnvironment: 'develop' | 'main',
  accountId: string,
  region: string,
): void {
  for (const descriptor of TARGET_SECRET_REFERENCE_DESCRIPTORS) {
    validateRuntimeConfigReferenceSource(descriptor.name, requireEnv(env, descriptor.envName), {
      expectedAccountId: accountId,
      expectedDeploymentEnvironment: deploymentEnvironment,
      expectedRegion: region,
    });
  }
}

function resolveTurnstileAllowedHostnames(env: NodeJS.ProcessEnv): string[] {
  const hostnames = requireEnv(env, 'TURNSTILE_ALLOWED_HOSTNAMES')
    .split(',')
    .map((value) => value.trim().toLowerCase());
  const hostnamePattern =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (hostnames.some((hostname) => !hostnamePattern.test(hostname))) {
    throw configError(
      ['TURNSTILE_ALLOWED_HOSTNAMES'],
      'TURNSTILE_ALLOWED_HOSTNAMES must contain only comma-separated hostnames.',
    );
  }
  return hostnames;
}

function createTargetProfile(
  selector: TargetAwsRuntimeProfileSelector,
  env: NodeJS.ProcessEnv,
): TargetAwsRuntimeProfile {
  const deploymentEnvironment = resolveTargetDeploymentEnvironment(env);
  if (selector === 'target-aws-async-quiesced' && deploymentEnvironment !== 'develop') {
    throw configError(
      ['RUNTIME_PROFILE', 'RUNTIME_DEPLOYMENT_ENV'],
      'The quiesced target runtime profile is limited to the develop recovery lane.',
    );
  }
  assertRequiredTargetValues(env);

  const accountId = requireEnv(env, 'AWS_ACCOUNT_ID');
  const region = resolveDynamoDbRegion(env);
  if (!region) {
    throw configError(
      ['AWS_REGION', 'AWS_DEFAULT_REGION'],
      'AWS_REGION or AWS_DEFAULT_REGION is required for target-aws-async.',
    );
  }
  validateAccountId(accountId);

  const sessionsTable = requireEnv(env, 'DYNAMODB_SESSIONS_TABLE');
  const votesTable = requireEnv(env, 'DYNAMODB_VOTES_TABLE');
  const rateLimitEventsTable = requireEnv(env, 'RATE_LIMIT_EVENTS_TABLE');
  const rateLimitCountersTable = requireEnv(env, 'RATE_LIMIT_COUNTERS_TABLE');
  validateDynamoTableReference('DYNAMODB_SESSIONS_TABLE', sessionsTable, accountId, region);
  validateDynamoTableReference('DYNAMODB_VOTES_TABLE', votesTable, accountId, region);
  validateDynamoTableReference('RATE_LIMIT_EVENTS_TABLE', rateLimitEventsTable, accountId, region);
  validateDynamoTableReference('RATE_LIMIT_COUNTERS_TABLE', rateLimitCountersTable, accountId, region);

  const proverWorkQueueUrl = requireEnv(env, 'PROVER_WORK_QUEUE_URL');
  const verificationWorkQueueUrl = requireEnv(env, 'VERIFICATION_WORK_QUEUE_URL');
  const proverStateMachineArn = requireEnv(env, 'PROVER_STATE_MACHINE_ARN');
  const verificationWorkerFunctionName = requireEnv(env, 'VERIFICATION_WORKER_FUNCTION_NAME');
  const bucket = requireEnv(env, 'S3_PROOF_BUCKET');
  const prefix = requireEnv(env, 'S3_PROOF_PREFIX');
  validateTargetRuntimeReferences(
    {
      proverWorkQueueUrl,
      verificationWorkQueueUrl,
      proverStateMachineArn,
      verificationWorkerFunctionName,
      s3ProofBucket: bucket,
      s3ProofPrefix: prefix,
    },
    {
      expectedAccountId: accountId,
      expectedRegion: region,
    },
  );
  validateTargetSecretReferences(env, deploymentEnvironment, accountId, region);

  const verifierPublicBaseUrl = requireEnv(env, 'VERIFIER_PUBLIC_BASE_URL');
  const expectedImageId = requireEnv(env, 'EXPECTED_IMAGE_ID');
  validateVerifierPublicBaseUrl(verifierPublicBaseUrl);
  validateExpectedImageId(expectedImageId);

  const common = {
    sessionStore: { kind: 'dynamo' },
    proof: { executor: 'risc0', evidence: 'production' },
    finalization: { mode: 'async', queue: 'sqs', orchestrator: 'step-functions' },
    artifacts: { kind: 's3' },
    runtimeAdapters: {
      api: 'lambda',
      prover: 'ecs',
      verification: 'lambda',
      browserApi: 'same-origin',
    },
    rateLimit: { store: 'dynamo', allowUnknownClientIp: false },
    external: {
      kind: 'aws',
      accountId,
      region,
      dynamo: {
        sessionsTable,
        votesTable,
        rateLimitEventsTable,
        rateLimitCountersTable,
      },
      asyncRuntime: {
        proverWorkQueueUrl,
        verificationWorkQueueUrl,
        proverStateMachineArn,
        verificationWorkerFunctionName,
      },
      artifactStorage: {
        bucket,
        prefix,
      },
      verifierPublicBaseUrl,
      expectedImageId,
      turnstileAllowedHostnames: resolveTurnstileAllowedHostnames(env),
      trustedProxy: requireEnv(env, 'TRUSTED_PROXY'),
      secretReferences: {
        sessionCapabilitySecret: requireEnv(env, 'SESSION_CAPABILITY_SECRET_REF'),
        voteSecretEncryptionKey: requireEnv(env, 'VOTE_SECRET_ENCRYPTION_KEY_REF'),
        sessionCapabilityTtlSeconds: requireEnv(env, 'SESSION_CAPABILITY_TTL_SECONDS_REF'),
        turnstileSecretKey: requireEnv(env, 'TURNSTILE_SECRET_KEY_REF'),
        expectedOriginVerifyHeader: requireEnv(env, 'EXPECTED_ORIGIN_VERIFY_HEADER_REF'),
        logIpHashSalt: requireEnv(env, 'LOG_IP_HASH_SALT_REF'),
      },
    },
  } as const satisfies Omit<TargetAwsRuntimeProfileBase, 'target'>;
  if (selector === 'target-aws-async-quiesced') {
    return {
      ...common,
      name: selector,
      target: { kind: 'aws', deploymentEnvironment: 'develop' },
      turnstile: {
        mode: 'operator-gated',
        bypassEligible: false,
        publicSessionCreate: false,
      },
    };
  }
  return {
    ...common,
    name: selector,
    target: { kind: 'aws', deploymentEnvironment },
    turnstile:
      deploymentEnvironment === 'develop'
        ? {
            mode: 'operator-gated',
            bypassEligible: false,
            publicSessionCreate: true,
          }
        : {
            mode: 'required',
            bypassEligible: false,
            publicSessionCreate: false,
          },
  };
}

export function resolveRuntimeProfile(env: NodeJS.ProcessEnv = process.env): ResolvedRuntimeProfile {
  const selector = resolveSelector(env);
  const targetAwsProfile = isTargetAwsProfileSelector(selector);
  const invalidNames = [
    ...collectPresentNames(env, REPLACED_RUNTIME_SELECTOR_NAMES),
    ...(targetAwsProfile ? collectUnsafeTargetInputNames(env) : []),
    ...(targetAwsProfile ? [] : collectPresentNames(env, TARGET_RUNTIME_EXTERNAL_INPUT_NAMES)),
  ];
  if (invalidNames.length > 0) {
    throw configError(invalidNames, 'Runtime profile inputs contain replaced or unsafe selectors.');
  }
  const profile = targetAwsProfile ? createTargetProfile(selector, env) : createLocalProfile(selector);
  return deeplyFreeze(profile);
}

export function validateRuntimeProfileSelection(
  profile: ResolvedRuntimeProfile,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const selector = resolveSelector(env);
  if (selector !== profile.name) {
    throw configError(['RUNTIME_PROFILE'], 'RUNTIME_PROFILE cannot change after runtime profile resolution.');
  }
}
