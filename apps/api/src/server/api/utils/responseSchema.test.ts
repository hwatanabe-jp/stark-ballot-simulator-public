import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineRoute, jsonResponse } from '@stark-ballot/api-contract/routes';
import { s } from '@stark-ballot/validation/schema';
import { respondWithRoute } from './responseSchema';
import { apiResponseSchema, publicObject } from '@stark-ballot/api-contract/schemas/primitives';
import { ErrorCode, getErrorMessage } from '@stark-ballot/api-contract/errors/apiErrors';
import { runWithLogContext } from '@stark-ballot/diagnostics/requestLogContext';
import { logger } from '@stark-ballot/diagnostics/logger';

describe('respondWithRoute', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects trusted request metadata before public response admission', async () => {
    const route = defineRoute({
      routeId: 'public-response-schema-test',
      method: 'GET',
      path: '/public-response-schema-test',
      request: {},
      responses: [jsonResponse(200, apiResponseSchema(publicObject({ id: s.string() })))],
    });

    const response = runWithLogContext({ requestId: 'trusted-success-request-id' }, () =>
      respondWithRoute(route, {
        status: 200,
        content: 'json',
        body: {
          data: {
            id: 'current-response',
          },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      data: {
        id: 'current-response',
      },
      meta: {
        requestId: 'trusted-success-request-id',
      },
    });
  });

  it('preserves declared route metadata while overriding a handler-supplied request ID', async () => {
    const route = defineRoute({
      routeId: 'paginated-public-response-schema-test',
      method: 'GET',
      path: '/paginated-public-response-schema-test',
      request: {},
      responses: [
        jsonResponse(
          200,
          apiResponseSchema(publicObject({ id: s.string() }), {
            page: publicObject({
              nextOffset: s.number().int().nonnegative().nullable(),
              hasMore: s.boolean(),
            }).optional(),
          }),
        ),
      ],
    });

    const response = runWithLogContext({ requestId: 'trusted-page-request-id' }, () =>
      respondWithRoute(route, {
        status: 200,
        content: 'json',
        body: {
          data: {
            id: 'current-response',
          },
          meta: {
            requestId: 'forged-handler-request-id',
            page: {
              nextOffset: 50,
              hasMore: true,
            },
          },
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      data: {
        id: 'current-response',
      },
      meta: {
        requestId: 'trusted-page-request-id',
        page: {
          nextOffset: 50,
          hasMore: true,
        },
      },
    });
  });

  it('rejects response payloads with unexpected public fields', async () => {
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const schema = apiResponseSchema(publicObject({ id: s.string() }));
    const route = defineRoute({
      routeId: 'response-schema-test',
      method: 'GET',
      path: '/response-schema-test',
      request: {},
      responses: [jsonResponse(200, schema)],
    });

    const body = {
      data: {
        id: 'current-response',
      },
      verificationBundleUrl: 'https://example.invalid/bundle.zip',
    };
    const output = {
      status: 200,
      content: 'json' as const,
      body,
    } as const;
    const response = runWithLogContext({ requestId: 'trusted-rejection-request-id' }, () =>
      respondWithRoute(route, output),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: getErrorMessage(ErrorCode.INTERNAL_ERROR),
      },
      meta: {
        requestId: 'trusted-rejection-request-id',
      },
    });
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[API] Response schema validation failed',
      expect.objectContaining({
        name: 'SchemaError',
        message: 'verificationBundleUrl: Unrecognized key',
      }),
    );
  });

  it('rejects nested unexpected public fields when the nested response schema is strict', async () => {
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const schema = apiResponseSchema(publicObject({ id: s.string() }));
    const route = defineRoute({
      routeId: 'nested-response-schema-test',
      method: 'GET',
      path: '/nested-response-schema-test',
      request: {},
      responses: [jsonResponse(200, schema)],
    });

    const body = {
      data: {
        id: 'current-response',
        privateArtifact: 'input.json',
      },
    };
    const output = {
      status: 200,
      content: 'json' as const,
      body,
    } as const;
    const response = runWithLogContext({ requestId: 'trusted-nested-rejection-id' }, () =>
      respondWithRoute(route, output),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: getErrorMessage(ErrorCode.INTERNAL_ERROR),
      },
      meta: {
        requestId: 'trusted-nested-rejection-id',
      },
    });
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[API] Response schema validation failed',
      expect.objectContaining({
        name: 'SchemaError',
        message: 'data.privateArtifact: Unrecognized key',
      }),
    );
  });

  it('keeps non-envelope callback responses exact', async () => {
    const route = defineRoute({
      routeId: 'callback-response-schema-test',
      method: 'POST',
      path: '/callback-response-schema-test',
      request: {},
      responses: [
        jsonResponse(
          200,
          publicObject({
            sessionId: s.string(),
            state: s.string(),
          }),
        ),
      ],
    });

    const response = runWithLogContext({ requestId: 'trusted-callback-request-id' }, () =>
      respondWithRoute(route, {
        status: 200,
        content: 'json',
        body: {
          sessionId: 'session-1',
          state: 'applied',
        },
      }),
    );

    await expect(response.json()).resolves.toEqual({
      sessionId: 'session-1',
      state: 'applied',
    });
  });
});
