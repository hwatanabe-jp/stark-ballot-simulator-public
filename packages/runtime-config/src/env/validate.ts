import { isUnresolvedRuntimeSecretPlaceholder } from '@stark-ballot/runtime-config/env/runtimeSecretPlaceholders';
import {
  type RuntimeConfigReferenceName,
  validateRuntimeConfigReferenceSource,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import { validateTargetRuntimeReferences } from '@stark-ballot/runtime-config/env/targetRuntimeReferences';
import {
  assertDynamoDbEndpointAllowed,
  requireDynamoDbRegion,
  resolveDynamoDbRegion,
} from '@stark-ballot/runtime-config/env/dynamodbConfig';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import {
  RuntimeConfigValidationError,
  type RuntimeConfigName,
} from '@stark-ballot/runtime-config/env/configValidationError';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

const MAX_SESSION_CAPABILITY_TTL_SECONDS = 7 * 24 * 60 * 60;
const IMAGE_ID_VARIANTS = new Set(['default', 'x86_64']);

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

function readTrimmedEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
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

function validateAwsAccountId(env: NodeJS.ProcessEnv): string {
  const accountId = readTrimmedEnv(env, 'AWS_ACCOUNT_ID');
  if (!accountId) {
    throw configError('AWS_ACCOUNT_ID', 'AWS_ACCOUNT_ID must be set for target DynamoDB runtime access.');
  }
  if (!/^[0-9]{12}$/.test(accountId)) {
    throw configError('AWS_ACCOUNT_ID', 'AWS_ACCOUNT_ID must be a 12-digit AWS account ID.');
  }
  return accountId;
}

function validateDynamoTableReference(
  name: RuntimeConfigName,
  rawValue: string | undefined,
  expectedAccountId: string,
  env: NodeJS.ProcessEnv,
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
    const expectedRegion = resolveDynamoDbRegion(env);
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
  env: NodeJS.ProcessEnv,
  name: RuntimeConfigReferenceName,
  rawValue: string | undefined,
  expectedAccountId: string,
  expectedDeploymentEnvironment: 'develop' | 'main',
): void {
  validateRuntimeConfigReferenceSource(name, rawValue, {
    ...omitUndefinedProperties({ expectedAccountId: expectedAccountId }),
    expectedDeploymentEnvironment,
    ...omitUndefinedProperties({ expectedRegion: resolveDynamoDbRegion(env) }),
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
    throw configError(name, `${name} must not be set directly for the target AWS runtime profile; use ${name}_REF.`);
  }
}

function validateTargetTurnstileRuntimeConfig(env: NodeJS.ProcessEnv): void {
  const rawSecret = readTrimmedEnv(env, 'TURNSTILE_SECRET_KEY');
  assertTargetRuntimeReferenceOnly('TURNSTILE_SECRET_KEY', rawSecret);

  const allowedHostnames = readTrimmedEnv(env, 'TURNSTILE_ALLOWED_HOSTNAMES');
  if (!allowedHostnames) {
    throw configError('TURNSTILE_ALLOWED_HOSTNAMES', 'TURNSTILE_ALLOWED_HOSTNAMES must be set for target runtime.');
  }

  const trustedProxy = readTrimmedEnv(env, 'TRUSTED_PROXY');
  if (!trustedProxy) {
    throw configError('TRUSTED_PROXY', 'TRUSTED_PROXY must be set for target runtime Turnstile source-IP handling.');
  }
}

function requireTargetRuntimeEnv(env: NodeJS.ProcessEnv, name: RuntimeConfigName): string {
  const value = readTrimmedEnv(env, name);
  if (!value) {
    throw configError(name, `${name} must be set for the target AWS runtime profile.`);
  }
  return value;
}

function validateTargetPublicBaseUrl(env: NodeJS.ProcessEnv): void {
  const value = requireTargetRuntimeEnv(env, 'VERIFIER_PUBLIC_BASE_URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw configError(
      'VERIFIER_PUBLIC_BASE_URL',
      'VERIFIER_PUBLIC_BASE_URL must be a valid https URL for the target AWS runtime profile.',
      cause,
    );
  }

  if (parsed.protocol !== 'https:') {
    throw configError(
      'VERIFIER_PUBLIC_BASE_URL',
      'VERIFIER_PUBLIC_BASE_URL must be a valid https URL for the target AWS runtime profile.',
    );
  }
  if (parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw configError(
      'VERIFIER_PUBLIC_BASE_URL',
      'VERIFIER_PUBLIC_BASE_URL must not include a path, query, or fragment for the target AWS runtime profile.',
    );
  }
}

function validateTargetExpectedImageId(env: NodeJS.ProcessEnv): void {
  const value = requireTargetRuntimeEnv(env, 'EXPECTED_IMAGE_ID');
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw configError(
      'EXPECTED_IMAGE_ID',
      'EXPECTED_IMAGE_ID must be a 32-byte 0x-prefixed hex string for the target AWS runtime profile.',
    );
  }
}

function validateTargetOriginVerifyHeader(env: NodeJS.ProcessEnv): void {
  requireTargetRuntimeEnv(env, 'EXPECTED_ORIGIN_VERIFY_HEADER_REF');
  if (readTrimmedEnv(env, 'EXPECTED_ORIGIN_VERIFY_HEADER')) {
    assertRawSecretIsNotReference(
      'EXPECTED_ORIGIN_VERIFY_HEADER',
      requireTargetRuntimeEnv(env, 'EXPECTED_ORIGIN_VERIFY_HEADER'),
    );
  } else {
    throw configError(
      'EXPECTED_ORIGIN_VERIFY_HEADER',
      'EXPECTED_ORIGIN_VERIFY_HEADER must be resolved from EXPECTED_ORIGIN_VERIFY_HEADER_REF for the target AWS runtime profile.',
    );
  }
}

function validateTargetAwsRuntimeConfig(profile: ResolvedRuntimeProfile, env: NodeJS.ProcessEnv): void {
  validateTargetRuntimeReferences(
    {
      proverWorkQueueUrl: requireTargetRuntimeEnv(env, 'PROVER_WORK_QUEUE_URL'),
      verificationWorkQueueUrl: requireTargetRuntimeEnv(env, 'VERIFICATION_WORK_QUEUE_URL'),
      proverStateMachineArn: requireTargetRuntimeEnv(env, 'PROVER_STATE_MACHINE_ARN'),
      verificationWorkerFunctionName: requireTargetRuntimeEnv(env, 'VERIFICATION_WORKER_FUNCTION_NAME'),
      s3ProofBucket: requireTargetRuntimeEnv(env, 'S3_PROOF_BUCKET'),
      s3ProofPrefix: requireTargetRuntimeEnv(env, 'S3_PROOF_PREFIX'),
    },
    {
      ...omitUndefinedProperties({ expectedAccountId: readTrimmedEnv(env, 'AWS_ACCOUNT_ID') }),
      ...omitUndefinedProperties({ expectedRegion: resolveDynamoDbRegion(env) }),
    },
  );
  validateTargetPublicBaseUrl(env);
  validateTargetExpectedImageId(env);
  validateTargetObservabilityEnv(profile, env);
  validateTargetOriginVerifyHeader(env);
}

/**
 * Environment variable validation
 *
 * Target AWS access uses DynamoDB, S3, SQS, Step Functions, and Lambda with execution-role/default credentials.
 */

export function validateEnv(profile: ResolvedRuntimeProfile, env: NodeJS.ProcessEnv = process.env): void {
  if (profile.target.kind === 'aws') {
    validateTargetAwsRuntimeConfig(profile, env);
  }

  const usesDynamoSessionStore = profile.sessionStore.kind === 'dynamo';
  const rateLimitStore = profile.rateLimit.store;

  const capabilitySecret = readTrimmedEnv(env, 'SESSION_CAPABILITY_SECRET');
  const capabilitySecretRef = readTrimmedEnv(env, 'SESSION_CAPABILITY_SECRET_REF');
  const capabilityTtlRaw = readTrimmedEnv(env, 'SESSION_CAPABILITY_TTL_SECONDS');
  if (usesDynamoSessionStore) {
    assertTargetRuntimeReferenceOnly('SESSION_CAPABILITY_SECRET', capabilitySecret);
    assertTargetRuntimeReferenceOnly('SESSION_CAPABILITY_TTL_SECONDS', capabilityTtlRaw);
    assertTargetRuntimeReferenceOnly('VOTE_SECRET_ENCRYPTION_KEY', readTrimmedEnv(env, 'VOTE_SECRET_ENCRYPTION_KEY'));
    validateTargetTurnstileRuntimeConfig(env);
  } else if (profile.proof.executor === 'risc0') {
    if (!capabilitySecret && !capabilitySecretRef) {
      throw configError(
        ['SESSION_CAPABILITY_SECRET', 'SESSION_CAPABILITY_SECRET_REF'],
        'SESSION_CAPABILITY_SECRET must be set to at least 32 characters',
      );
    }
    if (capabilitySecret && capabilitySecret.length < 32) {
      throw configError('SESSION_CAPABILITY_SECRET', 'SESSION_CAPABILITY_SECRET must be set to at least 32 characters');
    }
    if (capabilitySecret && isUnresolvedRuntimeSecretPlaceholder(capabilitySecret)) {
      throw configError(
        'SESSION_CAPABILITY_SECRET',
        'SESSION_CAPABILITY_SECRET was not resolved from runtime secret references',
      );
    }
    if (capabilitySecret) {
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
  // and /api/internal/sessions/:sessionId/finalizations/:finalizationId/callback
  // is registered only by the full local server, never Lambda or read-only mode.
  // When this secret is configured for that internal route, enforce strong values.
  const finalizeCallbackSecret = env['FINALIZE_CALLBACK_SECRET']?.trim();
  if (finalizeCallbackSecret) {
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
        `Invalid SESSION_CAPABILITY_TTL_SECONDS value: ${env['SESSION_CAPABILITY_TTL_SECONDS']}. ` +
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

  const expectedImageIdVariant = env['EXPECTED_IMAGE_ID_VARIANT']?.trim();
  if (expectedImageIdVariant && !isImageIdVariant(expectedImageIdVariant)) {
    throw configError(
      'EXPECTED_IMAGE_ID_VARIANT',
      `Invalid EXPECTED_IMAGE_ID_VARIANT value: ${env['EXPECTED_IMAGE_ID_VARIANT']}. Expected "default" or "x86_64".`,
    );
  }

  validatePositiveIntegerEnv('MAX_SESSIONS', env['MAX_SESSIONS'], { min: 1 });
  validatePositiveIntegerEnv('SESSION_CREATE_RATE_LIMIT', env['SESSION_CREATE_RATE_LIMIT'], { min: 1 });
  validatePositiveIntegerEnv('SESSION_CREATE_RATE_LIMIT_WINDOW_MS', env['SESSION_CREATE_RATE_LIMIT_WINDOW_MS'], {
    min: 1,
  });
  validatePositiveIntegerEnv('SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS', env['SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS'], {
    min: 1,
  });
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT', env['VOTE_RATE_LIMIT'], { min: 1 });
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT_WINDOW_MS', env['VOTE_RATE_LIMIT_WINDOW_MS'], { min: 1 });
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT_MAX_BUCKETS', env['VOTE_RATE_LIMIT_MAX_BUCKETS'], { min: 1 });
  validatePositiveIntegerEnv('FINALIZE_CANCEL_RATE_LIMIT', env['FINALIZE_CANCEL_RATE_LIMIT'], { min: 1 });
  validatePositiveIntegerEnv('FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS', env['FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS'], {
    min: 1,
  });
  validatePositiveIntegerEnv('FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS', env['FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS'], {
    min: 1,
  });
  validatePositiveIntegerEnv('FINALIZE_CALLBACK_BODY_LIMIT_BYTES', env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES'], {
    min: 1,
  });
  validatePositiveIntegerEnv('FINALIZE_CALLBACK_MAX_SKEW_MS', env['FINALIZE_CALLBACK_MAX_SKEW_MS'], {
    min: 1,
  });
  validatePositiveIntegerEnv(
    'FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS',
    env['FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS'],
    {
      min: 1,
    },
  );
  validatePositiveIntegerEnv('SESSION_LIVE_TTL_SECONDS', env['SESSION_LIVE_TTL_SECONDS'], { min: 1 });
  validatePositiveIntegerEnv('VERIFICATION_ARTIFACT_TTL_SECONDS', env['VERIFICATION_ARTIFACT_TTL_SECONDS'], {
    min: 1,
  });
  validatePositiveIntegerEnv('VOTE_DUPLICATE_DETECTOR_TTL_SECONDS', env['VOTE_DUPLICATE_DETECTOR_TTL_SECONDS'], {
    min: 1,
  });
  validatePositiveIntegerEnv('ZKVM_RATE_LIMIT_PER_IP', env['ZKVM_RATE_LIMIT_PER_IP'], { min: 1 });
  validatePositiveIntegerEnv('ZKVM_RATE_LIMIT_WINDOW_MS', env['ZKVM_RATE_LIMIT_WINDOW_MS'], { min: 1 });
  validatePositiveIntegerEnv('ZKVM_GLOBAL_DAILY_LIMIT', env['ZKVM_GLOBAL_DAILY_LIMIT'], { min: 1 });
  validatePositiveIntegerEnv('ZKVM_GLOBAL_HOURLY_LIMIT', env['ZKVM_GLOBAL_HOURLY_LIMIT'], { min: 1 });

  const signedUrlTtlRaw = env['S3_SIGNED_URL_TTL_SECONDS']?.trim();
  if (signedUrlTtlRaw) {
    const signedUrlTtl = Number(signedUrlTtlRaw);
    if (!Number.isInteger(signedUrlTtl) || signedUrlTtl <= 0) {
      throw configError(
        'S3_SIGNED_URL_TTL_SECONDS',
        `Invalid S3_SIGNED_URL_TTL_SECONDS value: ${env['S3_SIGNED_URL_TTL_SECONDS']}. ` +
          'Expected a positive integer.',
      );
    }
  }

  const bundleSignedUrlTtlRaw = env['S3_BUNDLE_SIGNED_URL_TTL_SECONDS']?.trim();
  if (bundleSignedUrlTtlRaw) {
    const bundleSignedUrlTtl = Number(bundleSignedUrlTtlRaw);
    if (!Number.isInteger(bundleSignedUrlTtl) || bundleSignedUrlTtl <= 0) {
      throw configError(
        'S3_BUNDLE_SIGNED_URL_TTL_SECONDS',
        `Invalid S3_BUNDLE_SIGNED_URL_TTL_SECONDS value: ${env['S3_BUNDLE_SIGNED_URL_TTL_SECONDS']}. ` +
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

  const voteSecretRef = readTrimmedEnv(env, 'VOTE_SECRET_ENCRYPTION_KEY_REF');
  const turnstileSecretRef = readTrimmedEnv(env, 'TURNSTILE_SECRET_KEY_REF');
  const expectedOriginVerifyHeaderRef = readTrimmedEnv(env, 'EXPECTED_ORIGIN_VERIFY_HEADER_REF');

  if (usesDynamoSessionStore) {
    const expectedAccountId = validateAwsAccountId(env);
    if (profile.target.kind !== 'aws') {
      throw configError('RUNTIME_PROFILE', 'DynamoDB validation requires a target AWS runtime profile.');
    }
    const deploymentEnvironment = profile.target.deploymentEnvironment;
    requireDynamoDbRegion(env);
    assertDynamoDbEndpointAllowed(profile, env);
    const allowBareTableName = false;
    validateDynamoTableReference('DYNAMODB_SESSIONS_TABLE', env['DYNAMODB_SESSIONS_TABLE'], expectedAccountId, env, {
      allowBareTableName,
    });
    validateDynamoTableReference('DYNAMODB_VOTES_TABLE', env['DYNAMODB_VOTES_TABLE'], expectedAccountId, env, {
      allowBareTableName,
    });
    validateRuntimeReference(
      env,
      'SESSION_CAPABILITY_SECRET',
      capabilitySecretRef,
      expectedAccountId,
      deploymentEnvironment,
    );
    validateRuntimeReference(
      env,
      'VOTE_SECRET_ENCRYPTION_KEY',
      voteSecretRef,
      expectedAccountId,
      deploymentEnvironment,
    );
    validateRuntimeReference(env, 'TURNSTILE_SECRET_KEY', turnstileSecretRef, expectedAccountId, deploymentEnvironment);
    validateRuntimeReference(
      env,
      'EXPECTED_ORIGIN_VERIFY_HEADER',
      expectedOriginVerifyHeaderRef,
      expectedAccountId,
      deploymentEnvironment,
    );
    validateRuntimeReference(
      env,
      'LOG_IP_HASH_SALT',
      readTrimmedEnv(env, 'LOG_IP_HASH_SALT_REF'),
      expectedAccountId,
      deploymentEnvironment,
    );
    validateRuntimeReference(
      env,
      'SESSION_CAPABILITY_TTL_SECONDS',
      readTrimmedEnv(env, 'SESSION_CAPABILITY_TTL_SECONDS_REF'),
      expectedAccountId,
      deploymentEnvironment,
    );
  }

  if (usesDynamoSessionStore) {
    if (rateLimitStore !== 'dynamo') {
      throw configError('RUNTIME_PROFILE', 'The target AWS runtime profile requires the DynamoDB rate-limit store.');
    }
    const expectedAccountId = validateAwsAccountId(env);
    const allowBareTableName = false;
    validateDynamoTableReference('RATE_LIMIT_EVENTS_TABLE', env['RATE_LIMIT_EVENTS_TABLE'], expectedAccountId, env, {
      allowBareTableName,
    });
    validateDynamoTableReference(
      'RATE_LIMIT_COUNTERS_TABLE',
      env['RATE_LIMIT_COUNTERS_TABLE'],
      expectedAccountId,
      env,
      {
        allowBareTableName,
      },
    );
  }
}
