import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { ErrorCode } from '@/lib/errors';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord, requireDataRecord } from '@/lib/testing/response-helpers';
import {
  getArrayProperty,
  getNumberArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringArrayProperty,
  getStringProperty,
} from '@/lib/utils/guards';
import type { FinalizationResult, FinalizationResultAuthority, SessionData, VoteData } from '@/types/server';
import type { VerificationReport } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { CURRENT_METHOD_VERSION, type ZkVMJournal } from '@/lib/zkvm/types';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { addHexPrefix } from '@/lib/utils/hex';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { createTestJournal, normalizeTestJournalCounts } from '@/lib/testing/test-helpers';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { deriveVerificationSummary } from '@/lib/verification/verification-summary';
import type { VerificationCheck } from '@/lib/verification/verification-checks';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock dependencies
vi.mock('@/lib/store/storeInstance');
vi.mock('@/lib/aws/presigned-url');

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

function createVoteData(overrides: Partial<VoteData> = {}): VoteData {
  return {
    vote: 'A',
    rand: '0x' + '1'.repeat(64),
    commit: '0x' + '2'.repeat(64),
    path: [],
    ...overrides,
  };
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
    includedBitmapRoot: '0x' + '3'.repeat(64),
    excludedSlots: 0,
    inputCommitment: '0x' + '4'.repeat(64),
    methodVersion: CURRENT_METHOD_VERSION,
    imageId: '0x' + '1'.repeat(64),
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

function createVerificationReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    status: 'success',
    verifier_version: '0.1.0',
    verified_at: '2025-10-16T00:00:00Z',
    duration_ms: 42,
    expected_image_id: '0x' + '4'.repeat(64),
    receipt_image_id: '0x' + '1'.repeat(64),
    bundle_path: '/tmp/bundle',
    receipt_path: '/tmp/bundle/receipt.json',
    dev_mode_receipt: false,
    ...overrides,
  };
}

function withCanonicalJournal(result: FinalizationResult): FinalizationResultAuthority {
  const journal =
    result.journal ??
    (() => {
      const verifiedTally = Array.isArray(result.verifiedTally) ? result.verifiedTally : [1, 0, 0, 0, 0];
      const claimedTotalVotes =
        typeof result.tally.totalVotes === 'number'
          ? result.tally.totalVotes
          : verifiedTally.reduce((sum, value) => sum + value, 0);
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
        ...(result.seenBitmapRoot ? { seenBitmapRoot: result.seenBitmapRoot } : {}),
        ...(result.sthDigest ? { sthDigest: result.sthDigest } : {}),
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

const MERKLE_PATH = ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)];
const MERKLE_PATH_SINGLE = ['0x' + '3'.repeat(64)];

describe('GET /api/verify', () => {
  let mockStore: VoteStore;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  let getVoteByIdWithProofMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getVoteByIdWithProof']>>>;
  let updateSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['updateSession']>>>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    getVoteByIdWithProofMock = vi.fn<NonNullable<VoteStore['getVoteByIdWithProof']>>();
    updateSessionMock = vi.fn<NonNullable<VoteStore['updateSession']>>();
    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      getVoteByIdWithProof: getVoteByIdWithProofMock,
      updateSession: updateSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);
    // Suppress console.error logs in tests
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should return verification data for finalized session', async () => {
    // Arrange
    const sessionId = 'test-session-id';
    const mockCommitment = '0x' + 'a'.repeat(64);
    const mockRandom = '0x' + 'f'.repeat(64);
    const mockRoot = '0x' + '1'.repeat(64);
    const mockInputCommitment = '0x' + '2'.repeat(64);

    const rawReceipt = {
      seal: 'real-stark-proof-seal-' + 'A'.repeat(42),
      journal: { bytes: [1, 2, 3] },
      inner: { Composite: { segments: [] } },
    };

    const toBase64 = (values: number[]) => Buffer.from(Uint8Array.from(values)).toString('base64');

    const s3BundleUrl = 'https://presigned.example.com/bundle';
    const s3BundleKey = 'sessions/test-session-id/exec-1/bundle.zip';
    const s3UploadedAt = '2025-10-18T12:00:00Z';

    const mockSession = createBaseSession({
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      logId: '0x' + 'a'.repeat(64),
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [
          0,
          {
            vote: 'A',
            voteId: '11111111-1111-4111-8111-111111111111',
            rand: mockRandom,
            commit: mockCommitment,
            path: MERKLE_PATH,
            timestamp: 1700000000000,
            rootAtCast: mockRoot,
          },
        ],
        [
          1,
          {
            vote: 'B',
            voteId: '22222222-2222-4222-8222-222222222222',
            rand: '0x' + 'b'.repeat(64),
            commit: '0x' + 'c'.repeat(64),
            path: MERKLE_PATH,
            timestamp: 1700000001000,
            rootAtCast: mockRoot,
          },
        ],
      ]),
      bulletinRootHistory: [
        {
          timestamp: 1700000000000,
          root: mockRoot,
          treeSize: 1,
        },
      ],
      // Store finalization data
      finalizationResult: {
        tally: {
          counts: { A: 33, B: 13, C: 10, D: 6, E: 2 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        bulletinRoot: mockRoot,
        receipt: {
          seal: rawReceipt.seal,
          journal: toBase64(rawReceipt.journal.bytes),
          imageId: '0x' + '1'.repeat(64),
        },
        receiptRaw: rawReceipt,
        imageId: '0x' + '1'.repeat(64),
        verifiedTally: [33, 13, 10, 6, 2],
        scenarios: [],
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 64,
        totalExpected: 64,
        treeSize: 64,
        inputCommitment: mockInputCommitment,
        s3BundleUrl,
        s3BundleKey,
        s3UploadedAt,
        verificationExecutionId: 'exec-1',
        verificationResult: {
          status: 'success',
          executionId: 'exec-1',
          report: {
            status: 'success',
            verifier_version: '0.1.0',
            verified_at: '2025-10-16T00:00:00Z',
            duration_ms: 42,
            expected_image_id: '0x' + '1'.repeat(64),
            receipt_image_id: '0x' + '1'.repeat(64),
            bundle_path: '/tmp/bundle',
            receipt_path: '/tmp/bundle/receipt.json',
            dev_mode_receipt: false,
            errors: [],
          },
          s3BundleKey,
          s3UploadedAt,
        },
      },
    });

    if (!mockSession.finalizationResult) {
      throw new Error('Expected finalizationResult in test setup');
    }
    const finalizationResult = mockSession.finalizationResult;

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    // Act
    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const payload = requireDataRecord(responsePayload);

    // Assert
    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'electionId')).toBe(mockSession.electionId);
    expect(getStringProperty(payload, 'logId')).toBe(mockSession.logId);
    expect(getRecordProperty(getRecordProperty(payload, 'tally'), 'counts')).toEqual(finalizationResult.tally.counts);
    expect(getNumberArrayProperty(payload, 'verifiedTally')).toEqual([33, 13, 10, 6, 2]);
    expect(getStringProperty(payload, 'bulletinRoot')).toBe(mockRoot);
    expect(getStringProperty(payload, 'verificationExecutionId')).toBe('exec-1');
    const userVote = getRecordProperty(payload, 'userVote');
    expect(userVote).toBeDefined();
    const userVoteProof = getRecordProperty(userVote, 'proof');
    expect(userVoteProof).toBeUndefined();
    expect(getStringProperty(payload, 'verificationBundleUrl')).toBeUndefined();
    expect(getStringProperty(payload, 's3BundleUrl')).toBeUndefined();
    expect(getStringProperty(payload, 's3BundleKey')).toBeUndefined();
    expect(getStringProperty(payload, 's3UploadedAt')).toBeUndefined();
    expect(getStringProperty(payload, 's3BundleExpiresAt')).toBeUndefined();
    const verificationSteps = getArrayProperty(payload, 'verificationSteps');
    expect(verificationSteps).toBeDefined();
    expect(verificationSteps).toHaveLength(4);
    expect(verificationSteps?.map((step) => getStringProperty(step, 'id'))).toEqual([
      'cast_as_intended',
      'recorded_as_cast',
      'counted_as_recorded',
      'stark_verification',
    ]);
    expect(verificationSteps?.map((step) => getStringProperty(step, 'status'))).toEqual([
      'not_run',
      'not_run',
      'not_run',
      'success',
    ]);
  });

  it('should return cast-time CT proof when bulletin is available', async () => {
    const sessionId = 'ct-proof-session';
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const electionConfigHash = '0x' + 'a'.repeat(64);
    const logId = 'log-ct-proof';

    const userVoteId = '11111111-1111-4111-8111-111111111111';
    const botVoteId = '22222222-2222-4222-8222-222222222222';
    const extraVoteId = '33333333-3333-4333-8333-333333333333';

    const userCommit = '0x' + '1'.repeat(64);
    const botCommit = '0x' + '2'.repeat(64);
    const extraCommit = '0x' + '3'.repeat(64);

    const bulletin = new SimpleBulletinBoard(logId);
    bulletin.appendVote(userVoteId, userCommit);
    bulletin.appendVote(botVoteId, botCommit);
    bulletin.appendVote(extraVoteId, extraCommit);

    const userProofAtCast = bulletin.getInclusionProof(userVoteId, 1);
    if (!userProofAtCast) {
      throw new Error('Expected cast-time inclusion proof');
    }
    const botProofAtCast = bulletin.getInclusionProof(botVoteId, 2);
    if (!botProofAtCast) {
      throw new Error('Expected bot inclusion proof');
    }
    const extraProofAtCast = bulletin.getInclusionProof(extraVoteId, 3);
    if (!extraProofAtCast) {
      throw new Error('Expected extra inclusion proof');
    }

    const mockSession = createBaseSession({
      sessionId,
      electionId,
      electionConfigHash,
      logId,
      finalized: true,
      userVoteIndex: 0,
      bulletin,
      votes: new Map([
        [
          0,
          createVoteData({
            voteId: userVoteId,
            commit: userCommit,
            rand: '0x' + '4'.repeat(64),
            rootAtCast: addHexPrefix(userProofAtCast.rootHash),
          }),
        ],
        [
          1,
          createVoteData({
            vote: 'B',
            voteId: botVoteId,
            commit: botCommit,
            rand: '0x' + '5'.repeat(64),
            rootAtCast: addHexPrefix(botProofAtCast.rootHash),
          }),
        ],
        [
          2,
          createVoteData({
            vote: 'C',
            voteId: extraVoteId,
            commit: extraCommit,
            rand: '0x' + '6'.repeat(64),
            rootAtCast: addHexPrefix(extraProofAtCast.rootHash),
          }),
        ],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 1, C: 1, D: 0, E: 0 },
          totalVotes: 3,
          tamperedCount: 0,
        },
        bulletinRoot: addHexPrefix(bulletin.getCurrentRoot()),
        imageId: '0x' + '1'.repeat(64),
        verifiedTally: [1, 1, 1, 0, 0],
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 3,
        totalExpected: 3,
        treeSize: 3,
        sthDigest: '0x' + '2'.repeat(64),
        includedBitmapRoot: '0x' + '3'.repeat(64),
        inputCommitment: '0x' + '4'.repeat(64),
      },
    });

    getSessionMock.mockResolvedValue(mockSession);
    getVoteByIdWithProofMock.mockResolvedValue({
      voteData: mockSession.votes.get(0) ?? createVoteData({ voteId: userVoteId, commit: userCommit }),
      leafIndex: 0,
      merklePath: userProofAtCast.proofNodes.map((node) => addHexPrefix(node)),
      bulletinRootAtCast: addHexPrefix(userProofAtCast.rootHash),
      treeSize: 1,
    });

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const payload = requireDataRecord(responsePayload);
    const userVote = getRecordProperty(payload, 'userVote');
    const userVoteProof = getRecordProperty(userVote, 'proof');

    expect(response.status).toBe(200);
    expect(getNumberProperty(userVoteProof, 'treeSize')).toBe(1);
    expect(getStringProperty(userVoteProof, 'bulletinRootAtCast')).toBe(addHexPrefix(userProofAtCast.rootHash));
    const merklePath = getStringArrayProperty(userVoteProof, 'merklePath') ?? [];
    expect(merklePath).toEqual(userProofAtCast.proofNodes.map((node) => addHexPrefix(node)));
  });

  it('passes capability auth when resolving counted_my_vote_included bitmap proof', async () => {
    const sessionId = 'bitmap-auth-session';
    const capabilityToken = createTestSessionCapabilityToken(sessionId);
    const leafChunk = '01' + '0'.repeat(62);
    const hash = createHash('sha256');
    hash.update(Buffer.from([0x00]));
    hash.update(Buffer.from('stark-ballot:leaf|v1'));
    hash.update(Buffer.from(leafChunk, 'hex'));
    const includedBitmapRoot = `0x${hash.digest('hex')}`;

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes('/api/bitmap-proof?i=0')) {
        throw new Error(`Unexpected fetch url in test: ${url}`);
      }

      const headers = new Headers(init?.headers);
      const incomingCapability = headers.get(SESSION_CAPABILITY_HEADER);
      if (incomingCapability !== capabilityToken) {
        return new Response(JSON.stringify({ error: 'SESSION_CAPABILITY_REQUIRED' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          leafChunk,
          auditPath: [],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const mockSession = createBaseSession({
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [
          0,
          createVoteData({
            voteId: '11111111-1111-4111-8111-111111111111',
            rootAtCast: '0x' + '2'.repeat(64),
            path: MERKLE_PATH_SINGLE,
          }),
        ],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        verifiedTally: [1, 0, 0, 0, 0],
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 1,
        totalExpected: 1,
        treeSize: 1,
        includedBitmapRoot,
        inputCommitment: '0x' + '4'.repeat(64),
        sthDigest: '0x' + '5'.repeat(64),
        bitmapProofSource: 'mock',
        verificationResult: {
          status: 'success',
          report: createVerificationReport(),
        },
      },
    });
    getVoteByIdWithProofMock.mockResolvedValue({
      voteData: mockSession.votes.get(0) ?? createVoteData({ voteId: '11111111-1111-4111-8111-111111111111' }),
      leafIndex: 0,
      merklePath: MERKLE_PATH_SINGLE,
      bulletinRootAtCast: '0x' + '2'.repeat(64),
      treeSize: 1,
    });

    getSessionMock.mockResolvedValue(mockSession);

    try {
      const request = new NextRequest('http://localhost:3000/api/verify', {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: capabilityToken,
        },
      });

      const response = await GET(request);
      const responsePayload = await readJsonRecord(response, 'verify response');
      const data = requireDataRecord(responsePayload);
      const verificationChecks = getArrayProperty(data, 'verificationChecks') ?? [];
      const countedMyVoteIncluded = verificationChecks.find(
        (check) => getStringProperty(check, 'id') === 'counted_my_vote_included',
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(countedMyVoteIncluded).toBeDefined();
      expect(getStringProperty(countedMyVoteIncluded, 'status')).toBe('success');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('returns not_run when verification result is missing', async () => {
    const sessionId = 'not-run-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [0, createVoteData({ voteId: 'id-1' })],
        [1, createVoteData({ vote: 'B', voteId: 'id-2' })],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
          totalVotes: 2,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        s3BundleKey: 'sessions/not-run-session/exec-1/bundle.zip',
        s3BundleUrl: 'https://example.com/bundle.zip',
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('not_run');
  });

  it('keeps readable finalized sessions on the normal path when exact cast-time evidence is missing', async () => {
    const sessionId = 'missing-cast-evidence-session';
    const journal = createJournal({
      bulletinRoot: '0x' + '3'.repeat(64),
      treeSize: 1,
      totalExpected: 1,
      verifiedTally: [1, 0, 0, 0, 0],
      totalVotes: 1,
      validVotes: 1,
      countedIndices: 1,
      seenIndicesCount: 1,
      sthDigest: '0x' + '2'.repeat(64),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      inputCommitment: '0x' + '5'.repeat(64),
    });

    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [
          0,
          createVoteData({
            voteId: '11111111-1111-4111-8111-111111111111',
            rootAtCast: undefined,
          }),
        ],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: journal.bulletinRoot,
        imageId: '0x' + '1'.repeat(64),
        journal,
        verificationResult: {
          status: 'success',
          report: createVerificationReport({
            expected_image_id: '0x' + '1'.repeat(64),
            receipt_image_id: '0x' + '1'.repeat(64),
          }),
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);
    getVoteByIdWithProofMock.mockRejectedValue(new Error('CT_PROOF_UNAVAILABLE'));

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);
    const checks = getArrayProperty(data, 'verificationChecks') ?? [];
    const inclusionCheck = checks.find((check) => getStringProperty(check, 'id') === 'recorded_inclusion_proof');

    expect(response.status).toBe(200);
    expect(getRecordProperty(data, 'voteReceipt')).toBeUndefined();
    expect(getRecordProperty(getRecordProperty(data, 'userVote'), 'proof')).toBeUndefined();
    expect(inclusionCheck).toBeDefined();
    expect(getStringProperty(inclusionCheck, 'status')).toBe('not_run');
    expect(
      deriveVerificationSummary(checks as VerificationCheck[], {
        missingSlots: getNumberProperty(data, 'missingSlots'),
        invalidPresentedSlots: getNumberProperty(data, 'invalidPresentedSlots'),
        excludedSlots: getNumberProperty(data, 'excludedSlots'),
      })?.status,
    ).toBe('missing_evidence');
  });

  it('keeps readable finalized sessions on the normal path when the exact proof lookup returns null', async () => {
    const sessionId = 'missing-cast-evidence-null-session';
    const journal = createJournal({
      bulletinRoot: '0x' + '3'.repeat(64),
      treeSize: 1,
      totalExpected: 1,
      verifiedTally: [1, 0, 0, 0, 0],
      totalVotes: 1,
      validVotes: 1,
      countedIndices: 1,
      seenIndicesCount: 1,
      sthDigest: '0x' + '2'.repeat(64),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      inputCommitment: '0x' + '5'.repeat(64),
    });

    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [
          0,
          createVoteData({
            voteId: '11111111-1111-4111-8111-222222222222',
            rootAtCast: '0x' + '6'.repeat(64),
          }),
        ],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: journal.bulletinRoot,
        imageId: '0x' + '1'.repeat(64),
        journal,
        verificationResult: {
          status: 'success',
          report: createVerificationReport({
            expected_image_id: '0x' + '1'.repeat(64),
            receipt_image_id: '0x' + '1'.repeat(64),
          }),
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);
    getVoteByIdWithProofMock.mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);
    const checks = getArrayProperty(data, 'verificationChecks') ?? [];
    const inclusionCheck = checks.find((check) => getStringProperty(check, 'id') === 'recorded_inclusion_proof');

    expect(response.status).toBe(200);
    expect(getRecordProperty(data, 'voteReceipt')).toBeUndefined();
    expect(getRecordProperty(getRecordProperty(data, 'userVote'), 'proof')).toBeUndefined();
    expect(inclusionCheck).toBeDefined();
    expect(getStringProperty(inclusionCheck, 'status')).toBe('not_run');
    expect(
      deriveVerificationSummary(checks as VerificationCheck[], {
        missingSlots: getNumberProperty(data, 'missingSlots'),
        invalidPresentedSlots: getNumberProperty(data, 'invalidPresentedSlots'),
        excludedSlots: getNumberProperty(data, 'excludedSlots'),
      })?.status,
    ).toBe('missing_evidence');
  });

  it('does not mark tally consistent when verifiedTally is missing', async () => {
    const sessionId = 'missing-verified-tally-session';
    const journal = createJournal({
      bulletinRoot: '0x' + '3'.repeat(64),
      treeSize: 1,
      totalExpected: 1,
      verifiedTally: [1, 0, 0, 0, 0],
      totalVotes: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
      countedIndices: 1,
      sthDigest: '0x' + '2'.repeat(64),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      inputCommitment: '0x' + '5'.repeat(64),
      imageId: '0x' + '1'.repeat(64),
    });
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1' })]]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: journal.bulletinRoot,
        imageId: '0x' + '1'.repeat(64),
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 1,
        totalExpected: 1,
        treeSize: 1,
        sthDigest: journal.sthDigest,
        includedBitmapRoot: journal.includedBitmapRoot,
        inputCommitment: journal.inputCommitment,
        journal,
        verificationResult: {
          status: 'success',
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);
    const verificationChecks = getArrayProperty(data, 'verificationChecks') ?? [];
    const tallyCheck = verificationChecks.find(
      (check) => getStringProperty(check, 'id') === 'counted_tally_consistent',
    );

    expect(response.status).toBe(200);
    expect(getNumberArrayProperty(data, 'verifiedTally')).toEqual(journal.verifiedTally);
    expect(tallyCheck).toBeDefined();
    expect(getStringProperty(tallyCheck, 'status')).toBe('success');
  });

  it('fails closed when executionId is present but public input authority is unbound', async () => {
    const sessionId = 'summary-unbound-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1' })]]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        treeSize: 1,
        totalExpected: 1,
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 1,
        sthDigest: '0x' + '2'.repeat(64),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        inputCommitment: '0x' + '5'.repeat(64),
        publicInputArtifact: createTestPublicInputArtifact({
          typedAuthority: {
            bulletinRoot: '0x' + '3'.repeat(64),
            treeSize: 1,
            totalExpected: 1,
            votesCount: 1,
            recomputedInputCommitment: '0x' + '5'.repeat(64),
          },
        }),
        verificationResult: {
          status: 'success',
          executionId: 'exec-1',
        },
        verificationExecutionId: 'exec-1',
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify fail-closed response');

    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('does not synthesize public audit artifacts when finalization result does not store them', async () => {
    const sessionId = 'missing-audit-artifacts-session';
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const electionConfigHash = '0x' + 'a'.repeat(64);
    const logId = '0x' + 'b'.repeat(64);
    const bulletinRoot = '0x' + '1'.repeat(64);
    const sthDigest = '0x' + '2'.repeat(64);
    const inputCommitment = '0x' + '4'.repeat(64);

    const mockSession = createBaseSession({
      sessionId,
      electionId,
      electionConfigHash,
      logId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1', rootAtCast: bulletinRoot })]]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot,
        imageId: '0x' + '5'.repeat(64),
        verifiedTally: [1, 0, 0, 0, 0],
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 1,
        totalExpected: 1,
        treeSize: 1,
        sthDigest,
        includedBitmapRoot: '0x' + '3'.repeat(64),
        inputCommitment,
        journal: createJournal({
          electionId,
          electionConfigHash,
          bulletinRoot,
          treeSize: 1,
          totalExpected: 1,
          sthDigest,
          inputCommitment,
        }),
        publicInputArtifact: createTestPublicInputArtifact({
          typedAuthority: {
            electionId,
            electionConfigHash,
            votesCount: 1,
            treeSize: 1,
            totalExpected: 1,
            bulletinRoot,
            logId,
            timestamp: 123,
            recomputedInputCommitment: inputCommitment,
          },
        }),
        verificationResult: {
          status: 'success',
          report: createVerificationReport(),
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);
    const verificationChecks = getArrayProperty(data, 'verificationChecks') ?? [];
    const electionManifestCheck = verificationChecks.find(
      (check) => getStringProperty(check, 'id') === 'counted_election_manifest_consistent',
    );
    const closeStatementCheck = verificationChecks.find(
      (check) => getStringProperty(check, 'id') === 'counted_close_statement_consistent',
    );

    expect(response.status).toBe(200);
    expect(electionManifestCheck).toBeDefined();
    expect(closeStatementCheck).toBeDefined();
    expect(getStringProperty(electionManifestCheck, 'status')).toBe('not_run');
    expect(getStringProperty(closeStatementCheck, 'status')).toBe('not_run');
  });

  it('keeps generated public audit artifacts on sync verify paths so close-statement checks can succeed', async () => {
    const sessionId = 'generated-audit-artifacts-session';
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-1';
    const electionManifest = buildElectionManifest(electionId, buildDefaultElectionConfig());
    const logId = '0x' + 'b'.repeat(64);
    const bulletinRoot = '0x' + '1'.repeat(64);
    const closeStatement = buildCloseStatement({
      logId,
      treeSize: 64,
      timestamp: 123,
      bulletinRoot,
    });
    const inputCommitment = '0x' + '4'.repeat(64);

    const mockSession = createBaseSession({
      sessionId,
      electionId,
      electionConfigHash: electionManifest.electionConfigHash,
      logId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1', rootAtCast: bulletinRoot })]]),
      finalizationResult: {
        tally: {
          counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        bulletinRoot,
        imageId: '0x' + '5'.repeat(64),
        verifiedTally: [64, 0, 0, 0, 0],
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 64,
        totalExpected: 64,
        treeSize: 64,
        sthDigest: closeStatement.sthDigest,
        includedBitmapRoot: '0x' + '3'.repeat(64),
        inputCommitment,
        journal: createJournal({
          electionId,
          electionConfigHash: electionManifest.electionConfigHash,
          bulletinRoot,
          treeSize: 64,
          totalExpected: 64,
          validVotes: 64,
          totalVotes: 64,
          countedIndices: 64,
          seenIndicesCount: 64,
          sthDigest: closeStatement.sthDigest,
          inputCommitment,
        }),
        publicInputArtifact: createTestPublicInputArtifact({
          source: 'generated',
          executionId,
          typedAuthority: {
            electionId,
            electionConfigHash: electionManifest.electionConfigHash,
            votesCount: 64,
            treeSize: 64,
            totalExpected: 64,
            bulletinRoot,
            logId,
            timestamp: 123,
            methodVersion: CURRENT_METHOD_VERSION,
            recomputedInputCommitment: inputCommitment,
          },
        }),
        electionManifest,
        closeStatement,
        verificationExecutionId: executionId,
        verificationResult: {
          status: 'success',
          executionId,
          report: createVerificationReport(),
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);
    const verificationChecks = getArrayProperty(data, 'verificationChecks') ?? [];
    const electionManifestCheck = verificationChecks.find(
      (check) => getStringProperty(check, 'id') === 'counted_election_manifest_consistent',
    );
    const closeStatementCheck = verificationChecks.find(
      (check) => getStringProperty(check, 'id') === 'counted_close_statement_consistent',
    );
    const inputCommitmentCheck = verificationChecks.find(
      (check) => getStringProperty(check, 'id') === 'counted_input_commitment_match',
    );

    expect(response.status).toBe(200);
    expect(electionManifestCheck).toBeDefined();
    expect(closeStatementCheck).toBeDefined();
    expect(inputCommitmentCheck).toBeDefined();
    expect(getStringProperty(electionManifestCheck, 'status')).toBe('success');
    expect(getStringProperty(closeStatementCheck, 'status')).toBe('success');
    expect(getStringProperty(inputCommitmentCheck, 'status')).toBe('success');
  });

  it('fails closed when the stored journal contract is unsupported', async () => {
    const sessionId = 'unsupported-journal-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1' })]]),
      allowUnsupportedFinalizationResult: true,
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

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify error response');

    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('generates logId when missing and persists it', async () => {
    const sessionId = 'missing-logid-session';
    const mockSession = createBaseSession({
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [0, createVoteData({ voteId: 'id-1' })],
        [1, createVoteData({ vote: 'B', voteId: 'id-2' })],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
          totalVotes: 2,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        s3BundleKey: `sessions/${sessionId}/exec-1/bundle.zip`,
        s3BundleUrl: 'https://example.com/bundle.zip',
      },
    });

    getSessionMock.mockResolvedValue(mockSession);
    updateSessionMock.mockResolvedValue(undefined);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);

    expect(response.status).toBe(200);
    const logId = getStringProperty(data, 'logId');
    expect(logId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(updateSessionMock).toHaveBeenCalledWith(sessionId, expect.objectContaining({ logId }));
  });

  it('should error when verification result indicates failure', async () => {
    const sessionId = 'verifier-failed-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [0, { vote: 'A', voteId: 'id', rand: '0x' + '1'.repeat(64), commit: '0x' + '2'.repeat(64), path: [] }],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        journal: createJournal({
          verifiedTally: [1, 0, 0, 0, 0],
          missingIndices: 1,
          invalidIndices: 0,
          excludedCount: 1,
          countedIndices: 0,
          totalExpected: 1,
          treeSize: 1,
        }),
        verificationResult: {
          status: 'failed',
          report: createVerificationReport({
            status: 'failed',
            duration_ms: 10,
            receipt_image_id: null,
            errors: ['ImageID mismatch'],
          }),
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
    expect(getNumberProperty(data, 'excludedSlots')).toBe(1);
    expect(getNumberProperty(data, 'excludedCount')).toBeUndefined();
    expect(data.tamperDetected).toBe(true);
  });

  it('returns fail-closed verification data for unsupported verification statuses', async () => {
    const sessionId = 'invalid-verification-status';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [0, createVoteData({ voteId: 'id' })],
        [1, createVoteData({ vote: 'B', voteId: 'id-2' })],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
          totalVotes: 2,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        journal: createJournal({
          verifiedTally: [1, 1, 0, 0, 0],
          missingIndices: 0,
          invalidIndices: 0,
          excludedCount: 0,
          countedIndices: 2,
          totalExpected: 2,
          treeSize: 2,
        }),
        verificationResult: {
          status: 'unexpected' as unknown as VerificationReport['status'],
          executionId: 'exec-1',
          report: createVerificationReport({
            status: 'success',
            duration_ms: 10,
            errors: [],
          }),
        },
        verificationExecutionId: 'exec-1',
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');

    expect(response.status).toBe(200);
    const data = requireDataRecord(responsePayload);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
    expect(getStringProperty(data, 'verificationExecutionId')).toBe('exec-1');
    expect(getStringProperty(data, 'verificationBundleUrl')).toBeUndefined();
    const steps = getArrayProperty(data, 'verificationSteps');
    expect(steps).toHaveLength(4);
    expect(steps?.map((step) => getStringProperty(step, 'id'))).toEqual([
      'cast_as_intended',
      'recorded_as_cast',
      'counted_as_recorded',
      'stark_verification',
    ]);
  });

  it('should return tamper detection when invalidIndices are present', async () => {
    const sessionId = 'invalid-indices-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [0, { vote: 'A', voteId: 'id', rand: '0x' + '1'.repeat(64), commit: '0x' + '2'.repeat(64), path: [] }],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        journal: createJournal({
          verifiedTally: [1, 0, 0, 0, 0],
          missingIndices: 0,
          invalidIndices: 1,
          excludedCount: 1,
          countedIndices: 0,
          totalExpected: 1,
          treeSize: 1,
        }),
        verificationResult: {
          status: 'success',
          report: createVerificationReport({
            status: 'success',
            duration_ms: 10,
            errors: [],
          }),
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
    expect(getNumberProperty(data, 'excludedSlots')).toBe(1);
    expect(getNumberProperty(data, 'excludedCount')).toBeUndefined();
    expect(getNumberProperty(data, 'missingSlots')).toBe(0);
    expect(getNumberProperty(data, 'invalidPresentedSlots')).toBe(1);
    expect(data.tamperDetected).toBe(true);
  });

  it('does not treat rejectedRecords without excludedSlots as tally exclusion', async () => {
    const previousExpectedImageId = process.env.EXPECTED_IMAGE_ID;
    process.env.EXPECTED_IMAGE_ID = '0x' + '1'.repeat(64);

    const sessionId = 'rejected-records-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1' })]]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '4'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        journal: createJournal({
          verifiedTally: [1, 0, 0, 0, 0],
          totalVotes: 2,
          validVotes: 1,
          invalidVotes: 1,
          seenIndicesCount: 1,
          missingSlots: 0,
          invalidPresentedSlots: 0,
          rejectedRecords: 1,
          excludedSlots: 0,
          totalExpected: 1,
          treeSize: 1,
        }),
        verificationResult: {
          status: 'success',
          report: createVerificationReport({
            status: 'success',
            duration_ms: 10,
            expected_image_id: '0x' + '1'.repeat(64),
            receipt_image_id: '0x' + '1'.repeat(64),
            errors: [],
          }),
        },
      },
    });

    try {
      getSessionMock.mockResolvedValue(mockSession);

      const request = new NextRequest('http://localhost:3000/api/verify', {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const responsePayload = await readJsonRecord(response, 'verify response');
      const data = requireDataRecord(responsePayload);
      const verificationChecks = getArrayProperty(data, 'verificationChecks') ?? [];
      const completenessCheck = verificationChecks.find(
        (check) => getStringProperty(check, 'id') === 'counted_missing_indices_zero',
      );

      expect(response.status).toBe(200);
      expect(getStringProperty(data, 'verificationStatus')).toBe('success');
      expect(getNumberProperty(data, 'excludedSlots')).toBe(0);
      expect(getNumberProperty(data, 'excludedCount')).toBeUndefined();
      expect(getNumberProperty(data, 'invalidPresentedSlots')).toBe(0);
      expect(getNumberProperty(data, 'rejectedRecords')).toBe(1);
      expect(data.tamperDetected).toBe(true);
      expect(getStringProperty(completenessCheck, 'status')).toBe('success');
    } finally {
      if (previousExpectedImageId === undefined) {
        delete process.env.EXPECTED_IMAGE_ID;
      } else {
        process.env.EXPECTED_IMAGE_ID = previousExpectedImageId;
      }
    }
  });

  it('preserves record-only rejections when synthesizing a canonical journal from top-level mirrors', async () => {
    const previousExpectedImageId = process.env.EXPECTED_IMAGE_ID;
    process.env.EXPECTED_IMAGE_ID = '0x' + '1'.repeat(64);

    const sessionId = 'rejected-records-top-level-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1' })]]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '4'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        countedIndices: 1,
        missingIndices: 0,
        invalidIndices: 0,
        rejectedRecords: 1,
        excludedCount: 0,
        totalExpected: 1,
        treeSize: 1,
        verificationResult: {
          status: 'success',
          report: createVerificationReport({
            status: 'success',
            duration_ms: 10,
            expected_image_id: '0x' + '1'.repeat(64),
            receipt_image_id: '0x' + '1'.repeat(64),
            errors: [],
          }),
        },
      },
    });

    try {
      getSessionMock.mockResolvedValue(mockSession);

      const request = new NextRequest('http://localhost:3000/api/verify', {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      });

      const response = await GET(request);
      const responsePayload = await readJsonRecord(response, 'verify response');
      const data = requireDataRecord(responsePayload);

      expect(response.status).toBe(200);
      expect(getStringProperty(data, 'verificationStatus')).toBe('success');
      expect(getNumberArrayProperty(data, 'verifiedTally')?.reduce((sum, count) => sum + count, 0)).toBe(1);
      expect(getNumberProperty(data, 'invalidPresentedSlots')).toBe(0);
      expect(getNumberProperty(data, 'rejectedRecords')).toBe(1);
      expect(getNumberProperty(data, 'excludedSlots')).toBe(0);
      expect(getNumberProperty(data, 'excludedCount')).toBeUndefined();
      expect(getNumberProperty(data, 'seenIndicesCount')).toBe(1);
      expect(data.tamperDetected).toBe(true);
    } finally {
      if (previousExpectedImageId === undefined) {
        delete process.env.EXPECTED_IMAGE_ID;
      } else {
        process.env.EXPECTED_IMAGE_ID = previousExpectedImageId;
      }
    }
  });

  it('prefers canonical journal values over stale top-level verification fields', async () => {
    const sessionId = 'journal-authority-session';
    const journal = createJournal({
      bulletinRoot: '0x' + '9'.repeat(64),
      verifiedTally: [0, 0, 0, 0, 0],
      totalVotes: 0,
      validVotes: 0,
      missingIndices: 1,
      invalidIndices: 0,
      countedIndices: 0,
      totalExpected: 1,
      treeSize: 1,
      sthDigest: '0x' + '8'.repeat(64),
      includedBitmapRoot: '0x' + '7'.repeat(64),
      inputCommitment: '0x' + '6'.repeat(64),
      excludedCount: 1,
    });
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1' })]]),
      finalizationResult: {
        tally: {
          counts: { A: 0, B: 1, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '1'.repeat(64),
        verifiedTally: [1, 0, 0, 0, 0],
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 1,
        totalExpected: 1,
        treeSize: 1,
        excludedCount: 0,
        sthDigest: '0x' + '2'.repeat(64),
        includedBitmapRoot: '0x' + '3'.repeat(64),
        inputCommitment: '0x' + '4'.repeat(64),
        journal,
        verificationResult: {
          status: 'success',
          report: createVerificationReport(),
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');

    expect(response.status).toBe(200);
    const data = requireDataRecord(responsePayload);
    expect(getNumberProperty(data, 'excludedSlots')).toBe(1);
    expect(getNumberProperty(data, 'excludedCount')).toBeUndefined();
    expect(getNumberProperty(data, 'missingSlots')).toBe(1);
    expect(getNumberArrayProperty(data, 'verifiedTally')?.reduce((sum, count) => sum + count, 0)).toBe(0);
    expect(getStringProperty(data, 'bulletinRoot')).toBe(journal.bulletinRoot);
    expect(getStringProperty(data, 'inputCommitment')).toBe(journal.inputCommitment);
    expect(getStringProperty(data, 'includedBitmapRoot')).toBe(journal.includedBitmapRoot);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
  });

  it('fails closed when claimed and verifier-confirmed image ids disagree', async () => {
    const sessionId = 'image-id-mismatch-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ voteId: 'id-1' })]]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + 'f'.repeat(64),
        journal: createJournal(),
        verificationResult: {
          status: 'success',
          report: createVerificationReport({
            expected_image_id: '0x' + '1'.repeat(64),
            receipt_image_id: '0x' + '1'.repeat(64),
          }),
        },
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');

    expect(response.status).toBe(200);
    const data = requireDataRecord(responsePayload);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
    const verificationChecks = getArrayProperty(data, 'verificationChecks') ?? [];
    const imageCheck = verificationChecks.find((check) => getStringProperty(check, 'id') === 'stark_image_id_match');
    expect(imageCheck).toBeDefined();
    expect(getStringProperty(imageCheck, 'status')).toBe('failed');
  });

  it('fails closed when canonical proof-bound journal data is missing', async () => {
    const sessionId = 'missing-journal-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      allowUnsupportedFinalizationResult: true,
      votes: new Map([[0, createVoteData({ voteId: 'id-1' })]]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        imageId: '0x' + '4'.repeat(64),
        verifiedTally: [1, 0, 0, 0, 0],
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 1,
        totalExpected: 1,
        treeSize: 1,
        excludedCount: 0,
        sthDigest: '0x' + '5'.repeat(64),
        includedBitmapRoot: '0x' + '6'.repeat(64),
        inputCommitment: '0x' + '7'.repeat(64),
      },
    });

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('should return error if session ID is missing', async () => {
    // Arrange
    const request = new NextRequest('http://localhost:3000/api/verify');

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.SESSION_ID_REQUIRED);
  });

  it('should return error if capability token is missing', async () => {
    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'test-session-id',
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    expect(response.status).toBe(401);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('should return error if session is not found', async () => {
    // Arrange
    getSessionMock.mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'non-existent',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('non-existent'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    // Assert
    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it('should return object error payload on unexpected exceptions', async () => {
    // Arrange
    getSessionMock.mockRejectedValueOnce(new Error('boom'));

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'test-session-id',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-id'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    // Assert
    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('should return error if session is not finalized', async () => {
    // Arrange
    const mockSession = createBaseSession({
      sessionId: 'test-session-id',
      finalized: false,
    });
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'test-session-id',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-id'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.SESSION_NOT_FINALIZED);
  });

  it('fails closed for stale finalized artifacts before projecting verification data', async () => {
    const sessionId = 'stale-finalized-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      finalizationContractGeneration: 'stale-contract-generation',
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData()]]),
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
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify stale finalized response');

    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT);
    expect(getStringProperty(payload, 'artifactState')).toBe('unsupported_current_artifact');
  });

  it('returns a dedicated corrupt-state error for unreadable finalized artifacts', async () => {
    const sessionId = 'corrupt-finalized-session';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      finalizationArtifactState: 'corrupt_or_unreadable',
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData()]]),
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
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify corrupt finalized response');

    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('fails closed when a current finalized session is missing the top-level verificationExecutionId', async () => {
    const sessionId = 'missing-selector-session';
    const mockSession = createBaseSession({
      sessionId,
      allowMissingVerificationExecutionId: true,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData()]]),
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
        journal: createJournal(),
        verificationResult: {
          status: 'success',
          executionId: 'exec-1',
        },
      },
    });
    getSessionMock.mockResolvedValue(mockSession);

    const response = await GET(
      new NextRequest('http://localhost:3000/api/verify', {
        headers: {
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
      }),
    );
    const payload = await readJsonRecord(response, 'verify missing selector response');

    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('should return error if user has not voted', async () => {
    // Arrange
    const mockSession = createBaseSession({
      sessionId: 'test-session-id',
      finalized: true,
      userVoteIndex: undefined,
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
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'test-session-id',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-id'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    // Assert
    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.USER_NOT_VOTED);
  });

  it('should return error if finalization result is missing', async () => {
    // Arrange
    const mockSession = createBaseSession({
      sessionId: 'test-session-id',
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ commit: '0x' + '2'.repeat(64) })]]),
      finalizationResult: undefined,
    });
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'test-session-id',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-id'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    // Assert
    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('fails closed when the stored finalized authority cannot be canonicalized', async () => {
    const sessionId = 'verify-current-authority-missing-public-input';
    const mockSession = createBaseSession({
      sessionId,
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ commit: '0x' + '2'.repeat(64) })]]),
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
    delete mockSession.finalizationResult?.publicInputArtifact;
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
    });

    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify corrupt canonicalization response');

    expect(response.status).toBe(200);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('should handle store errors gracefully', async () => {
    // Arrange
    getSessionMock.mockRejectedValue(new Error('Database error'));

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'test-session-id',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-id'),
      },
    });

    // Act
    const response = await GET(request);
    const payload = await readJsonRecord(response, 'verify response');

    // Assert
    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('should include tamper scenarios in response', async () => {
    // Arrange
    const mockSession = createBaseSession({
      sessionId: 'test-session-id',
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([[0, createVoteData({ commit: '0x' + '2'.repeat(64), path: MERKLE_PATH_SINGLE })]]),
      finalizationResult: {
        tally: {
          counts: { A: 32, B: 13, C: 10, D: 6, E: 3 },
          totalVotes: 64,
          tamperedCount: 1,
        },
        bulletinRoot: '0x' + '3'.repeat(64),
        receipt: { seal: 'seal', journal: 'journal' },
        imageId: '0x' + '1'.repeat(64),
        scenarios: ['S1'],
      },
    });
    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'test-session-id',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('test-session-id'),
      },
    });

    // Act
    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);

    // Assert
    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'scenarioId')).toBe('S1');
    const tally = getRecordProperty(data, 'tally');
    expect(getNumberProperty(tally, 'tamperedCount')).toBe(1);
  });

  it('suppresses stored raw bundle URL fields', async () => {
    const mockCommitment = '0x' + 'a'.repeat(64);
    const mockRandom = '0x' + 'f'.repeat(64);

    const mockSession = createBaseSession({
      sessionId: 'session-with-expired-url',
      finalized: true,
      userVoteIndex: 0,
      votes: new Map([
        [
          0,
          createVoteData({
            vote: 'A',
            commit: mockCommitment,
            path: MERKLE_PATH,
            rand: mockRandom,
          }),
        ],
      ]),
      finalizationResult: {
        tally: {
          counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        receipt: { seal: 'seal', journal: 'journal' },
        imageId: '0x' + '1'.repeat(64),
        s3BundleUrl: 'https://old-presigned-url.s3.amazonaws.com/bundle.zip',
        s3BundleKey: 'sessions/session-with-expired-url/exec-123/bundle.zip',
        s3BundleExpiresAt: '2025-10-20T02:00:00.000Z',
        verificationExecutionId: 'exec-123',
        verificationResult: {
          status: 'success',
          executionId: 'exec-123',
          report: createVerificationReport(),
        },
      },
    });
    getSessionMock.mockResolvedValue(mockSession);
    updateSessionMock.mockResolvedValue(undefined);

    const request = new NextRequest('http://localhost:3000/api/verify', {
      headers: {
        'X-Session-ID': 'session-with-expired-url',
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-with-expired-url'),
      },
    });

    // Act
    const response = await GET(request);
    const responsePayload = await readJsonRecord(response, 'verify response');
    const data = requireDataRecord(responsePayload);

    // Assert
    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationExecutionId')).toBe('exec-123');
    expect(getStringProperty(data, 'verificationBundleUrl')).toBeUndefined();
    expect(getStringProperty(data, 's3BundleUrl')).toBeUndefined();
    expect(getStringProperty(data, 's3BundleKey')).toBeUndefined();
    expect(getStringProperty(data, 's3UploadedAt')).toBeUndefined();
    expect(getStringProperty(data, 's3BundleExpiresAt')).toBeUndefined();
    const finalizationResultUpdate = updateSessionMock.mock.calls
      .map((call) => call[1])
      .find((payload) => payload?.finalizationResult);
    expect(finalizationResultUpdate).toBeUndefined();
  });
});
