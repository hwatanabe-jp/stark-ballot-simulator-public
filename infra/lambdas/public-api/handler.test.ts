import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  honoHandler: vi.fn(async () => await Promise.resolve({ statusCode: 200 })),
  bootstrapLambdaRuntime: vi.fn(
    async (options: {
      serviceName: string;
      resolveRuntimeReferences: (invalidNames: { add(name: Uppercase<string>): void }) => Promise<void>;
      validationSteps: ReadonlyArray<{
        validate: () => void | Promise<void>;
      }>;
    }) => {
      await options.resolveRuntimeReferences({ add: vi.fn() });
      for (const step of options.validationSteps) {
        await step.validate();
      }
    },
  ),
  loggerError: vi.fn(),
  runtimeProfile: {
    name: 'target-aws-async',
    target: { kind: 'aws', deploymentEnvironment: 'develop' },
    external: { kind: 'aws', region: 'ap-northeast-1' },
  },
}));

vi.mock('hono/aws-lambda', () => ({
  handle: vi.fn(() => mocks.honoHandler),
}));

vi.mock('@stark-ballot/api/server', () => ({
  createHonoApp: vi.fn(() => ({ kind: 'test-app' })),
}));

vi.mock('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver', () => ({
  ensureAwsRuntimeConfigReferencesLoaded: vi.fn(async () => await Promise.resolve(undefined)),
}));

vi.mock('@stark-ballot/runtime-config/env/observability', () => ({
  validateTargetObservabilityEnv: vi.fn(),
}));

vi.mock('@stark-ballot/runtime-config/env/runtimeProfile', () => ({
  resolveRuntimeProfile: vi.fn(() => mocks.runtimeProfile),
  validateRuntimeProfileSelection: vi.fn(),
}));

vi.mock('@stark-ballot/runtime-config/env/validate', () => ({
  validateEnv: vi.fn(),
}));

vi.mock('../runtimeBootstrap.js', () => ({
  bootstrapLambdaRuntime: mocks.bootstrapLambdaRuntime,
}));

vi.mock('@stark-ballot/diagnostics/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

const resolverModule = await import('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver');
const apiModule = await import('@stark-ballot/api/server');
const observabilityModule = await import('@stark-ballot/runtime-config/env/observability');
const envModule = await import('@stark-ballot/runtime-config/env/validate');
const { handler } = await import('./handler');

function createValidGatewayEvent(requestId = 'trusted-gateway-id'): Record<string, unknown> {
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const progressPath = `/api/sessions/${sessionId}/progress`;
  return {
    version: '2.0',
    rawPath: progressPath,
    rawQueryString: '',
    requestContext: {
      requestId,
      http: {
        method: 'GET',
        path: progressPath,
      },
    },
  };
}

describe('target public API handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeProfile.name = 'target-aws-async';
    mocks.runtimeProfile.target = { kind: 'aws', deploymentEnvironment: 'develop' };
    mocks.runtimeProfile.external = { kind: 'aws', region: 'ap-northeast-1' };
  });

  it('bootstraps references and component validation before handling a valid API Gateway v2 invocation', async () => {
    await (handler as (...args: unknown[]) => Promise<unknown>)(createValidGatewayEvent(), {
      awsRequestId: 'lambda-request-1',
    });

    expect(mocks.bootstrapLambdaRuntime).toHaveBeenCalledTimes(1);
    const bootstrapOptions = mocks.bootstrapLambdaRuntime.mock.calls[0]?.[0];
    expect(bootstrapOptions?.serviceName).toBe('public-api');
    expect(bootstrapOptions?.validationSteps).toHaveLength(4);
    const resolverCall = vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mock.calls.at(-1);
    expect(resolverCall?.[0]).toBe('public_api');
    expect(typeof resolverCall?.[1]?.invalidNameCollector?.add).toBe('function');
    expect(observabilityModule.validateTargetObservabilityEnv).toHaveBeenCalledWith(mocks.runtimeProfile, process.env);
    expect(envModule.validateEnv).toHaveBeenCalledWith(mocks.runtimeProfile, process.env);
    expect(apiModule.createHonoApp).toHaveBeenCalledWith({
      basePath: '/api',
      mode: 'lambda',
      runtimeProfile: mocks.runtimeProfile,
    });
    expect(vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(apiModule.createHonoApp).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.honoHandler).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-target runtime profile before creating the public API', async () => {
    mocks.runtimeProfile.name = 'local-demo';
    mocks.runtimeProfile.target = { kind: 'local', deploymentEnvironment: 'local' };
    mocks.runtimeProfile.external = { kind: 'local', region: 'local' };

    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)(createValidGatewayEvent(), { awsRequestId: 'request-1' }),
    ).rejects.toThrow('target AWS runtime profile');

    expect(mocks.honoHandler).not.toHaveBeenCalled();
    expect(apiModule.createHonoApp).not.toHaveBeenCalled();
  });

  it('allows the develop-only quiesced AWS recovery profile', async () => {
    mocks.runtimeProfile.name = 'target-aws-async-quiesced';

    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)(createValidGatewayEvent(), { awsRequestId: 'request-1' }),
    ).resolves.toEqual({ statusCode: 200 });

    expect(observabilityModule.validateTargetObservabilityEnv).toHaveBeenCalledWith(mocks.runtimeProfile, process.env);
    expect(mocks.honoHandler).toHaveBeenCalledTimes(1);
  });

  it('fails the request before Hono when the target observability contract is invalid', async () => {
    const observabilityError = new Error('invalid target observability contract');
    vi.mocked(observabilityModule.validateTargetObservabilityEnv).mockImplementationOnce(() => {
      throw observabilityError;
    });

    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)(createValidGatewayEvent(), { awsRequestId: 'request-1' }),
    ).rejects.toThrow(observabilityError);

    const resolverCall = vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mock.calls.at(-1);
    expect(resolverCall?.[0]).toBe('public_api');
    expect(typeof resolverCall?.[1]?.invalidNameCollector?.add).toBe('function');
    expect(mocks.honoHandler).not.toHaveBeenCalled();
  });

  it('emits invocation_invalid without the raw event when requestContext.requestId is missing', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const malformedEvent = {
      version: '2.0',
      rawPath: `/api/sessions/${rawSessionId}/finalizations/current`,
      headers: {
        'x-request-id': rawSessionId,
        'x-session-capability': 'v1.ABCDEFGHIJKLMNOP.QRSTUVWXYZabcdef',
      },
      requestContext: {},
    };

    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)(malformedEvent, { awsRequestId: 'lambda-request-1' }),
    ).rejects.toThrow('Invalid API Gateway v2 invocation');

    expect(mocks.bootstrapLambdaRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.honoHandler).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith('API Gateway invocation is invalid', {
      event: 'invocation_invalid',
      source_kind: 'api_gateway_v2',
      reason: 'request_id_missing',
    });
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(rawSessionId);
  });

  it('rejects non-v2 gateway shapes before the Hono adapter inspects them', async () => {
    const malformedEvent = {
      version: '2.0',
      requestContext: { requestId: 'trusted-gateway-id' },
    };

    await expect(
      (handler as (...args: unknown[]) => Promise<unknown>)(malformedEvent, { awsRequestId: 'lambda-request-1' }),
    ).rejects.toThrow('Invalid API Gateway v2 invocation');

    expect(mocks.honoHandler).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith('API Gateway invocation is invalid', {
      event: 'invocation_invalid',
      source_kind: 'api_gateway_v2',
      reason: 'event_shape_invalid',
    });
  });
});
