import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApiFetch } from '../fetcher';
import { resetMockState, updateMockState } from '../state';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

const mockRandomUUID = vi.fn();

Object.defineProperty(globalThis, 'crypto', {
  value: { randomUUID: mockRandomUUID },
  writable: true,
});

describe('mockApiFetch', () => {
  beforeEach(() => {
    resetMockState();
    mockRandomUUID.mockReset();
  });

  async function createSession(): Promise<{ sessionId: string; capabilityToken: string }> {
    mockRandomUUID
      .mockReturnValueOnce('session-auth')
      .mockReturnValueOnce('capability-auth')
      .mockReturnValueOnce('550e8400-e29b-41d4-a716-446655440000');
    const response = mockApiFetch('http://localhost/api/session', { method: 'POST' });
    const payload = (await response.json()) as {
      data?: { sessionId?: string; capabilityToken?: string };
    };
    const sessionId = payload.data?.sessionId;
    const capabilityToken = payload.data?.capabilityToken;
    if (!sessionId || !capabilityToken) {
      throw new Error('Invalid mock session payload');
    }
    return { sessionId, capabilityToken };
  }

  it('returns a new session for each /api/session call', async () => {
    mockRandomUUID
      .mockReturnValueOnce('session-1')
      .mockReturnValueOnce('capability-1')
      .mockReturnValueOnce('election-1')
      .mockReturnValueOnce('session-2')
      .mockReturnValueOnce('capability-2')
      .mockReturnValueOnce('election-2');

    const response1 = mockApiFetch('http://localhost/api/session', { method: 'POST' });
    const payload1 = (await response1.json()) as { data?: { sessionId?: string } };

    const response2 = mockApiFetch('http://localhost/api/session', { method: 'POST' });
    const payload2 = (await response2.json()) as { data?: { sessionId?: string } };

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);
    expect(payload1.data?.sessionId).toBe('session-1');
    expect(payload2.data?.sessionId).toBe('session-2');
  });

  it.each([
    { name: 'session creation', url: 'http://localhost/api/session?unexpected=1', init: { method: 'POST' } },
    { name: 'vote submission', url: 'http://localhost/api/vote?unexpected=1', init: { method: 'POST' } },
    { name: 'progress', url: 'http://localhost/api/progress?unexpected=1', init: { method: 'GET' } },
    { name: 'finalize', url: 'http://localhost/api/finalize?unexpected=1', init: { method: 'POST' } },
    {
      name: 'finalize cancel',
      url: 'http://localhost/api/finalize/cancel?unexpected=1',
      init: { method: 'POST' },
    },
    {
      name: 'session status',
      url: 'http://localhost/api/sessions/session-auth/status?unexpected=1',
      init: { method: 'GET' },
    },
    {
      name: 'verification run',
      url: 'http://localhost/api/verification/run?unexpected=1',
      init: { method: 'POST' },
    },
    {
      name: 'verification observation',
      url: 'http://localhost/api/verification/observation?unexpected=1',
      init: { method: 'POST' },
    },
    {
      name: 'bulletin vote proof',
      url: 'http://localhost/api/bulletin/11111111-1111-4111-8111-111111111111/proof?unexpected=1',
      init: { method: 'GET' },
    },
    {
      name: 'local mock finalize shortcut',
      url: 'http://localhost/api/sessions/mock/finalize?unexpected=1',
      init: { method: 'POST' },
    },
  ])('rejects unexpected query parameters for $name before route handling', async ({ url, init }) => {
    const response = mockApiFetch(url, init);
    const payload = (await response.json()) as { error?: string; issues?: { fieldErrors?: Record<string, string[]> } };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('INVALID_REQUEST');
    expect(payload.issues?.fieldErrors?.['unexpected']).toEqual(['Unexpected query parameter']);
  });

  it('rejects invalid finalize request bodies', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch('http://localhost/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
      body: JSON.stringify({ scenarioId: 'S9' }),
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('INVALID_REQUEST');
  });

  it('rejects malformed JSON in mock mutation bodies', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch('http://localhost/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
      body: '{',
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('INVALID_REQUEST');
  });

  it('rejects unexpected fields in mock mutation bodies', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch('http://localhost/api/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
      body: JSON.stringify({
        commitment: `0x${'1'.repeat(64)}`,
        vote: 'A',
        rand: `0x${'2'.repeat(64)}`,
        unexpected: true,
      }),
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('INVALID_REQUEST');
  });

  it('requires capability token for /api/finalize', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/finalize', {
      method: 'POST',
      headers: { 'X-Session-ID': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for /api/vote', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/vote', {
      method: 'POST',
      headers: { 'X-Session-ID': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commitment: `0x${'1'.repeat(64)}`,
        vote: 'A',
        rand: `0x${'2'.repeat(64)}`,
      }),
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for /api/verify', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/verify', {
      method: 'GET',
      headers: { 'X-Session-ID': sessionId },
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for /api/sessions/:id/status', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch(`http://localhost/api/sessions/${sessionId}/status`, {
      method: 'GET',
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for /api/verification/run', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/verification/run', {
      method: 'POST',
      headers: { 'X-Session-ID': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for /api/verification/observation', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/verification/observation', {
      method: 'POST',
      headers: { 'X-Session-ID': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verificationExecutionId: 'mock-verification-001',
        castChecks: {
          cast_receipt_present: 'success',
          cast_choice_range: 'success',
          cast_random_format: 'success',
          cast_commitment_match: 'success',
        },
      }),
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('validates and idempotently records a browser-local verification observation', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const now = Date.now();
    updateMockState((current) => {
      current.finalizationQueuedAt = now - 22_000;
      current.finalizationStartedAt = now - 20_000;
      current.finalizationCompletedAt = now - 1_000;
      current.verificationStatus = 'success';
    });
    const request = {
      method: 'POST',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        verificationExecutionId: 'mock-verification-001',
        castChecks: {
          cast_receipt_present: 'success',
          cast_choice_range: 'success',
          cast_random_format: 'success',
          cast_commitment_match: 'success',
        },
      }),
    };

    const first = mockApiFetch('http://localhost/api/verification/observation', request);
    const second = mockApiFetch('http://localhost/api/verification/observation', request);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: { status: 'recorded' } });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ data: { status: 'idempotent' } });
  });

  it('rejects a verification observation before finalization or while verification is non-terminal', async () => {
    const { sessionId, capabilityToken } = await createSession();
    const request = {
      method: 'POST',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        verificationExecutionId: 'mock-verification-001',
        castChecks: {
          cast_receipt_present: 'success',
          cast_choice_range: 'success',
          cast_random_format: 'success',
          cast_commitment_match: 'success',
        },
      }),
    };

    const beforeFinalization = mockApiFetch('http://localhost/api/verification/observation', request);
    expect(beforeFinalization.status).toBe(409);
    expect(await beforeFinalization.json()).toMatchObject({
      error: 'VERIFICATION_OBSERVATION_CONFLICT',
      statusCode: 409,
    });

    const now = Date.now();
    updateMockState((current) => {
      current.finalizationQueuedAt = now - 22_000;
      current.finalizationStartedAt = now - 20_000;
      current.finalizationCompletedAt = now - 1_000;
      current.verificationStatus = 'running';
    });
    const whileRunning = mockApiFetch('http://localhost/api/verification/observation', request);
    expect(whileRunning.status).toBe(409);
    expect(await whileRunning.json()).toMatchObject({
      error: 'VERIFICATION_OBSERVATION_CONFLICT',
      statusCode: 409,
    });
  });

  it('requires capability token for /api/progress', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/progress', {
      method: 'GET',
      headers: { 'X-Session-ID': sessionId },
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for /api/bulletin', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/bulletin', {
      method: 'GET',
      headers: { 'X-Session-ID': sessionId },
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for /api/bulletin/:voteId/proof', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/bulletin/11111111-1111-4111-8111-111111111111/proof', {
      method: 'GET',
      headers: { 'X-Session-ID': sessionId },
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('requires capability token for /api/bulletin/consistency-proof', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/bulletin/consistency-proof?oldSize=1&newSize=1', {
      method: 'GET',
      headers: { 'X-Session-ID': sessionId },
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('rejects retired /api/botdata/:id access in normal browser mock mode', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/botdata/1', {
      method: 'GET',
      headers: { 'X-Session-ID': sessionId },
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(410);
    expect(payload.error).toBe('ROUTE_RETIRED');
  });

  it('accepts sensitive request with valid capability token', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch('http://localhost/api/verify', {
      method: 'GET',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
    });

    expect(response.status).toBe(200);
  });

  it('returns a canonical current journal for /api/verify?includeJournal=1', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch('http://localhost/api/verify?includeJournal=1', {
      method: 'GET',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
    });
    const payload = (await response.json()) as {
      data?: {
        journalStatus?: string;
        journal?: {
          methodVersion?: number;
          bulletinRoot?: string;
          missingSlots?: number;
        };
        bulletinRoot?: string;
        missingSlots?: number;
        missingIndices?: number;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.data?.journalStatus).toBe('available');
    expect(payload.data?.journal?.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(payload.data?.journal?.bulletinRoot).toBe(payload.data?.bulletinRoot);
    expect(payload.data?.journal?.missingSlots).toBe(payload.data?.missingSlots);
    expect(payload.data?.journal).not.toHaveProperty('missingIndices');
  });

  it('rejects undocumented verify query flags in browser mock mode', async () => {
    const response = mockApiFetch('http://localhost/api/verify?includeJournal=maybe');
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('INVALID_REQUEST');
  });

  it('rejects unexpected bulletin query fields in browser mock mode', async () => {
    const response = mockApiFetch('http://localhost/api/bulletin?offset=0&unexpected=1');
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('INVALID_REQUEST');
  });

  it('accepts zero-size consistency proofs in browser mock mode', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const response = mockApiFetch('http://localhost/api/bulletin/consistency-proof?oldSize=0&newSize=0', {
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
    });
    const payload = (await response.json()) as { oldSize?: number; newSize?: number };

    expect(response.status).toBe(200);
    expect(payload.oldSize).toBe(0);
    expect(payload.newSize).toBe(0);
  });

  it('returns a canonical current journal for /api/sessions/mock/finalize', async () => {
    await createSession();

    const response = mockApiFetch('http://localhost/api/sessions/mock/finalize', {
      method: 'POST',
    });
    const payload = (await response.json()) as {
      data?: {
        journal?: {
          methodVersion?: number;
          bulletinRoot?: string;
          excludedSlots?: number;
          seenIndicesCount?: number;
        };
        bulletinRoot?: string;
        excludedSlots?: number;
        seenIndicesCount?: number;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.data?.journal?.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(payload.data?.journal?.bulletinRoot).toBe(payload.data?.bulletinRoot);
    expect(payload.data?.journal?.excludedSlots).toBe(payload.data?.excludedSlots);
    expect(payload.data?.journal).not.toHaveProperty('excludedCount');
    expect(payload.data?.journal?.seenIndicesCount).toBe(payload.data?.seenIndicesCount);
  });

  it('serves the S5 mock finalize, status, and verify flow with current-contract metrics', async () => {
    const { sessionId, capabilityToken } = await createSession();

    const finalizeResponse = mockApiFetch('http://localhost/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
      body: JSON.stringify({ scenarioId: 'S5' }),
    });
    expect(finalizeResponse.status).toBe(202);

    const now = Date.now();
    updateMockState((current) => {
      current.finalizationQueuedAt = now - 22000;
      current.finalizationStartedAt = now - 20000;
      current.finalizationCompletedAt = now - 1000;
    });

    const statusResponse = mockApiFetch(`http://localhost/api/sessions/${sessionId}/status`, {
      method: 'GET',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
    });
    const statusPayload = (await statusResponse.json()) as {
      finalizationResult?: {
        missingSlots?: number;
        journal?: {
          validVotes?: number;
        };
        excludedSlots?: number;
      } | null;
    };

    expect(statusResponse.status).toBe(200);
    expect(statusPayload.finalizationResult?.missingSlots).toBe(4);
    expect(statusPayload.finalizationResult?.journal?.validVotes).toBe(60);
    expect(statusPayload.finalizationResult?.excludedSlots).toBe(4);

    const verifyResponse = mockApiFetch('http://localhost/api/verify', {
      method: 'GET',
      headers: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': capabilityToken,
      },
    });
    const verifyPayload = (await verifyResponse.json()) as {
      data?: {
        missingSlots?: number;
        verifiedTally?: number[];
        excludedSlots?: number;
      };
    };

    expect(verifyResponse.status).toBe(200);
    expect(verifyPayload.data?.missingSlots).toBe(4);
    expect(verifyPayload.data?.verifiedTally?.reduce((sum, count) => sum + count, 0)).toBe(60);
    expect(verifyPayload.data?.excludedSlots).toBe(4);
  });
});
