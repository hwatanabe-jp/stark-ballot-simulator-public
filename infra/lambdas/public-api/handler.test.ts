import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { APIGatewayProxyResult } from '@hono/aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  honoHandler: vi.fn(async (): Promise<APIGatewayProxyResult> => ({
    statusCode: 200,
    body: '',
    isBase64Encoded: false,
    headers: {},
  })),
  responseMetadata: vi.fn((stream: Writable, _metadata: unknown) => stream),
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

vi.mock('@hono/aws-lambda', () => ({
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
vi.stubGlobal('awslambda', {
  streamifyResponse: (handler: unknown) => handler,
  HttpResponseStream: { from: mocks.responseMetadata },
});
const { handler } = await import('./handler');

async function invoke(event: unknown, context: unknown) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await (handler as (...args: unknown[]) => Promise<void>)(event, stream, context);
  return {
    metadata: mocks.responseMetadata.mock.lastCall?.[1],
    body: Buffer.concat(chunks),
    ended: stream.writableFinished,
  };
}

async function invokeStatus(event: unknown, context: unknown) {
  const result = await invoke(event, context);
  return { statusCode: (result.metadata as { statusCode: number }).statusCode };
}

function createValidGatewayEvent(requestId = 'trusted-gateway-id'): Record<string, unknown> {
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const progressPath = `/api/sessions/${sessionId}/progress`;
  return {
    resource: '/api/sessions/{sessionId}/progress',
    path: progressPath,
    httpMethod: 'GET',
    body: null,
    isBase64Encoded: false,
    requestContext: {
      requestId: 'client-overridable',
      extendedRequestId: requestId,
      stage: 'live',
      domainName: 'example.execute-api.ap-northeast-1.amazonaws.com',
      identity: { sourceIp: '203.0.113.1' },
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

  it('bootstraps references and component validation before handling a valid API Gateway REST invocation', async () => {
    await invokeStatus(createValidGatewayEvent(), {
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

    await expect(invokeStatus(createValidGatewayEvent(), { awsRequestId: 'request-1' })).rejects.toThrow(
      'target AWS runtime profile',
    );

    expect(mocks.honoHandler).not.toHaveBeenCalled();
    expect(apiModule.createHonoApp).not.toHaveBeenCalled();
  });

  it('allows the develop-only quiesced AWS recovery profile', async () => {
    mocks.runtimeProfile.name = 'target-aws-async-quiesced';

    await expect(invokeStatus(createValidGatewayEvent(), { awsRequestId: 'request-1' })).resolves.toEqual({
      statusCode: 200,
    });

    expect(observabilityModule.validateTargetObservabilityEnv).toHaveBeenCalledWith(mocks.runtimeProfile, process.env);
    expect(mocks.honoHandler).toHaveBeenCalledTimes(1);
  });

  it('fails the request before Hono when the target observability contract is invalid', async () => {
    const observabilityError = new Error('invalid target observability contract');
    vi.mocked(observabilityModule.validateTargetObservabilityEnv).mockImplementationOnce(() => {
      throw observabilityError;
    });

    await expect(invokeStatus(createValidGatewayEvent(), { awsRequestId: 'request-1' })).rejects.toThrow(
      observabilityError,
    );

    const resolverCall = vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mock.calls.at(-1);
    expect(resolverCall?.[0]).toBe('public_api');
    expect(typeof resolverCall?.[1]?.invalidNameCollector?.add).toBe('function');
    expect(mocks.honoHandler).not.toHaveBeenCalled();
  });

  it('emits invocation_invalid without the raw event when requestContext.extendedRequestId is missing', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const malformedEvent = {
      path: `/api/sessions/${rawSessionId}/finalizations/current`,
      headers: {
        'x-request-id': rawSessionId,
        'x-session-capability': 'v1.ABCDEFGHIJKLMNOP.QRSTUVWXYZabcdef',
      },
      requestContext: {},
    };

    await expect(invokeStatus(malformedEvent, { awsRequestId: 'lambda-request-1' })).rejects.toThrow(
      'Invalid API Gateway REST invocation',
    );

    expect(mocks.bootstrapLambdaRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.honoHandler).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith('API Gateway invocation is invalid', {
      event: 'invocation_invalid',
      source_kind: 'api_gateway_rest',
      reason: 'request_id_missing',
    });
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(rawSessionId);
  });

  it('rejects HTTP gateway shapes before the Hono adapter inspects them', async () => {
    const malformedEvent = {
      version: '2.0',
      requestContext: { extendedRequestId: 'trusted-gateway-id' },
    };

    await expect(invokeStatus(malformedEvent, { awsRequestId: 'lambda-request-1' })).rejects.toThrow(
      'Invalid API Gateway REST invocation',
    );

    expect(mocks.honoHandler).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith('API Gateway invocation is invalid', {
      event: 'invocation_invalid',
      source_kind: 'api_gateway_rest',
      reason: 'event_shape_invalid',
    });
  });
  it.each([false, true])('streams exact response bytes and multi-value headers (binary=%s)', async (binary) => {
    const bytes = binary ? Buffer.alloc(4 * 1024 * 1024, 193) : Buffer.from('{"message":"投票😀"}');
    const metadata = {
      statusCode: binary ? 206 : 200,
      multiValueHeaders: {
        'content-type': [binary ? 'application/zip' : 'application/json'],
        etag: ['"exact-artifact"'],
        'x-request-id': ['trusted-gateway-id'],
        'set-cookie': ['first=1', 'second=2'],
        ...(binary ? { 'content-range': [`bytes 0-${bytes.length - 1}/${bytes.length + 1}`] } : {}),
      },
    };
    mocks.honoHandler.mockResolvedValueOnce({
      ...metadata,
      body: bytes.toString(binary ? 'base64' : 'utf8'),
      isBase64Encoded: binary,
    });
    const result = await invoke(createValidGatewayEvent(), { awsRequestId: 'request-1' });
    expect(result.metadata).toEqual(metadata);
    expect(createHash('sha256').update(result.body).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(result.ended).toBe(true);
  });

  it.each([204, 304, 416])('ends an empty response with status %s', async (statusCode) => {
    mocks.honoHandler.mockResolvedValueOnce({
      statusCode,
      body: '',
      isBase64Encoded: false,
      headers: { etag: '"artifact"' },
    });
    const result = await invoke(createValidGatewayEvent(), { awsRequestId: 'request-1' });
    expect(result.metadata).toEqual({ statusCode, headers: { etag: '"artifact"' } });
    expect(result.body.length).toBe(0);
    expect(result.ended).toBe(true);
  });

  it('does not start a successful response when Hono fails', async () => {
    mocks.honoHandler.mockRejectedValueOnce(new Error('upstream failed'));
    await expect(invoke(createValidGatewayEvent(), { awsRequestId: 'request-1' })).rejects.toThrow('upstream failed');
    expect(mocks.responseMetadata).not.toHaveBeenCalled();
  });

  it('propagates response stream failures', async () => {
    mocks.honoHandler.mockResolvedValueOnce({ statusCode: 200, body: 'response', isBase64Encoded: false, headers: {} });
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('stream closed'));
      },
    });
    await expect(
      (handler as (...args: unknown[]) => Promise<void>)(createValidGatewayEvent(), stream, {}),
    ).rejects.toThrow('stream closed');
  });
});
