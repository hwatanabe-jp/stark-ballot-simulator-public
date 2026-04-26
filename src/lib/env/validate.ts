import { resolveRuntimeEnvMode } from '@/lib/env/runtimeMode';
import { isUnresolvedAmplifySecret } from '@/lib/env/amplifySecrets';
import { isImageIdVariant } from '@/lib/verification/image-id-policy.js';
import { parseVoteSecretKey } from '@/lib/security/voteSecretCipher';
import { isTruthyFlag } from '@/lib/utils/env';

const DISALLOWED_SESSION_CAPABILITY_SECRETS = new Set([
  'change-me-please-min-32-chars',
  'test-session-capability-secret-0123456789abcdef',
]);
const DISALLOWED_FINALIZE_CALLBACK_SECRETS = new Set([
  'change-me-please-min-32-chars',
  'test-finalize-callback-secret-0123456789abcdef',
]);

function validatePositiveIntegerEnv(name: string, rawValue: string | undefined, options: { min?: number } = {}): void {
  if (!rawValue) {
    return;
  }

  const min = options.min ?? 1;
  const value = Number(rawValue.trim());
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Invalid ${name} value: ${rawValue}. Expected an integer greater than or equal to ${min}.`);
  }
}

/**
 * Environment variable validation
 *
 * AppSync access uses IAM SigV4 with execution-role/default credentials.
 */

export function validateEnv(): void {
  const runtimeMode = resolveRuntimeEnvMode();
  if (isTruthyFlag(process.env.TURNSTILE_BYPASS) && runtimeMode !== 'non-production') {
    throw new Error('TURNSTILE_BYPASS must be disabled unless runtime is explicitly non-production');
  }

  const capabilitySecret = process.env.SESSION_CAPABILITY_SECRET?.trim();
  if (process.env.NODE_ENV !== 'test' && (!capabilitySecret || capabilitySecret.length < 32)) {
    throw new Error('SESSION_CAPABILITY_SECRET must be set to at least 32 characters');
  }
  if (process.env.NODE_ENV !== 'test' && isUnresolvedAmplifySecret(capabilitySecret)) {
    throw new Error('SESSION_CAPABILITY_SECRET was not resolved from Amplify Secrets');
  }
  if (process.env.NODE_ENV !== 'test' && capabilitySecret) {
    const lowered = capabilitySecret.toLowerCase();
    if (DISALLOWED_SESSION_CAPABILITY_SECRETS.has(lowered) || lowered.startsWith('change-me-please')) {
      throw new Error('SESSION_CAPABILITY_SECRET must be changed from placeholder/test values');
    }
  }

  // Optional by design:
  // production async flow updates state via finalize-callback-runner Lambda,
  // and /api/finalize/callback is excluded from lambda route registration.
  // When this secret is configured (e.g. local/manual callback route use), enforce strong values.
  const finalizeCallbackSecret = process.env.FINALIZE_CALLBACK_SECRET?.trim();
  if (process.env.NODE_ENV !== 'test' && finalizeCallbackSecret) {
    if (finalizeCallbackSecret.length < 32) {
      throw new Error('FINALIZE_CALLBACK_SECRET must be at least 32 characters when configured');
    }
    if (isUnresolvedAmplifySecret(finalizeCallbackSecret)) {
      throw new Error('FINALIZE_CALLBACK_SECRET was not resolved from Amplify Secrets');
    }
    const lowered = finalizeCallbackSecret.toLowerCase();
    if (DISALLOWED_FINALIZE_CALLBACK_SECRETS.has(lowered) || lowered.startsWith('change-me-please')) {
      throw new Error('FINALIZE_CALLBACK_SECRET must be changed from placeholder values');
    }
  }

  const capabilityTtlRaw = process.env.SESSION_CAPABILITY_TTL_SECONDS?.trim();
  if (capabilityTtlRaw) {
    const capabilityTtl = Number(capabilityTtlRaw);
    if (!Number.isInteger(capabilityTtl) || capabilityTtl <= 0) {
      throw new Error(
        `Invalid SESSION_CAPABILITY_TTL_SECONDS value: ${process.env.SESSION_CAPABILITY_TTL_SECONDS}. ` +
          'Expected a positive integer.',
      );
    }
  }

  const expectedImageIdVariant = process.env.EXPECTED_IMAGE_ID_VARIANT?.trim();
  if (expectedImageIdVariant && !isImageIdVariant(expectedImageIdVariant)) {
    throw new Error(
      `Invalid EXPECTED_IMAGE_ID_VARIANT value: ${process.env.EXPECTED_IMAGE_ID_VARIANT}. Expected "default" or "x86_64".`,
    );
  }

  validatePositiveIntegerEnv('MAX_SESSIONS', process.env.MAX_SESSIONS, { min: 1 });
  validatePositiveIntegerEnv('SESSION_CREATE_RATE_LIMIT', process.env.SESSION_CREATE_RATE_LIMIT, { min: 1 });
  validatePositiveIntegerEnv('SESSION_CREATE_RATE_LIMIT_WINDOW_MS', process.env.SESSION_CREATE_RATE_LIMIT_WINDOW_MS, {
    min: 1,
  });
  validatePositiveIntegerEnv(
    'SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS',
    process.env.SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS,
    { min: 1 },
  );
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT', process.env.VOTE_RATE_LIMIT, { min: 1 });
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT_WINDOW_MS', process.env.VOTE_RATE_LIMIT_WINDOW_MS, { min: 1 });
  validatePositiveIntegerEnv('VOTE_RATE_LIMIT_MAX_BUCKETS', process.env.VOTE_RATE_LIMIT_MAX_BUCKETS, { min: 1 });
  validatePositiveIntegerEnv('FINALIZE_CANCEL_RATE_LIMIT', process.env.FINALIZE_CANCEL_RATE_LIMIT, { min: 1 });
  validatePositiveIntegerEnv('FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS', process.env.FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS, {
    min: 1,
  });
  validatePositiveIntegerEnv(
    'FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS',
    process.env.FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS,
    { min: 1 },
  );
  validatePositiveIntegerEnv('FINALIZE_CALLBACK_BODY_LIMIT_BYTES', process.env.FINALIZE_CALLBACK_BODY_LIMIT_BYTES, {
    min: 1,
  });

  const signedUrlTtlRaw = process.env.S3_SIGNED_URL_TTL_SECONDS?.trim();
  if (signedUrlTtlRaw) {
    const signedUrlTtl = Number(signedUrlTtlRaw);
    if (!Number.isInteger(signedUrlTtl) || signedUrlTtl <= 0) {
      throw new Error(
        `Invalid S3_SIGNED_URL_TTL_SECONDS value: ${process.env.S3_SIGNED_URL_TTL_SECONDS}. ` +
          'Expected a positive integer.',
      );
    }
  }

  const bundleSignedUrlTtlRaw = process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS?.trim();
  if (bundleSignedUrlTtlRaw) {
    const bundleSignedUrlTtl = Number(bundleSignedUrlTtlRaw);
    if (!Number.isInteger(bundleSignedUrlTtl) || bundleSignedUrlTtl <= 0) {
      throw new Error(
        `Invalid S3_BUNDLE_SIGNED_URL_TTL_SECONDS value: ${process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS}. ` +
          'Expected a positive integer.',
      );
    }
    if (bundleSignedUrlTtl > 900) {
      throw new Error('S3_BUNDLE_SIGNED_URL_TTL_SECONDS must be 900 or less for security hardening.');
    }
  }

  // Skip Amplify Data validation when using mock store (CI/tests)
  const useMockStore = process.env.USE_MOCK_STORE === 'true' || process.env.NODE_ENV === 'test';
  const rateLimitStore = process.env.RATE_LIMIT_STORE?.trim().toLowerCase();

  if (!useMockStore && process.env.USE_AMPLIFY_DATA === 'false') {
    throw new Error(
      'USE_AMPLIFY_DATA=false is incompatible with USE_MOCK_STORE=false. Set USE_MOCK_STORE=true to use a mock store explicitly.',
    );
  }

  if (!useMockStore && !parseVoteSecretKey(process.env.VOTE_SECRET_ENCRYPTION_KEY)) {
    throw new Error('VOTE_SECRET_ENCRYPTION_KEY must be set to a valid 32-byte key (hex or base64).');
  }

  if (rateLimitStore && rateLimitStore !== 'memory' && rateLimitStore !== 'dynamo') {
    throw new Error(`Invalid RATE_LIMIT_STORE value: ${process.env.RATE_LIMIT_STORE}. Expected "memory" or "dynamo".`);
  }

  if (!useMockStore) {
    const required = ['AMPLIFY_DATA_ENDPOINT', 'AMPLIFY_DATA_API_ID'];

    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(', ')}\n` +
          'See .env.local.example for configuration template.',
      );
    }
  }

  if (!useMockStore && rateLimitStore === 'dynamo') {
    const missingTables = ['RATE_LIMIT_EVENTS_TABLE', 'RATE_LIMIT_COUNTERS_TABLE'].filter((key) => !process.env[key]);
    if (missingTables.length > 0) {
      throw new Error(
        `Missing required rate limit table environment variables: ${missingTables.join(', ')}\n` +
          'DynamoDB rate limiting requires both tables to be configured.',
      );
    }
  }
}
