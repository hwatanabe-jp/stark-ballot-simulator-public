import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData, VoteData } from '@stark-ballot/domain/types/server';
import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';
import type {
  ProofBundleService,
  ProofBundleVerificationResult,
} from '@stark-ballot/application/finalize/proof-bundle-service';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import { CURRENT_METHOD_VERSION, type ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { FinalizeScenarioContext } from '@stark-ballot/application/finalize/usecases/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { finalizeSync } from '@stark-ballot/application/finalize/usecases/finalize-sync';
import { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import { parseFinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-storage';
import { createMockVoteStore, type MockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const TEST_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

const { buildUserVoteArtifactsMock, UserVoteArtifactsUnavailableErrorMock } = vi.hoisted(() => ({
  buildUserVoteArtifactsMock: vi.fn(),
  UserVoteArtifactsUnavailableErrorMock: class UserVoteArtifactsUnavailableErrorMock extends Error {},
}));

function readDetailsMessage(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return undefined;
  }
  const value = (details as { details?: unknown }).details;
  return typeof value === 'string' ? value : undefined;
}

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

vi.mock('@stark-ballot/application/finalize/usecases/user-vote-artifacts', () => ({
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

const createVerificationResult = (
  overrides: Partial<ProofBundleVerificationResult> = {},
): ProofBundleVerificationResult => ({
  status: 'dev_mode' as const,
  report: {
    status: 'dev_mode' as const,
    verifier_version: 'mock-bundle',
    verified_at: '2026-01-01T00:00:00.000Z',
    duration_ms: 0,
    expected_image_id: '0x' + 'ee'.repeat(32),
    receipt_image_id: '0x' + 'ee'.repeat(32),
    dev_mode_receipt: true,
    errors: [],
  },
  ...overrides,
});

const createProofBundleSuccess = (
  verificationOverrides: Partial<ProofBundleVerificationResult> = {},
  executionId = 'exec-1',
): Awaited<ReturnType<ProofBundleService['createBundle']>> => ({
  ok: true,
  verificationResult: createVerificationResult(verificationOverrides),
  executionId,
});

function assertAuthorityResult(result: unknown): asserts result is FinalizationResultAuthority {
  if (!parseFinalizationResultAuthority(result)?.journal) {
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
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue(createProofBundleSuccess());

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
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
      expect(result.value.finalizationResult.journal.missingSlots).toBe(0);
      expect(result.value.finalizationResult.journal.invalidPresentedSlots).toBe(0);
      expect(result.value.finalizationResult.journal.validVotes).toBe(1);
    }
  });

  it('returns finalization facts for claim tampering responses', async () => {
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
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue(createProofBundleSuccess());

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
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
      expect(result.value.finalizationResult.verificationResult).toMatchObject({
        status: 'dev_mode',
      });
      expect(result.value.finalizationResult.tally.counts).toEqual(scenario.claimedCounts);
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
    const finalizeSession = vi.fn<NonNullable<MockVoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const store = createMockVoteStore({ finalizeSession });
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue(createProofBundleSuccess());

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
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
    const [calledSessionId, calledResult] = strictDefined(finalizeSession.mock.calls[0]);
    expect(calledSessionId).toBe('session-1');
    assertAuthorityResult(calledResult);
    expect(calledResult.tamperDetected).toBe(true);
    expect(calledResult.journal.rejectedRecords).toBe(1);
    expect(calledResult.journal.excludedSlots).toBe(0);
  });

  it('uses atomic finalization with receipt publication when the store supports it', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const zkvmResult = createZkvmResult();
    const finalizeSession = vi.fn<NonNullable<MockVoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const finalizeSessionWithReceiptPublication = vi
      .fn<NonNullable<MockVoteStore['finalizeSessionWithReceiptPublication']>>()
      .mockResolvedValue({
        receiptHash: '0x' + '12'.repeat(32),
        boardIndex: 100,
      });
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue(createProofBundleSuccess());

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
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
      },
      {
        store: createMockVoteStore({
          finalizeSession,
          finalizeSessionWithReceiptPublication,
        }),
        getExecutor: () =>
          Promise.resolve({
            type: 'mock',
            execute: () => Promise.resolve(zkvmResult),
            version: '1.0',
          }),
        proofBundleService: { createBundle },
        now: () => 1234,
      },
    );

    expect(result.ok).toBe(true);
    expect(finalizeSessionWithReceiptPublication).toHaveBeenCalledOnce();
    expect(finalizeSession).not.toHaveBeenCalled();
    const [sessionId, storedResult, contractGeneration, receipt] = strictDefined(
      finalizeSessionWithReceiptPublication.mock.calls[0],
    );
    expect(sessionId).toBe('session-1');
    expect(contractGeneration).toBe(session.contractGeneration);
    expect(receipt.timestamp).toBe(1234);
    assertAuthorityResult(storedResult);
    expect(storedResult.receiptPublication).toMatchObject({
      receiptHash: '0x' + '12'.repeat(32),
      boardIndex: 100,
      timestamp: 1234,
    });
    if (result.ok) {
      expect(result.value.finalizationResult.receiptPublication).toEqual({
        receiptHash: '0x' + '12'.repeat(32),
        boardIndex: 100,
        timestamp: 1234,
      });
    }
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
    const createBundle = vi
      .fn<ProofBundleService['createBundle']>()
      .mockResolvedValue(createProofBundleSuccess({ status: 'success' }));

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
        scenario,
        allowDevMode: true,
        debugFinalize: false,
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
    const bundleOptions = strictDefined(createBundle.mock.calls[0])[0];
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
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue(
      createProofBundleSuccess({
        status: 'success',
        report: {
          status: 'success',
          verifier_version: '0.1.0',
          verified_at: '2026-01-01T00:00:00.000Z',
          duration_ms: 42,
          expected_image_id: zkvmResult.imageId ?? '',
          receipt_image_id: zkvmResult.imageId ?? '',
          dev_mode_receipt: false,
          errors: [],
        },
      }),
    );

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput,
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
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
      expect(result.value.finalizationResult.verificationResult).toMatchObject({
        status: 'success',
      });
    }
  });

  it('fails closed on an unsupported zkVM journal contract before persisting success', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<MockVoteStore['finalizeSession']>>().mockResolvedValue(undefined);
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
        scenario,
        allowDevMode: true,
        debugFinalize: false,
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
        expect(result.error.code).toBe(ApplicationErrorCode.INTERNAL_ERROR);
        expect(readDetailsMessage(result.error.details)).toContain('Unsupported zkVM journal contract');
      }
    }
    expect(createBundle).not.toHaveBeenCalled();
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  it('fails before verifier, publication, persistence, or bitmap side effects when exact user vote artifacts are unavailable', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<MockVoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const createBundle = vi.fn<ProofBundleService['createBundle']>();
    const finalizeSessionWithReceiptPublication = vi.fn().mockResolvedValue({
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
      },
      {
        store: createMockVoteStore({ finalizeSession, finalizeSessionWithReceiptPublication, saveBitmapData }),
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
        expect(result.error.code).toBe(ApplicationErrorCode.VERIFICATION_FAILED);
        expect(readDetailsMessage(result.error.details)).toContain('Exact cast-time bulletin root is missing');
      }
    }
    expect(createBundle).not.toHaveBeenCalled();
    expect(finalizeSessionWithReceiptPublication).not.toHaveBeenCalled();
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(saveBitmapData).not.toHaveBeenCalled();
    expect(session.finalizationResult).toBeUndefined();
  });

  it('returns an internal error when unexpected user vote artifact assembly fails', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<MockVoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const createBundle = vi.fn<ProofBundleService['createBundle']>();
    const finalizeSessionWithReceiptPublication = vi.fn().mockResolvedValue({
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
      },
      {
        store: createMockVoteStore({ finalizeSession, finalizeSessionWithReceiptPublication, saveBitmapData }),
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
        expect(result.error.code).toBe(ApplicationErrorCode.INTERNAL_ERROR);
        expect(readDetailsMessage(result.error.details)).toBe('Failed to build exact user vote artifacts');
      }
    }
    expect(createBundle).not.toHaveBeenCalled();
    expect(finalizeSessionWithReceiptPublication).not.toHaveBeenCalled();
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
        report: {
          status: 'failed',
          verifier_version: '0.1.0',
          verified_at: '2026-01-01T00:00:00.000Z',
          duration_ms: 42,
          expected_image_id: zkvmResult.imageId ?? '',
          receipt_image_id: null,
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
        expect(result.error.code).toBe(ApplicationErrorCode.VERIFICATION_FAILED);
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
        scenario,
        allowDevMode: true,
        debugFinalize: false,
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
          createBundle: vi.fn().mockResolvedValue(createProofBundleSuccess({ status: 'success' })),
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
      expect(result.value.finalizationResult.journal.seenBitmapRoot).toBe(computeIncludedBitmapRoot(seenBitmap));
    }
  });

  it('stores a sanitized journal while keeping bitmap data separate', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<MockVoteStore['finalizeSession']>>().mockResolvedValue(undefined);
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
    const createBundle = vi.fn<ProofBundleService['createBundle']>().mockResolvedValue(createProofBundleSuccess());

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: zkvmResult.imageId ?? '',
        scenario,
        allowDevMode: true,
        debugFinalize: false,
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
    const [sessionId, storedResult] = strictDefined(finalizeSession.mock.calls[0]);
    expect(sessionId).toBe('session-1');

    assertAuthorityResult(storedResult);
    const authority = storedResult;
    expect(authority.journal.includedBitmapRoot).toBe(computeIncludedBitmapRoot(exactBitmap));
    expect(Object.hasOwn(authority.verificationResult ?? {}, 'executionId')).toBe(false);
    expect(Object.hasOwn(authority.verificationResult ?? {}, 's3BundleKey')).toBe(false);
    expect(strictDefined(finalizeSession.mock.calls[0])[3]).toBe('exec-1');
    if (result.ok) {
      expect(result.value.verificationExecutionId).toBe('exec-1');
    }
    expect(authority.bitmapData).toBeUndefined();
    expect('includedBitmap' in authority.journal).toBe(false);
  });

  it('fails closed before persistence when bundle creation returns a missing top-level execution authority', async () => {
    const votes = new Map<number, VoteData>([[0, createVote('A')]]);
    const session = createSession(votes);
    const finalizeSession = vi.fn<NonNullable<MockVoteStore['finalizeSession']>>().mockResolvedValue(undefined);
    const finalizeSessionWithReceiptPublication = vi.fn().mockResolvedValue({
      receiptHash: 'receipt-hash',
      boardIndex: 0,
    });
    const saveBitmapData = vi.fn().mockResolvedValue(undefined);
    const createBundle = vi
      .fn<ProofBundleService['createBundle']>()
      .mockResolvedValue(createProofBundleSuccess({}, ''));

    const result = await finalizeSync(
      {
        sessionId: 'session-1',
        session,
        contractGeneration: session.contractGeneration as string,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: createZkvmResult().imageId ?? '',
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
      },
      {
        store: createMockVoteStore({ finalizeSession, finalizeSessionWithReceiptPublication, saveBitmapData }),
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
        expect(result.error.code).toBe(ApplicationErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
      }
    }
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(finalizeSessionWithReceiptPublication).not.toHaveBeenCalled();
    expect(saveBitmapData).not.toHaveBeenCalled();
  });
});
