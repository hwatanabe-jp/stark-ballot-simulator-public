import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeConfigReferenceResolver,
  installStaticRuntimeConfigReferenceResolver,
  resolveRuntimeConfigReference,
  setRuntimeConfigReferenceResolver,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';

const SESSION_SECRET_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret';
const PROD_SESSION_SECRET_REF = '/stark-ballot-simulator/stark-prod/main/app/secrets/session-capability-secret';
const TURNSTILE_SECRET_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/turnstile-secret-key';
const ORIGIN_VERIFY_HEADER_REF = '/stark-ballot-simulator/stark-dev/develop/app/secrets/expected-origin-verify-header';
const SESSION_SECRET = 'resolved-session-capability-secret-0123456789abcdef';
const DEVELOP_REFERENCE_AUTHORITY = { expectedDeploymentEnvironment: 'develop' } as const;
const MAIN_REFERENCE_AUTHORITY = { expectedDeploymentEnvironment: 'main' } as const;
const DEVELOP_ARN_REFERENCE_AUTHORITY = {
  expectedAccountId: '123456789012',
  expectedDeploymentEnvironment: 'develop',
  expectedRegion: 'ap-northeast-1',
} as const;
const EXPECTED_SESSION_SECRET_REF_MESSAGE =
  'SESSION_CAPABILITY_SECRET_REF must reference /stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret';
const EXPECTED_SESSION_TTL_REF_MESSAGE =
  'SESSION_CAPABILITY_TTL_SECONDS_REF must reference /stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds';
const EXPECTED_VOTE_SECRET_REF_MESSAGE =
  'VOTE_SECRET_ENCRYPTION_KEY_REF must reference /stark-ballot-simulator/stark-dev/develop/app/secrets/vote-secret-encryption-key';

describe('runtimeConfigReferences', () => {
  afterEach(() => {
    clearRuntimeConfigReferenceResolver();
    vi.unstubAllEnvs();
  });

  it('resolves approved non-secret references through an injected static boundary', () => {
    installStaticRuntimeConfigReferenceResolver(
      new Map([[SESSION_SECRET_REF, SESSION_SECRET]]),
      DEVELOP_REFERENCE_AUTHORITY,
    );

    expect(
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: SESSION_SECRET_REF,
      }),
    ).toBe(SESSION_SECRET);
  });

  it('binds an installed resolver to its immutable deployment lane authority', () => {
    installStaticRuntimeConfigReferenceResolver(
      new Map([[SESSION_SECRET_REF, SESSION_SECRET]]),
      DEVELOP_REFERENCE_AUTHORITY,
    );
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'main');

    expect(
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: SESSION_SECRET_REF,
      }),
    ).toBe(SESSION_SECRET);
  });

  it('does not widen an explicitly bound resolver when the process lane is absent', () => {
    setRuntimeConfigReferenceResolver(
      {
        resolve() {
          return SESSION_SECRET;
        },
      },
      DEVELOP_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: PROD_SESSION_SECRET_REF,
      }),
    ).toThrow(
      'SESSION_CAPABILITY_SECRET_REF must reference /stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret',
    );
  });

  it('resolves the protected-production target reference path when the runtime lane is main', () => {
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'main');
    installStaticRuntimeConfigReferenceResolver(
      new Map([[PROD_SESSION_SECRET_REF, SESSION_SECRET]]),
      MAIN_REFERENCE_AUTHORITY,
    );

    expect(
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: PROD_SESSION_SECRET_REF,
      }),
    ).toBe(SESSION_SECRET);
  });

  it('rejects develop references when the runtime lane is protected production', () => {
    vi.stubEnv('RUNTIME_DEPLOYMENT_ENV', 'main');
    installStaticRuntimeConfigReferenceResolver(
      new Map([[SESSION_SECRET_REF, SESSION_SECRET]]),
      MAIN_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: SESSION_SECRET_REF,
      }),
    ).toThrow(
      'SESSION_CAPABILITY_SECRET_REF must reference /stark-ballot-simulator/stark-prod/main/app/secrets/session-capability-secret',
    );
  });

  it('accepts the approved target Turnstile secret reference path', () => {
    installStaticRuntimeConfigReferenceResolver(
      new Map([[TURNSTILE_SECRET_REF, 'turnstile-secret-value']]),
      DEVELOP_REFERENCE_AUTHORITY,
    );

    expect(
      resolveRuntimeConfigReference({
        name: 'TURNSTILE_SECRET_KEY',
        reference: TURNSTILE_SECRET_REF,
      }),
    ).toBe('turnstile-secret-value');
  });

  it('accepts the approved target origin verify header reference path', () => {
    installStaticRuntimeConfigReferenceResolver(
      new Map([[ORIGIN_VERIFY_HEADER_REF, 'origin-header-secret-value']]),
      DEVELOP_REFERENCE_AUTHORITY,
    );

    expect(
      resolveRuntimeConfigReference({
        name: 'EXPECTED_ORIGIN_VERIFY_HEADER',
        reference: ORIGIN_VERIFY_HEADER_REF,
      }),
    ).toBe('origin-header-secret-value');
  });

  it('fails closed when no resolver can resolve a configured reference', () => {
    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: SESSION_SECRET_REF,
      }),
    ).toThrow('SESSION_CAPABILITY_SECRET_REF is configured but no target runtime resolver returned a value');
  });

  it('rejects unresolved or invalid reference values from the resolver', () => {
    setRuntimeConfigReferenceResolver(
      {
        resolve(reference) {
          return reference.reference;
        },
      },
      DEVELOP_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: SESSION_SECRET_REF,
      }),
    ).toThrow('SESSION_CAPABILITY_SECRET_REF resolved to an unresolved or invalid SESSION_CAPABILITY_SECRET value');
  });

  it('rejects unapproved reference locations before invoking the resolver', () => {
    setRuntimeConfigReferenceResolver(
      {
        resolve() {
          throw new Error('resolver should not run');
        },
      },
      DEVELOP_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: '/some/other/app/secrets/session-capability-secret',
      }),
    ).toThrow(EXPECTED_SESSION_SECRET_REF_MESSAGE);
  });

  it('rejects wrong-category absolute paths before invoking the resolver', () => {
    setRuntimeConfigReferenceResolver(
      {
        resolve() {
          throw new Error('resolver should not run');
        },
      },
      DEVELOP_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference: '/stark-ballot-simulator/stark-dev/develop/app/config/session-capability-secret',
      }),
    ).toThrow(EXPECTED_SESSION_SECRET_REF_MESSAGE);
  });

  it('rejects correct-account ARN references with the wrong parameter path before invoking the resolver', () => {
    vi.stubEnv('AWS_ACCOUNT_ID', '123456789012');
    vi.stubEnv('AWS_REGION', 'ap-northeast-1');
    setRuntimeConfigReferenceResolver(
      {
        resolve() {
          throw new Error('resolver should not run');
        },
      },
      DEVELOP_ARN_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_TTL_SECONDS',
        reference:
          'arn:aws:ssm:ap-northeast-1:123456789012:parameter/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-ttl-seconds',
      }),
    ).toThrow(EXPECTED_SESSION_TTL_REF_MESSAGE);
  });

  it('rejects correct-account ARN references with the wrong secret path before invoking the resolver', () => {
    vi.stubEnv('AWS_ACCOUNT_ID', '123456789012');
    vi.stubEnv('AWS_REGION', 'ap-northeast-1');
    setRuntimeConfigReferenceResolver(
      {
        resolve() {
          throw new Error('resolver should not run');
        },
      },
      DEVELOP_ARN_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'VOTE_SECRET_ENCRYPTION_KEY',
        reference:
          'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:/stark-ballot-simulator/stark-dev/develop/app/config/vote-secret-encryption-key-a1B2c3',
      }),
    ).toThrow(EXPECTED_VOTE_SECRET_REF_MESSAGE);
  });

  it('rejects direct ARN resolution for the wrong target account before invoking the resolver', () => {
    vi.stubEnv('AWS_ACCOUNT_ID', '123456789012');
    vi.stubEnv('AWS_REGION', 'ap-northeast-1');
    setRuntimeConfigReferenceResolver(
      {
        resolve() {
          throw new Error('resolver should not run');
        },
      },
      DEVELOP_ARN_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_SECRET',
        reference:
          'arn:aws:ssm:ap-northeast-1:999999999999:parameter/stark-ballot-simulator/stark-dev/develop/app/secrets/session-capability-secret',
      }),
    ).toThrow('SESSION_CAPABILITY_SECRET_REF account must match AWS_ACCOUNT_ID');
  });

  it('rejects direct ARN resolution for the wrong target region before invoking the resolver', () => {
    vi.stubEnv('AWS_ACCOUNT_ID', '123456789012');
    vi.stubEnv('AWS_REGION', 'ap-northeast-1');
    setRuntimeConfigReferenceResolver(
      {
        resolve() {
          throw new Error('resolver should not run');
        },
      },
      DEVELOP_ARN_REFERENCE_AUTHORITY,
    );

    expect(() =>
      resolveRuntimeConfigReference({
        name: 'SESSION_CAPABILITY_TTL_SECONDS',
        reference:
          'arn:aws:ssm:us-east-1:123456789012:parameter/stark-ballot-simulator/stark-dev/develop/app/config/session-capability-ttl-seconds',
      }),
    ).toThrow('SESSION_CAPABILITY_TTL_SECONDS_REF region must match AWS_REGION/AWS_DEFAULT_REGION');
  });
});
