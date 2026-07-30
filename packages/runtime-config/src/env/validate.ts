import { resolveRuntimeEnvMode } from '@stark-ballot/runtime-config/env/runtimeMode';
import { isUnresolvedRuntimeSecretPlaceholder } from '@stark-ballot/runtime-config/env/runtimeSecretPlaceholders';
import {
  type RuntimeConfigReferenceName,
  validateRuntimeConfigReferenceSource,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import { validateTargetRuntimeReferences } from '@stark-ballot/runtime-config/env/targetRuntimeReferences';
import {
  assertDynamoDbEndpointAllowed,
  requireDynamoDbRegion,
  resolveDynamoDbEndpoint,
  resolveDynamoDbRegion,
} from '@stark-ballot/runtime-config/env/dynamodbConfig';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import {
  RuntimeConfigValidationError,
  type RuntimeConfigName,
} from '@stark-ballot/runtime-config/env/configValidationError';

const MAX_SESSION_CAPABILITY_TTL_SECONDS = 7 * 24 * 60 * 60;
const IMAGE_ID_VARIANTS = new Set(['default', 'x86_64']);

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function isImageIdVariant(value: string): boolean {
  return IMAGE_ID_VARIANTS.has(value);
}

const DISALLOWED_SESSION_CAPABILITY_SECRETS = new Set([
  'change-me-please-min-32-chars',
  'test-session-capability-secret-0123456789abcdef',
]);
const DISALLOWED_FINALIZE_CALLBACK_SECRETS = new Set([
  'change-me-please-min-32-chars',
  'test-finalization-writer-secret-0123456789abcdef',
]);

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function configError(
  invalidNames: RuntimeConfigName | readonly RuntimeConfigName[],
  message: string,
  cause?: unknown,
): RuntimeConfigValidationError {
  return new RuntimeConfigValidationError(
    typeof invalidNames === 'string' ? [invalidNames] : invalidNames,
    cause,
    message,
  );
}

function validatePositiveIntegerEnv(
  name: RuntimeConfigName,
  rawValue: string | undefined,
  options: { min?: number } = {},
): void {
  if (!rawValue) {
    return;
  }

  const min = options.min ?? 1;
  const value = Number(rawValue.trim());
  if (!Number.isInteger(value) || value < min) {
    throw configError(name, `Invalid ${name} value: ${rawValue}. Expected an integer greater than or equal to ${min}.`);
  }
}

function validateAwsAccountId(): string {
  const accountId = readTrimmedEnv('AWS_ACCOUNT_ID');
  if (!accountId) {
    throw configError('AWS_ACCOUNT_ID', 'AWS_ACCOUNT_ID must be set for target DynamoDB runtime access.');
  }
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw configError('AWS_ACCOUNT_ID', 'AWS_ACCOUNT_ID must be a 12-digit AWS account ID.');
  }
  return accountId;
}

function isBareDynamoTableNameExceptionAllowed(): boolean {
  if (process.env['NODE_ENV'] === 'test') {
    return true;
  }

  return Boolean(resolveDynamoDbEndpoint()) && process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] === 'true';
}

function validateDynamoTableReference(
  name: RuntimeConfigName,
  rawValue: string | undefined,
  expectedAccountId: string,
  options: { allowBareTableName?: boolean } = {},
): void {
  const value = rawValue?.trim();
  if (!value) {
    throw configError(name, `${name} must be set for DynamoDB runtime access.`);
  }
  if (value.toLowerCase().includes('amplify')) {
    throw configError(name, `${name} must not reference legacy Amplify tables.`);
  }

  const arnMatch = /^arn:aws:dynamodb:([^:]+):([0-9]{12}):table\/([A-Za-z0-9_.-]{3,255})$/.exec(value);
  if (arnMatch) {
    const [, region, accountId] = arnMatch;
    const expectedRegion = resolveDynamoDbRegion();
    if (expectedRegion && region !== expectedRegion) {
      throw configError(name, `${name} region must match AWS_REGION/AWS_DEFAULT_REGION.`);
    }
    if (accountId !== expectedAccountId) {
      throw configError(name, `${name} account must match AWS_ACCOUNT_ID.`);
    }
    return;
  }

  const isBareTableName = /^[A-Za-z0-9_.-]{3,255}$/.test(value);
  if (!isBareTableName) {
    throw configError(name, `${name} must be a DynamoDB table name or table ARN.`);
  }
  if (!options.allowBareTableName) {
    throw configError(
      name,
      `${name} must be a DynamoDB table ARN outside explicit local/test DynamoDB endpoint exceptions.`,
    );
  }
}

function validateRuntimeReference(
  name: RuntimeConfigReferenceName,
  rawValue: string | undefined,
  expectedAccountId: string,
): void {
  validateRuntimeConfigReferenceSource(name, rawValue, {
    ...omitUndefinedProperties({ expectedAccountId: expectedAccountId }),
    ...omitUndefinedProperties({ expectedDeploymentEnvironment: readTrimmedEnv('RUNTIME_DEPLOYMENT_ENV') }),
    ...omitUndefinedProperties({ expectedRegion: resolveDynamoDbRegion() }),
  });
}

function assertRawSecretIsNotReference(
  name:
    | 'SESSION_CAPABILITY_SECRET'
    | 'VOTE_SECRET_ENCRYPTION_KEY'
    | 'TURNSTILE_SECRET_KEY'
    | 'EXPECTED_ORIGIN_VERIFY_HEADER',
  value: string,
): void {
  const lowered = value.toLowerCase();
  if (value.startsWith('/') || lowered.startsWith('arn:aws:')) {
    throw configError(name, `${name} must contain raw secret material, not a reference.`);
  }
}

function assertTargetRuntimeReferenceOnly(name: RuntimeConfigName, rawValue: string | undefined): void {
  if (rawValue?.trim()) {
    throw configError(name, `${name} must not be set directly when USE_MOCK_STORE=false; use ${name}_REF.`);
  }
}

function validateTargetTurnstileRuntimeConfig(): void {
  const rawSecret = readTrimmedEnv('TURNSTILE_SECRET_KEY');
  assertTargetRuntimeReferenceOnly('TURNSTILE_SECRET_KEY', rawSecret);

  const allowedHostnames = readTrimmedEnv('TURNSTILE_ALLOWED_HOSTNAMES');
  if (!allowedHostnames) {
    throw configError('TURNSTILE_ALLOWED_HOSTNAMES', 'TURNSTILE_ALLOWED_HOSTNAMES must be set for target runtime.');
  }

  const trustedProxy = readTrimmedEnv('TRUSTED_PROXY');
  if (!trustedProxy) {
    throw configError('TRUSTED_PROXY', 'TRUSTED_PROXY must be set for target runtime Turnstile source-IP handling.');
  }
}

function requireTargetRuntimeEnv(name: RuntimeConfigName): string {
  const value = readTrimmedEnv(name);
  if (!value) {
    throw configError(name, `${name} must be set when TARGET_AWS_RUNTIME=1.`);
  }
  return value;
}

function requireTargetRuntimeEnvValue(name: RuntimeConfigName, expectedValue: string): void {
  const value = requireTargetRuntimeEnv(name);
  if (value !== expectedValue) {
    throw configError(name, `${name}=${expectedValue} is required when TARGET_AWS_RUNTIME=1.`);
  }
}

function validateTargetPublicBaseUrl(): void {
  const value = requireTargetRuntimeEnv('VERIFIER_PUBLIC_BASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw configError(
      'VERIFIER_PUBLIC_BASE_URL',
      'VERIFIER_PUBLIC_BASE_URL must be a valid https URL when TARGET_AWS_RUNTIME=1.',
      cause,
    );
  }

  if (parsed.protocol !== 'https:') {
    throw configError(
      'VERIFIER_PUBLIC_BASE_URL',
      'VERIFIER_PUBLIC_BASE_URL must be a valid https URL when TARGET_AWS_RUNTIME=1.',
    );
  }
  if (parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw configError(
      'VERIFIER_PUBLIC_BASE_URL',
      'VERIFIER_PUBLIC_BASE_URL must not include a path, query, or fragment when TARGET_AWS_RUNTIME=1.',
    );
  }
}

function validateTargetExpectedImageId(): void {
  const value = requireTargetRuntimeEnv('EXPECTED_IMAGE_ID');
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw configError(
      'EXPECTED_IMAGE_ID',
      'EXPECTED_IMAGE_ID must be a 32-byte 0x-prefixed hex string when TARGET_AWS_RUNTIME=1.',
    );
  }
}

function validateTargetProofModeControls(): void {
  if (process.env['USE_MOCK_ZKVM'] === 'true') {
    throw configError('USE_MOCK_ZKVM', 'USE_MOCK_ZKVM=true is not allowed when TARGET_AWS_RUNTIME=1.');
  }
  if (process.env['RISC0_DEV_MODE'] === '1') {
    throw configError('RISC0_DEV_MODE', 'RISC0_DEV_MODE=1 is not allowed when TARGET_AWS_RUNTIME=1.');
  }
  if (isTruthyFlag(process.env['FORCE_DEV_MODE'])) {
    throw configError('FORCE_DEV_MODE', 'FORCE_DEV_MODE is not allowed when TARGET_AWS_RUNTIME=1.');
  }
  if (isTruthyFlag(process.env['ALLOW_INSECURE_ZKVM'])) {
    throw configError('ALLOW_INSECURE_ZKVM', 'ALLOW_INSECURE_ZKVM is not allowed when TARGET_AWS_RUNTIME=1.');
  }
  if (isTruthyFlag(process.env['ALLOW_DEV_MODE_VERIFICATION'])) {
    throw configError(
      'ALLOW_DEV_MODE_VERIFICATION',
      'ALLOW_DEV_MODE_VERIFICATION is not allowed when TARGET_AWS_RUNTIME=1.',
    );
  }
}

function validateTargetOriginVerifyHeader(): void {
  requireTargetRuntimeEnv('EXPECTED_ORIGIN_VERIFY_HEADER_REF');
  if (readTrimmedEnv('EXPECTED_ORIGIN_VERIFY_HEADER')) {
    assertRawSecretIsNotReference(
      'EXPECTED_ORIGIN_VERIFY_HEADER',
      requireTargetRuntimeEnv('EXPECTED_ORIGIN_VERIFY_HEADER'),
    );
  } else {
    throw configError(
      'EXPECTED_ORIGIN_VERIFY_HEADER',
      'EXPECTED_ORIGIN_VERIFY_HEADER must be resolved from EXPECTED_ORIGIN_VERIFY_HEADER_REF when TARGET_AWS_RUNTIME=1.',
    );
  }
}

function validateTargetSessionCreateAdmission(): void {
  const publicCreateEnabled = isTruthyFlag(process.env['TARGET_PUBLIC_SESSION_CREATE_ENABLED']);
  const sessionTurnstileRequired = isTruthyFlag(process.env['SESSION_CREATE_TURNSTILE_REQUIRED']);
  const operatorGateEnabled = isTruthyFlag(process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED']);
  const deploymentEnv = readTrimmedEnv('RUNTIME_DEPLOYMENT_ENV');

  if (!publicCreateEnabled) {
    return;
  }
  if (sessionTurnstileRequired) {
    return;
  }
  if (deploymentEnv === 'develop' && operatorGateEnabled) {
    return;
  }

  throw configError(
    [
      'TARGET_PUBLIC_SESSION_CREATE_ENABLED',
      'SESSION_CREATE_TURNSTILE_REQUIRED',
      'TARGET_DEVELOP_OPERATOR_GATE_ENABLED',
      'RUNTIME_DEPLOYMENT_ENV',
    ],
    'TARGET_PUBLIC_SESSION_CREATE_ENABLED without SESSION_CREATE_TURNSTILE_REQUIRED is allowed only for operator-gated develop.',
  );
}

function validateTargetAwsRuntimeConfig(): void {
  requireTargetRuntimeEnvValue('USE_MOCK_STORE', 'false');
  requireTargetRuntimeEnvValue('FINALIZE_ASYNC_MODE', 'true');
  requireTargetRuntimeEnvValue('USE_S3', 'true');
  const verificationWorkerFunctionName =
    readTrimmedEnv('VERIFICATION_WORKER_FUNCTION_NAME') ?? readTrimmedEnv('VERIFICATION_WORKER_ARN');
  validateTargetRuntimeReferences(
    {
      proverWorkQueueUrl: requireTargetRuntimeEnv('PROVER_WORK_QUEUE_URL'),
      proverStateMachineArn: requireTargetRuntimeEnv('PROVER_STATE_MACHINE_ARN'),
      verificationWorkerFunctionName:
        verificationWorkerFunctionName ?? requireTargetRuntimeEnv('VERIFICATION_WORKER_FUNCTION_NAME'),
      s3ProofBucket: requireTargetRuntimeEnv('S3_PROOF_BUCKET'),
      s3ProofPrefix: requireTargetRuntimeEnv('S3_PROOF_PREFIX'),
    },
    {
      ...omitUndefinedProperties({ expectedAccountId: readTrimmedEnv('AWS_ACCOUNT_ID') }),
      ...omitUndefinedProperties({ expectedRegion: resolveDynamoDbRegion() }),
    },
  );
  validateTargetPublicBaseUrl();
  validateTargetExpectedImageId();
  validateTargetProofModeControls();
  validateTargetObservabilityEnv();
  validateTargetOriginVerifyHeader();
  validateTargetSessionCreateAdmission();
}

/**
 * Environment variable validation
 *
 * Target AWS access uses DynamoDB, S3, SQS, Step Functions, and Lambda with execution-role/default credentials.
 */

export function validateEnv(): void {
  const runtimeMode = resolveRuntimeEnvMode();
  if (isTruthyFlag(process.env['TURNSTILE_BYPASS']) && runtimeMode !== 'non-production') {
    throw configError(
      'TURNSTILE_BYPASS',
      'TURNSTILE_BYPASS must be disabled unless runtime is explicitly non-production',
    );
  }

  if (process.env['TARGET_AWS_RUNTIME'] === '1') {
    validateTargetAwsRuntimeConfig();
  }

  // Skip target DynamoDB validation when using mock store (CI/tests)
  const useMockStore = process.env['USE_MOCK_STORE'] === 'true' || process.env['NODE_ENV'] === 'test';
  const rateLimitStore = process.env['RATE_LIMIT_STORE']?.trim().toLowerCase();

  const capabilitySecret = readTrimmedEnv('SESSION_CAPABILITY_SECRET');
  const capabilitySecretRef = readTrimmedEnv('SESSION_CAPABILITY_SECRET_REF');
  const capabilityTtlRaw = readTrimmedEnv('SESSION_CAPABILITY_TTL_SECONDS');
  if (!useMockStore) {
    assertTargetRuntimeReferenceOnly('SESSION_CAPABILITY_SECRET', capabilitySecret);
    assertTargetRuntimeReferenceOnly('SESSION_CAPABILITY_TTL_SECONDS', capabilityTtlRaw);
    assertTargetRuntimeReferenceOnly('VOTE_SECRET_ENCRYPTION_KEY', readTrimmedEnv('VOTE_SECRET_ENCRYPTION_KEY'));
    validateTargetTurnstileRuntimeConfig();
  } else {
    if (process.env['NODE_ENV'] !== 'test' && !capabilitySecret && !capabilitySecretRef) {
      throw configError(
        ['SESSION_CAPABILITY_SECRET', 'SESSION_CAPABILITY_SECRET_REF'],
        'SESSION_CAPABILITY_SECRET must be set to at least 32 characters',
      );
    }
    if (process.env['NODE_ENV'] !== 'test' && capabilitySecret && capabilitySecret.length < 32) {
      throw configError('SESSION_CAPABILITY_SECRET', 'SESSION_CAPABILITY_SECRET must be set to at least 32 characters');
    }
    if (
      process.env['NODE_ENV'] !== 'test' &&
      capabilitySecret &&
      isUnresolvedRuntimeSecretPlaceholder(capabilitySecret)
    ) {
      throw configError(
        'SESSION_CAPABILITY_SECRET',
        'SESSION_CAPABILITY_SECRET was not resolved from runtime secret references',
      );
    }
    if (process.env['NODE_ENV'] !== 'test' && capabilitySecret) {
      assertRawSecretIsNotReference('SESSION_CAPABILITY_SECRET', capabilitySecret);
      const lowered = capabilitySecret.toLowerCase();
      if (DISALLOWED_SESSION_CAPABILITY_SECRETS.has(lowered) || lowered.startsWith('change-me-please')) {
        throw configError(
          'SESSION_CAPABILITY_SECRET',
          'SESSION_CAPABILITY_SECRET must be changed from placeholder/test values',
        );
      }
    }
  }

  // Optional by design:
  // production async flow updates state via finalization-writer Lambda,
  // and /api/finalize/callback is excluded from lambda route registration.
  // When this secret is configured (e.g. local/manual callback route use), enforce strong values.
  const finalizeCallbackSecret = process.env['FINALIZE_CALLBACK_SECRET']?.trim();
  if (process.env['NODE_ENV'] !== 'test' && finalizeCallbackSecret) {
    if (finalizeCallbackSecret.length < 32) {
      throw configError(
        'FINALIZE_CALLBACK_SECRET',
        'FINALIZE_CALLBACK_SECRET must be at least 32 characters when configured',
      );
    }
    if (isUnresolvedRuntimeSecretPlaceholder(finalizeCallbackSecret)) {
      throw configError(
        'FINALIZE_CALLBACK_SECRET',
        'FINALIZE_CALLBACK_SECRET was not resolved from runtime secret references',
      );
    }
    const lowered = finalizeCallbackSecret.toLowerCase();
    if (DISALLOWED_FINALIZE_CALLBACK_SECRETS.has(lowered) || lowered.startsWith('change-me-please')) {
      throw configError('FINALIZE_CALLBACK_SECRET', 'FINALIZE_CALLBACK_SECRET must be changed from placeholder values');
    }
  }

  if (capabilityTtlRaw) {
    const capabilityTtl = Number(capabilityTtlRaw);
    if (!Number.isInteger(capabilityTtl) || capabilityTtl <= 0) {
      throw configError(
        'SESSION_CAPABILITY_TTL_SECONDS',
        `Invalid SESSION_CAPABILITY_TTL_SECONDS value: ${process.env['SESSION_CAPABILITY_TTL_SECONDS']}. ` +
          'Expected a positive integer.',
      );
    }
    if (capabilityTtl > MAX_SESSION_CAPABILITY_TTL_SECONDS) {
      throw configError(
        'SESSION_CAPABILITY_TTL_SECONDS',
        `SESSION_CAPABILITY_TTL_SECONDS must be ${MAX_SESSION_CAPABILITY_TTL_SECONDS} or less for security hardening.`,
      );
    }
  }

  const expectedImageIdVariant = process.env['EXPECTED_IMAGE_ID_VARIANT']?.trim();
  if (expectedImageIdVariant && !isImageIdVariant(expectedImageIdVariant)) {
    throw configError(
      'EXPECTED_IMAGE_ID_VARIANT',
      `Invalid EXPECTED_IMAGE_ID_VARIANT value: ${process.env['EXPECTED_IMAGE_ID_VARIANT']}. Expected "default" or "x86_64".`,
    );
  }

  validatePositiveIntegerEnv('MAX_SESSIONS', process.env['MAX_SESSIONS'], { min: 1 });
  validatePositiveIntegerEnv('SESSION_CREATE_RATE_LIMIT', process.env['SESSION_CREATE_RATE_LIMIT'], { min: 1 });
  validatePositiveIntegerEnv(
    'SESSION_CREATE_RATE_LIMIT_WINDOW_MS',
    process.env['SESSION_CREATE_RATE_LIMIT_WINDOW_MS'],
    {
      min: 1,
    },
  );
  validatePositiveIntegerEnv(
    'SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS',
    process.env['SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS'],
    { min: 1 },
  );
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT', process.env['VOTE_RATE_LIMIT'], { min: 1 });
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT_WINDOW_MS', process.env['VOTE_RATE_LIMIT_WINDOW_MS'], { min: 1 });
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT_MAX_BUCKETS', process.env['VOTE_RATE_LIMIT_MAX_BUCKETS'], { min: 1 });
  validatePositiveIntegerEnv('FINALIZE_CANCEL_RATE_LIMIT', process.env['FINALIZE_CANCEL_RATE_LIMIT'], { min: 1 });
  validatePositiveIntegerEnv(
    'FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS',
    process.env['FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS'],
    {
      min: 1,
    },
  );
  validatePositiveIntegerEnv(
    'FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS',
    process.env['FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS'],
    { min: 1 },
  );
  validatePositiveIntegerEnv('FINALIZE_CALLBACK_BODY_LIMIT_BYTES', process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES'], {
    min: 1,
  });
  validatePositiveIntegerEnv(
    'FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS',
    process.env['FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS'],
    {
      min: 1,
    },
  );
  validatePositiveIntegerEnv('SESSION_LIVE_TTL_SECONDS', process.env['SESSION_LIVE_TTL_SECONDS'], { min: 1 });
  validatePositiveIntegerEnv('VERIFICATION_ARTIFACT_TTL_SECONDS', process.env['VERIFICATION_ARTIFACT_TTL_SECONDS'], {
    min: 1,
  });
  validatePositiveIntegerEnv(
    'VOTE_DUPLICATE_DETECTOR_TTL_SECONDS',
    process.env['VOTE_DUPLICATE_DETECTOR_TTL_SECONDS'],
    {
      min: 1,
    },
  );
  validatePositiveIntegerEnv('ZKVM_RATE_LIMIT_PER_IP', process.env['ZKVM_RATE_LIMIT_PER_IP'], { min: 1 });
  validatePositiveIntegerEnv('ZKVM_RATE_LIMIT_WINDOW_MS', process.env['ZKVM_RATE_LIMIT_WINDOW_MS'], { min: 1 });
  validatePositiveIntegerEnv('ZKVM_GLOBAL_DAILY_LIMIT', process.env['ZKVM_GLOBAL_DAILY_LIMIT'], { min: 1 });
  validatePositiveIntegerEnv('ZKVM_GLOBAL_HOURLY_LIMIT', process.env['ZKVM_GLOBAL_HOURLY_LIMIT'], { min: 1 });

  const signedUrlTtlRaw = process.env['S3_SIGNED_URL_TTL_SECONDS']?.trim();
  if (signedUrlTtlRaw) {
    const signedUrlTtl = Number(signedUrlTtlRaw);
    if (!Number.isInteger(signedUrlTtl) || signedUrlTtl <= 0) {
      throw configError(
        'S3_SIGNED_URL_TTL_SECONDS',
        `Invalid S3_SIGNED_URL_TTL_SECONDS value: ${process.env['S3_SIGNED_URL_TTL_SECONDS']}. ` +
          'Expected a positive integer.',
      );
    }
  }

  const bundleSignedUrlTtlRaw = process.env['S3_BUNDLE_SIGNED_URL_TTL_SECONDS']?.trim();
  if (bundleSignedUrlTtlRaw) {
    const bundleSignedUrlTtl = Number(bundleSignedUrlTtlRaw);
    if (!Number.isInteger(bundleSignedUrlTtl) || bundleSignedUrlTtl <= 0) {
      throw configError(
        'S3_BUNDLE_SIGNED_URL_TTL_SECONDS',
        `Invalid S3_BUNDLE_SIGNED_URL_TTL_SECONDS value: ${process.env['S3_BUNDLE_SIGNED_URL_TTL_SECONDS']}. ` +
          'Expected a positive integer.',
      );
    }
    if (bundleSignedUrlTtl > 900) {
      throw configError(
        'S3_BUNDLE_SIGNED_URL_TTL_SECONDS',
        'S3_BUNDLE_SIGNED_URL_TTL_SECONDS must be 900 or less for security hardening.',
      );
    }
  }

  const voteSecretRef = readTrimmedEnv('VOTE_SECRET_ENCRYPTION_KEY_REF');
  const turnstileSecretRef = readTrimmedEnv('TURNSTILE_SECRET_KEY_REF');
  const expectedOriginVerifyHeaderRef = readTrimmedEnv('EXPECTED_ORIGIN_VERIFY_HEADER_REF');

  if (rateLimitStore && rateLimitStore !== 'memory' && rateLimitStore !== 'dynamo') {
    throw configError(
      'RATE_LIMIT_STORE',
      `Invalid RATE_LIMIT_STORE value: ${process.env['RATE_LIMIT_STORE']}. Expected "memory" or "dynamo".`,
    );
  }

  if (!useMockStore) {
    const expectedAccountId = validateAwsAccountId();
    if (process.env['USE_AMPLIFY_DATA']?.trim().toLowerCase() === 'true') {
      throw configError(
        'USE_AMPLIFY_DATA',
        'USE_AMPLIFY_DATA is retired for target non-mock runtime; use DynamoDB session storage.',
      );
    }
    requireDynamoDbRegion();
    assertDynamoDbEndpointAllowed();
    const allowBareTableName = isBareDynamoTableNameExceptionAllowed();
    validateDynamoTableReference('DYNAMODB_SESSIONS_TABLE', process.env['DYNAMODB_SESSIONS_TABLE'], expectedAccountId, {
      allowBareTableName,
    });
    validateDynamoTableReference('DYNAMODB_VOTES_TABLE', process.env['DYNAMODB_VOTES_TABLE'], expectedAccountId, {
      allowBareTableName,
    });
    validateRuntimeReference('SESSION_CAPABILITY_SECRET', capabilitySecretRef, expectedAccountId);
    validateRuntimeReference('VOTE_SECRET_ENCRYPTION_KEY', voteSecretRef, expectedAccountId);
    validateRuntimeReference('TURNSTILE_SECRET_KEY', turnstileSecretRef, expectedAccountId);
    validateRuntimeReference('EXPECTED_ORIGIN_VERIFY_HEADER', expectedOriginVerifyHeaderRef, expectedAccountId);
    validateRuntimeReference('LOG_IP_HASH_SALT', readTrimmedEnv('LOG_IP_HASH_SALT_REF'), expectedAccountId);
    validateRuntimeReference(
      'SESSION_CAPABILITY_TTL_SECONDS',
      readTrimmedEnv('SESSION_CAPABILITY_TTL_SECONDS_REF'),
      expectedAccountId,
    );
  }

  if (!useMockStore) {
    if (rateLimitStore !== 'dynamo') {
      throw configError('RATE_LIMIT_STORE', 'RATE_LIMIT_STORE=dynamo is required when USE_MOCK_STORE=false.');
    }
    const expectedAccountId = validateAwsAccountId();
    const allowBareTableName = isBareDynamoTableNameExceptionAllowed();
    validateDynamoTableReference('RATE_LIMIT_EVENTS_TABLE', process.env['RATE_LIMIT_EVENTS_TABLE'], expectedAccountId, {
      allowBareTableName,
    });
    validateDynamoTableReference(
      'RATE_LIMIT_COUNTERS_TABLE',
      process.env['RATE_LIMIT_COUNTERS_TABLE'],
      expectedAccountId,
      {
        allowBareTableName,
      },
    );
  }
}
