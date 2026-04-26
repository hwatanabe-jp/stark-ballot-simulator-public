import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import { startStarkVerificationPolling, stopStarkVerificationPolling } from '../stark-verification-polling';
import { createTestJournal } from '@/lib/testing/test-helpers';

vi.mock('@/lib/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock('@/lib/session', () => ({
  captureSessionIdentity: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) =>
    session?.sessionId ? { sessionId: session.sessionId, capabilityToken: session.capabilityToken } : null,
  ),
  clearSessionData: vi.fn(),
  getSessionData: vi.fn(),
  getSessionAuthHeaders: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) => {
    if (!session?.sessionId) {
      return {};
    }
    const headers: Record<string, string> = {
      'X-Session-ID': session.sessionId,
    };
    if (session.capabilityToken) {
      headers['X-Session-Capability'] = session.capabilityToken;
    }
    return headers;
  }),
}));

const apiModule = await import('@/lib/api/apiFetch');
const sessionModule = await import('@/lib/session');

const mockApiFetch = vi.mocked(apiModule.apiFetch);
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);

const createResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  }) as Response;

const createSessionWithFinalization = () => {
  const journal = createTestJournal({
    totalExpected: 1,
    validVotes: 1,
    missingIndices: 0,
    invalidIndices: 0,
    seenIndicesCount: 1,
  });
  const finalizeResult = resolveCanonicalFinalizationPayload({
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: '0x' + 'e'.repeat(64),
    journal,
  });

  if (!finalizeResult) {
    throw new Error('Failed to build canonical finalization snapshot');
  }

  return {
    sessionId: 'session-1',
    capabilityToken: 'test-capability-token',
    lastActivity: Date.now(),
    finalizeResult,
  };
};

describe('stark-verification-polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockApiFetch.mockReset();
    mockGetSessionData.mockReset();
    mockGetSessionData.mockReturnValue(createSessionWithFinalization());
  });

  afterEach(async () => {
    stopStarkVerificationPolling();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('stops polling after terminal status resolves', async () => {
    const responses = [{ data: { verificationStatus: 'running' } }, { data: { verificationStatus: 'success' } }];
    mockApiFetch.mockImplementation(() => Promise.resolve(createResponse(responses.shift() ?? {})));

    startStarkVerificationPolling({ sessionId: 'session-1', intervalMs: 10, timeoutMs: 1000 });

    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('retries after legacy 400 verification errors instead of treating them as terminal payloads', async () => {
    const responses = [
      createResponse(
        {
          error: 'VERIFICATION_FAILED',
          data: {
            verificationStatus: 'failed',
          },
        },
        false,
        400,
      ),
      createResponse({ data: { verificationStatus: 'success' } }),
    ];
    mockApiFetch.mockImplementation(() => Promise.resolve(responses.shift() ?? createResponse({}, true, 200)));

    startStarkVerificationPolling({ sessionId: 'session-1', intervalMs: 10, timeoutMs: 1000 });

    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('stops polling when session disappears', async () => {
    const sessions = [
      createSessionWithFinalization(),
      createSessionWithFinalization(),
      createSessionWithFinalization(),
      null,
    ] as Array<ReturnType<typeof mockGetSessionData>>;
    mockGetSessionData.mockImplementation(() => sessions.shift() ?? null);
    mockApiFetch.mockResolvedValue(createResponse({ data: { verificationStatus: 'running' } }));

    startStarkVerificationPolling({ sessionId: 'session-1', intervalMs: 10, timeoutMs: 1000 });

    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the canonical finalization snapshot disappears from browser state', async () => {
    const sessions = [
      createSessionWithFinalization(),
      createSessionWithFinalization(),
      {
        sessionId: 'session-1',
        capabilityToken: 'test-capability-token',
        lastActivity: Date.now(),
      },
    ] as Array<ReturnType<typeof mockGetSessionData>>;
    mockGetSessionData.mockImplementation(() => sessions.shift() ?? null);
    mockApiFetch.mockResolvedValue(createResponse({ data: { verificationStatus: 'running' } }));

    startStarkVerificationPolling({ sessionId: 'session-1', intervalMs: 10, timeoutMs: 1000 });

    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade to X-Session-ID-only fetches when session authority disappears mid-poll', async () => {
    const sessions = [createSessionWithFinalization(), createSessionWithFinalization(), null] as Array<
      ReturnType<typeof mockGetSessionData>
    >;
    mockGetSessionData.mockImplementation(() => sessions.shift() ?? null);

    startStarkVerificationPolling({ sessionId: 'session-1', intervalMs: 10, timeoutMs: 1000 });

    await vi.runAllTimersAsync();

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
