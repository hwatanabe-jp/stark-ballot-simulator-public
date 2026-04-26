import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApiFetch } from '../fetcher';
import { resetMockState, updateMockState } from '../state';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';

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

  it('rejects invalid scenarioId in /api/finalize', async () => {
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
    expect(payload.error).toBe('INVALID_SCENARIO');
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

  it('requires capability token for /api/botdata/:id', async () => {
    const { sessionId } = await createSession();

    const response = mockApiFetch('http://localhost/api/botdata/1', {
      method: 'GET',
      headers: { 'X-Session-ID': sessionId },
    });
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
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

  it('returns a canonical v12 journal for /api/verify?includeJournal=1', async () => {
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

  it('returns a canonical v12 journal for /api/sessions/mock/finalize', async () => {
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
