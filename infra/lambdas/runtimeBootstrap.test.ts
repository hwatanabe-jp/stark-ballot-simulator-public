import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { resolveRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

const loggerMocks = vi.hoisted(() => ({
  configureLogger: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@stark-ballot/diagnostics/logger', () => ({
  configureLogger: loggerMocks.configureLogger,
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerMocks.error,
  },
  parseLogFormat: (value: string | undefined, fallback: 'json' | 'text') =>
    value === 'json' || value === 'text' ? value : fallback,
  parseLogLevel: (value: string | undefined, fallback: 'debug' | 'info' | 'warn' | 'error' | 'silent') =>
    value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'silent'
      ? value
      : fallback,
}));

const { RuntimeConfigValidationError, bootstrapLambdaRuntime } = await import('./runtimeBootstrap');
const activeTargetProfile = targetRuntimeProfile();
const quiescedTargetProfile = resolveRuntimeProfile({
  ...targetRuntimeProfileEnv(),
  RUNTIME_PROFILE: 'target-aws-async-quiesced',
});
const localProfile = localRuntimeProfile();

async function captureRejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('Expected bootstrap to reject with an Error.');
  }
  throw new Error('Expected bootstrap to reject.');
}

function serializeRejectedError(error: Error): string {
  return JSON.stringify({
    rejectedError: error,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
  });
}

describe('Lambda runtime observability bootstrap', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['RUNTIME_PROFILE'] = 'target-aws-async';
    process.env['LOG_FORMAT'] = 'json';
    process.env['LOG_LEVEL'] = 'warn';
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
    process.env['DEPLOYMENT_ID'] = 'dep_0123456789abcdef0123456789abcdef';
    process.env['APP_SOURCE_SHA'] = 'a'.repeat(40);
    process.env['DEPLOY_MODE'] = 'normal';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('configures the secret-free logger before resolving references and validating component config', async () => {
    const order: string[] = [];
    loggerMocks.configureLogger.mockImplementationOnce(() => order.push('configure_logger'));

    await bootstrapLambdaRuntime({
      serviceName: 'proof-dispatcher',
      runtimeProfile: activeTargetProfile,
      resolveRuntimeReferences: () => {
        order.push('resolve_references');
        return Promise.resolve();
      },
      validationSteps: [
        {
          validate: () => {
            order.push('validate_component');
          },
        },
      ],
    });

    expect(order).toEqual(['configure_logger', 'resolve_references', 'validate_component']);
    expect(loggerMocks.configureLogger).toHaveBeenCalledWith({
      format: 'json',
      jsonOutputMode: 'lambda-native',
      level: 'warn',
      serviceName: 'proof-dispatcher',
      envName: 'develop',
      includeStack: true,
      deploymentId: 'dep_0123456789abcdef0123456789abcdef',
      appSourceSha: 'a'.repeat(40),
      deployMode: 'normal',
    });
  });

  it.each([
    ['active', activeTargetProfile],
    ['quiesced', quiescedTargetProfile],
  ] as const)('selects Lambda-native JSON logging from the injected %s target profile', async (_name, profile) => {
    await bootstrapLambdaRuntime({
      serviceName: 'public-api',
      runtimeProfile: profile,
      resolveRuntimeReferences: async () => await Promise.resolve(),
      validationSteps: [],
      env: {
        RUNTIME_PROFILE: 'local-demo',
        LOG_FORMAT: 'text',
        LOG_LEVEL: 'warn',
      },
    });

    expect(loggerMocks.configureLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'json',
        jsonOutputMode: 'lambda-native',
      }),
    );
  });

  it('logs exact reference names and rejects with a fresh names-only error', async () => {
    const unsafeOriginal =
      'SESSION_CAPABILITY_SECRET=never-log s3://private-bucket/sessions/raw/input.json token=eyJhbGciOiJIUzI1NiJ9';
    const resolutionError = new Error(unsafeOriginal, {
      cause: new Error('nested VOTE_SECRET_ENCRYPTION_KEY=also-private'),
    });

    const rejectedError = await captureRejectedError(
      bootstrapLambdaRuntime({
        serviceName: 'verification-worker',
        runtimeProfile: activeTargetProfile,
        resolveRuntimeReferences: (invalidNames) => {
          invalidNames.add('VOTE_SECRET_ENCRYPTION_KEY_REF');
          return Promise.reject(resolutionError);
        },
        validationSteps: [
          {
            validate: vi.fn(),
          },
        ],
      }),
    );

    expect(rejectedError).toBeInstanceOf(RuntimeConfigValidationError);
    expect(rejectedError).not.toBe(resolutionError);
    expect(rejectedError).toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['VOTE_SECRET_ENCRYPTION_KEY_REF'],
    });
    expect(rejectedError.cause).toBeUndefined();
    expect(Object.hasOwn(rejectedError, 'cause')).toBe(false);
    expect(serializeRejectedError(rejectedError)).not.toContain(unsafeOriginal);
    expect(serializeRejectedError(rejectedError)).not.toContain('also-private');

    expect(loggerMocks.error).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['VOTE_SECRET_ENCRYPTION_KEY_REF'],
    });
    expect(JSON.stringify(loggerMocks.error.mock.calls)).not.toContain('never-log');
  });

  it('sanitizes typed validator errors before they can reach Lambda platform logging', async () => {
    const unsafeOriginal = 's3://private-bucket/sessions/raw-session/input.json bearer=stark-secret-token-value';
    const validationError = new RuntimeConfigValidationError(
      ['PROVER_STATE_MACHINE_ARN'],
      new Error('SESSION_CAPABILITY_SECRET=nested-private'),
      unsafeOriginal,
    );

    const rejectedError = await captureRejectedError(
      bootstrapLambdaRuntime({
        serviceName: 'proof-dispatcher',
        runtimeProfile: activeTargetProfile,
        resolveRuntimeReferences: async () => await Promise.resolve(),
        validationSteps: [
          {
            validate: () => {
              throw validationError;
            },
          },
        ],
      }),
    );

    expect(rejectedError).toBeInstanceOf(RuntimeConfigValidationError);
    expect(rejectedError).not.toBe(validationError);
    expect(rejectedError).toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['PROVER_STATE_MACHINE_ARN'],
    });
    expect(rejectedError.cause).toBeUndefined();
    expect(Object.hasOwn(rejectedError, 'cause')).toBe(false);
    expect(serializeRejectedError(rejectedError)).not.toContain('private-bucket');
    expect(serializeRejectedError(rejectedError)).not.toContain('stark-secret-token-value');
    expect(serializeRejectedError(rejectedError)).not.toContain('nested-private');

    expect(loggerMocks.error).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['PROVER_STATE_MACHINE_ARN'],
    });
    expect(JSON.stringify(loggerMocks.error.mock.calls)).not.toContain('private-bucket');
  });

  it('preserves an untyped reference resolver programming failure when no invalid names were collected', async () => {
    const unexpectedError = new Error('resolver implementation failed');

    await expect(
      bootstrapLambdaRuntime({
        serviceName: 'verification-worker',
        runtimeProfile: activeTargetProfile,
        resolveRuntimeReferences: () => Promise.reject(unexpectedError),
        validationSteps: [],
      }),
    ).rejects.toBe(unexpectedError);

    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it('keeps text logging available only when an explicit non-target runtime requests it', async () => {
    process.env['LOG_FORMAT'] = 'text';

    await bootstrapLambdaRuntime({
      serviceName: 'local-test-worker',
      runtimeProfile: localProfile,
      resolveRuntimeReferences: async () => await Promise.resolve(),
      validationSteps: [],
    });

    expect(loggerMocks.configureLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'text',
        jsonOutputMode: 'serialized',
        includeStack: true,
      }),
    );
  });

  it('omits malformed deployment authority from the minimal logger until validation rejects it', async () => {
    process.env['DEPLOYMENT_ID'] = 'dep_example';
    process.env['APP_SOURCE_SHA'] = 'not-a-sha';
    process.env['DEPLOY_MODE'] = 'static-fast';

    await bootstrapLambdaRuntime({
      serviceName: 'verification-worker',
      runtimeProfile: activeTargetProfile,
      resolveRuntimeReferences: async () => await Promise.resolve(),
      validationSteps: [],
    });

    const serializedCalls = JSON.stringify(loggerMocks.configureLogger.mock.calls);
    expect(serializedCalls).not.toContain('deploymentId');
    expect(serializedCalls).not.toContain('appSourceSha');
    expect(serializedCalls).not.toContain('deployMode');
  });

  it('does not mislabel an untyped programming failure as configuration invalid', async () => {
    const unexpectedError = new Error('validator implementation failed');

    await expect(
      bootstrapLambdaRuntime({
        serviceName: 'verification-worker',
        runtimeProfile: activeTargetProfile,
        resolveRuntimeReferences: async () => await Promise.resolve(),
        validationSteps: [
          {
            validate: () => {
              throw unexpectedError;
            },
          },
        ],
      }),
    ).rejects.toBe(unexpectedError);

    expect(loggerMocks.error).not.toHaveBeenCalled();
  });
});
