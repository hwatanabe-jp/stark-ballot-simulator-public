import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import { startStarkVerificationPolling, stopStarkVerificationPolling } from './stark-verification-polling';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import verifyS0Fixture from '@stark-ballot/web/mock-api/fixtures/json/verify.get.S0.json';

vi.mock('@stark-ballot/web/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@stark-ballot/web/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock('@stark-ballot/web/session', () => ({
  captureSessionIdentity: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) =>
    session?.sessionId ? { sessionId: session.sessionId, capabilityToken: session.capabilityToken } : null,
  ),
  clearSession: vi.fn(),
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

const apiModule = await import('@stark-ballot/web/api/apiFetch');
const sessionModule = await import('@stark-ballot/web/session');

const mockApiFetch = vi.mocked(apiModule.apiFetch);
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);

const createResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  }) as Response;

const createVerifyResponse = (status: VerificationStatus): Record<string, unknown> => {
  const payload = JSON.parse(JSON.stringify(verifyS0Fixture)) as {
    data?: {
      verificationStatus?: VerificationStatus;
      verificationReport?: {
        status?: VerificationStatus;
      };
    };
  };
  if (!payload.data) {
    throw new Error('Verify fixture missing data');
  }
  payload.data.verificationStatus = status;
  if (payload.data.verificationReport) {
    payload.data.verificationReport.status = status;
  }
  return payload;
};

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
    const responses = [createVerifyResponse('running'), createVerifyResponse('success')];
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
      createResponse(createVerifyResponse('success')),
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
    mockApiFetch.mockResolvedValue(createResponse(createVerifyResponse('running')));

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
    mockApiFetch.mockResolvedValue(createResponse(createVerifyResponse('running')));

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

  it('fails closed instead of polling malformed successful verify responses', async () => {
    mockApiFetch.mockResolvedValue(createResponse({ data: { verificationStatus: 'success' } }));

    startStarkVerificationPolling({ sessionId: 'session-1', intervalMs: 10, timeoutMs: 1000 });

    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });
});
