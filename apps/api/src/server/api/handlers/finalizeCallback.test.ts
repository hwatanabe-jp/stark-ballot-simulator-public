import { createHmac } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { parseFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function signedRequest(rawBody: string): Request {
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    return new Request('http://localhost/api/finalize/callback', {
      method: 'POST',
      body: rawBody,
      headers: {
        'content-type': 'application/json',
        'x-finalization-writer-timestamp': timestamp,
        'x-finalization-writer-signature': signature,
      },
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
  });
});
