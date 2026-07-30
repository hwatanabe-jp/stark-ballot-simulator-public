import { describe, expect, it } from 'vitest';
import { collectInvalidTargetObservabilityEnvNames, validateTargetObservabilityEnv } from './observability';

function targetObservabilityEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TARGET_AWS_RUNTIME: '1',
    LOG_FORMAT: 'json',
    LOG_IP_HASH_SALT_REF: '/stark-ballot-simulator/stark-dev/develop/app/secrets/log-ip-hash-salt',
    LOG_IP_HASH_SALT: 'resolved-target-log-hash-salt',
    DEPLOYMENT_ID: 'dep_0123456789abcdef0123456789abcdef',
    APP_SOURCE_SHA: 'a'.repeat(40),
    DEPLOY_MODE: 'normal',
    ...overrides,
  };
}

describe('validateTargetObservabilityEnv', () => {
  it('collects exact invalid variable names without deriving them from exception messages', () => {
    const env = targetObservabilityEnv({
      LOG_FORMAT: 'text',
      LOG_IP_HASH_SALT: 'stark-ballot-log-salt',
      DEPLOYMENT_ID: 'dep_example',
      APP_SOURCE_SHA: 'not-a-source-sha',
      DEPLOY_MODE: 'static-fast',
    });
    delete env['LOG_IP_HASH_SALT_REF'];

    expect(collectInvalidTargetObservabilityEnvNames(env)).toEqual([
      'LOG_IP_HASH_SALT_REF',
      'LOG_IP_HASH_SALT',
      'LOG_FORMAT',
      'DEPLOYMENT_ID',
      'APP_SOURCE_SHA',
      'DEPLOY_MODE',
    ]);
    expect(collectInvalidTargetObservabilityEnvNames({ TARGET_AWS_RUNTIME: '0' })).toEqual([]);
  });

  it('accepts the complete target observability contract without unrelated app configuration', () => {
    expect(() => validateTargetObservabilityEnv(targetObservabilityEnv())).not.toThrow();
  });

  it('does not impose the deployed contract on non-target runtimes', () => {
    expect(() => validateTargetObservabilityEnv({ TARGET_AWS_RUNTIME: '0' })).not.toThrow();
  });

  it.each([undefined, 'text', 'JSON', ' json', 'json '])('rejects target LOG_FORMAT value %s', (logFormat) => {
    const env = targetObservabilityEnv();
    if (logFormat === undefined) {
      delete env['LOG_FORMAT'];
    } else {
      env['LOG_FORMAT'] = logFormat;
    }

    expect(() => validateTargetObservabilityEnv(env)).toThrow('LOG_FORMAT=json is required when TARGET_AWS_RUNTIME=1.');
  });

  it('rejects the public local-development hash salt', () => {
    expect(() =>
      validateTargetObservabilityEnv(
        targetObservabilityEnv({
          LOG_IP_HASH_SALT: 'stark-ballot-log-salt',
        }),
      ),
    ).toThrow('LOG_IP_HASH_SALT must not use the public local-development default when TARGET_AWS_RUNTIME=1.');
  });

  it('requires the salt reference and its resolved value', () => {
    const missingReference = targetObservabilityEnv();
    delete missingReference['LOG_IP_HASH_SALT_REF'];
    const unresolved = targetObservabilityEnv();
    delete unresolved['LOG_IP_HASH_SALT'];

    expect(() => validateTargetObservabilityEnv(missingReference)).toThrow(
      'LOG_IP_HASH_SALT_REF must be set when TARGET_AWS_RUNTIME=1.',
    );
    expect(() => validateTargetObservabilityEnv(unresolved)).toThrow(
      'LOG_IP_HASH_SALT must be resolved from LOG_IP_HASH_SALT_REF when TARGET_AWS_RUNTIME=1.',
    );
  });

  it.each([
    ['DEPLOYMENT_ID', undefined, 'DEPLOYMENT_ID must be set'],
    ['DEPLOYMENT_ID', 'dep_example', 'DEPLOYMENT_ID must be an opaque deployment digest'],
    ['APP_SOURCE_SHA', undefined, 'APP_SOURCE_SHA must be set'],
    ['APP_SOURCE_SHA', 'not-a-source-sha', 'APP_SOURCE_SHA must be the full selected source SHA'],
    ['DEPLOY_MODE', undefined, 'DEPLOY_MODE must be set'],
    ['DEPLOY_MODE', 'static-fast', 'DEPLOY_MODE must be normal or rollback'],
  ])('rejects invalid deployment authority %s=%s', (name, value, message) => {
    const env = targetObservabilityEnv();
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }

    expect(() => validateTargetObservabilityEnv(env)).toThrow(message);
  });

  it('accepts rollback and a full 64-character selected source SHA', () => {
    expect(() =>
      validateTargetObservabilityEnv(
        targetObservabilityEnv({
          APP_SOURCE_SHA: 'b'.repeat(64),
          DEPLOY_MODE: 'rollback',
        }),
      ),
    ).not.toThrow();
  });
});
