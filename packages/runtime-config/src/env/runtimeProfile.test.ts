import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';
import {
  SUPPORTED_RUNTIME_PROFILES,
  resolveRuntimeProfile,
  validateRuntimeProfileSelection,
  type ResolvedRuntimeProfile,
} from '@stark-ballot/runtime-config/env/runtimeProfile';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';

const TARGET_ACCOUNT_ID = '123456789012';
const TARGET_REGION = 'ap-northeast-1';

function tableArn(name: string): string {
  return `arn:aws:dynamodb:${TARGET_REGION}:${TARGET_ACCOUNT_ID}:table/${name}`;
}

function targetAwsEnv(
  deploymentEnvironment: 'develop' | 'main' = 'develop',
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const accountAlias = deploymentEnvironment === 'develop' ? 'stark-dev' : 'stark-prod';
  const resourcePrefix = `stark-ballot-simulator-${accountAlias}-${deploymentEnvironment}`;
  const referencePrefix = `/stark-ballot-simulator/${accountAlias}/${deploymentEnvironment}/app`;
  return {
    RUNTIME_PROFILE: 'target-aws-async',
    RUNTIME_DEPLOYMENT_ENV: deploymentEnvironment,
    AWS_ACCOUNT_ID: TARGET_ACCOUNT_ID,
    AWS_REGION: TARGET_REGION,
    DYNAMODB_SESSIONS_TABLE: tableArn(`${resourcePrefix}-sessions`),
    DYNAMODB_VOTES_TABLE: tableArn(`${resourcePrefix}-votes`),
    RATE_LIMIT_EVENTS_TABLE: tableArn(`${resourcePrefix}-rate-limit-events`),
    RATE_LIMIT_COUNTERS_TABLE: tableArn(`${resourcePrefix}-rate-limit-counters`),
    PROVER_WORK_QUEUE_URL: `https://sqs.${TARGET_REGION}.amazonaws.com/${TARGET_ACCOUNT_ID}/${resourcePrefix}-prover-work`,
    VERIFICATION_WORK_QUEUE_URL: `https://sqs.${TARGET_REGION}.amazonaws.com/${TARGET_ACCOUNT_ID}/${resourcePrefix}-verification-work`,
    PROVER_STATE_MACHINE_ARN: `arn:aws:states:${TARGET_REGION}:${TARGET_ACCOUNT_ID}:stateMachine:${resourcePrefix}-finalization`,
    VERIFICATION_WORKER_FUNCTION_NAME: `${resourcePrefix}-verification-worker`,
    S3_PROOF_BUCKET: `${resourcePrefix}-proof-artifacts`,
    S3_PROOF_PREFIX: 'sessions/',
    VERIFIER_PUBLIC_BASE_URL:
      deploymentEnvironment === 'develop'
        ? 'https://develop.stark-ballot-sim.hwatanabe.dev'
        : 'https://stark-ballot-sim.hwatanabe.dev',
    EXPECTED_IMAGE_ID: `0x${'1'.repeat(64)}`,
    SESSION_CAPABILITY_SECRET_REF: `${referencePrefix}/secrets/session-capability-secret`,
    VOTE_SECRET_ENCRYPTION_KEY_REF: `${referencePrefix}/secrets/vote-secret-encryption-key`,
    SESSION_CAPABILITY_TTL_SECONDS_REF: `${referencePrefix}/config/session-capability-ttl-seconds`,
    TURNSTILE_SECRET_KEY_REF: `${referencePrefix}/secrets/turnstile-secret-key`,
    EXPECTED_ORIGIN_VERIFY_HEADER_REF: `${referencePrefix}/secrets/expected-origin-verify-header`,
    LOG_IP_HASH_SALT_REF: `${referencePrefix}/secrets/log-ip-hash-salt`,
    TURNSTILE_ALLOWED_HOSTNAMES:
      deploymentEnvironment === 'develop' ? 'develop.stark-ballot-sim.hwatanabe.dev' : 'stark-ballot-sim.hwatanabe.dev',
    TRUSTED_PROXY: 'api-gateway',
    ...overrides,
  };
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeepFrozen(child, seen);
  }
}

function captureRuntimeConfigFailure(env: NodeJS.ProcessEnv): RuntimeConfigValidationError {
  try {
    resolveRuntimeProfile(env);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeConfigValidationError);
    return error as RuntimeConfigValidationError;
  }
  throw new Error('Expected runtime profile resolution to fail');
}

function parseEnvTemplate(source: URL): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [index, rawLine] of readFileSync(source, 'utf8').split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`${source.pathname}:${index + 1} is not a canonical environment assignment.`);
    }
    if (Object.hasOwn(env, match[1])) {
      throw new Error(`${source.pathname}:${index + 1} duplicates ${match[1]}.`);
    }
    env[match[1]] = match[2];
  }
  return env;
}

describe('resolveRuntimeProfile', () => {
  it('keeps the checked-in local environment example valid for its selected profile', () => {
    const env = parseEnvTemplate(new URL('../../../../.env.local.example', import.meta.url));
    const profile = resolveRuntimeProfile(env);

    expect(profile.name).toBe('local-demo');
    expect(env['VITE_RUNTIME_PROFILE']).toBe(profile.name);
    expect(() => validateEnv(profile, env)).not.toThrow();
  });

  it('exposes the complete supported semantic profile selector set', () => {
    expect(SUPPORTED_RUNTIME_PROFILES).toEqual([
      'local-demo',
      'static-mock-e2e',
      'local-proof-development',
      'local-proof-production',
      'target-aws-async',
      'target-aws-async-quiesced',
    ]);
  });

  it.each([
    [
      'local-demo',
      {
        name: 'local-demo',
        target: { kind: 'local' },
        sessionStore: { kind: 'memory' },
        proof: { executor: 'mock', evidence: 'mock' },
        finalization: { mode: 'sync' },
        artifacts: { kind: 'local' },
        runtimeAdapters: {
          api: 'node',
          prover: 'in-process',
          verification: 'local-process',
          browserApi: 'mock',
        },
        rateLimit: { store: 'memory', allowUnknownClientIp: true },
        turnstile: { mode: 'bypass', bypassEligible: true, publicSessionCreate: true },
        external: { kind: 'none' },
      },
    ],
    [
      'static-mock-e2e',
      {
        name: 'static-mock-e2e',
        target: { kind: 'local' },
        sessionStore: { kind: 'file' },
        proof: { executor: 'mock', evidence: 'mock' },
        finalization: { mode: 'sync' },
        artifacts: { kind: 'local' },
        runtimeAdapters: {
          api: 'node',
          prover: 'in-process',
          verification: 'local-process',
          browserApi: 'same-origin',
        },
        rateLimit: { store: 'memory', allowUnknownClientIp: true },
        turnstile: { mode: 'bypass', bypassEligible: true, publicSessionCreate: true },
        external: { kind: 'none' },
      },
    ],
    [
      'local-proof-development',
      {
        name: 'local-proof-development',
        target: { kind: 'local' },
        sessionStore: { kind: 'memory' },
        proof: { executor: 'risc0', evidence: 'development' },
        finalization: { mode: 'sync' },
        artifacts: { kind: 'local' },
        runtimeAdapters: {
          api: 'node',
          prover: 'child-process',
          verification: 'local-process',
          browserApi: 'same-origin',
        },
        rateLimit: { store: 'memory', allowUnknownClientIp: true },
        turnstile: { mode: 'bypass', bypassEligible: true, publicSessionCreate: true },
        external: { kind: 'none' },
      },
    ],
    [
      'local-proof-production',
      {
        name: 'local-proof-production',
        target: { kind: 'local' },
        sessionStore: { kind: 'memory' },
        proof: { executor: 'risc0', evidence: 'production' },
        finalization: { mode: 'sync' },
        artifacts: { kind: 'local' },
        runtimeAdapters: {
          api: 'node',
          prover: 'child-process',
          verification: 'local-process',
          browserApi: 'same-origin',
        },
        rateLimit: { store: 'memory', allowUnknownClientIp: true },
        turnstile: { mode: 'bypass', bypassEligible: true, publicSessionCreate: true },
        external: { kind: 'none' },
      },
    ],
  ] as const)('resolves the complete %s profile', (name, expected) => {
    expect(resolveRuntimeProfile({ RUNTIME_PROFILE: name })).toEqual(expected);
  });

  it('resolves the complete operator-gated target develop profile without secret values', () => {
    const env = targetAwsEnv('develop');

    const profile = resolveRuntimeProfile(env);

    expect(profile).toEqual({
      name: 'target-aws-async',
      target: { kind: 'aws', deploymentEnvironment: 'develop' },
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
      turnstile: {
        mode: 'operator-gated',
        bypassEligible: false,
        publicSessionCreate: true,
      },
      external: {
        kind: 'aws',
        accountId: TARGET_ACCOUNT_ID,
        region: TARGET_REGION,
        dynamo: {
          sessionsTable: env['DYNAMODB_SESSIONS_TABLE'],
          votesTable: env['DYNAMODB_VOTES_TABLE'],
          rateLimitEventsTable: env['RATE_LIMIT_EVENTS_TABLE'],
          rateLimitCountersTable: env['RATE_LIMIT_COUNTERS_TABLE'],
        },
        asyncRuntime: {
          proverWorkQueueUrl: env['PROVER_WORK_QUEUE_URL'],
          verificationWorkQueueUrl: env['VERIFICATION_WORK_QUEUE_URL'],
          proverStateMachineArn: env['PROVER_STATE_MACHINE_ARN'],
          verificationWorkerFunctionName: env['VERIFICATION_WORKER_FUNCTION_NAME'],
        },
        artifactStorage: {
          bucket: env['S3_PROOF_BUCKET'],
          prefix: 'sessions/',
        },
        verifierPublicBaseUrl: env['VERIFIER_PUBLIC_BASE_URL'],
        expectedImageId: env['EXPECTED_IMAGE_ID'],
        turnstileAllowedHostnames: ['develop.stark-ballot-sim.hwatanabe.dev'],
        trustedProxy: 'api-gateway',
        secretReferences: {
          sessionCapabilitySecret: env['SESSION_CAPABILITY_SECRET_REF'],
          voteSecretEncryptionKey: env['VOTE_SECRET_ENCRYPTION_KEY_REF'],
          sessionCapabilityTtlSeconds: env['SESSION_CAPABILITY_TTL_SECONDS_REF'],
          turnstileSecretKey: env['TURNSTILE_SECRET_KEY_REF'],
          expectedOriginVerifyHeader: env['EXPECTED_ORIGIN_VERIFY_HEADER_REF'],
          logIpHashSalt: env['LOG_IP_HASH_SALT_REF'],
        },
      },
    });
    expect(JSON.stringify(profile)).not.toContain('SECRET_KEY');
    expect(JSON.stringify(profile)).not.toContain('resolved-secret-material');
  });

  it.each([
    ['an all-malformed list', 'https://,/'],
    ['a mixed valid and malformed list', 'develop.stark-ballot-sim.hwatanabe.dev,https://'],
    ['an empty list member', 'develop.stark-ballot-sim.hwatanabe.dev,,audit.example.com'],
  ])('rejects %s in the target Turnstile hostname allowlist', (_label, allowedHostnames) => {
    const failure = captureRuntimeConfigFailure(
      targetAwsEnv('develop', {
        TURNSTILE_ALLOWED_HOSTNAMES: allowedHostnames,
      }),
    );

    expect(failure.invalidNames).toEqual(['TURNSTILE_ALLOWED_HOSTNAMES']);
  });

  it('resolves a quiesced target develop profile that blocks new public sessions', () => {
    const profile = resolveRuntimeProfile(
      targetAwsEnv('develop', {
        RUNTIME_PROFILE: 'target-aws-async-quiesced',
      }),
    );

    expect(profile).toMatchObject({
      name: 'target-aws-async-quiesced',
      target: { kind: 'aws', deploymentEnvironment: 'develop' },
      sessionStore: { kind: 'dynamo' },
      proof: { executor: 'risc0', evidence: 'production' },
      finalization: { mode: 'async', queue: 'sqs', orchestrator: 'step-functions' },
      artifacts: { kind: 's3' },
      turnstile: {
        mode: 'operator-gated',
        bypassEligible: false,
        publicSessionCreate: false,
      },
    });
    expectDeepFrozen(profile);
  });

  it('rejects a quiesced target profile outside the develop recovery lane', () => {
    const failure = captureRuntimeConfigFailure(
      targetAwsEnv('main', {
        RUNTIME_PROFILE: 'target-aws-async-quiesced',
      }),
    );

    expect(failure.invalidNames).toEqual(['RUNTIME_PROFILE', 'RUNTIME_DEPLOYMENT_ENV']);
  });

  it('requires Turnstile for public production admission with production proof and AWS storage', () => {
    const profile = resolveRuntimeProfile(targetAwsEnv('main'));

    expect(profile.target).toEqual({ kind: 'aws', deploymentEnvironment: 'main' });
    expect(profile.proof).toEqual({ executor: 'risc0', evidence: 'production' });
    expect(profile.sessionStore).toEqual({ kind: 'dynamo' });
    expect(profile.finalization).toEqual({ mode: 'async', queue: 'sqs', orchestrator: 'step-functions' });
    expect(profile.artifacts).toEqual({ kind: 's3' });
    expect(profile.turnstile).toEqual({
      mode: 'required',
      bypassEligible: false,
      publicSessionCreate: true,
    });
  });

  it.each([
    { RUNTIME_PROFILE: undefined },
    { RUNTIME_PROFILE: '' },
    { RUNTIME_PROFILE: 'local-mock' },
    { RUNTIME_PROFILE: 'target-aws-production' },
  ])('rejects a missing or unknown selector: $RUNTIME_PROFILE', (env) => {
    const failure = captureRuntimeConfigFailure(env);

    expect(failure.invalidNames).toEqual(['RUNTIME_PROFILE']);
  });

  it('rejects replaced selector mixing even when old flags look compatible', () => {
    const failure = captureRuntimeConfigFailure({
      RUNTIME_PROFILE: 'local-demo',
      USE_MOCK_STORE: 'true',
      USE_AMPLIFY_DATA: 'true',
      USE_S3: 'false',
      VITE_USE_MOCK_API: 'true',
      EXPECTED_IMAGEID_POC: '0xlegacy',
    });

    expect(failure.invalidNames).toEqual([
      'USE_MOCK_STORE',
      'USE_AMPLIFY_DATA',
      'USE_S3',
      'VITE_USE_MOCK_API',
      'EXPECTED_IMAGEID_POC',
    ]);
  });

  it('rejects target-only external references mixed into a local profile', () => {
    const failure = captureRuntimeConfigFailure({
      RUNTIME_PROFILE: 'local-proof-production',
      DYNAMODB_SESSIONS_TABLE: tableArn('stark-ballot-simulator-stark-dev-develop-sessions'),
      PROVER_WORK_QUEUE_URL:
        'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-prover-work',
      VERIFICATION_WORK_QUEUE_URL:
        'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-verification-work',
      S3_PROOF_BUCKET: 'stark-ballot-simulator-stark-dev-develop-proof-artifacts',
      SESSION_CAPABILITY_SECRET_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret',
    });

    expect(failure.invalidNames).toEqual([
      'DYNAMODB_SESSIONS_TABLE',
      'PROVER_WORK_QUEUE_URL',
      'VERIFICATION_WORK_QUEUE_URL',
      'S3_PROOF_BUCKET',
      'SESSION_CAPABILITY_SECRET_REF',
    ]);
  });

  it('rejects unsafe target endpoint and proof-mode mixing', () => {
    const failure = captureRuntimeConfigFailure(
      targetAwsEnv('develop', {
        DYNAMODB_ENDPOINT: 'http://localhost:8000',
        RISC0_DEV_MODE: '1',
      }),
    );

    expect(failure.invalidNames).toEqual(['RISC0_DEV_MODE', 'DYNAMODB_ENDPOINT']);
  });

  it('reports every missing required target external reference by exact name', () => {
    const env = targetAwsEnv();
    delete env['PROVER_WORK_QUEUE_URL'];
    delete env['VERIFICATION_WORK_QUEUE_URL'];
    delete env['S3_PROOF_BUCKET'];
    delete env['SESSION_CAPABILITY_SECRET_REF'];

    const failure = captureRuntimeConfigFailure(env);

    expect(failure.invalidNames).toEqual([
      'PROVER_WORK_QUEUE_URL',
      'VERIFICATION_WORK_QUEUE_URL',
      'S3_PROOF_BUCKET',
      'SESSION_CAPABILITY_SECRET_REF',
    ]);
  });

  it('composes existing target external identifier admission', () => {
    const failure = captureRuntimeConfigFailure(
      targetAwsEnv('develop', {
        PROVER_WORK_QUEUE_URL:
          'https://sqs.us-east-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-prover-work',
      }),
    );

    expect(failure.invalidNames).toEqual(['PROVER_WORK_QUEUE_URL']);
  });

  it('rejects a verification queue outside the target account and region authority', () => {
    const failure = captureRuntimeConfigFailure(
      targetAwsEnv('develop', {
        VERIFICATION_WORK_QUEUE_URL:
          'https://sqs.us-east-1.amazonaws.com/999999999999/stark-ballot-simulator-stark-dev-develop-verification-work',
      }),
    );

    expect(failure.invalidNames).toEqual(['VERIFICATION_WORK_QUEUE_URL']);
  });

  it('composes existing target secret-reference admission', () => {
    const failure = captureRuntimeConfigFailure(
      targetAwsEnv('develop', {
        SESSION_CAPABILITY_SECRET_REF: '/unapproved/session-capability-secret',
      }),
    );

    expect(failure.invalidNames).toEqual(['SESSION_CAPABILITY_SECRET_REF']);
  });

  it.each([
    'SESSION_CAPABILITY_SECRET',
    'VOTE_SECRET_ENCRYPTION_KEY',
    'SESSION_CAPABILITY_TTL_SECONDS',
    'TURNSTILE_SECRET_KEY',
    'EXPECTED_ORIGIN_VERIFY_HEADER',
    'LOG_IP_HASH_SALT',
    'FINALIZE_CALLBACK_SECRET',
  ] as const)('rejects direct target secret/config material in %s', (name) => {
    const failure = captureRuntimeConfigFailure(
      targetAwsEnv('develop', {
        [name]: 'resolved-secret-material',
      }),
    );

    expect(failure.invalidNames).toEqual([name]);
  });

  it('returns deeply frozen profiles', () => {
    const localProfile = resolveRuntimeProfile({ RUNTIME_PROFILE: 'local-proof-development' });
    const targetProfile = resolveRuntimeProfile(targetAwsEnv());

    expectDeepFrozen(localProfile);
    expectDeepFrozen(targetProfile);
  });

  it('retains a discriminated profile type for exhaustive consumers', () => {
    const profile: ResolvedRuntimeProfile = resolveRuntimeProfile({ RUNTIME_PROFILE: 'local-demo' });

    if (profile.target.kind === 'aws') {
      expect(profile.external.kind).toBe('aws');
    } else {
      expect(profile.external).toEqual({ kind: 'none' });
    }
  });
});

describe('validateRuntimeProfileSelection', () => {
  it('accepts the selector used to resolve the immutable profile', () => {
    const profile = resolveRuntimeProfile({ RUNTIME_PROFILE: 'local-demo' });

    expect(() => validateRuntimeProfileSelection(profile, { RUNTIME_PROFILE: 'local-demo' })).not.toThrow();
  });

  it('rejects selector mutation after the immutable profile is resolved', () => {
    const profile = resolveRuntimeProfile({ RUNTIME_PROFILE: 'local-demo' });

    expect(() => validateRuntimeProfileSelection(profile, { RUNTIME_PROFILE: 'static-mock-e2e' })).toThrow(
      RuntimeConfigValidationError,
    );
  });
});
