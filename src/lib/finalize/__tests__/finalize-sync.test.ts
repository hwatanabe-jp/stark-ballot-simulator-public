import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizationResultAuthority, SessionData, VerificationResult, VoteData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import type { ProofBundleService } from '@/lib/finalize/proof-bundle-service';
import type { ZkVMExecutionResult } from '@/lib/zkvm/executor';
import { CURRENT_METHOD_VERSION, type ZkVMInput } from '@/lib/zkvm/types';
import type { FinalizeScenarioContext } from '@/lib/finalize/usecases/types';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { finalizeSync } from '@/lib/finalize/usecases/finalize-sync';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { computeIncludedBitmapRoot } from '@/lib/zkvm/bitmap';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { projectFinalizationResultForPublicResponse } from '@/lib/finalize/finalization-result';
import { resolveCurrentContractGeneration } from '@/lib/contract';

const TEST_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

const { buildUserVoteArtifactsMock, UserVoteArtifactsUnavailableErrorMock } = vi.hoisted(() => ({
  buildUserVoteArtifactsMock: vi.fn(),
  UserVoteArtifactsUnavailableErrorMock: class UserVoteArtifactsUnavailableErrorMock extends Error {},
}));

function createUserVoteArtifacts() {
  return {
    bulletinRoot: '0x' + '11'.repeat(32),
    inputCommitment: '0x' + '22'.repeat(32),
    voteReceipt: {
      voteId: 'vote-1',
      commitment: '0x' + '33'.repeat(32),
      bulletinIndex: 0,
      bulletinRootAtCast: '0x' + '44'.repeat(32),
      timestamp: Date.now(),
      inputCommitment: '0x' + '22'.repeat(32),
    },
    userVoteProof: {
      commitment: '0x' + '33'.repeat(32),
      voteId: 'vote-1',
      proof: {
        leafIndex: 0,
        merklePath: ['0x' + '55'.repeat(32)],
        treeSize: 1,
        bulletinRootAtCast: '0x' + '44'.repeat(32),
      },
    },
  };
}

vi.mock('@/lib/finalize/usecases/user-vote-artifacts', () => ({
  buildUserVoteArtifacts: buildUserVoteArtifactsMock,
  UserVoteArtifactsUnavailableError: UserVoteArtifactsUnavailableErrorMock,
}));

const createVote = (vote: VoteData['vote']): VoteData => ({
  vote,
  rand: '0x' + '1'.repeat(64),
  commit: '0x' + '2'.repeat(64),
  path: [],
});

const createSession = (votes: Map<number, VoteData>): SessionData => ({
  sessionId: 'session-1',
  contractGeneration: resolveCurrentContractGeneration(),
  electionId: TEST_ELECTION_ID,
  electionConfigHash: getDefaultElectionConfigHash(),
  electionConfig: buildDefaultElectionConfig(),
  votes,
  botCount: 64,
  finalized: false,
  createdAt: Date.now(),
  lastActivity: Date.now(),
  userVoteIndex: 0,
});

const createZkvmInput = (): ZkVMInput => ({
  electionId: TEST_ELECTION_ID,
  electionConfigHash: getDefaultElectionConfigHash(),
  bulletinRoot: '0x' + 'aa'.repeat(32),
  treeSize: 1,
  totalExpected: 64,
  logId: '0x' + 'bb'.repeat(32),
  timestamp: Date.now(),
  votes: [
    {
      index: 0,
      commitment: '0x' + 'cc'.repeat(32),
      choice: 0,
      random: '0x' + 'dd'.repeat(32),
      merklePath: ['0x' + 'ee'.repeat(32)],
    },
  ],
});

const createZkvmResult = (): ZkVMExecutionResult => ({
  ...createTestJournal({
    totalExpected: 1,
    validVotes: 1,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    seenIndicesCount: 1,
  }),
  electionId: TEST_ELECTION_ID,
  electionConfigHash: getDefaultElectionConfigHash(),
  bulletinRoot: '0x' + 'aa'.repeat(32),
  treeSize: 1,
  totalExpected: 64,
  sthDigest: '0x' + 'bb'.repeat(32),
  verifiedTally: [1, 0, 0, 0, 0],
  totalVotes: 1,
  validVotes: 1,
  invalidVotes: 0,
  seenIndicesCount: 1,
  missingSlots: 0,
  invalidPresentedSlots: 0,
  rejectedRecords: 0,
  includedBitmapRoot: '0x' + 'cc'.repeat(32),
  excludedSlots: 0,
  inputCommitment: '0x' + 'dd'.repeat(32),
  methodVersion: CURRENT_METHOD_VERSION,
  imageId: '0x' + 'ee'.repeat(32),
  receipt: {
    imageId: '0x' + 'ee'.repeat(32),
    payload: {
      inner: { Fake: {} },
      seal: 'seal',
      journal: { fake: true },
    },
    raw: {},
  },
});

const createVerificationResult = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
  status: 'dev_mode' as const,
  report: {
    status: 'dev_mode' as const,
    verifier_version: 'mock-bundle',
    verified_at: '2026-01-01T00:00:00.000Z',
    duration_ms: 0,
    expected_image_id: '0x' + 'ee'.repeat(32),
    receipt_image_id: '0x' + 'ee'.repeat(32),
    bundle_path: '/tmp/bundle',
    receipt_path: '/tmp/bundle/receipt.json',
    dev_mode_receipt: true,
    errors: [],
  },
  executionId: 'exec-1',
  ...overrides,
});

function assertAuthorityResult(
  result: SessionData['finalizationResult'],
): asserts result is FinalizationResultAuthority {
  if (!result?.journal) {
    throw new Error('Expected canonical finalization result payload');
  }
}

describe('finalizeSync (scenario overrides)', () => {
  beforeEach(() => {
    buildUserVoteArtifactsMock.mockReset();
    buildUserVoteArtifactsMock.mockImplementation(() => createUserVoteArtifacts());
  });

  it('does not override missing/invalid for claim tampering', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const zkvmInput = createZkvmInput();
    const zkvmResult = createZkvmResult();

    const scenario: FinalizeScenarioContext = {
      scenarios: ['S2'],
      scenariosApplied: ['S2'],
      tamperMode: 'claim',
      claimedCounts: { A: 0, B: 1, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 1,
      summary: { ignoredCount: 0, recountedCount: 1, userRecountChoice: 'B' },
      scenarioResult: null,
    };
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue({
      ok: true,
      verificationResult: createVerificationResult(),
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore(),
        getExecutor: () =>
          Promise.resolve({
            type: 'mock',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(true);
    expect(createBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationMode: 'mock',
      }),
    );
    if (result.ok) {
      expect(result.value.missingSlots).toBe(0);
      expect(result.value.invalidPresentedSlots).toBe(0);
      expect(result.value.journal.validVotes).toBe(1);
    }
  });

  it('projects a fail-closed verification status for claim tampering responses', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const zkvmInput = createZkvmInput();
    const zkvmResult = createZkvmResult();

    const scenario: FinalizeScenarioContext = {
      scenarios: ['S2'],
      scenariosApplied: ['S2'],
      tamperMode: 'claim',
      claimedCounts: { A: 0, B: 1, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 1,
      summary: { ignoredCount: 0, recountedCount: 1, userRecountChoice: 'B' },
      scenarioResult: null,
    };
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue({
      ok: true,
      verificationResult: createVerificationResult(),
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore(),
        getExecutor: () =>
          Promise.resolve({
            type: 'mock',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verificationStatus).toBe('failed');
    }
  });

  it('persists tamperDetected when rejected records are present without excluded slots', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const zkvmInput = createZkvmInput();
    const zkvmResult = {
      ...createZkvmResult(),
      totalVotes: 2,
      invalidVotes: 1,
      invalidPresentedSlots: 0,
      rejectedRecords: 1,
      excludedSlots: 0,
    } satisfies ZkVMExecutionResult;
    const finalizeSession = vi.fn<NonNullable<VoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const store = createMockVoteStore({ finalizeSession });
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue({
      ok: true,
      verificationResult: createVerificationResult(),
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario: {
          scenarios: [],
          scenariosApplied: [],
          tamperMode: 'none',
          claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          claimedTotalVotes: 1,
          summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
          scenarioResult: null,
        },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store,
        getExecutor: () =>
          Promise.resolve({
            type: 'mock',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(true);
    expect(finalizeSession).toHaveBeenCalledOnce();
    const [calledSessionId, calledResult] = finalizeSession.mock.calls[0];
    expect(calledSessionId).toBe('session-1');
    assertAuthorityResult(calledResult);
    expect(calledResult.tamperDetected).toBe(true);
    expect(calledResult.journal.rejectedRecords).toBe(1);
    expect(calledResult.journal.excludedSlots).toBe(0);
  });

  it('does not mutate proof-derived counts for input tampering before bundle creation', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const zkvmInput = createZkvmInput();
    const zkvmResult = {
      ...createZkvmResult(),
      validVotes: 1,
      invalidVotes: 0,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      excludedSlots: 0,
    } satisfies ZkVMExecutionResult;
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue({
      ok: true,
      verificationResult: createVerificationResult({ status: 'success' }),
    });

    const scenario: FinalizeScenarioContext = {
      scenarios: ['S5'],
      scenariosApplied: ['S5'],
      tamperMode: 'input',
      claimedCounts: { A: 0, B: 1, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 1,
      summary: { ignoredCount: 3, recountedCount: 2, userRecountChoice: 'B' },
      scenarioResult: null,
    };

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore(),
        getExecutor: () =>
          Promise.resolve({
            type: 'real',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(true);
    expect(createBundle).toHaveBeenCalledOnce();
    const bundleOptions = createBundle.mock.calls[0][0];
    expect(bundleOptions.zkvmResult.validVotes).toBe(1);
    expect(bundleOptions.zkvmResult.invalidVotes).toBe(0);
    expect(bundleOptions.zkvmResult.missingSlots).toBe(0);
    expect(bundleOptions.zkvmResult.invalidPresentedSlots).toBe(0);
    expect(bundleOptions.zkvmResult.rejectedRecords).toBe(0);
    expect(bundleOptions.zkvmResult.excludedSlots).toBe(0);
  });

  it('projects fail-closed verification status and strips verifier-only report fields from the sync response', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const zkvmInput = createZkvmInput();
    const zkvmResult = {
      ...createZkvmResult(),
      totalVotes: 63,
      validVotes: 63,
      missingSlots: 1,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      excludedSlots: 1,
    } satisfies ZkVMExecutionResult;
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue({
      ok: true,
      verificationResult: createVerificationResult({
        status: 'success',
        report: {
          status: 'success',
          verifier_version: '0.1.0',
          verified_at: '2026-01-01T00:00:00.000Z',
          duration_ms: 42,
          expected_image_id: zkvmResult.imageId ?? '',
          receipt_image_id: zkvmResult.imageId ?? '',
          bundle_path: '/tmp/bundle',
          receipt_path: '/tmp/bundle/receipt.json',
          dev_mode_receipt: false,
          errors: [],
        },
      }),
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario: {
          scenarios: ['S0'],
          scenariosApplied: ['S0'],
          tamperMode: 'none',
          claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          claimedTotalVotes: 1,
          summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
          scenarioResult: null,
        },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore(),
        getExecutor: () =>
          Promise.resolve({
            type: 'real',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verificationStatus).toBe('failed');
      expect(result.value.verificationReport).not.toHaveProperty('bundle_path');
      expect(result.value.verificationReport).not.toHaveProperty('receipt_path');
      expect(result.value.verificationExecutionId).toBe('exec-1');
    }
  });

  it('fails closed on an unsupported zkVM journal contract before persisting success', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<VoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const createBundle = vi.fn();
    const zkvmResult = {
      ...createZkvmResult(),
      methodVersion: CURRENT_METHOD_VERSION - 1,
    } satisfies ZkVMExecutionResult;

    const scenario: FinalizeScenarioContext = {
      scenarios: ['S0'],
      scenariosApplied: ['S0'],
      tamperMode: 'none',
      claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 1,
      summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
      scenarioResult: null,
    };

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore({ finalizeSession }),
        getExecutor: () =>
          Promise.resolve({
            type: 'real',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('api');
      if (result.error.kind === 'api') {
        expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
        expect(result.error.details?.details).toContain('Unsupported zkVM journal contract');
      }
    }
    expect(createBundle).not.toHaveBeenCalled();
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  it('fails before verifier, publication, persistence, or bitmap side effects when exact user vote artifacts are unavailable', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<VoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const createBundle = vi.fn<ProofBundleService['createBundle']>();
    const saveReceiptToBoard = vi.fn().mockResolvedValue({
      receiptHash: 'receipt-hash',
      boardIndex: 0,
    });
    const saveBitmapData = vi.fn().mockResolvedValue(undefined);
    const zkvmResult = createZkvmResult();

    buildUserVoteArtifactsMock.mockImplementationOnce(() => {
      throw new UserVoteArtifactsUnavailableErrorMock('Exact cast-time bulletin root is missing for user vote');
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario: {
          scenarios: ['S0'],
          scenariosApplied: ['S0'],
          tamperMode: 'none',
          claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          claimedTotalVotes: 1,
          summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
          scenarioResult: null,
        },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore({ finalizeSession, saveReceiptToBoard, saveBitmapData }),
        getExecutor: () =>
          Promise.resolve({
            type: 'real',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('api');
      if (result.error.kind === 'api') {
        expect(result.error.code).toBe(ErrorCode.VERIFICATION_FAILED);
        expect(result.error.details?.details).toContain('Exact cast-time bulletin root is missing');
      }
    }
    expect(createBundle).not.toHaveBeenCalled();
    expect(saveReceiptToBoard).not.toHaveBeenCalled();
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(saveBitmapData).not.toHaveBeenCalled();
    expect(session.finalizationResult).toBeUndefined();
  });

  it('returns an internal error when unexpected user vote artifact assembly fails', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<VoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const createBundle = vi.fn<ProofBundleService['createBundle']>();
    const saveReceiptToBoard = vi.fn().mockResolvedValue({
      receiptHash: 'receipt-hash',
      boardIndex: 0,
    });
    const saveBitmapData = vi.fn().mockResolvedValue(undefined);
    const zkvmResult = createZkvmResult();

    buildUserVoteArtifactsMock.mockImplementationOnce(() => {
      throw new Error('unexpected artifact failure');
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario: {
          scenarios: ['S0'],
          scenariosApplied: ['S0'],
          tamperMode: 'none',
          claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          claimedTotalVotes: 1,
          summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
          scenarioResult: null,
        },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore({ finalizeSession, saveReceiptToBoard, saveBitmapData }),
        getExecutor: () =>
          Promise.resolve({
            type: 'real',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('api');
      if (result.error.kind === 'api') {
        expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
        expect(result.error.details?.details).toBe('Failed to build exact user vote artifacts');
      }
    }
    expect(createBundle).not.toHaveBeenCalled();
    expect(saveReceiptToBoard).not.toHaveBeenCalled();
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(saveBitmapData).not.toHaveBeenCalled();
    expect(session.finalizationResult).toBeUndefined();
  });

  it('returns verifier failures with safe public details only', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const zkvmResult = createZkvmResult();
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue({
      ok: false,
      error: {
        type: 'verifier_failed',
        executionId: 'exec-1',
        status: 'failed',
        reportPath: '/tmp/bundle/verification.json',
        bundlePath: '/tmp/bundle',
        bundleArchivePath: '/tmp/bundle/bundle.zip',
        bundleUrl: 'https://example.com/bundle',
        reportUrl: 'https://example.com/bundle/report',
        report: {
          status: 'failed',
          verifier_version: '0.1.0',
          verified_at: '2026-01-01T00:00:00.000Z',
          duration_ms: 42,
          expected_image_id: zkvmResult.imageId ?? '',
          receipt_image_id: null,
          bundle_path: '/tmp/bundle',
          receipt_path: '/tmp/bundle/receipt.json',
          dev_mode_receipt: false,
          errors: ['ImageID mismatch'],
        },
      },
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario: {
          scenarios: ['S0'],
          scenariosApplied: ['S0'],
          tamperMode: 'none',
          claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          claimedTotalVotes: 1,
          summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
          scenarioResult: null,
        },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore(),
        getExecutor: () =>
          Promise.resolve({
            type: 'real',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('api');
      if (result.error.kind === 'api') {
        expect(result.error.code).toBe(ErrorCode.VERIFICATION_FAILED);
        expect(result.error.details).toMatchObject({
          status: 'failed',
          verificationExecutionId: 'exec-1',
          verificationReport: {
            status: 'failed',
            verifier_version: '0.1.0',
            duration_ms: 42,
            errors: ['ImageID mismatch'],
          },
        });
        expect(result.error.details).not.toHaveProperty('bundlePath');
        expect(result.error.details).not.toHaveProperty('reportPath');
        expect(result.error.details).not.toHaveProperty('bundleArchivePath');
        expect(result.error.details).not.toHaveProperty('bundleUrl');
        expect(result.error.details).not.toHaveProperty('reportUrl');
      }
    }
  });

  it('persists the exact included and seen bitmaps for real flows', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const zkvmInput = createZkvmInput();
    const exactBitmap = [false, true, true, true];
    const seenBitmap = [true, true, true, true];
    const saveBitmapData = vi.fn().mockResolvedValue(undefined);
    const zkvmResult = {
      ...createZkvmResult(),
      treeSize: exactBitmap.length,
      validVotes: 3,
      totalVotes: 4,
      seenIndicesCount: 4,
      missingSlots: 0,
      invalidPresentedSlots: 1,
      rejectedRecords: 1,
      excludedSlots: 1,
      seenBitmapRoot: computeIncludedBitmapRoot(seenBitmap),
      includedBitmapRoot: computeIncludedBitmapRoot(exactBitmap),
      seenBitmap,
      includedBitmap: exactBitmap,
      methodVersion: CURRENT_METHOD_VERSION,
    } satisfies ZkVMExecutionResult;

    const scenario: FinalizeScenarioContext = {
      scenarios: ['S0'],
      scenariosApplied: ['S0'],
      tamperMode: 'none',
      claimedCounts: { A: 3, B: 0, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 4,
      summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
      scenarioResult: null,
    };

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: { ...zkvmInput, treeSize: exactBitmap.length },
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore({ saveBitmapData }),
        getExecutor: () =>
          Promise.resolve({
            type: 'real',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: {
          createBundle: vi.fn().mockResolvedValue({
            ok: true,
            verificationResult: createVerificationResult({ status: 'success' }),
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(saveBitmapData).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        includedBitmap: exactBitmap,
        includedBitmapRoot: computeIncludedBitmapRoot(exactBitmap),
        seenBitmap,
        seenBitmapRoot: computeIncludedBitmapRoot(seenBitmap),
        treeSize: exactBitmap.length,
      }),
    );
    if (result.ok) {
      expect(result.value.seenBitmapRoot).toBe(computeIncludedBitmapRoot(seenBitmap));
    }
  });

  it('stores a sanitized journal while keeping bitmap data separate', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<VoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const exactBitmap = [true];
    const zkvmResult = {
      ...createZkvmResult(),
      includedBitmapRoot: computeIncludedBitmapRoot(exactBitmap),
      includedBitmap: exactBitmap,
    } satisfies ZkVMExecutionResult;

    const scenario: FinalizeScenarioContext = {
      scenarios: ['S0'],
      scenariosApplied: ['S0'],
      tamperMode: 'none',
      claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 1,
      summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
      scenarioResult: null,
    };
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue({
      ok: true,
      verificationResult: createVerificationResult(),
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore({ finalizeSession }),
        getExecutor: () =>
          Promise.resolve({
            type: 'mock',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(true);
    expect(finalizeSession).toHaveBeenCalledOnce();
    const [sessionId, storedResult] = finalizeSession.mock.calls[0];
    expect(sessionId).toBe('session-1');

    assertAuthorityResult(storedResult);
    const authority = storedResult;
    const projected = projectFinalizationResultForPublicResponse(authority);

    expect(projected.includedBitmapRoot).toBe(computeIncludedBitmapRoot(exactBitmap));
    expect(authority.verificationExecutionId).toBe('exec-1');
    expect(authority.bitmapData).toBeUndefined();
    expect('includedBitmap' in authority.journal).toBe(false);
  });

  it('fails closed before persistence when bundle creation returns a missing top-level execution authority', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<VoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const saveReceiptToBoard = vi.fn().mockResolvedValue({
      receiptHash: 'receipt-hash',
      boardIndex: 0,
    });
    const saveBitmapData = vi.fn().mockResolvedValue(undefined);
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue({
      ok: true,
      verificationResult: createVerificationResult({ executionId: undefined }),
    });

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: createZkvmResult().imageId ?? '',
        publicBaseUrl: 'https://example.com',
        scenario: {
          scenarios: ['S0'],
          scenariosApplied: ['S0'],
          tamperMode: 'none',
          claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          claimedTotalVotes: 1,
          summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
          scenarioResult: null,
        },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
      },
      {
        store: createMockVoteStore({ finalizeSession, saveReceiptToBoard, saveBitmapData }),
        getExecutor: () =>
          Promise.resolve({
            type: 'mock',
            execute: () => Promise.resolve(createZkvmResult()),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('api');
      if (result.error.kind === 'api') {
        expect(result.error.code).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
      }
    }
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(saveReceiptToBoard).not.toHaveBeenCalled();
    expect(saveBitmapData).not.toHaveBeenCalled();
  });
});
