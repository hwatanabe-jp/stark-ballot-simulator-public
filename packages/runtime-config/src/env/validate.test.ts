import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnv as validateResolvedEnv } from '@stark-ballot/runtime-config/env/validate';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';
import { resolveRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { localRuntimeProfile, targetRuntimeProfile, targetRuntimeProfileEnv } from './__tests__/runtimeProfileFixtures';

const originalEnv = { ...process.env };
const VALID_SESSION_CAPABILITY_SECRET = 'prod-session-capability-secret-0123456789abcdef';
const VALID_FINALIZE_CALLBACK_SECRET = 'prod-finalization-writer-secret-0123456789abcdef';
const VALID_VOTE_SECRET_ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER = '<value will be resolved during runtime>';
const TARGET_ACCOUNT_ID = '123456789012';
const TARGET_REGION = 'ap-northeast-1';
const TARGET_RUNTIME_REFERENCES = {
  develop: {
    SESSION_CAPABILITY_SECRET_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret',
    VOTE_SECRET_ENCRYPTION_KEY_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/vote-secret-encryption-key',
    SESSION_CAPABILITY_TTL_SECONDS_REF:
      '/stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds',
    TURNSTILE_SECRET_KEY_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/turnstile-secret-key',
    EXPECTED_ORIGIN_VERIFY_HEADER_REF:
      '/stark-ballot-simulator/stark-dev/develop/app/secrets/expected-origin-verify-header',
    LOG_IP_HASH_SALT_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/log-ip-hash-salt',
  },
  main: {
    SESSION_CAPABILITY_SECRET_REF: '/stark-ballot-simulator/stark-prod/main/app/secrets/session-capability-secret',
    VOTE_SECRET_ENCRYPTION_KEY_REF: '/stark-ballot-simulator/stark-prod/main/app/secrets/vote-secret-encryption-key',
    SESSION_CAPABILITY_TTL_SECONDS_REF:
      '/stark-ballot-simulator/stark-prod/main/app/config/session-capability-ttl-seconds',
    TURNSTILE_SECRET_KEY_REF: '/stark-ballot-simulator/stark-prod/main/app/secrets/turnstile-secret-key',
    EXPECTED_ORIGIN_VERIFY_HEADER_REF:
      '/stark-ballot-simulator/stark-prod/main/app/secrets/expected-origin-verify-header',
    LOG_IP_HASH_SALT_REF: '/stark-ballot-simulator/stark-prod/main/app/secrets/log-ip-hash-salt',
  },
} as const;
const EXPECTED_SESSION_SECRET_REFERENCE_MESSAGE =
  'SESSION_CAPABILITY_SECRET_REF must reference /stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret';
const EXPECTED_SESSION_TTL_REFERENCE_MESSAGE =
  'SESSION_CAPABILITY_TTL_SECONDS_REF must reference /stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds';
const EXPECTED_VOTE_SECRET_REFERENCE_MESSAGE =
  'VOTE_SECRET_ENCRYPTION_KEY_REF must reference /stark-ballot-simulator/stark-dev/develop/app/secrets/vote-secret-encryption-key';
let activeProfile = localRuntimeProfile();

function validateEnv(): void {
  validateResolvedEnv(activeProfile, process.env);
}

function dynamoTableArn(tableName: string): string {
  return `arn:aws:dynamodb:${TARGET_REGION}:${TARGET_ACCOUNT_ID}:table/${tableName}`;
}

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
    activeProfile = localRuntimeProfile();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('validates an injected local profile without process-wide selector state', () => {
    expect(() => validateResolvedEnv(localRuntimeProfile(), {})).not.toThrow();
  });

  it('applies target requirements from the injected target profile', () => {
    const env = targetRuntimeProfileEnv();
    env['LOG_IP_HASH_SALT'] = 'resolved-target-log-hash-salt';
    env['EXPECTED_ORIGIN_VERIFY_HEADER'] = 'resolved-origin-verify-header-0123456789abcdef';
    env['LOG_FORMAT'] = 'text';

    expect(() => validateResolvedEnv(targetRuntimeProfile(), env)).toThrow(
      'LOG_FORMAT=json is required for the target AWS runtime profile.',
    );
  });

  it.each([
    ['local-demo', undefined],
    ['static-mock-e2e', undefined],
    ['local-proof-development', VALID_SESSION_CAPABILITY_SECRET],
    ['local-proof-production', VALID_SESSION_CAPABILITY_SECRET],
  ] as const)('validates the supported local profile %s', (profileName, capabilitySecret) => {
    activeProfile = localRuntimeProfile(profileName);
    if (capabilitySecret) {
      process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    }

    expect(() => validateEnv()).not.toThrow();
  });

  function configureDynamoRuntimeEnv(): void {
    activeProfile = targetRuntimeProfile();
    Object.assign(process.env, targetRuntimeProfileEnv());
    process.env['AWS_REGION'] = TARGET_REGION;
    process.env['AWS_ACCOUNT_ID'] = TARGET_ACCOUNT_ID;
    process.env['DYNAMODB_SESSIONS_TABLE'] = dynamoTableArn('stark-ballot-simulator-develop-sessions');
    process.env['DYNAMODB_VOTES_TABLE'] = dynamoTableArn('stark-ballot-simulator-develop-votes');
    process.env['RATE_LIMIT_EVENTS_TABLE'] = dynamoTableArn('stark-ballot-simulator-develop-rate-limit-events');
    process.env['RATE_LIMIT_COUNTERS_TABLE'] = dynamoTableArn('stark-ballot-simulator-develop-rate-limit-counters');
    delete process.env['SESSION_CAPABILITY_SECRET'];
    delete process.env['SESSION_CAPABILITY_TTL_SECONDS'];
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
    Object.assign(process.env, TARGET_RUNTIME_REFERENCES.develop);
    process.env['TURNSTILE_ALLOWED_HOSTNAMES'] = 'develop.stark-ballot-sim.hwatanabe.dev';
    process.env['TRUSTED_PROXY'] = 'api-gateway';
    process.env['LOG_IP_HASH_SALT'] = 'resolved-target-log-hash-salt';
    process.env['LOG_FORMAT'] = 'json';
    process.env['DEPLOYMENT_ID'] = `dep_${'1'.repeat(32)}`;
    process.env['APP_SOURCE_SHA'] = '2'.repeat(40);
    process.env['DEPLOY_MODE'] = 'normal';
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = 'resolved-origin-verify-header-0123456789abcdef';
  }

  function configureTargetAwsRuntimeEnv(): void {
    activeProfile = targetRuntimeProfile();
    configureDynamoRuntimeEnv();
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
    process.env['PROVER_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-prover-work';
    process.env['VERIFICATION_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-verification-work';
    process.env['PROVER_STATE_MACHINE_ARN'] =
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization';
    process.env['VERIFICATION_WORKER_FUNCTION_NAME'] = 'stark-ballot-simulator-stark-dev-develop-verification-worker';
    delete process.env['VERIFIER_SERVICE_RUNNER_FUNCTION_NAME'];
    delete process.env['VERIFIER_SERVICE_RUNNER_ARN'];
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';
    process.env['VERIFIER_PUBLIC_BASE_URL'] = 'https://develop.stark-ballot-sim.hwatanabe.dev';
    process.env['EXPECTED_IMAGE_ID'] = '0x' + '1'.repeat(64);
    process.env['LOG_IP_HASH_SALT'] = 'resolved-target-log-hash-salt';
    process.env['LOG_FORMAT'] = 'json';
    process.env['DEPLOYMENT_ID'] = `dep_${'1'.repeat(32)}`;
    process.env['APP_SOURCE_SHA'] = '2'.repeat(40);
    process.env['DEPLOY_MODE'] = 'normal';
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = 'resolved-origin-verify-header-0123456789abcdef';
  }

  it('allows target DynamoDB runtime without DynamoDB identifiers', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['AMPLIFY_DATA_ENDPOINT'];
    delete process.env['AMPLIFY_DATA_API_ID'];
    delete process.env['COGNITO_IDENTITY_POOL_ID'];

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows complete target AWS runtime configuration', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();

    expect(() => validateEnv()).not.toThrow();
  });

  it('applies the same target security validation to the quiesced profile', () => {
    const env = {
      ...targetRuntimeProfileEnv(),
      RUNTIME_PROFILE: 'target-aws-async-quiesced',
    };
    const profile = resolveRuntimeProfile(env);
    Object.assign(env, {
      LOG_IP_HASH_SALT: 'resolved-target-log-hash-salt',
      LOG_FORMAT: 'json',
      DEPLOYMENT_ID: `dep_${'1'.repeat(32)}`,
      APP_SOURCE_SHA: '2'.repeat(40),
      DEPLOY_MODE: 'normal',
      EXPECTED_ORIGIN_VERIFY_HEADER: 'resolved-origin-verify-header-0123456789abcdef',
    });

    expect(() => validateResolvedEnv(profile, env)).not.toThrow();
  });

  it.each([
    ['PROVER_WORK_QUEUE_URL', 'not-an-sqs-url'],
    ['VERIFICATION_WORK_QUEUE_URL', 'not-an-sqs-url'],
    ['PROVER_STATE_MACHINE_ARN', 'not-a-state-machine-arn'],
    ['EXPECTED_IMAGE_ID', 'not-an-image-id'],
    ['DYNAMODB_SESSIONS_TABLE', 'legacy-amplify-table'],
    ['SESSION_CAPABILITY_SECRET_REF', '/unexpected/secret/reference'],
    ['EXPECTED_ORIGIN_VERIFY_HEADER', '/unexpected/reference'],
  ] as const)('throws a typed exact-name error when target %s is invalid', (name, value) => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env[name] = value;

    let failure: unknown;
    try {
      validateEnv();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeConfigValidationError);
    expect((failure as RuntimeConfigValidationError).invalidNames).toEqual([name]);
  });

  it('requires LOG_IP_HASH_SALT_REF in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['LOG_IP_HASH_SALT_REF'];

    expect(() => validateEnv()).toThrow('LOG_IP_HASH_SALT_REF must be set for the target AWS runtime profile.');
  });

  it('requires LOG_IP_HASH_SALT to be resolved in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['LOG_IP_HASH_SALT'];

    expect(() => validateEnv()).toThrow(
      'LOG_IP_HASH_SALT must be resolved from LOG_IP_HASH_SALT_REF for the target AWS runtime profile.',
    );
  });

  it('rejects the public local-development log hash salt in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['LOG_IP_HASH_SALT'] = 'stark-ballot-log-salt';

    expect(() => validateEnv()).toThrow(
      'LOG_IP_HASH_SALT must not use the public local-development default for the target AWS runtime profile.',
    );
  });

  it.each([undefined, 'text'])('requires target LOG_FORMAT=json instead of %s', (logFormat) => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    if (logFormat === undefined) {
      delete process.env['LOG_FORMAT'];
    } else {
      process.env['LOG_FORMAT'] = logFormat;
    }

    expect(() => validateEnv()).toThrow('LOG_FORMAT=json is required for the target AWS runtime profile.');
  });

  it('requires EXPECTED_ORIGIN_VERIFY_HEADER_REF in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['EXPECTED_ORIGIN_VERIFY_HEADER_REF'];

    expect(() => validateEnv()).toThrow(
      'EXPECTED_ORIGIN_VERIFY_HEADER_REF must be set for the target AWS runtime profile.',
    );
  });

  it('requires EXPECTED_ORIGIN_VERIFY_HEADER to be resolved in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['EXPECTED_ORIGIN_VERIFY_HEADER'];

    expect(() => validateEnv()).toThrow(
      'EXPECTED_ORIGIN_VERIFY_HEADER must be resolved from EXPECTED_ORIGIN_VERIFY_HEADER_REF for the target AWS runtime profile.',
    );
  });

  it('requires no secondary session-create selector after target profile admission', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();

    expect(() => validateEnv()).not.toThrow();
  });

  it('keeps local non-target runtime compatible with missing LOG_IP_HASH_SALT', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;
    delete process.env['LOG_IP_HASH_SALT'];
    delete process.env['LOG_IP_HASH_SALT_REF'];

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows the verification worker as a target Lambda ARN', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['VERIFICATION_WORKER_FUNCTION_NAME'] =
      'arn:aws:lambda:ap-northeast-1:123456789012:function:stark-ballot-simulator-stark-dev-develop-verification-worker';

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows the protected-production target runtime naming contract without AWS mutation', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'main';
    Object.assign(process.env, TARGET_RUNTIME_REFERENCES.main);
    process.env['PROVER_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-prod-main-prover-work';
    process.env['VERIFICATION_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-prod-main-verification-work';
    process.env['PROVER_STATE_MACHINE_ARN'] =
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-prod-main-finalization';
    process.env['VERIFICATION_WORKER_FUNCTION_NAME'] = 'stark-ballot-simulator-stark-prod-main-verification-worker';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-prod-main-proof-artifacts';
    activeProfile = targetRuntimeProfile('main');

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects develop runtime config reference paths in the protected-production target runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'main';
    process.env['PROVER_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-prod-main-prover-work';
    process.env['VERIFICATION_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-prod-main-verification-work';
    process.env['PROVER_STATE_MACHINE_ARN'] =
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-prod-main-finalization';
    process.env['VERIFICATION_WORKER_FUNCTION_NAME'] = 'stark-ballot-simulator-stark-prod-main-verification-worker';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-prod-main-proof-artifacts';
    activeProfile = targetRuntimeProfile('main');

    expect(() => validateEnv()).toThrow(
      'SESSION_CAPABILITY_SECRET_REF must reference /stark-ballot-simulator/stark-prod/main/app/secrets/session-capability-secret',
    );
  });

  it('rejects the old verifier runner env as a verification-worker locator', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['VERIFICATION_WORKER_FUNCTION_NAME'];
    process.env['VERIFIER_SERVICE_RUNNER_FUNCTION_NAME'] =
      'stark-ballot-simulator-stark-dev-develop-verification-worker';

    expect(() => validateEnv()).toThrow(
      'VERIFICATION_WORKER_FUNCTION_NAME must be set for the target AWS runtime profile.',
    );
  });

  it('does not derive target storage behavior from NODE_ENV', () => {
    vi.stubEnv('NODE_ENV', 'test');
    configureTargetAwsRuntimeEnv();

    expect(() => validateEnv()).not.toThrow();
  });

  it('validates after async finalization composition is resolved by the profile', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();

    expect(activeProfile.finalization.mode).toBe('async');
    expect(() => validateEnv()).not.toThrow();
  });

  it('validates after S3 artifact composition is resolved by the profile', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();

    expect(activeProfile.artifacts.kind).toBe('s3');
    expect(() => validateEnv()).not.toThrow();
  });

  it.each([
    ['PROVER_WORK_QUEUE_URL', 'PROVER_WORK_QUEUE_URL must be set for the target AWS runtime profile'],
    ['VERIFICATION_WORK_QUEUE_URL', 'VERIFICATION_WORK_QUEUE_URL must be set for the target AWS runtime profile'],
    ['PROVER_STATE_MACHINE_ARN', 'PROVER_STATE_MACHINE_ARN must be set for the target AWS runtime profile'],
    [
      'VERIFICATION_WORKER_FUNCTION_NAME',
      'VERIFICATION_WORKER_FUNCTION_NAME must be set for the target AWS runtime profile',
    ],
    ['S3_PROOF_BUCKET', 'S3_PROOF_BUCKET must be set for the target AWS runtime profile'],
    ['S3_PROOF_PREFIX', 'S3_PROOF_PREFIX must be set for the target AWS runtime profile'],
    ['VERIFIER_PUBLIC_BASE_URL', 'VERIFIER_PUBLIC_BASE_URL must be set for the target AWS runtime profile'],
    ['EXPECTED_IMAGE_ID', 'EXPECTED_IMAGE_ID must be set for the target AWS runtime profile'],
  ])('rejects incomplete target AWS runtime config for %s', (name, expectedMessage) => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env[name];

    expect(() => validateEnv()).toThrow(expectedMessage);
  });

  it.each([
    ['PROVER_WORK_QUEUE_URL', 'not-a-url', 'PROVER_WORK_QUEUE_URL must be a valid SQS queue URL'],
    [
      'PROVER_WORK_QUEUE_URL',
      'https://sqs.us-east-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-prover-work',
      'PROVER_WORK_QUEUE_URL region must match AWS_REGION/AWS_DEFAULT_REGION',
    ],
    [
      'PROVER_WORK_QUEUE_URL',
      'https://sqs.ap-northeast-1.amazonaws.com/999999999999/stark-ballot-simulator-stark-dev-develop-prover-work',
      'PROVER_WORK_QUEUE_URL account must match AWS_ACCOUNT_ID',
    ],
    [
      'PROVER_WORK_QUEUE_URL',
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/ProverWorkQueue',
      'PROVER_WORK_QUEUE_URL must reference the Terraform-managed target prover work queue',
    ],
    ['VERIFICATION_WORK_QUEUE_URL', 'not-a-url', 'VERIFICATION_WORK_QUEUE_URL must be a valid SQS queue URL'],
    [
      'VERIFICATION_WORK_QUEUE_URL',
      'https://sqs.us-east-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-verification-work',
      'VERIFICATION_WORK_QUEUE_URL region must match AWS_REGION/AWS_DEFAULT_REGION',
    ],
    [
      'VERIFICATION_WORK_QUEUE_URL',
      'https://sqs.ap-northeast-1.amazonaws.com/999999999999/stark-ballot-simulator-stark-dev-develop-verification-work',
      'VERIFICATION_WORK_QUEUE_URL account must match AWS_ACCOUNT_ID',
    ],
    [
      'VERIFICATION_WORK_QUEUE_URL',
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/VerificationWorkQueue',
      'VERIFICATION_WORK_QUEUE_URL must reference the Terraform-managed target verification work queue',
    ],
    [
      'PROVER_STATE_MACHINE_ARN',
      'arn:aws:states:us-east-1:123456789012:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization',
      'PROVER_STATE_MACHINE_ARN region must match AWS_REGION/AWS_DEFAULT_REGION',
    ],
    [
      'PROVER_STATE_MACHINE_ARN',
      'arn:aws:states:ap-northeast-1:999999999999:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization',
      'PROVER_STATE_MACHINE_ARN account must match AWS_ACCOUNT_ID',
    ],
    [
      'PROVER_STATE_MACHINE_ARN',
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:legacy-finalization',
      'PROVER_STATE_MACHINE_ARN must reference Terraform-managed target runtime resources',
    ],
    [
      'VERIFICATION_WORKER_FUNCTION_NAME',
      'arn:aws:lambda:us-east-1:123456789012:function:stark-ballot-simulator-stark-dev-develop-verification-worker',
      'VERIFICATION_WORKER_FUNCTION_NAME region must match AWS_REGION/AWS_DEFAULT_REGION',
    ],
    [
      'VERIFICATION_WORKER_FUNCTION_NAME',
      'arn:aws:lambda:ap-northeast-1:999999999999:function:stark-ballot-simulator-stark-dev-develop-verification-worker',
      'VERIFICATION_WORKER_FUNCTION_NAME account must match AWS_ACCOUNT_ID',
    ],
    [
      'VERIFICATION_WORKER_FUNCTION_NAME',
      'verification-worker',
      'VERIFICATION_WORKER_FUNCTION_NAME must reference the Terraform-managed verification worker',
    ],
    [
      'S3_PROOF_BUCKET',
      'stark-ballot-simulator-proof-bundles-develop',
      'S3_PROOF_BUCKET must reference Terraform-managed target runtime resources',
    ],
    [
      'S3_PROOF_BUCKET',
      'stark-ballot-simulator-legacy-proof-artifacts',
      'S3_PROOF_BUCKET must reference Terraform-managed target runtime resources',
    ],
    [
      'S3_PROOF_BUCKET',
      'stark-ballot-simulator-stark-dev-main-proof-artifacts',
      'S3_PROOF_BUCKET must reference the Terraform-managed target proof/artifact bucket',
    ],
    ['S3_PROOF_PREFIX', 'public/', 'S3_PROOF_PREFIX must match the Terraform-managed target proof/artifact prefix'],
  ])('rejects invalid target runtime reference %s=%s', (name, value, expectedMessage) => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env[name] = value;

    expect(() => validateEnv()).toThrow(expectedMessage);
  });

  it('rejects target verifier public base URLs with path, query, or fragment', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['VERIFIER_PUBLIC_BASE_URL'] = 'https://develop.stark-ballot-sim.hwatanabe.dev/api?x=1#frag';

    expect(() => validateEnv()).toThrow(
      'VERIFIER_PUBLIC_BASE_URL must not include a path, query, or fragment for the target AWS runtime profile',
    );
  });

  it('rejects target verifier public base URLs using plain HTTP', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['VERIFIER_PUBLIC_BASE_URL'] = 'http://develop.stark-ballot-sim.hwatanabe.dev';

    expect(() => validateEnv()).toThrow(
      'VERIFIER_PUBLIC_BASE_URL must be a valid https URL for the target AWS runtime profile.',
    );
  });

  it('does not apply target HTTPS verifier URL validation outside target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env['VERIFIER_PUBLIC_BASE_URL'] = 'http://localhost:3000';

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects raw SESSION_CAPABILITY_SECRET values in target runtime even with an approved reference', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).toThrow(
      'SESSION_CAPABILITY_SECRET must not be set directly for the target AWS runtime profile; use SESSION_CAPABILITY_SECRET_REF',
    );
  });

  it('rejects raw SESSION_CAPABILITY_TTL_SECONDS values in target runtime even with an approved reference', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '3600';

    expect(() => validateEnv()).toThrow(
      'SESSION_CAPABILITY_TTL_SECONDS must not be set directly for the target AWS runtime profile; use SESSION_CAPABILITY_TTL_SECONDS_REF',
    );
  });

  it('rejects raw VOTE_SECRET_ENCRYPTION_KEY values in target runtime even with an approved reference', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['VOTE_SECRET_ENCRYPTION_KEY'] = VALID_VOTE_SECRET_ENCRYPTION_KEY;

    expect(() => validateEnv()).toThrow(
      'VOTE_SECRET_ENCRYPTION_KEY must not be set directly for the target AWS runtime profile; use VOTE_SECRET_ENCRYPTION_KEY_REF',
    );
  });

  it('rejects raw TURNSTILE_SECRET_KEY values in target runtime even with an approved reference', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['TURNSTILE_SECRET_KEY'] = 'live-secret';

    expect(() => validateEnv()).toThrow(
      'TURNSTILE_SECRET_KEY must not be set directly for the target AWS runtime profile; use TURNSTILE_SECRET_KEY_REF',
    );
  });

  it('rejects a missing VOTE_SECRET_ENCRYPTION_KEY reference for the target AWS profile', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'];

    expect(() => validateEnv()).toThrow('VOTE_SECRET_ENCRYPTION_KEY_REF must be set');
  });

  it('rejects a missing TURNSTILE_SECRET_KEY reference for the target AWS profile', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['TURNSTILE_SECRET_KEY_REF'];

    expect(() => validateEnv()).toThrow('TURNSTILE_SECRET_KEY_REF must be set');
  });

  it('rejects target runtime without an explicit Turnstile hostname allowlist', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['TURNSTILE_ALLOWED_HOSTNAMES'];

    expect(() => validateEnv()).toThrow('TURNSTILE_ALLOWED_HOSTNAMES must be set for target runtime');
  });

  it('rejects target DynamoDB runtime without session and vote table names', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['DYNAMODB_SESSIONS_TABLE'];

    expect(() => validateEnv()).toThrow('DYNAMODB_SESSIONS_TABLE must be set');
  });

  it('rejects target DynamoDB runtime without explicit AWS account identity', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['AWS_ACCOUNT_ID'];

    expect(() => validateEnv()).toThrow('AWS_ACCOUNT_ID must be set for target DynamoDB runtime access');
  });

  it('rejects target DynamoDB runtime with wrong-account table ARNs', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_SESSIONS_TABLE'] =
      'arn:aws:dynamodb:ap-northeast-1:999999999999:table/stark-ballot-simulator-develop-sessions';

    expect(() => validateEnv()).toThrow('DYNAMODB_SESSIONS_TABLE account must match AWS_ACCOUNT_ID');
  });

  it('rejects bare target table names outside explicit local/test DynamoDB endpoint exceptions', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_SESSIONS_TABLE'] = 'stark-ballot-simulator-develop-sessions';

    expect(() => validateEnv()).toThrow(
      'DYNAMODB_SESSIONS_TABLE must be a DynamoDB table ARN outside explicit local/test DynamoDB endpoint exceptions',
    );
  });

  it('rejects loopback endpoints and bare table names for a target profile', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';
    process.env['DYNAMODB_SESSIONS_TABLE'] = 'stark-ballot-simulator-local-sessions';
    process.env['DYNAMODB_VOTES_TABLE'] = 'stark-ballot-simulator-local-votes';
    process.env['RATE_LIMIT_EVENTS_TABLE'] = 'stark-ballot-simulator-local-rate-limit-events';
    process.env['RATE_LIMIT_COUNTERS_TABLE'] = 'stark-ballot-simulator-local-rate-limit-counters';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('uses the rate-limit store already resolved by the target profile', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();

    expect(activeProfile.rateLimit.store).toBe('dynamo');
    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects legacy Amplify table references for target DynamoDB runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_VOTES_TABLE'] = 'amplify-legacy-votes';

    expect(() => validateEnv()).toThrow('DYNAMODB_VOTES_TABLE must not reference legacy Amplify tables');
  });

  it('rejects DynamoDB endpoint override in production runtime', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'production');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('rejects DynamoDB endpoint override on develop without an explicit local exception', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it.each(['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000'])(
    'rejects local DynamoDB endpoint override for a target profile: %s',
    (endpoint) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
      configureDynamoRuntimeEnv();
      process.env['DYNAMODB_ENDPOINT'] = endpoint;

      expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
    },
  );

  it('rejects local DynamoDB endpoint exception for legacy Lambda names that contain development tokens', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'amplify-starkballotsimulator-dev-honoapi-lambda');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('rejects local DynamoDB endpoint exception when ENV_NAME=develop is paired with an untrusted Lambda name', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', 'develop');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'amplify-starkballotsimulator-dev-honoapi-lambda');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('does not let ENV_NAME enable a target-profile DynamoDB endpoint exception', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('AWS_EXECUTION_ENV', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
    vi.stubEnv('ENV_NAME', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('does not let a Lambda name enable a target-profile DynamoDB endpoint exception', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'stark-ballot-simulator-stark-dev-develop-public-api');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('does not let deployment markers enable a target-profile DynamoDB endpoint exception', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'custom-prod-worker');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('rejects non-local DynamoDB endpoint override even with an explicit local exception', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'https://dynamodb.ap-northeast-1.amazonaws.com';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT must use a local loopback host');
  });

  it('rejects malformed DynamoDB endpoint override values', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'not a url';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT must be a valid URL');
  });

  it('allows target runtime config validation with non-secret references instead of raw secret values', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['SESSION_CAPABILITY_SECRET'];
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
    process.env['SESSION_CAPABILITY_TTL_SECONDS_REF'] =
      'arn:aws:ssm:ap-northeast-1:123456789012:parameter/stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds';

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects absolute target reference paths outside the adopted namespace', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['SESSION_CAPABILITY_SECRET_REF'] = '/some/other/app/secrets/session-capability-secret';

    expect(() => validateEnv()).toThrow(EXPECTED_SESSION_SECRET_REFERENCE_MESSAGE);
  });

  it('rejects target reference paths with the wrong category', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['SESSION_CAPABILITY_SECRET_REF'] =
      '/stark-ballot-simulator/stark-dev/develop/app/config/session-capability-secret';

    expect(() => validateEnv()).toThrow(EXPECTED_SESSION_SECRET_REFERENCE_MESSAGE);
  });

  it('rejects correct-account target reference ARNs with the wrong parameter path', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['SESSION_CAPABILITY_TTL_SECONDS_REF'] =
      'arn:aws:ssm:ap-northeast-1:123456789012:parameter/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-ttl-seconds';

    expect(() => validateEnv()).toThrow(EXPECTED_SESSION_TTL_REFERENCE_MESSAGE);
  });

  it('rejects correct-account target secret ARNs with the wrong secret path', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'] =
      'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:/stark-ballot-simulator/stark-dev/develop/app/config/vote-secret-encryption-key-a1B2c3';

    expect(() => validateEnv()).toThrow(EXPECTED_VOTE_SECRET_REFERENCE_MESSAGE);
  });

  it('rejects missing target secret/config reference names in target runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['SESSION_CAPABILITY_SECRET_REF'];

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET_REF must be set');
  });

  it('rejects wrong-account target secret/config reference ARNs', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'] =
      'arn:aws:secretsmanager:ap-northeast-1:999999999999:secret:stark-ballot/vote-secret';

    expect(() => validateEnv()).toThrow('VOTE_SECRET_ENCRYPTION_KEY_REF account must match AWS_ACCOUNT_ID');
  });

  it('rejects startup when SESSION_CAPABILITY_SECRET is missing', () => {
    activeProfile = localRuntimeProfile('local-proof-development');
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env['SESSION_CAPABILITY_SECRET'];

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must be set to at least 32 characters');
  });

  it('rejects invalid SESSION_CAPABILITY_TTL_SECONDS', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = 'abc';

    expect(() => validateEnv()).toThrow('Invalid SESSION_CAPABILITY_TTL_SECONDS value: abc.');
  });

  it('rejects non-integer SESSION_CAPABILITY_TTL_SECONDS', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '0.5';

    expect(() => validateEnv()).toThrow('Invalid SESSION_CAPABILITY_TTL_SECONDS value: 0.5.');
  });

  it('rejects zero SESSION_CAPABILITY_TTL_SECONDS', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '0';

    expect(() => validateEnv()).toThrow('Invalid SESSION_CAPABILITY_TTL_SECONDS value: 0.');
  });

  it('rejects negative SESSION_CAPABILITY_TTL_SECONDS', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '-1';

    expect(() => validateEnv()).toThrow('Invalid SESSION_CAPABILITY_TTL_SECONDS value: -1.');
  });

  it('rejects SESSION_CAPABILITY_TTL_SECONDS above the accepted maximum', () => {
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '604801';

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_TTL_SECONDS must be 604800 or less');
  });

  it('rejects invalid MAX_SESSIONS value', () => {
    process.env['MAX_SESSIONS'] = 'abc';

    expect(() => validateEnv()).toThrow('Invalid MAX_SESSIONS value: abc.');
  });

  it('rejects MAX_SESSIONS less than 1', () => {
    process.env['MAX_SESSIONS'] = '0';

    expect(() => validateEnv()).toThrow('Invalid MAX_SESSIONS value: 0.');
  });

  it('rejects placeholder SESSION_CAPABILITY_SECRET outside test runtime', () => {
    activeProfile = localRuntimeProfile('local-proof-development');
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = 'change-me-please-min-32-chars-and-should-be-replaced';

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must be changed from placeholder/test values');
  });

  it('rejects known test SESSION_CAPABILITY_SECRET outside test runtime', () => {
    activeProfile = localRuntimeProfile('local-proof-development');
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = 'test-session-capability-secret-0123456789abcdef';

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must be changed from placeholder/test values');
  });

  it('rejects unresolved runtime secret placeholder for SESSION_CAPABILITY_SECRET', () => {
    activeProfile = localRuntimeProfile('local-proof-development');
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER;

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET was not resolved from runtime secret references');
  });

  it.each([
    '/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret',
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret-a1B2c3',
  ])('rejects SESSION_CAPABILITY_SECRET when a raw secret field contains a reference: %s', (secretReference) => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['SESSION_CAPABILITY_SECRET'] = secretReference;

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must not be set directly');
  });

  it('rejects weak FINALIZE_CALLBACK_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;
    process.env['FINALIZE_CALLBACK_SECRET'] = 'short-secret';

    expect(() => validateEnv()).toThrow('FINALIZE_CALLBACK_SECRET must be at least 32 characters when configured');
  });

  it('rejects unresolved runtime secret placeholder for FINALIZE_CALLBACK_SECRET', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;
    process.env['FINALIZE_CALLBACK_SECRET'] = UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER;

    expect(() => validateEnv()).toThrow('FINALIZE_CALLBACK_SECRET was not resolved from runtime secret references');
  });

  it('rejects placeholder FINALIZE_CALLBACK_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;
    process.env['FINALIZE_CALLBACK_SECRET'] = 'change-me-please-random-secret-value';

    expect(() => validateEnv()).toThrow('FINALIZE_CALLBACK_SECRET must be changed from placeholder values');
  });

  it('allows strong FINALIZE_CALLBACK_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;
    process.env['FINALIZE_CALLBACK_SECRET'] = VALID_FINALIZE_CALLBACK_SECRET;

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows missing FINALIZE_CALLBACK_SECRET when no callback route secret is configured', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;
    delete process.env['FINALIZE_CALLBACK_SECRET'];

    expect(() => validateEnv()).not.toThrow();
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])(
    'rejects non-positive or non-integer FINALIZE_CALLBACK_MAX_SKEW_MS: %s',
    (value) => {
      process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'] = value;

      expect(() => validateEnv()).toThrow(`Invalid FINALIZE_CALLBACK_MAX_SKEW_MS value: ${value}.`);
    },
  );

  it('allows a positive integer FINALIZE_CALLBACK_MAX_SKEW_MS', () => {
    process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'] = '300000';

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects invalid S3_SIGNED_URL_TTL_SECONDS', () => {
    process.env['S3_SIGNED_URL_TTL_SECONDS'] = 'abc';

    expect(() => validateEnv()).toThrow('Invalid S3_SIGNED_URL_TTL_SECONDS value: abc.');
  });

  it('rejects invalid S3_BUNDLE_SIGNED_URL_TTL_SECONDS', () => {
    process.env['S3_BUNDLE_SIGNED_URL_TTL_SECONDS'] = 'abc';

    expect(() => validateEnv()).toThrow('Invalid S3_BUNDLE_SIGNED_URL_TTL_SECONDS value: abc.');
  });

  it('validates the target duplicate-detector TTL setting', () => {
    process.env['VOTE_DUPLICATE_DETECTOR_TTL_SECONDS'] = 'abc';

    expect(() => validateEnv()).toThrow('Invalid VOTE_DUPLICATE_DETECTOR_TTL_SECONDS value: abc.');
  });

  it.each(['abc', '0', '-1', '1.5'])(
    'rejects invalid FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS value %s',
    (deadlineSeconds) => {
      configureTargetAwsRuntimeEnv();
      process.env['FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS'] = deadlineSeconds;

      expect(() => validateEnv()).toThrow(
        `Invalid FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS value: ${deadlineSeconds}.`,
      );
    },
  );

  it('rejects S3_BUNDLE_SIGNED_URL_TTL_SECONDS above hardening cap', () => {
    process.env['S3_BUNDLE_SIGNED_URL_TTL_SECONDS'] = '901';

    expect(() => validateEnv()).toThrow('S3_BUNDLE_SIGNED_URL_TTL_SECONDS must be 900 or less');
  });
});
