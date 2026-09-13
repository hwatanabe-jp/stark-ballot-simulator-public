import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import type { AvailableVerificationResource } from '@stark-ballot/api-contract/schemas/verification';
import type { SessionIdentity } from '@stark-ballot/web/session';
import type { SessionData } from '@stark-ballot/web/session/types';
import { VERIFICATION_CHECK_DEFINITIONS } from '@stark-ballot/verification/checks';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import { useVerificationData } from './useVerificationData';

vi.mock('@stark-ballot/web/session', () => ({
  getSessionDataForIdentity: vi.fn(),
  isSessionReplaced: vi.fn(() => false),
  isSessionReplacedForIdentity: vi.fn(() => false),
}));

vi.mock('@stark-ballot/web/api/verification', () => ({
  getVerification: vi.fn(),
}));

vi.mock('@stark-ballot/web/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stark-ballot/web/knowledge')>();
  return {
    ...actual,
    getKnowledgeValue: vi.fn(),
    mergeKnowledgeFromApi: vi.fn(),
    saveKnowledgeData: vi.fn(),
  };
});

vi.mock('@stark-ballot/web/finalize/client-finalization-boundary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stark-ballot/web/finalize/client-finalization-boundary')>();
  return {
    ...actual,
    clearClientFinalizedProjection: vi.fn(),
    clearClientSessionAuthority: vi.fn(),
  };
});

vi.mock('@stark-ballot/web/verification/stark-verification-polling', () => ({
  getStarkVerificationSnapshot: vi.fn(),
  subscribeStarkVerificationSnapshot: vi.fn(() => () => undefined),
}));

const sessionModule = await import('@stark-ballot/web/session');
const verificationModule = await import('@stark-ballot/web/api/verification');
const boundaryModule = await import('@stark-ballot/web/finalize/client-finalization-boundary');
const pollingModule = await import('@stark-ballot/web/verification/stark-verification-polling');

const mockGetSessionDataForIdentity = vi.mocked(sessionModule.getSessionDataForIdentity);
const mockGetVerification = vi.mocked(verificationModule.getVerification);
const mockClearClientFinalizedProjection = vi.mocked(boundaryModule.clearClientFinalizedProjection);
const mockGetStarkVerificationSnapshot = vi.mocked(pollingModule.getStarkVerificationSnapshot);
const mockSubscribeStarkVerificationSnapshot = vi.mocked(pollingModule.subscribeStarkVerificationSnapshot);

const ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const RANDOM = `0x${'1'.repeat(64)}`;
const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;
const HEX_D = `0x${'d'.repeat(64)}`;
const HEX_E = `0x${'e'.repeat(64)}`;
const HEX_F = `0x${'f'.repeat(64)}`;

function createSupportedFinalizeResult(): NonNullable<SessionData['finalizeResult']> {
  const result = resolveCanonicalFinalizationPayload({
    finalizationId: 'finalization-1',
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: HEX_C,
    journal: createTestJournal({
      electionId: ELECTION_ID,
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    }),
  });
  if (!result) {
    throw new Error('Failed to build finalization fixture');
  }
  return result;
}

function session(): SessionData {
  return {
    sessionId: 'session-1',
    capabilityToken: 'capability-token',
    lastActivity: 1,
    expiresAt: 86_400_001,
    phase: 'verifying',
    verificationRequestedAt: 1,
    finalizeResult: createSupportedFinalizeResult(),
    electionId: ELECTION_ID,
    electionConfigHash: HEX_A,
    logId: HEX_B,
    myVote: 'A',
    myCommit: computeCommitment(ELECTION_ID, 0, RANDOM),
    myRand: RANDOM,
  };
}

function availableResource(): AvailableVerificationResource {
  const commitment = computeCommitment(ELECTION_ID, 0, RANDOM);
  return {
    availability: 'available',
    finalizationId: 'finalization-1',
    proofAuthority: {
      electionId: ELECTION_ID,
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
      seenBitmapRoot: HEX_E,
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
      scenarioId: 'S0',
      tamperDetected: false,
      policy: {
        summary: { status: 'fully_verified', tone: 'verified' },
        stageStatuses: {
          cast_as_intended: 'success',
          recorded_as_cast: 'success',
          counted_as_recorded: 'success',
          stark_verification: 'success',
        },
        evidenceFullyVerified: true,
        fullyVerifiedLabelEligible: true,
        display: {
          readiness: 'ready',
          source: 'summary',
          status: 'verified',
          renderedStatus: 'verified',
        },
        publishedTallyMismatch: false,
        devModeEvidence: false,
        missingEvidence: false,
      },
    },
    verifierResult: {
      status: 'success',
      report: {
        status: 'success',
        verifier_version: 'test-verifier',
        verified_at: '2026-08-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: HEX_C,
        receipt_image_id: HEX_C,
        dev_mode_receipt: false,
      },
    },
    verification: {
      checks: VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
        id: definition.id,
        status: 'success',
        evidence: definition.evidence,
        inputs: [...definition.inputs],
        ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
      })),
      steps: [],
    },
    voterEvidence: {
      availability: 'available',
      voteReceipt: {
        voteId: 'vote-1',
        commitment,
        bulletinIndex: 0,
        bulletinRootAtCast: HEX_B,
        castAtMs: 1,
        inputCommitment: HEX_F,
      },
      userVote: {
        commitment,
        voteId: 'vote-1',
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: [],
          bulletinRootAtCast: HEX_B,
        },
      },
    },
    journal: { representation: 'omitted' },
  };
}

function identityRef(): RefObject<SessionIdentity | null> {
  return {
    current: {
      sessionId: 'session-1',
      capabilityToken: 'capability-token',
    },
  };
}

describe('useVerificationData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionDataForIdentity.mockReturnValue(session());
    mockGetStarkVerificationSnapshot.mockReturnValue(null);
    mockSubscribeStarkVerificationSnapshot.mockImplementation(() => () => undefined);
    mockGetVerification.mockResolvedValue(availableResource());
  });

  it('reads the exact canonical finalization and projects the grouped resource', async () => {
    const sessionIdentityRef = identityRef();
    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    let fetched: Awaited<ReturnType<typeof result.current.fetchVerification>> | undefined;
    await act(async () => {
      fetched = await result.current.fetchVerification();
    });
    expect(fetched).toMatchObject({
      finalizationId: 'finalization-1',
      verificationStatus: 'success',
    });
    expect(mockGetVerification).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      'finalization-1',
    );
    expect(result.current.serverValidated).toBe(true);
  });

  it('fails closed and clears finalized projection for unavailable data', async () => {
    mockGetVerification.mockResolvedValue({
      availability: 'unavailable',
      finalizationId: 'finalization-1',
      reason: 'finalization_not_current',
      message: 'Unsupported artifact',
    });
    const sessionIdentityRef = identityRef();
    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    await expect(result.current.fetchVerification()).rejects.toThrow('Unsupported artifact');
    expect(mockClearClientFinalizedProjection).toHaveBeenCalledWith(sessionIdentityRef.current);
    expect(result.current.serverValidated).toBe(false);
  });

  it('hydrates only a snapshot for the current finalization', () => {
    mockGetStarkVerificationSnapshot.mockReturnValue({
      sessionId: 'session-1',
      finalizationId: 'finalization-2',
      status: 'success',
      payload: { ...availableResource(), finalizationId: 'finalization-2' },
      receivedAt: 1,
    });
    const sessionIdentityRef = identityRef();
    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    expect(result.current.data).toBeNull();
  });

  it('clears previously validated data when a newer snapshot is malformed', async () => {
    let listener: Parameters<typeof pollingModule.subscribeStarkVerificationSnapshot>[0] | undefined;
    mockSubscribeStarkVerificationSnapshot.mockImplementation((callback) => {
      listener = callback;
      return () => undefined;
    });
    const sessionIdentityRef = identityRef();
    const { result } = renderHook(() =>
      useVerificationData({
        t: (key) => key,
        sessionIdentityRef,
        initialSessionIdentity: sessionIdentityRef.current,
      }),
    );

    await act(async () => {
      await result.current.fetchVerification();
    });
    await waitFor(() => expect(result.current.data).not.toBeNull());

    act(() => {
      listener?.({
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        status: 'failed',
        payload: { unknown: true } as never,
        receivedAt: Date.now() + 100,
      });
    });

    expect(result.current.data).toBeNull();
    expect(result.current.serverValidated).toBe(false);
    expect(result.current.error).toContain('Invalid verification snapshot');
  });
});
