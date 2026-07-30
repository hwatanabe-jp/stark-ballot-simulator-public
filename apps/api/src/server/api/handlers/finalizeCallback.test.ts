import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { parseFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { UnsupportedCurrentArtifactBoundaryError } from '@stark-ballot/domain/contract';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stark-ballot/diagnostics/canonicalEvents')>()),
  emitCanonicalEvent: emitCanonicalEventMock,
}));

import { finalizeCallbackHandler } from './finalizeCallback';

describe('parseFinalizationStateUpdatePayload', () => {
  const basePayload = {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    executionId: 'exec-123456',
    contractGeneration: '2026-04-zkvm-current-v1',
    status: 'FAILED',
    queuedAt: 1730000000000,
  } as const;

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe executionId %s',
    (executionId) => {
      expect(parseFinalizationStateUpdatePayload({ ...basePayload, executionId })).toBeUndefined();
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
  const executionId = 'exec-123456';
  const validFailedBody = JSON.stringify({
    sessionId,
    executionId,
    contractGeneration: '2026-04-zkvm-current-v1',
    status: 'FAILED',
    queuedAt: 1730000000000,
    failedAt: 1730000000100,
    error: {
      code: 'PROVER_TASK_FAILED',
      message: 'Finalization failed',
      category: 'prover_execution',
    },
  });

  beforeEach(() => {
    emitCanonicalEventMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function signedRequest(
    rawBody: string,
    options: { timestamp?: string; signature?: string; headers?: Record<string, string> } = {},
  ): Request {
    const timestamp = options.timestamp ?? new Date().toISOString();
    const signature = options.signature ?? createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    return new Request('http://localhost/api/finalize/callback', {
      method: 'POST',
      body: rawBody,
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
    correlation?: { sessionId: string; executionId: string },
  ): void {
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'http_callback',
      auth_result,
      outcome_code,
      ...(correlation
        ? {
            session_id_hash: hashSessionIdForLogging(correlation.sessionId),
            execution_id: correlation.executionId,
          }
        : {}),
    });
  }

  it('rejects a signed payload with unexpected top-level fields before applying it', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const markFinalizationFailed = vi.fn(() =>
      Promise.resolve({
        status: 'failed' as const,
        executionId: 'exec-123456',
        queuedAt: 1730000000000,
        failedAt: 1730000000100,
        error: {
          code: 'TEST_FAILURE',
          message: 'test failure',
        },
      }),
    );
    const store = createMockVoteStore({ markFinalizationFailed });
    const rawBody = JSON.stringify({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      executionId: 'exec-123456',
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'FAILED',
      queuedAt: 1730000000000,
      failedAt: 1730000000100,
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
      executionId: 'exec-123456',
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'FAILED',
      queuedAt: 1730000000000,
      failedAt: 1730000000100,
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

  it('records early callback authentication and admission refusals without sensitive inputs', async () => {
    const privateSignature = 'f'.repeat(64);
    const cases = [
      {
        name: 'secret unavailable',
        prepare: () => vi.stubEnv('FINALIZE_CALLBACK_SECRET', ''),
        request: () => new Request('http://localhost/api/finalize/callback', { method: 'POST' }),
        outcome: 'secret_unavailable',
        auth: 'not_checked',
        status: 500,
      },
      {
        name: 'signature headers missing',
        prepare: () => vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret),
        request: () => new Request('http://localhost/api/finalize/callback', { method: 'POST', body: validFailedBody }),
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

  it('records transition-store refusal, artifact rejection, unexpected failure, and success', async () => {
    vi.stubEnv('FINALIZE_CALLBACK_SECRET', secret);
    const unavailableStore = createMockVoteStore();
    Object.assign(unavailableStore, { markAwsFinalizationRunning: undefined });

    const unavailable = await finalizeCallbackHandler({
      request: signedRequest(validFailedBody),
      store: unavailableStore,
    });
    expect(unavailable.status).toBe(501);
    expectUpdateEvent('transition_store_unavailable', 'passed', { sessionId, executionId });

    const boundaryError = new UnsupportedCurrentArtifactBoundaryError({
      runtimeContractGeneration: '2026-04-zkvm-current-v1',
      persistedContractGeneration: 'legacy',
      carriedContractGeneration: 'legacy',
    });
    emitCanonicalEventMock.mockClear();
    const artifactStore = createMockVoteStore({
      markAwsFinalizationFailed: vi.fn().mockRejectedValue(boundaryError),
    });
    const artifact = await finalizeCallbackHandler({
      request: signedRequest(validFailedBody),
      store: artifactStore,
    });
    expect(artifact.status).toBe(409);
    expectUpdateEvent('artifact_rejected', 'passed', { sessionId, executionId });

    emitCanonicalEventMock.mockClear();
    const unexpectedStore = createMockVoteStore({
      markAwsFinalizationFailed: vi.fn().mockRejectedValue(new Error('private database failure detail')),
    });
    await expect(
      finalizeCallbackHandler({ request: signedRequest(validFailedBody), store: unexpectedStore }),
    ).rejects.toThrow('private database failure detail');
    expectUpdateEvent('application_failed', 'passed', { sessionId, executionId });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('private database failure detail');

    emitCanonicalEventMock.mockClear();
    const failedState = {
      status: 'failed' as const,
      executionId,
      queuedAt: 1730000000000,
      failedAt: 1730000000100,
      error: {
        code: 'PROVER_EXECUTION_FAILED',
        message: 'Finalization failed',
        category: 'prover_execution' as const,
      },
    };
    const successStore = createMockVoteStore({
      markAwsFinalizationFailed: vi.fn().mockResolvedValue(failedState),
    });
    const applied = await finalizeCallbackHandler({
      request: signedRequest(validFailedBody),
      store: successStore,
    });
    expect(applied.status).toBe(200);
    expectUpdateEvent('applied', 'passed', { sessionId, executionId });
  });
});
