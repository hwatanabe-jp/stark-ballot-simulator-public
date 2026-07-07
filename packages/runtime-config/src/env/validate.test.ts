import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';

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
  'SESSION_CAPABILITY_SECRET_REF must reference one of /stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret, /stark-ballot-simulator/stark-prod/main/app/secrets/session-capability-secret';
const EXPECTED_SESSION_TTL_REFERENCE_MESSAGE =
  'SESSION_CAPABILITY_TTL_SECONDS_REF must reference one of /stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds, /stark-ballot-simulator/stark-prod/main/app/config/session-capability-ttl-seconds';
const EXPECTED_VOTE_SECRET_REFERENCE_MESSAGE =
  'VOTE_SECRET_ENCRYPTION_KEY_REF must reference one of /stark-ballot-simulator/stark-dev/develop/app/secrets/vote-secret-encryption-key, /stark-ballot-simulator/stark-prod/main/app/secrets/vote-secret-encryption-key';

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
    process.env['USE_MOCK_STORE'] = 'true';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('rejects production startup when TURNSTILE_BYPASS is enabled', () => {
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'main');
    process.env['TURNSTILE_BYPASS'] = '1';

    expect(() => validateEnv()).toThrow(
      'TURNSTILE_BYPASS must be disabled unless runtime is explicitly non-production',
    );
  });

  it('allows startup when TURNSTILE_BYPASS is disabled in production', () => {
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'main');
    process.env['TURNSTILE_BYPASS'] = '0';
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows bypass on develop branch even when NODE_ENV is production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    process.env['TURNSTILE_BYPASS'] = '1';
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects bypass when runtime classification is unknown', () => {
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
    vi.stubEnv('ENV_NAME', '');
    process.env['TURNSTILE_BYPASS'] = '1';

    expect(() => validateEnv()).toThrow(
      'TURNSTILE_BYPASS must be disabled unless runtime is explicitly non-production',
    );
  });

  it('rejects bypass for legacy Lambda names that contain development tokens', () => {
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'amplify-starkballotsimulator-dev-honoapi-lambda');
    process.env['TURNSTILE_BYPASS'] = '1';

    expect(() => validateEnv()).toThrow(
      'TURNSTILE_BYPASS must be disabled unless runtime is explicitly non-production',
    );
  });

  it('allows bypass for target develop Lambda names when stronger markers are missing', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'stark-ballot-simulator-stark-dev-develop-public-api');
    process.env['TURNSTILE_BYPASS'] = '1';
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).not.toThrow();
  });

  function configureDynamoRuntimeEnv(): void {
    process.env['USE_MOCK_STORE'] = 'false';
    process.env['RATE_LIMIT_STORE'] = 'dynamo';
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
  }

  function configureTargetAwsRuntimeEnv(): void {
    configureDynamoRuntimeEnv();
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
    process.env['FINALIZE_ASYNC_MODE'] = 'true';
    process.env['USE_S3'] = 'true';
    process.env['PROVER_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-prover-work';
    process.env['PROVER_STATE_MACHINE_ARN'] =
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization';
    process.env['VERIFICATION_WORKER_FUNCTION_NAME'] = 'stark-ballot-simulator-stark-dev-develop-verification-worker';
    delete process.env['VERIFICATION_WORKER_ARN'];
    delete process.env['VERIFIER_SERVICE_RUNNER_FUNCTION_NAME'];
    delete process.env['VERIFIER_SERVICE_RUNNER_ARN'];
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';
    process.env['VERIFIER_PUBLIC_BASE_URL'] = 'https://develop.stark-ballot-sim.hwatanabe.dev';
    process.env['EXPECTED_IMAGE_ID'] = '0x' + '1'.repeat(64);
    process.env['LOG_IP_HASH_SALT'] = 'resolved-target-log-hash-salt';
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = 'resolved-origin-verify-header-0123456789abcdef';
    process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'true';
    process.env['TARGET_PUBLIC_SESSION_CREATE_ENABLED'] = 'true';
    process.env['SESSION_CREATE_TURNSTILE_REQUIRED'] = 'false';
    delete process.env['USE_MOCK_ZKVM'];
    delete process.env['RISC0_DEV_MODE'];
    delete process.env['FORCE_DEV_MODE'];
    delete process.env['ALLOW_INSECURE_ZKVM'];
    delete process.env['ALLOW_DEV_MODE_VERIFICATION'];
  }

  it('allows target DynamoDB runtime without DynamoDB identifiers', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['USE_AMPLIFY_DATA'];
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

  it('requires LOG_IP_HASH_SALT_REF in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['LOG_IP_HASH_SALT_REF'];

    expect(() => validateEnv()).toThrow('LOG_IP_HASH_SALT_REF must be set when TARGET_AWS_RUNTIME=1.');
  });

  it('requires LOG_IP_HASH_SALT to be resolved in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['LOG_IP_HASH_SALT'];

    expect(() => validateEnv()).toThrow(
      'LOG_IP_HASH_SALT must be resolved from LOG_IP_HASH_SALT_REF when TARGET_AWS_RUNTIME=1.',
    );
  });

  it('requires EXPECTED_ORIGIN_VERIFY_HEADER_REF in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['EXPECTED_ORIGIN_VERIFY_HEADER_REF'];

    expect(() => validateEnv()).toThrow('EXPECTED_ORIGIN_VERIFY_HEADER_REF must be set when TARGET_AWS_RUNTIME=1.');
  });

  it('requires EXPECTED_ORIGIN_VERIFY_HEADER to be resolved in target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    delete process.env['EXPECTED_ORIGIN_VERIFY_HEADER'];

    expect(() => validateEnv()).toThrow(
      'EXPECTED_ORIGIN_VERIFY_HEADER must be resolved from EXPECTED_ORIGIN_VERIFY_HEADER_REF when TARGET_AWS_RUNTIME=1.',
    );
  });

  it('rejects public session creation without Turnstile outside operator-gated develop', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'false';

    expect(() => validateEnv()).toThrow(
      'TARGET_PUBLIC_SESSION_CREATE_ENABLED without SESSION_CREATE_TURNSTILE_REQUIRED is allowed only for operator-gated develop.',
    );
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
    process.env['PROVER_STATE_MACHINE_ARN'] =
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-prod-main-finalization';
    process.env['VERIFICATION_WORKER_FUNCTION_NAME'] = 'stark-ballot-simulator-stark-prod-main-verification-worker';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-prod-main-proof-artifacts';
    process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'false';
    process.env['TARGET_PUBLIC_SESSION_CREATE_ENABLED'] = 'false';
    process.env['SESSION_CREATE_TURNSTILE_REQUIRED'] = 'true';

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects develop runtime config reference paths in the protected-production target runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'main';
    process.env['PROVER_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-prod-main-prover-work';
    process.env['PROVER_STATE_MACHINE_ARN'] =
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-prod-main-finalization';
    process.env['VERIFICATION_WORKER_FUNCTION_NAME'] = 'stark-ballot-simulator-stark-prod-main-verification-worker';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-prod-main-proof-artifacts';
    process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'false';
    process.env['TARGET_PUBLIC_SESSION_CREATE_ENABLED'] = 'false';
    process.env['SESSION_CREATE_TURNSTILE_REQUIRED'] = 'true';

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

    expect(() => validateEnv()).toThrow('VERIFICATION_WORKER_FUNCTION_NAME must be set when TARGET_AWS_RUNTIME=1.');
  });

  it('does not let mock store bypass target AWS runtime validation', () => {
    vi.stubEnv('NODE_ENV', 'test');
    configureTargetAwsRuntimeEnv();
    process.env['USE_MOCK_STORE'] = 'true';

    expect(() => validateEnv()).toThrow('USE_MOCK_STORE=false is required when TARGET_AWS_RUNTIME=1');
  });

  it.each([
    ['FINALIZE_ASYNC_MODE', 'false', 'FINALIZE_ASYNC_MODE=true is required when TARGET_AWS_RUNTIME=1'],
    ['USE_S3', 'false', 'USE_S3=true is required when TARGET_AWS_RUNTIME=1'],
    ['PROVER_WORK_QUEUE_URL', undefined, 'PROVER_WORK_QUEUE_URL must be set when TARGET_AWS_RUNTIME=1'],
    ['PROVER_STATE_MACHINE_ARN', undefined, 'PROVER_STATE_MACHINE_ARN must be set when TARGET_AWS_RUNTIME=1'],
    [
      'VERIFICATION_WORKER_FUNCTION_NAME',
      undefined,
      'VERIFICATION_WORKER_FUNCTION_NAME must be set when TARGET_AWS_RUNTIME=1',
    ],
    ['S3_PROOF_BUCKET', undefined, 'S3_PROOF_BUCKET must be set when TARGET_AWS_RUNTIME=1'],
    ['S3_PROOF_PREFIX', undefined, 'S3_PROOF_PREFIX must be set when TARGET_AWS_RUNTIME=1'],
    ['VERIFIER_PUBLIC_BASE_URL', undefined, 'VERIFIER_PUBLIC_BASE_URL must be set when TARGET_AWS_RUNTIME=1'],
    ['EXPECTED_IMAGE_ID', undefined, 'EXPECTED_IMAGE_ID must be set when TARGET_AWS_RUNTIME=1'],
  ])('rejects incomplete target AWS runtime config for %s', (name, value, expectedMessage) => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }

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

  it.each([
    ['USE_MOCK_ZKVM', 'true', 'USE_MOCK_ZKVM=true is not allowed when TARGET_AWS_RUNTIME=1'],
    ['RISC0_DEV_MODE', '1', 'RISC0_DEV_MODE=1 is not allowed when TARGET_AWS_RUNTIME=1'],
    ['FORCE_DEV_MODE', 'true', 'FORCE_DEV_MODE is not allowed when TARGET_AWS_RUNTIME=1'],
    ['ALLOW_INSECURE_ZKVM', 'true', 'ALLOW_INSECURE_ZKVM is not allowed when TARGET_AWS_RUNTIME=1'],
    ['ALLOW_DEV_MODE_VERIFICATION', 'true', 'ALLOW_DEV_MODE_VERIFICATION is not allowed when TARGET_AWS_RUNTIME=1'],
  ])('rejects insecure proof-mode control %s in target AWS runtime', (name, value, expectedMessage) => {
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
      'VERIFIER_PUBLIC_BASE_URL must not include a path, query, or fragment when TARGET_AWS_RUNTIME=1',
    );
  });

  it('rejects target verifier public base URLs using plain HTTP', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureTargetAwsRuntimeEnv();
    process.env['VERIFIER_PUBLIC_BASE_URL'] = 'http://develop.stark-ballot-sim.hwatanabe.dev';

    expect(() => validateEnv()).toThrow(
      'VERIFIER_PUBLIC_BASE_URL must be a valid https URL when TARGET_AWS_RUNTIME=1.',
    );
  });

  it('does not apply target HTTPS verifier URL validation outside target AWS runtime', () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env['TARGET_AWS_RUNTIME'] = '0';
    process.env['USE_MOCK_STORE'] = 'true';
    process.env['VERIFIER_PUBLIC_BASE_URL'] = 'http://localhost:3000';

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects raw SESSION_CAPABILITY_SECRET values in target runtime even with an approved reference', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;

    expect(() => validateEnv()).toThrow(
      'SESSION_CAPABILITY_SECRET must not be set directly when USE_MOCK_STORE=false; use SESSION_CAPABILITY_SECRET_REF',
    );
  });

  it('rejects raw SESSION_CAPABILITY_TTL_SECONDS values in target runtime even with an approved reference', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['SESSION_CAPABILITY_TTL_SECONDS'] = '3600';

    expect(() => validateEnv()).toThrow(
      'SESSION_CAPABILITY_TTL_SECONDS must not be set directly when USE_MOCK_STORE=false; use SESSION_CAPABILITY_TTL_SECONDS_REF',
    );
  });

  it('rejects raw VOTE_SECRET_ENCRYPTION_KEY values in target runtime even with an approved reference', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['VOTE_SECRET_ENCRYPTION_KEY'] = VALID_VOTE_SECRET_ENCRYPTION_KEY;

    expect(() => validateEnv()).toThrow(
      'VOTE_SECRET_ENCRYPTION_KEY must not be set directly when USE_MOCK_STORE=false; use VOTE_SECRET_ENCRYPTION_KEY_REF',
    );
  });

  it('rejects raw TURNSTILE_SECRET_KEY values in target runtime even with an approved reference', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['TURNSTILE_SECRET_KEY'] = 'live-secret';

    expect(() => validateEnv()).toThrow(
      'TURNSTILE_SECRET_KEY must not be set directly when USE_MOCK_STORE=false; use TURNSTILE_SECRET_KEY_REF',
    );
  });

  it('rejects startup when VOTE_SECRET_ENCRYPTION_KEY is missing outside mock store', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
    delete process.env['VOTE_SECRET_ENCRYPTION_KEY_REF'];

    expect(() => validateEnv()).toThrow('VOTE_SECRET_ENCRYPTION_KEY_REF must be set');
  });

  it('rejects startup when TURNSTILE_SECRET_KEY_REF is missing outside mock store', () => {
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

  it('rejects USE_AMPLIFY_DATA=true outside mock store', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['USE_AMPLIFY_DATA'] = 'true';

    expect(() => validateEnv()).toThrow('USE_AMPLIFY_DATA is retired for target non-mock runtime');
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

  it('allows bare target table names only with an explicit local DynamoDB endpoint exception', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';
    process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';
    process.env['DYNAMODB_SESSIONS_TABLE'] = 'stark-ballot-simulator-local-sessions';
    process.env['DYNAMODB_VOTES_TABLE'] = 'stark-ballot-simulator-local-votes';
    process.env['RATE_LIMIT_EVENTS_TABLE'] = 'stark-ballot-simulator-local-rate-limit-events';
    process.env['RATE_LIMIT_COUNTERS_TABLE'] = 'stark-ballot-simulator-local-rate-limit-counters';

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects target DynamoDB runtime without DynamoDB rate-limit selection', () => {
    vi.stubEnv('NODE_ENV', 'development');
    configureDynamoRuntimeEnv();
    process.env['RATE_LIMIT_STORE'] = 'memory';

    expect(() => validateEnv()).toThrow('RATE_LIMIT_STORE=dynamo is required when USE_MOCK_STORE=false');
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
    'allows local DynamoDB endpoint override on develop with an explicit exception: %s',
    (endpoint) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
      configureDynamoRuntimeEnv();
      process.env['DYNAMODB_ENDPOINT'] = endpoint;
      process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';

      expect(() => validateEnv()).not.toThrow();
    },
  );

  it('rejects local DynamoDB endpoint exception for legacy Lambda names that contain development tokens', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'amplify-starkballotsimulator-dev-honoapi-lambda');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';
    process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('rejects local DynamoDB endpoint exception when ENV_NAME=develop is paired with an untrusted Lambda name', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', 'develop');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'amplify-starkballotsimulator-dev-honoapi-lambda');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';
    process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT is local/test-only');
  });

  it('allows local DynamoDB endpoint exception with ENV_NAME when only AWS_REGION is present', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('AWS_EXECUTION_ENV', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
    vi.stubEnv('ENV_NAME', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';
    process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows local DynamoDB endpoint exception for target develop Lambda names', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', '');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'stark-ballot-simulator-stark-dev-develop-public-api');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';
    process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';

    expect(() => validateEnv()).not.toThrow();
  });

  it('allows local DynamoDB endpoint exception when explicit runtime marker overrides arbitrary Lambda names', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    vi.stubEnv('ENV_NAME', '');
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'custom-prod-worker');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'http://localhost:8000';
    process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';

    expect(() => validateEnv()).not.toThrow();
  });

  it('rejects non-local DynamoDB endpoint override even with an explicit local exception', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'https://dynamodb.ap-northeast-1.amazonaws.com';
    process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';

    expect(() => validateEnv()).toThrow('DYNAMODB_ENDPOINT must use a local loopback host');
  });

  it('rejects malformed DynamoDB endpoint override values', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'develop');
    configureDynamoRuntimeEnv();
    process.env['DYNAMODB_ENDPOINT'] = 'not a url';
    process.env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] = 'true';

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
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = 'change-me-please-min-32-chars-and-should-be-replaced';

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must be changed from placeholder/test values');
  });

  it('rejects known test SESSION_CAPABILITY_SECRET outside test runtime', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = 'test-session-capability-secret-0123456789abcdef';

    expect(() => validateEnv()).toThrow('SESSION_CAPABILITY_SECRET must be changed from placeholder/test values');
  });

  it('rejects unresolved runtime secret placeholder for SESSION_CAPABILITY_SECRET', () => {
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

  it('allows missing FINALIZE_CALLBACK_SECRET in async mode', () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env['SESSION_CAPABILITY_SECRET'] = VALID_SESSION_CAPABILITY_SECRET;
    process.env['FINALIZE_ASYNC_MODE'] = 'true';
    delete process.env['FINALIZE_CALLBACK_SECRET'];

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

  it('validates the target duplicate-detector TTL setting without legacy retention config', () => {
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
