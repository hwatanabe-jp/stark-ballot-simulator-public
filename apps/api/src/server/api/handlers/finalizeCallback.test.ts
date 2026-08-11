import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { createMockVoteStore } from '../../__tests__/support/mockVoteStore';
import { parseFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stark-ballot/diagnostics/canonicalEvents')>()),
  emitCanonicalEvent: emitCanonicalEventMock,
}));

import {
  admitFinalizationCallbackRequest,
  finalizeCallbackHandler as admittedFinalizeCallbackHandler,
} from './finalizeCallback';
import type { ApiContextStore } from '../context';

async function finalizeCallbackHandler({
  request,
  store,
}: {
  request: Request;
  store: ApiContextStore;
}): Promise<Response> {
  const input = await admitFinalizationCallbackRequest(request);
  if (input instanceof Response) {
    return input;
  }
  const pathMatch = new URL(request.url).pathname.match(
    /^\/api\/internal\/sessions\/([^/]+)\/finalizations\/([^/]+)\/callback$/,
  );
  if (!pathMatch?.[1] || !pathMatch[2]) {
    throw new Error('Callback test request must use the canonical internal route');
  }
  return admittedFinalizeCallbackHandler({
    rawBody: input.rawBody,
    sessionId: decodeURIComponent(pathMatch[1]),
    finalizationId: decodeURIComponent(pathMatch[2]),
    store,
  });
}

describe('parseFinalizationStateUpdatePayload', () => {
  const basePayload = {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    finalizationId: 'exec-123456',
    status: 'FAILED',
    queuedAtMs: 1730000000000,
  } as const;

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe finalizationId %s',
    (finalizationId) => {
      expect(parseFinalizationStateUpdatePayload({ ...basePayload, finalizationId })).toBeUndefined();
    },
  );

  it.each(['550e8400/e29b-41d4-a716-446655440000', '550e8400.e29b-41d4-a716-446655440000'])(
    'rejects unsafe sessionId %s',
    (sessionId) => {
      expect(parseFinalizationStateUpdatePayload({ ...basePayload, sessionId })).toBeUndefined();
    },
  );

  it('rejects unexpected top-level fields', () => {
    expect(parseFinalizationStateUpdatePayload({ ...basePayload, unexpected: true })).toBeUndefined();
  });

  it.each([
    ['malformed failed error', { ...basePayload, error: { code: 'TEST_FAILURE' } }],
    ['malformed succeeded result', { ...basePayload, status: 'SUCCEEDED', finalizationResult: { tally: {} } }],
    ['malformed bundle metadata', { ...basePayload, bundleMetadata: { s3BundleKey: 123 } }],
  ])('rejects %s', (_name, payload) => {
    expect(parseFinalizationStateUpdatePayload(payload)).toBeUndefined();
  });
});

describe('finalizeCallbackHandler', () => {
  const secret = 'test-finalization-writer-secret-0123456789abcdef';
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const finalizationId = 'exec-123456';
  const validFailedPayload = {
    sessionId,
    finalizationId,
    status: 'FAILED',
    queuedAtMs: 1730000000000,
    failedAtMs: 1730000000100,
    error: {
      code: 'PROVER_TASK_FAILED',
      message: 'Finalization failed',
      category: 'prover_execution',
    },
  } as const;
  const validFailedBody = JSON.stringify(validFailedPayload);

  beforeEach(() => {
    emitCanonicalEventMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function signedRequest(
    rawBody: string | Uint8Array,
    options: { timestamp?: string; signature?: string; headers?: Record<string, string> } = {},
  ): Request {
    const timestamp = options.timestamp ?? new Date().toISOString();
    const rawBodyBytes = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody;
    const signature =
      options.signature ??
      createHmac('sha256', secret).update(timestamp).update('.').update(rawBodyBytes).digest('hex');
    const requestBody = typeof rawBody === 'string' ? rawBody : new Uint8Array(rawBody).buffer;
    return new Request(`http://localhost/api/internal/sessions/${sessionId}/finalizations/${finalizationId}/callback`, {
      method: 'POST',
      body: requestBody,
      headers: {
        'content-type': 'application/json',
        'x-finalization-writer-timestamp': timestamp,
        'x-finalization-writer-signature': signature,
        ...options.headers,
      },
    });
  }

  function expectUpdateEvent(
    outcome_code: string,
    auth_result: string,
    correlation?: { sessionId: string; finalizationId: string },
  ): void {
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'http_callback',
      auth_result,
      outcome_code,
      ...(correlation
        ? {
            session_id_hash: hashSessionIdForLogging(correlation.sessionId),
            finalization_id: correlation.finalizationId,
          }
        : {}),
    });
  }

  it('rejects a signed payload with unexpected top-level fields before applying it', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const markFinalizationFailed = vi.fn();
    const store = createMockVoteStore({ markFinalizationFailed });
    const rawBody = JSON.stringify({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      finalizationId: 'exec-123456',
      status: 'FAILED',
      queuedAtMs: 1730000000000,
      failedAtMs: 1730000000100,
      error: {
        code: 'TEST_FAILURE',
        message: 'test failure',
      },
      unexpected: true,
    });

    const response = await finalizeCallbackHandler({
      request: signedRequest(rawBody),
      store,
    });
    const payload = await readJsonRecord(response, 'finalize callback response');

    expect(response.status).toBe(400);
    expect(payload['error']).toBe('Invalid callback payload');
    expect(markFinalizationFailed).not.toHaveBeenCalled();
    expectUpdateEvent('payload_invalid', 'passed');
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(rawBody);
  });

  it('rejects a signed payload with malformed nested error before applying it', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const markFinalizationFailed = vi.fn();
    const store = createMockVoteStore({ markFinalizationFailed });
    const rawBody = JSON.stringify({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      finalizationId: 'exec-123456',
      status: 'FAILED',
      queuedAtMs: 1730000000000,
      failedAtMs: 1730000000100,
      error: {
        code: 'TEST_FAILURE',
      },
    });

    const response = await finalizeCallbackHandler({
      request: signedRequest(rawBody),
      store,
    });
    const payload = await readJsonRecord(response, 'finalize callback response');

    expect(response.status).toBe(400);
    expect(payload['error']).toBe('Invalid callback payload');
    expect(markFinalizationFailed).not.toHaveBeenCalled();
    expectUpdateEvent('payload_invalid', 'passed');
  });

  it('authenticates exact raw bytes before decoding an invalid UTF-8 body', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const rawBody = Uint8Array.from([0xff]);

    const response = await finalizeCallbackHandler({
      request: signedRequest(rawBody),
      store: createMockVoteStore(),
    });
    const payload = await readJsonRecord(response, 'invalid UTF-8 callback response');

    expect(response.status).toBe(400);
    expect(payload['error']).toBe('Invalid JSON payload');
    expectUpdateEvent('payload_invalid', 'passed');
  });

  it('rejects an invalid signature before inspecting malformed JSON', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const malformedJson = '{';

    const response = await finalizeCallbackHandler({
      request: signedRequest(malformedJson, { signature: 'f'.repeat(64) }),
      store: createMockVoteStore(),
    });
    const payload = await readJsonRecord(response, 'invalid callback signature response');

    expect(response.status).toBe(401);
    expect(payload['error']).toBe('Invalid callback signature');
    expectUpdateEvent('signature_invalid', 'failed');
  });

  it('records early callback authentication and admission refusals without sensitive inputs', async () => {
    const privateSignature = 'f'.repeat(64);
    const cases = [
      {
        name: 'secret unavailable',
        prepare: () => vi.stubEnv('FINALIZE_CALLBACK_SECRET', ''),
        request: () =>
          new Request(`http://localhost/api/internal/sessions/${sessionId}/finalizations/${finalizationId}/callback`, {
            method: 'POST',
          }),
        outcome: 'secret_unavailable',
        auth: 'not_checked',
        status: 500,
      },
      {
        name: 'signature headers missing',
        prepare: () => vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret),
        request: () =>
          new Request(`http://localhost/api/internal/sessions/${sessionId}/finalizations/${finalizationId}/callback`, {
            method: 'POST',
            body: validFailedBody,
          }),
        outcome: 'signature_headers_missing',
        auth: 'failed',
        status: 401,
      },
      {
        name: 'timestamp invalid',
        prepare: () => vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret),
        request: () => signedRequest(validFailedBody, { timestamp: 'not-a-timestamp' }),
        outcome: 'timestamp_invalid',
        auth: 'failed',
        status: 401,
      },
      {
        name: 'signature invalid',
        prepare: () => vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret),
        request: () => signedRequest(validFailedBody, { signature: privateSignature }),
        outcome: 'signature_invalid',
        auth: 'failed',
        status: 401,
      },
    ] as const;

    for (const testCase of cases) {
      emitCanonicalEventMock.mockClear();
      vi.unstubAllEnvs();
      testCase.prepare();

      const response = await finalizeCallbackHandler({
        request: testCase.request(),
        store: createMockVoteStore(),
      });

      expect(response.status, testCase.name).toBe(testCase.status);
      expectUpdateEvent(testCase.outcome, testCase.auth);
      const serializedEvents = JSON.stringify(emitCanonicalEventMock.mock.calls);
      expect(serializedEvents).not.toContain(validFailedBody);
      expect(serializedEvents).not.toContain(privateSignature);
      expect(serializedEvents).not.toContain('x-finalization-writer');
    }
  });

  it('rejects missing callback authority before applying body-limit admission', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_BODY_LIMIT_BYTES', '1');
    const oversizedBody = 'private-body-that-exceeds-the-limit';
    const callbackUrl = `http://localhost/api/internal/sessions/${sessionId}/finalizations/${finalizationId}/callback`;

    vi.stubEnv('FINALIZE_CALLBACK_SECRET', '');
    const missingSecret = await finalizeCallbackHandler({
      request: new Request(callbackUrl, {
        method: 'POST',
        body: oversizedBody,
      }),
      store: createMockVoteStore(),
    });
    expect(missingSecret.status).toBe(500);
    expectUpdateEvent('secret_unavailable', 'not_checked');
    expect(emitCanonicalEventMock).toHaveBeenCalledTimes(1);

    emitCanonicalEventMock.mockClear();
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const missingHeaders = await finalizeCallbackHandler({
      request: new Request(callbackUrl, {
        method: 'POST',
        body: oversizedBody,
      }),
      store: createMockVoteStore(),
    });
    expect(missingHeaders.status).toBe(401);
    expectUpdateEvent('signature_headers_missing', 'failed');
    expect(emitCanonicalEventMock).toHaveBeenCalledTimes(1);
  });

  it('records body-limit and timestamp-skew configuration refusals', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    vi.stubEnv('FINALIZE_CALLBACK_BODY_LIMIT_BYTES', '1');

    const oversized = await finalizeCallbackHandler({
      request: signedRequest(validFailedBody),
      store: createMockVoteStore(),
    });

    expect(oversized.status).toBe(413);
    expectUpdateEvent('payload_too_large', 'not_checked');

    emitCanonicalEventMock.mockClear();
    vi.stubEnv('FINALIZE_CALLBACK_BODY_LIMIT_BYTES', '-1');
    const invalidLimit = await finalizeCallbackHandler({
      request: signedRequest(validFailedBody),
      store: createMockVoteStore(),
    });
    expect(invalidLimit.status).toBe(500);
    expectUpdateEvent('body_limit_invalid', 'not_checked');

    emitCanonicalEventMock.mockClear();
    vi.stubEnv('FINALIZE_CALLBACK_BODY_LIMIT_BYTES', '8192');
    vi.stubEnv('FINALIZE_CALLBACK_MAX_SKEW_MS', '-1');
    const invalidSkew = await finalizeCallbackHandler({
      request: signedRequest(validFailedBody),
      store: createMockVoteStore(),
    });
    expect(invalidSkew.status).toBe(500);
    expectUpdateEvent('skew_config_invalid', 'not_checked');
  });

  it('preserves the callback-specific body read failure response', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const timestamp = new Date().toISOString();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('callback body stream failed'));
      },
    });
    const request = new Request(
      `http://localhost/api/internal/sessions/${sessionId}/finalizations/${finalizationId}/callback`,
      {
        method: 'POST',
        body,
        duplex: 'half',
        headers: {
          'x-finalization-writer-timestamp': timestamp,
          'x-finalization-writer-signature': '0'.repeat(64),
        },
      } as RequestInit & { duplex: 'half' },
    );

    const response = await finalizeCallbackHandler({
      request,
      store: createMockVoteStore(),
    });
    const payload = await readJsonRecord(response, 'callback body read failure');

    expect(response.status).toBe(400);
    expect(payload['error']).toBe('Invalid callback payload');
    expectUpdateEvent('payload_read_failed', 'not_checked');
  });

  it('records transition-store refusal, strict retired-shape rejection, unexpected failure, and success', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const unavailableStore = createMockVoteStore();
    Object.assign(unavailableStore, { markAwsFinalizationRunning: undefined });

    const unavailable = await finalizeCallbackHandler({
      request: signedRequest(validFailedBody),
      store: unavailableStore,
    });
    expect(unavailable.status).toBe(501);
    expectUpdateEvent('transition_store_unavailable', 'passed', { sessionId, finalizationId });

    const retiredShapeBody = JSON.stringify({
      ...validFailedPayload,
      contractGeneration: 'legacy',
    });
    emitCanonicalEventMock.mockClear();
    const markRetiredShapeFailed = vi.fn();
    const retiredShapeStore = createMockVoteStore({
      markAwsFinalizationFailed: markRetiredShapeFailed,
    });
    const retiredShape = await finalizeCallbackHandler({
      request: signedRequest(retiredShapeBody),
      store: retiredShapeStore,
    });
    expect(retiredShape.status).toBe(400);
    expect(markRetiredShapeFailed).not.toHaveBeenCalled();
    expectUpdateEvent('payload_invalid', 'passed');

    emitCanonicalEventMock.mockClear();
    const unexpectedStore = createMockVoteStore({
      markAwsFinalizationFailed: vi.fn().mockRejectedValue(new Error('private database failure detail')),
    });
    await expect(
      finalizeCallbackHandler({ request: signedRequest(validFailedBody), store: unexpectedStore }),
    ).rejects.toThrow('private database failure detail');
    expectUpdateEvent('application_failed', 'passed', { sessionId, finalizationId });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('private database failure detail');

    emitCanonicalEventMock.mockClear();
    const failedState = {
      status: 'failed' as const,
      finalizationId,
      queuedAtMs: 1730000000000,
      failedAtMs: 1730000000100,
      error: {
        code: 'PROVER_EXECUTION_FAILED',
        message: 'Finalization failed',
        category: 'prover_execution' as const,
      },
    };
    const successStore = createMockVoteStore({
      markAwsFinalizationFailed: vi.fn().mockResolvedValue(failedState),
      getFinalizationRecord: vi.fn().mockResolvedValue({
        sessionId,
        finalizationId,
        scenarioContext: {
          scenarios: [],
          tamperMode: 'none',
          claimedCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
          claimedTotalVotes: 0,
          summary: {
            ignoredCount: 0,
            recountedCount: 0,
            userRecountChoice: null,
          },
        },
        state: failedState,
      }),
    });
    const applied = await finalizeCallbackHandler({
      request: signedRequest(validFailedBody),
      store: successStore,
    });
    expect(applied.status).toBe(200);
    expectUpdateEvent('applied', 'passed', { sessionId, finalizationId });
  });
});
