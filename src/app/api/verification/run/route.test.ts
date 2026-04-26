import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { ErrorCode } from '@/lib/errors';
import type { FinalizationResult, FinalizationResultAuthority, SessionData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { enforceFinalizeRateLimit } from '@/server/api/middleware/rateLimit';
import { computeInputCommitment, CURRENT_METHOD_VERSION, type ZkVMInput, type ZkVMJournal } from '@/lib/zkvm/types';
import { createTestJournal, normalizeTestJournalCounts } from '@/lib/testing/test-helpers';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildPublicInputArtifactFromZkvmInput } from '@/lib/verification/public-input-contract';

const { EXPECTED_IMAGE_ID } = vi.hoisted(() => ({
  EXPECTED_IMAGE_ID: '0x' + 'e'.repeat(64),
}));

vi.mock('@/lib/store/storeInstance');
vi.mock('@/lib/verification/expected-image-id', () => ({
  resolveExpectedImageId: vi.fn().mockResolvedValue(EXPECTED_IMAGE_ID),
}));
vi.mock('@/lib/verification/verifier-service-runner-client', () => ({
  invokeVerifierServiceRunner: vi.fn(),
}));
vi.mock('@/lib/verification/verifier-service-client', () => ({
  invokeVerifierService: vi.fn(),
}));
vi.mock('@/server/api/middleware/rateLimit', () => ({
  enforceFinalizeRateLimit: vi
    .fn()
    .mockResolvedValue({ clientIp: '203.0.113.10', rateLimiter: {}, shouldRecord: false }),
  recordFinalizeRateLimit: vi.fn(),
}));

import { resolveExpectedImageId } from '@/lib/verification/expected-image-id';
import { invokeVerifierService } from '@/lib/verification/verifier-service-client';
import { invokeVerifierServiceRunner } from '@/lib/verification/verifier-service-runner-client';

function createBaseSession(
  overrides: Omit<Partial<SessionData>, 'finalizationResult'> & {
    finalizationResult?: FinalizationResult;
    allowUnsupportedFinalizationResult?: boolean;
    allowMissingVerificationExecutionId?: boolean;
  } = {},
): SessionData {
  const now = Date.now();
  const {
    allowUnsupportedFinalizationResult = false,
    allowMissingVerificationExecutionId = false,
    finalizationResult: finalizationResultOverride,
    ...sessionOverrides
  } = overrides;
  const session: SessionData = {
    sessionId: 'session-base',
    contractGeneration: resolveCurrentContractGeneration(),
    votes: new Map(),
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    ...sessionOverrides,
  };

  if (finalizationResultOverride !== undefined) {
    session.finalizationResult = allowUnsupportedFinalizationResult
      ? (finalizationResultOverride as FinalizationResultAuthority)
      : withCanonicalJournal(finalizationResultOverride);
  }

  if (!allowMissingVerificationExecutionId && session.finalized && session.finalizationResult) {
    const needsDerivedExecutionId = !session.finalizationResult.verificationExecutionId;
    const derivedExecutionId =
      session.finalizationResult.verificationResult?.executionId ?? session.finalizationState?.executionId ?? 'exec-1';
    if (needsDerivedExecutionId) {
      session.finalizationResult.verificationExecutionId = derivedExecutionId;
    }
    if (
      needsDerivedExecutionId &&
      session.finalizationResult.publicInputArtifact?.provenance &&
      !session.finalizationResult.publicInputArtifact.provenance.executionId
    ) {
      session.finalizationResult.publicInputArtifact.provenance.executionId = derivedExecutionId;
    }
  }

  if (
    !allowUnsupportedFinalizationResult &&
    session.finalizationResult &&
    !session.finalizationResult.publicInputArtifact
  ) {
    session.finalizationResult = withCanonicalJournal(session.finalizationResult);
  }

  if (
    session.finalizationContractGeneration === undefined &&
    (session.finalized ||
      session.finalizationResult !== undefined ||
      session.finalizationState !== undefined ||
      session.finalizationScenarioContext !== undefined)
  ) {
    session.finalizationContractGeneration = session.contractGeneration;
  }

  return session;
}

type JournalOverrides = Partial<ZkVMJournal> & {
  missingIndices?: number;
  invalidIndices?: number;
  countedIndices?: number;
  excludedCount?: number;
};

function createJournal(overrides: JournalOverrides = {}): ZkVMJournal {
  const canonicalOverrides: Partial<ZkVMJournal> = { ...overrides };
  delete (canonicalOverrides as Record<string, unknown>).missingIndices;
  delete (canonicalOverrides as Record<string, unknown>).invalidIndices;
  delete (canonicalOverrides as Record<string, unknown>).countedIndices;
  delete (canonicalOverrides as Record<string, unknown>).excludedCount;
  const baseJournal: ZkVMJournal = {
    ...createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 1,
    }),
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: '0x' + '0'.repeat(64),
    bulletinRoot: '0x' + '1'.repeat(64),
    treeSize: 1,
    totalExpected: 1,
    sthDigest: '0x' + '2'.repeat(64),
    verifiedTally: [1, 0, 0, 0, 0],
    totalVotes: 1,
    validVotes: 1,
    invalidVotes: 0,
    seenIndicesCount: 1,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    seenBitmapRoot: '0x' + '3'.repeat(64),
    includedBitmapRoot: '0x' + '4'.repeat(64),
    excludedSlots: 0,
    inputCommitment: '0x' + '5'.repeat(64),
    methodVersion: CURRENT_METHOD_VERSION,
    ...canonicalOverrides,
  };
  const normalizedCounts = normalizeTestJournalCounts(overrides, baseJournal);

  const normalizedJournal: ZkVMJournal = {
    ...baseJournal,
    validVotes: normalizedCounts.validVotes,
    invalidVotes: normalizedCounts.invalidVotes,
    missingSlots: normalizedCounts.missingSlots,
    invalidPresentedSlots: normalizedCounts.invalidPresentedSlots,
    rejectedRecords: normalizedCounts.rejectedRecords,
    excludedSlots: normalizedCounts.excludedSlots,
    seenIndicesCount: normalizedCounts.seenIndicesCount,
    totalVotes: normalizedCounts.totalVotes,
  };

  return normalizedJournal;
}

function withCanonicalJournal(result: FinalizationResult): FinalizationResultAuthority {
  const journal =
    result.journal ??
    (() => {
      const verifiedTally = Array.isArray(result.verifiedTally)
        ? result.verifiedTally
        : [
            result.tally.counts.A,
            result.tally.counts.B,
            result.tally.counts.C,
            result.tally.counts.D,
            result.tally.counts.E,
          ];
      const claimedTotalVotes = result.tally.totalVotes;
      const normalizedCounts = normalizeTestJournalCounts({
        countedIndices: typeof result.countedIndices === 'number' ? result.countedIndices : claimedTotalVotes,
        seenIndicesCount: typeof result.seenIndicesCount === 'number' ? result.seenIndicesCount : undefined,
        missingSlots: typeof result.missingSlots === 'number' ? result.missingSlots : undefined,
        missingIndices: typeof result.missingIndices === 'number' ? result.missingIndices : undefined,
        invalidPresentedSlots:
          typeof result.invalidPresentedSlots === 'number' ? result.invalidPresentedSlots : undefined,
        invalidIndices: typeof result.invalidIndices === 'number' ? result.invalidIndices : undefined,
        rejectedRecords: typeof result.rejectedRecords === 'number' ? result.rejectedRecords : undefined,
        excludedSlots: typeof result.excludedSlots === 'number' ? result.excludedSlots : undefined,
        excludedCount: typeof result.excludedCount === 'number' ? result.excludedCount : undefined,
      });
      const totalExpected = typeof result.totalExpected === 'number' ? result.totalExpected : claimedTotalVotes;
      const treeSize = typeof result.treeSize === 'number' ? result.treeSize : totalExpected;

      return createJournal({
        bulletinRoot: result.bulletinRoot,
        treeSize,
        totalExpected,
        verifiedTally,
        totalVotes: normalizedCounts.totalVotes,
        validVotes: normalizedCounts.validVotes,
        invalidVotes: normalizedCounts.invalidVotes,
        seenIndicesCount: normalizedCounts.seenIndicesCount,
        missingSlots: normalizedCounts.missingSlots,
        invalidPresentedSlots: normalizedCounts.invalidPresentedSlots,
        rejectedRecords: normalizedCounts.rejectedRecords,
        excludedSlots: normalizedCounts.excludedSlots,
        methodVersion: CURRENT_METHOD_VERSION,
        ...(result.sthDigest ? { sthDigest: result.sthDigest } : {}),
        ...(result.seenBitmapRoot ? { seenBitmapRoot: result.seenBitmapRoot } : {}),
        ...(result.includedBitmapRoot ? { includedBitmapRoot: result.includedBitmapRoot } : {}),
        ...(result.inputCommitment ? { inputCommitment: result.inputCommitment } : {}),
        ...(result.imageId ? { imageId: result.imageId } : {}),
      });
    })();

  const publicInputArtifact =
    result.publicInputArtifact ??
    createTestPublicInputArtifact({
      executionId: result.verificationExecutionId ?? result.verificationResult?.executionId,
      bundleKey: result.s3BundleKey ?? result.verificationResult?.s3BundleKey,
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        methodVersion: journal.methodVersion,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        votesCount: journal.validVotes,
        logId: result.closeStatement?.logId ?? '0x' + '2'.repeat(64),
        timestamp: result.closeStatement?.timestamp ?? 123,
        recomputedInputCommitment: journal.inputCommitment,
      },
    });

  return {
    tally: result.tally,
    ...(result.s3BundleKey ? { s3BundleKey: result.s3BundleKey } : {}),
    ...(result.s3UploadedAt ? { s3UploadedAt: result.s3UploadedAt } : {}),
    ...(result.receipt ? { receipt: result.receipt } : {}),
    ...(result.receiptRaw !== undefined ? { receiptRaw: result.receiptRaw } : {}),
    ...(result.receiptPublication ? { receiptPublication: result.receiptPublication } : {}),
    imageId: result.imageId,
    ...(result.tamperDetected !== undefined ? { tamperDetected: result.tamperDetected } : {}),
    ...(result.scenarios ? { scenarios: result.scenarios } : {}),
    journal,
    publicInputArtifact,
    ...(result.electionManifest ? { electionManifest: result.electionManifest } : {}),
    ...(result.closeStatement ? { closeStatement: result.closeStatement } : {}),
    ...(result.bitmapProofSource ? { bitmapProofSource: result.bitmapProofSource } : {}),
    ...(result.bitmapData ? { bitmapData: result.bitmapData } : {}),
    ...(result.verificationResult ? { verificationResult: result.verificationResult } : {}),
    ...(result.verificationExecutionId ? { verificationExecutionId: result.verificationExecutionId } : {}),
    ...(result.tamperSummary ? { tamperSummary: result.tamperSummary } : {}),
  };
}

describe('POST /api/verification/run', () => {
  let mockStore: VoteStore;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  let updateSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['updateSession']>>>;
  let verifierWorkDir: string | null;

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();
    verifierWorkDir = null;
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    updateSessionMock = vi.fn<NonNullable<VoteStore['updateSession']>>();
    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      updateSession: updateSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);
  });

  afterEach(async () => {
    if (verifierWorkDir) {
      await fs.rm(verifierWorkDir, { recursive: true, force: true });
    }
    delete process.env.VERIFIER_WORK_DIR;
  });

  it('returns error when session id header is missing', async () => {
    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload.error).toBe(ErrorCode.SESSION_ID_REQUIRED);
  });

  it('returns rate-limit response before parsing malformed JSON body', async () => {
    const sessionId = 'session-rate-limited-before-parse';
    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: true,
        finalizationResult: {
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
            tamperedCount: 0,
          },
          imageId: '0x' + '1'.repeat(64),
          journal: createJournal(),
        },
      }),
    );
    vi.mocked(enforceFinalizeRateLimit).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: ErrorCode.GLOBAL_LIMIT_EXCEEDED }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: '{',
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(payload.error).toBe(ErrorCode.GLOBAL_LIMIT_EXCEEDED);
  });

  it('returns 413 when verification-run payload exceeds body limit', async () => {
    const originalBodyLimit = process.env.API_REQUEST_BODY_LIMIT_BYTES;
    process.env.API_REQUEST_BODY_LIMIT_BYTES = '70';
    const sessionId = 'session-oversized-verification-run';
    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: true,
        finalizationResult: {
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
            tamperedCount: 0,
          },
          imageId: '0x' + '1'.repeat(64),
          journal: createJournal(),
        },
      }),
    );

    try {
      const request = new NextRequest('http://localhost:3000/api/verification/run', {
        method: 'POST',
        body: JSON.stringify({ padding: 'x'.repeat(256) }),
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await POST(request);
      const payload = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(413);
      expect(payload.error).toBe('PAYLOAD_TOO_LARGE');
      expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
    } finally {
      if (originalBodyLimit === undefined) {
        delete process.env.API_REQUEST_BODY_LIMIT_BYTES;
      } else {
        process.env.API_REQUEST_BODY_LIMIT_BYTES = originalBodyLimit;
      }
    }
  });

  it('returns error when session is not finalized', async () => {
    const sessionId = 'session-not-finalized';
    const session = createBaseSession({ sessionId, finalized: false });
    getSessionMock.mockResolvedValue(session);

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload.error).toBe(ErrorCode.SESSION_NOT_FINALIZED);
  });

  it('fails closed for stale finalized artifacts before starting verifier work', async () => {
    const sessionId = 'session-run-stale-finalized';
    getSessionMock.mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: true,
        finalizationContractGeneration: 'stale-contract-generation',
        finalizationResult: {
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
            tamperedCount: 0,
          },
          imageId: '0x' + '1'.repeat(64),
          journal: createJournal(),
        },
      }),
    );

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(payload.error).toBe(ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT);
    expect(payload.artifactState).toBe('unsupported_current_artifact');
    expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
  });

  it('fails closed when the stored journal contract is unsupported', async () => {
    const sessionId = 'session-unsupported-journal';
    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        journal: createJournal({ methodVersion: 3 }),
      },
    });
    getSessionMock.mockResolvedValue(session);

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(payload.error).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
  });

  it('fails closed when finalized authority cannot be canonicalized before verifier work starts', async () => {
    const sessionId = 'session-run-corrupt-current-finalized';
    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
        journal: createJournal(),
      },
    });
    delete session.finalizationResult?.publicInputArtifact;
    getSessionMock.mockResolvedValue(session);

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(payload.error).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
    expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
  });

  it('fails closed when only publicInputSummary carries methodVersion and canonical journal is absent', async () => {
    const sessionId = 'session-public-input-only';
    const session = createBaseSession({
      sessionId,
      finalized: true,
      allowUnsupportedFinalizationResult: true,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        publicInputArtifact: createTestPublicInputArtifact({
          typedAuthority: {
            votesCount: 1,
            treeSize: 1,
            totalExpected: 1,
            bulletinRoot: '0x' + '1'.repeat(64),
            methodVersion: CURRENT_METHOD_VERSION,
          },
        }),
      },
    });
    getSessionMock.mockResolvedValue(session);

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(payload.error).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
    expect(vi.mocked(resolveExpectedImageId)).not.toHaveBeenCalled();
    expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
  });

  it('returns idempotent result when verification already completed', async () => {
    const sessionId = 'session-complete';
    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        verificationResult: {
          status: 'success',
        },
        verificationExecutionId: 'exec-1',
      },
    });
    getSessionMock.mockResolvedValue(session);

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.data).toEqual(expect.objectContaining({ verificationStatus: 'success', idempotent: true }));
    expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
  });

  it('fails closed for idempotent responses when canonical result contradicts stored success', async () => {
    const sessionId = 'session-complete-excluded';
    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 1,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        excludedCount: 1,
        missingIndices: 1,
        invalidIndices: 0,
        totalExpected: 1,
        treeSize: 1,
        verificationResult: {
          status: 'success',
        },
        verificationExecutionId: 'exec-1',
      },
    });
    getSessionMock.mockResolvedValue(session);

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.data).toEqual(expect.objectContaining({ verificationStatus: 'failed', idempotent: true }));
    expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
    expect(updateSessionMock).toHaveBeenCalledTimes(1);
    expect(updateSessionMock.mock.calls[0]?.[0]).toBe(sessionId);
    const updatePayload = updateSessionMock.mock.calls[0]?.[1];
    expect(updatePayload?.finalizationResult?.verificationResult).toEqual(
      expect.objectContaining({
        status: 'failed',
      }),
    );
  });

  it('invokes verifier-service-runner when verification has not run', async () => {
    const sessionId = 'session-run';
    const executionId = 'exec-123';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;

    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationState: {
        status: 'succeeded',
        executionId,
        queuedAt: 1,
        startedAt: 2,
        completedAt: 3,
      },
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        s3BundleKey: bundleKey,
        s3BundleUrl: 'https://example.com/bundle.zip',
      },
    });
    getSessionMock.mockResolvedValue(session);

    vi.mocked(invokeVerifierServiceRunner).mockResolvedValue({
      status: 'success',
      sessionId,
      executionId,
      verifierStatus: 'success',
      verificationReport: {
        status: 'success',
        verifier_version: '1.0.0',
        verified_at: '2025-12-31T00:00:00Z',
        duration_ms: 100,
        expected_image_id: EXPECTED_IMAGE_ID,
        receipt_image_id: EXPECTED_IMAGE_ID,
        bundle_path: bundleKey,
        receipt_path: 'receipt.json',
        dev_mode_receipt: false,
      },
      s3: {
        bundleKey,
        reportKey: `sessions/${sessionId}/${executionId}/verification.json`,
        uploadedAt: '2025-12-31T00:00:00Z',
        expiresAt: '2026-01-01T00:00:00Z',
      },
    });

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.data).toEqual(expect.objectContaining({ verificationStatus: 'success' }));
    expect(invokeVerifierServiceRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 's3_bundle',
        sessionId,
        executionId,
        bundleKey,
        expectedImageId: EXPECTED_IMAGE_ID,
      }),
    );
    expect(updateSessionMock).toHaveBeenCalled();
    const lastUpdatePayload = updateSessionMock.mock.calls.at(-1)?.[1];
    expect(lastUpdatePayload?.finalizationResult?.verificationResult).toEqual(
      expect.objectContaining({
        s3ReportKey: `sessions/${sessionId}/${executionId}/verification.json`,
      }),
    );
  });

  it('verifies a trusted local bundle directly when no authoritative s3BundleKey exists', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-local-bundle';
    verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-run-'));
    process.env.VERIFIER_WORK_DIR = verifierWorkDir;
    const bundlePath = path.join(verifierWorkDir, sessionId, executionId);
    const reportPath = path.join(bundlePath, 'verification.json');
    const electionConfig = {
      ...buildDefaultElectionConfig(),
      totalExpected: 1,
      botCount: 0,
    };
    const electionManifest = buildElectionManifest(sessionId, electionConfig);
    const zkvmInput: ZkVMInput = {
      electionId: sessionId,
      electionConfigHash: electionManifest.electionConfigHash,
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 1,
      totalExpected: 1,
      logId: '0x' + '2'.repeat(64),
      timestamp: 123,
      votes: [
        {
          index: 0,
          commitment: '0x' + '6'.repeat(64),
          choice: 0,
          random: '0x' + '7'.repeat(64),
          merklePath: [],
        },
      ],
    };
    const closeStatement = buildCloseStatement({
      logId: zkvmInput.logId,
      treeSize: zkvmInput.treeSize,
      timestamp: zkvmInput.timestamp,
      bulletinRoot: zkvmInput.bulletinRoot,
    });
    const journal = createJournal({
      electionId: zkvmInput.electionId,
      electionConfigHash: zkvmInput.electionConfigHash,
      bulletinRoot: zkvmInput.bulletinRoot,
      treeSize: zkvmInput.treeSize,
      totalExpected: zkvmInput.totalExpected,
      sthDigest: closeStatement.sthDigest,
      inputCommitment: computeInputCommitment(zkvmInput),
      methodVersion: CURRENT_METHOD_VERSION,
      validVotes: 1,
      totalVotes: 1,
      seenIndicesCount: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      excludedSlots: 0,
    });
    await fs.mkdir(bundlePath, { recursive: true });
    await fs.writeFile(
      path.join(bundlePath, 'public-input.json'),
      JSON.stringify(
        buildPublicInputArtifactFromZkvmInput(zkvmInput, CURRENT_METHOD_VERSION, resolveCurrentContractGeneration()),
        null,
        2,
      ),
      'utf-8',
    );
    await fs.writeFile(
      path.join(bundlePath, 'election-manifest.json'),
      JSON.stringify(electionManifest, null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(bundlePath, 'close-statement.json'), JSON.stringify(closeStatement, null, 2), 'utf-8');

    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationState: {
        status: 'succeeded',
        executionId,
        queuedAt: 1,
        startedAt: 2,
        completedAt: 3,
      },
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: zkvmInput.bulletinRoot,
        imageId: EXPECTED_IMAGE_ID,
        journal,
        electionManifest,
        closeStatement,
        verificationExecutionId: executionId,
        verificationResult: {
          status: 'not_run',
          executionId,
        },
      },
    });
    getSessionMock.mockResolvedValue(session);

    vi.mocked(invokeVerifierService).mockResolvedValue({
      status: 'success',
      bundlePath,
      reportPath,
      report: {
        status: 'success',
        verifier_version: '1.0.0',
        verified_at: '2025-12-31T00:00:00Z',
        duration_ms: 100,
        expected_image_id: EXPECTED_IMAGE_ID,
        receipt_image_id: EXPECTED_IMAGE_ID,
        bundle_path: 'bundle',
        receipt_path: 'receipt.json',
        dev_mode_receipt: false,
      },
    });

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.data).toEqual(expect.objectContaining({ verificationStatus: 'success' }));
    expect(invokeVerifierService).toHaveBeenCalledWith({
      bundlePath,
      expectedImageId: EXPECTED_IMAGE_ID,
      reportPath,
    });
    expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
    const lastUpdatePayload = updateSessionMock.mock.calls.at(-1)?.[1];
    expect(lastUpdatePayload?.finalizationResult?.verificationResult).toEqual(
      expect.objectContaining({
        status: 'success',
        executionId,
      }),
    );
    expect(lastUpdatePayload?.finalizationResult?.verificationResult).not.toHaveProperty('bundlePath');
    expect(lastUpdatePayload?.finalizationResult?.verificationResult).not.toHaveProperty('reportPath');
  });

  it('fails closed when the authoritative top-level s3BundleKey is missing even if nested compatibility locators remain', async () => {
    const sessionId = 'session-missing-authoritative-bundle-key';
    const executionId = 'exec-missing-authoritative-bundle-key';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;

    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationState: {
        status: 'succeeded',
        executionId,
        queuedAt: 1,
        startedAt: 2,
        completedAt: 3,
        bundleMetadata: {
          s3BundleKey: bundleKey,
        },
      },
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        verificationExecutionId: executionId,
        verificationResult: {
          status: 'not_run',
          executionId,
          s3BundleKey: bundleKey,
        },
      },
    });
    getSessionMock.mockResolvedValue(session);

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(payload.error).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
    expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
  });

  it('uses the canonical journal methodVersion when resolving expected ImageID', async () => {
    const sessionId = 'session-run-v11';
    const executionId = 'exec-456';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;

    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationState: {
        status: 'succeeded',
        executionId,
        queuedAt: 1,
        startedAt: 2,
        completedAt: 3,
      },
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        s3BundleKey: bundleKey,
        journal: createJournal({ methodVersion: CURRENT_METHOD_VERSION }),
        publicInputArtifact: createTestPublicInputArtifact({
          bundleKey,
          typedAuthority: {
            electionId: '550e8400-e29b-41d4-a716-446655440000',
            electionConfigHash: '0x' + '0'.repeat(64),
            votesCount: 1,
            treeSize: 1,
            totalExpected: 1,
            bulletinRoot: '0x' + '1'.repeat(64),
            logId: '0x' + '2'.repeat(64),
            timestamp: 123,
            recomputedInputCommitment: '0x' + '5'.repeat(64),
            methodVersion: CURRENT_METHOD_VERSION,
          },
        }),
      },
    });
    getSessionMock.mockResolvedValue(session);

    vi.mocked(invokeVerifierServiceRunner).mockResolvedValue({
      status: 'success',
      sessionId,
      executionId,
      verifierStatus: 'success',
      verificationReport: {
        status: 'success',
        verifier_version: '1.0.0',
        verified_at: '2025-12-31T00:00:00Z',
        duration_ms: 100,
        expected_image_id: EXPECTED_IMAGE_ID,
        receipt_image_id: EXPECTED_IMAGE_ID,
        bundle_path: bundleKey,
        receipt_path: 'receipt.json',
        dev_mode_receipt: false,
      },
    });

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(vi.mocked(resolveExpectedImageId)).toHaveBeenCalledWith(CURRENT_METHOD_VERSION);
  });

  it('fails closed when publicInputSummary disagrees with the canonical journal methodVersion', async () => {
    const sessionId = 'session-run-mismatched-method-version';
    const executionId = 'exec-789';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;

    const session = createBaseSession({
      sessionId,
      finalized: true,
      finalizationState: {
        status: 'succeeded',
        executionId,
        queuedAt: 1,
        startedAt: 2,
        completedAt: 3,
      },
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        s3BundleKey: bundleKey,
        journal: createJournal({ methodVersion: CURRENT_METHOD_VERSION }),
        publicInputArtifact: createTestPublicInputArtifact({
          source: 'generated',
          bundleKey,
          typedAuthority: {
            electionId: '550e8400-e29b-41d4-a716-446655440000',
            electionConfigHash: '0x' + '0'.repeat(64),
            votesCount: 1,
            treeSize: 1,
            totalExpected: 1,
            bulletinRoot: '0x' + '1'.repeat(64),
            logId: '0x' + '0'.repeat(64),
            timestamp: 1,
            recomputedInputCommitment: '0x' + '5'.repeat(64),
            methodVersion: CURRENT_METHOD_VERSION - 1,
          },
        }),
      },
    });
    getSessionMock.mockResolvedValue(session);

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(payload.error).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
    expect(vi.mocked(resolveExpectedImageId)).not.toHaveBeenCalled();
    expect(invokeVerifierServiceRunner).not.toHaveBeenCalled();
  });

  it('returns 401 when capability token is missing', async () => {
    const sessionId = 'session-run-no-capability';
    getSessionMock.mockResolvedValue(createBaseSession({ sessionId, finalized: true, finalizationResult: undefined }));

    const request = new NextRequest('http://localhost:3000/api/verification/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'X-Session-ID': sessionId,
      },
    });

    const response = await POST(request);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(payload.error).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('preserves record-only rejections when creating a canonical journal from top-level mirrors', () => {
    const session = createBaseSession({
      sessionId: 'session-record-only-top-level',
      finalized: true,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        countedIndices: 1,
        missingIndices: 0,
        invalidIndices: 0,
        rejectedRecords: 2,
        excludedCount: 0,
        totalExpected: 1,
        treeSize: 1,
      },
    });

    expect(session.finalizationResult?.journal).toEqual(
      expect.objectContaining({
        validVotes: 1,
        invalidVotes: 2,
        totalVotes: 3,
        seenIndicesCount: 1,
        invalidPresentedSlots: 0,
        rejectedRecords: 2,
        excludedSlots: 0,
      }),
    );
    expect(session.finalizationResult?.journal).not.toHaveProperty('invalidIndices');
    expect(session.finalizationResult?.journal).not.toHaveProperty('excludedCount');
  });

  it('derives seenIndicesCount from counted and invalid-presented slots when synthesizing a canonical journal', () => {
    const session = createBaseSession({
      sessionId: 'session-slot-only-top-level',
      finalized: true,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 1,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: EXPECTED_IMAGE_ID,
        countedIndices: 1,
        missingIndices: 0,
        invalidIndices: 1,
        totalExpected: 2,
        treeSize: 2,
        excludedCount: 1,
      },
    });

    expect(session.finalizationResult?.journal).toEqual(
      expect.objectContaining({
        validVotes: 1,
        invalidVotes: 1,
        seenIndicesCount: 2,
        missingSlots: 0,
        invalidPresentedSlots: 1,
        rejectedRecords: 1,
        excludedSlots: 1,
      }),
    );
    expect(session.finalizationResult?.journal).not.toHaveProperty('invalidIndices');
    expect(session.finalizationResult?.journal).not.toHaveProperty('excludedCount');
  });
});
