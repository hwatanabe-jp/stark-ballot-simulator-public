import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  getStarkVerificationSnapshot,
  startStarkVerificationPolling,
  stopStarkVerificationPolling,
} from './stark-verification-polling';

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
}));

const apiModule = await import('@stark-ballot/web/api/apiFetch');
const sessionModule = await import('@stark-ballot/web/session');
const mockApiFetch = vi.mocked(apiModule.apiFetch);
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);

const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;
const HEX_D = `0x${'d'.repeat(64)}`;
const HEX_E = `0x${'e'.repeat(64)}`;
const HEX_F = `0x${'f'.repeat(64)}`;

function response(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      data,
      meta: { requestId: 'request-1' },
    }),
    { status },
  );
}

function verificationResource(status: VerificationStatus) {
  return {
    availability: 'available' as const,
    finalizationId: 'finalization-1',
    proofAuthority: {
      electionId: 'election-1',
      electionConfigHash: HEX_A,
      logId: 'log-1',
      bulletinRoot: HEX_B,
      imageId: HEX_C,
      verifiedTally: [1, 0, 0, 0, 0],
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      totalExpected: 1,
      treeSize: 1,
      excludedSlots: 0,
      sthDigest: HEX_D,
      includedBitmapRoot: HEX_E,
      inputCommitment: HEX_F,
      seenIndicesCount: 1,
    },
    presentation: {
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      scenarioId: 'S0' as const,
      policy: {
        summary: null,
        stageStatuses: {
          cast_as_intended: 'not_run' as const,
          recorded_as_cast: 'not_run' as const,
          counted_as_recorded: 'not_run' as const,
          stark_verification: status === 'success' ? ('success' as const) : ('running' as const),
        },
        evidenceFullyVerified: false,
        fullyVerifiedLabelEligible: false,
        display: {
          readiness: 'ready' as const,
          source: 'pending' as const,
          status: 'warning' as const,
          renderedStatus: 'warning' as const,
        },
        publishedTallyMismatch: false,
        devModeEvidence: false,
        missingEvidence: true,
      },
    },
    verifierResult: { status },
    verification: { checks: [], steps: [] },
    voterEvidence: {
      availability: 'unavailable' as const,
      reason: 'exact_proof_unavailable' as const,
      userVote: { commitment: HEX_A },
    },
    journal: { representation: 'omitted' as const },
  };
}

function createSessionWithFinalization(finalizationId = 'finalization-1') {
  const finalizeResult = resolveCanonicalFinalizationPayload({
    finalizationId,
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: HEX_C,
    journal: createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    }),
  });
  if (!finalizeResult) {
    throw new Error('Failed to build finalization fixture');
  }
  return {
    sessionId: 'session-1',
    capabilityToken: 'test-capability-token',
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: HEX_A,
    logId: HEX_B,
    lastActivity: 1,
    expiresAt: 86_400_001,
    phase: 'verifying' as const,
    finalizeResult,
  };
}

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

  it('polls the exact finalization path until a terminal resource arrives', async () => {
    const resources = [verificationResource('running'), verificationResource('success')];
    mockApiFetch.mockImplementation(() => Promise.resolve(response(resources.shift())));

    startStarkVerificationPolling({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      intervalMs: 10,
      timeoutMs: 1000,
    });
    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/sessions/session-1/finalizations/finalization-1/verification', {
      headers: { 'X-Session-Capability': 'test-capability-token' },
      method: 'GET',
    });
    expect(getStarkVerificationSnapshot()).toMatchObject({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      status: 'success',
      payload: { availability: 'available' },
    });
  });

  it('publishes unavailable data as a terminal fail-closed snapshot', async () => {
    mockApiFetch.mockResolvedValue(
      response({
        availability: 'unavailable',
        finalizationId: 'finalization-1',
        reason: 'finalization_not_current',
        message: 'Unsupported artifact',
      }),
    );

    startStarkVerificationPolling({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      intervalMs: 10,
      timeoutMs: 1000,
    });
    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledOnce();
    expect(getStarkVerificationSnapshot()).toMatchObject({
      status: 'failed',
      payload: { availability: 'unavailable' },
    });
  });

  it('turns a malformed successful response into a terminal corrupt snapshot', async () => {
    mockApiFetch.mockResolvedValue(response({ verificationStatus: 'success' }));

    startStarkVerificationPolling({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      intervalMs: 10,
      timeoutMs: 1000,
    });
    await vi.runAllTimersAsync();

    expect(mockApiFetch).toHaveBeenCalledOnce();
    expect(getStarkVerificationSnapshot()).toMatchObject({
      status: 'failed',
      payload: {
        availability: 'corrupt',
        finalizationId: 'finalization-1',
      },
    });
  });

  it('does not poll when browser authority names another finalization', async () => {
    mockGetSessionData.mockReturnValue(createSessionWithFinalization('finalization-2'));

    startStarkVerificationPolling({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      intervalMs: 10,
      timeoutMs: 1000,
    });
    await vi.runAllTimersAsync();

    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
