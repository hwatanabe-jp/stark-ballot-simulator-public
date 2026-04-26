import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '@/lib/env/validate';

const originalEnv = { ...process.env };
const VALID_SESSION_CAPABILITY_SECRET = 'prod-session-capability-secret-0123456789abcdef';
const VALID_FINALIZE_CALLBACK_SECRET = 'prod-finalize-callback-secret-0123456789abcdef';
const AMPLIFY_RUNTIME_SECRET_PLACEHOLDER = '<value will be resolved during runtime>';

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

describe('validateEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
    process.env.USE_MOCK_STORE = 'true';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('rejects production startup when TURNSTILE_BYPASS is enabled', () => {
    vi.stubEnv('AWS_BRANCH', 'main');
    process.env.TURNSTILE_BYPASS = '1';

    expect(() => validateEnv()).toThrow(
      'TURNSTILE_BYPASS must be disabled unless runtime is explicitly non-production',
    );
  });

  it('allows startup when TURNSTILE_BYPASS is disabled in production', () => {
    vi.stubEnv('AWS_BRANCH', 'main');
    process.env.TURNSTILE_BYPASS = '0';
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows bypass on develop branch even when NODE_ENV is production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AWS_BRANCH', 'develop');
    process.env.TURNSTILE_BYPASS = '1';
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects bypass when runtime classification is unknown', () => {
    vi.stubEnv('AWS_BRANCH', '');
    vi.stubEnv('AMPLIFY_BRANCH', '');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
    vi.stubEnv('ENV_NAME', '');
    process.env.TURNSTILE_BYPASS = '1';

    expect(() => validateEnv()).toThrow(
      'TURNSTILE_BYPASS must be disabled unless runtime is explicitly non-production',
    );
  });

  it('does not require COGNITO_IDENTITY_POOL_ID for Amplify Data access', () => {
    process.env.USE_MOCK_STORE = 'false';
    process.env.RATE_LIMIT_STORE = 'memory';
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql';
    process.env.AMPLIFY_DATA_API_ID = 'example-api-id';
    process.env.VOTE_SECRET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;
    delete process.env.COGNITO_IDENTITY_POOL_ID;

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects startup when VOTE_SECRET_ENCRYPTION_KEY is missing outside mock store', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.USE_MOCK_STORE = 'false';
    process.env.RATE_LIMIT_STORE = 'memory';
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql';
    process.env.AMPLIFY_DATA_API_ID = 'example-api-id';
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;
    delete process.env.VOTE_SECRET_ENCRYPTION_KEY;

    expect(() => validateEnv()).toThrow('VOTE_SECRET_ENCRYPTION_KEY must be set to a valid 32-byte key');
  });

  it('rejects USE_AMPLIFY_DATA=false outside mock store', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.USE_MOCK_STORE = 'false';
    process.env.USE_AMPLIFY_DATA = 'false';
    process.env.RATE_LIMIT_STORE = 'memory';
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql';
    process.env.AMPLIFY_DATA_API_ID = 'example-api-id';
    process.env.VOTE_SECRET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).toThrow('USE_AMPLIFY_DATA=false is incompatible with USE_MOCK_STORE=false');
  });

  it('rejects startup when SESSION_CAPABILITY_SECRET is missing', () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must be set to at least 32 characters');
  });

  it('rejects invalid SESSION_CAPABILITY_TTL_SECONDS', () => {
    process.env.SESSION_CAPABILITY_TTL_SECONDS = 'abc';

    expect(() => validateEnv()).toThrow('Invalid SESSION_CAPABILITY_TTL_SECONDS value: abc.');
  });

  it('rejects non-integer SESSION_CAPABILITY_TTL_SECONDS', () => {
    process.env.SESSION_CAPABILITY_TTL_SECONDS = '0.5';

    expect(() => validateEnv()).toThrow('Invalid SESSION_CAPABILITY_TTL_SECONDS value: 0.5.');
  });

  it('rejects invalid MAX_SESSIONS value', () => {
    process.env.MAX_SESSIONS = 'abc';

    expect(() => validateEnv()).toThrow('Invalid MAX_SESSIONS value: abc.');
  });

  it('rejects MAX_SESSIONS less than 1', () => {
    process.env.MAX_SESSIONS = '0';

    expect(() => validateEnv()).toThrow('Invalid MAX_SESSIONS value: 0.');
  });

  it('rejects placeholder SESSION_CAPABILITY_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SESSION_CAPABILITY_SECRET = 'change-me-please-min-32-chars-and-should-be-replaced';

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must be changed from placeholder/test values');
  });

  it('rejects known test SESSION_CAPABILITY_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SESSION_CAPABILITY_SECRET = 'test-session-capability-secret-0123456789abcdef';

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must be changed from placeholder/test values');
  });

  it('rejects unresolved Amplify secret placeholder for SESSION_CAPABILITY_SECRET', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SESSION_CAPABILITY_SECRET = AMPLIFY_RUNTIME_SECRET_PLACEHOLDER;

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET was not resolved from Amplify Secrets');
  });

  it('rejects weak FINALIZE_CALLBACK_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;
    process.env.FINALIZE_CALLBACK_SECRET = 'short-secret';

    expect(() => validateEnv()).toThrow('FINALIZE_CALLBACK_SECRET must be at least 32 characters when configured');
  });

  it('rejects unresolved Amplify placeholder for FINALIZE_CALLBACK_SECRET', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;
    process.env.FINALIZE_CALLBACK_SECRET = AMPLIFY_RUNTIME_SECRET_PLACEHOLDER;

    expect(() => validateEnv()).toThrow('FINALIZE_CALLBACK_SECRET was not resolved from Amplify Secrets');
  });

  it('rejects placeholder FINALIZE_CALLBACK_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;
    process.env.FINALIZE_CALLBACK_SECRET = 'change-me-please-random-secret-value';

    expect(() => validateEnv()).toThrow('FINALIZE_CALLBACK_SECRET must be changed from placeholder values');
  });

  it('allows strong FINALIZE_CALLBACK_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;
    process.env.FINALIZE_CALLBACK_SECRET = VALID_FINALIZE_CALLBACK_SECRET;

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows missing FINALIZE_CALLBACK_SECRET in async mode', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;
    process.env.FINALIZE_ASYNC_MODE = 'true';
    delete process.env.FINALIZE_CALLBACK_SECRET;

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects invalid S3_SIGNED_URL_TTL_SECONDS', () => {
    process.env.S3_SIGNED_URL_TTL_SECONDS = 'abc';

    expect(() => validateEnv()).toThrow('Invalid S3_SIGNED_URL_TTL_SECONDS value: abc.');
  });

  it('rejects invalid S3_BUNDLE_SIGNED_URL_TTL_SECONDS', () => {
    process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS = 'abc';

    expect(() => validateEnv()).toThrow('Invalid S3_BUNDLE_SIGNED_URL_TTL_SECONDS value: abc.');
  });

  it('rejects S3_BUNDLE_SIGNED_URL_TTL_SECONDS above hardening cap', () => {
    process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS = '901';

    expect(() => validateEnv()).toThrow('S3_BUNDLE_SIGNED_URL_TTL_SECONDS must be 900 or less');
  });
});
