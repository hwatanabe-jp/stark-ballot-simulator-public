import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCurrentFinalization, resolveFinalizationStatusErrorCode } from './finalizations';
import { ApiClientError } from './client';
import {
  clearBrowserPublicEnvForTests,
  setBrowserPublicEnvForTests,
} from '@stark-ballot/runtime-config/env/browserPublic';

const sessionId = '1f8c6e60-8dec-4a44-b19c-c226bb7de6be';
const identity = { sessionId, capabilityToken: 'token-123' };
const requestMeta = { requestId: 'request-id' } as const;
const finalizationId = '01HVN5WA1CEH94868G90QGJ7HX';

const buildRunningResource = () => ({
  finalizationId,
  status: 'running' as const,
  queuedAtMs: 1730000000000,
  startedAtMs: 1730000001000,
  runtimeDiagnostics: {
    asyncMode: 'enabled' as const,
    queue: null,
  },
});

function successEnvelope<T>(data: T) {
  return { data, meta: requestMeta };
}

function errorEnvelope(code: string, message: string) {
  return {
    error: { code, message },
    meta: requestMeta,
  };
}

describe('finalization resource client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    setBrowserPublicEnvForTests('VITE_RUNTIME_PROFILE', 'static-mock-e2e');
  });

  afterEach(() => {
    clearBrowserPublicEnvForTests();
  });

  it('parses a successful current-finalization response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successEnvelope(buildRunningResource())), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchMock;

    const result = await fetchCurrentFinalization(identity, { baseUrl: 'https://example.com' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/sessions/1f8c6e60-8dec-4a44-b19c-c226bb7de6be/finalizations/current',
      {
        headers: { 'X-Session-Capability': 'token-123' },
        method: 'GET',
      },
    );
    expect(result?.status).toBe('running');
    expect(result?.finalizationId).toBe(finalizationId);
  });

  it('throws when the server returns an error response', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errorEnvelope('SESSION_NOT_FOUND', 'Session not found')), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchCurrentFinalization(identity, { baseUrl: 'https://example.com' })).rejects.toThrow(
      ApiClientError,
    );
  });

  it('extracts the API error code from ApiClientError payloads', () => {
    const error = new ApiClientError('missing', 404, errorEnvelope('SESSION_NOT_FOUND', 'Session not found'));

    expect(resolveFinalizationStatusErrorCode(error)).toBe('SESSION_NOT_FOUND');
    expect(resolveFinalizationStatusErrorCode(new Error('plain error'))).toBeNull();
  });
});
