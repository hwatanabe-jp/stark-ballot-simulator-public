import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { finalizeSessionUsecase } from '@stark-ballot/application/finalize/usecases/finalize-session';
import { createMockVoteStore } from '../test-support/mockVoteStore';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const SESSION_ID = asSessionId('session-1');

vi.mock('@stark-ballot/application/zkvm-input/input-builder', () => ({
  buildZkVMInputFromSession: vi.fn(),
  CtProofUnavailableError: class CtProofUnavailableError extends Error {},
}));

vi.mock('@stark-ballot/application/finalize/usecases/finalize-async', () => ({
  finalizeAsync: vi.fn(),
}));

const createVote = (index: number, vote: StoredVoteRecord['vote']): StoredVoteRecord => ({
  voteId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
  vote,
  rand: '0x' + '1'.repeat(64),
  commit: '0x' + (index + 2).toString(16).repeat(64),
  timestamp: 1_730_000_000_000 + index,
  rootAtCast: '0x' + 'a'.repeat(64),
});

const createSession = (
  votes: Map<number, StoredVoteRecord>,
): { identity: SessionIdentityRecord; voting: SessionVotingRecord } => {
  const sessionId = SESSION_ID;
  return {
    identity: {
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: getDefaultElectionConfigHash(),
      electionConfig: buildDefaultElectionConfig(),
      logId: '0x' + '2'.repeat(64),
      createdAtMs: 1_730_000_000_000,
    },
    voting: {
      sessionId,
      votes,
      bulletin: new SimpleBulletinBoard('0x' + '2'.repeat(64)),
      bulletinRootHistory: [],
      botCount: BOT_COUNT,
      userParticipation: { status: 'cast', voteIndex: 0 },
      lastActivityMs: 1_730_000_000_000,
    },
  };
};

const dummyInput: ZkVMInput = {
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: getDefaultElectionConfigHash(),
  bulletinRoot: '0x' + '11'.repeat(32),
  treeSize: 1,
  totalExpected: BOT_COUNT + 1,
  logId: '0x' + '22'.repeat(32),
  timestamp: Date.now(),
  votes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('finalizeSessionUsecase (zkVM input selection)', () => {
  it.each([
    ['S1', 0, { A: 0, B: 1, C: 1, D: 0, E: 0 }],
    ['S3', 1, { A: 1, B: 0, C: 1, D: 0, E: 0 }],
    ['S5', 0, { A: 0, B: 1, C: 1, D: 0, E: 0 }],
  ] as const)(
    'uses sparse modified votes for exclusion tampering (%s)',
    async (scenarioId, excludedIndex, expectedClaimedCounts) => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const { buildZkVMInputFromSession } = await import('@stark-ballot/application/zkvm-input/input-builder');
      const { finalizeAsync } = await import('@stark-ballot/application/finalize/usecases/finalize-async');
      const buildZkVMInputFromSessionMock = vi.mocked(buildZkVMInputFromSession);
      const finalizeAsyncMock = vi.mocked(finalizeAsync);

      const votes = new Map<number, StoredVoteRecord>([
        [0, createVote(0, 'A')],
        [1, createVote(1, 'B')],
        [2, createVote(2, 'C')],
      ]);
      const session = createSession(votes);

      buildZkVMInputFromSessionMock.mockReturnValue(dummyInput);
      const finalizationId = asFinalizationId(`exec-${scenarioId.toLowerCase()}`);
      const pendingState = { status: 'pending' as const, finalizationId, queuedAtMs: 1_730_000_000_000 };
      finalizeAsyncMock.mockResolvedValue({
        ok: true,
        value: {
          payload: { finalizationId, state: pendingState },
          state: pendingState,
        },
      });

      const result = await finalizeSessionUsecase(
        {
          sessionId: SESSION_ID,
          identity: session.identity,
          voting: session.voting,
          currentFinalization: null,
          scenarioId,
          expectedImageId: '0x' + '33'.repeat(32),
          finalizationMode: { kind: 'async', inputSource: 'inline' },
          publishMaxAttempts: 1,
          allowDevMode: true,
          debugFinalize: false,
        },
        {
          store: createMockVoteStore(),
          finalizationQueue: { publish: vi.fn() },
          proofBundleService: { createBundle: vi.fn() },
          getExecutor: () =>
            Promise.resolve({
              type: 'mock',
              version: '1.0',
              execute: vi.fn(),
            }),
        },
      );

      expect(result.ok).toBe(true);
      expect(buildZkVMInputFromSessionMock).toHaveBeenCalledTimes(1);
      const [sessionForInput, options] = buildZkVMInputFromSessionMock.mock.calls[0] ?? [];
      expect(sessionForInput?.voting.votes).not.toBe(votes);
      expect(sessionForInput?.voting.votes.has(excludedIndex)).toBe(false);
      expect(sessionForInput?.voting.votes.size).toBe(2);
      expect(votes.size).toBe(3);
      expect(options).toEqual({ allowSparseVoteIndices: true });
      const queuedScenarioContext = finalizeAsyncMock.mock.calls[0]?.[0].scenarioContext;
      expect(queuedScenarioContext?.scenarios).toEqual([scenarioId]);
      expect(queuedScenarioContext?.tamperMode).toBe('input');
      expect(queuedScenarioContext?.claimedCounts).toEqual(expectedClaimedCounts);
      expect(queuedScenarioContext?.claimedTotalVotes).toBe(2);

      randomSpy.mockRestore();
    },
  );

  it.each([
    ['S2', { A: 0, B: 2, C: 1, D: 0, E: 0 }],
    ['S4', { A: 2, B: 0, C: 1, D: 0, E: 0 }],
  ] as const)('uses original non-sparse votes for claimed-tally tampering (%s)', async (scenarioId, claimedCounts) => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { buildZkVMInputFromSession } = await import('@stark-ballot/application/zkvm-input/input-builder');
    const { finalizeAsync } = await import('@stark-ballot/application/finalize/usecases/finalize-async');
    const buildZkVMInputFromSessionMock = vi.mocked(buildZkVMInputFromSession);
    const finalizeAsyncMock = vi.mocked(finalizeAsync);

    const votes = new Map<number, StoredVoteRecord>([
      [0, createVote(0, 'A')],
      [1, createVote(1, 'B')],
      [2, createVote(2, 'C')],
    ]);
    const session = createSession(votes);

    buildZkVMInputFromSessionMock.mockReturnValue(dummyInput);
    const finalizationId = asFinalizationId('exec-1');
    const pendingState = { status: 'pending' as const, finalizationId, queuedAtMs: 1_730_000_000_000 };
    finalizeAsyncMock.mockResolvedValue({
      ok: true,
      value: {
        payload: { finalizationId, state: pendingState },
        state: pendingState,
      },
    });

    const result = await finalizeSessionUsecase(
      {
        sessionId: SESSION_ID,
        identity: session.identity,
        voting: session.voting,
        currentFinalization: null,
        scenarioId,
        expectedImageId: '0x' + '33'.repeat(32),
        finalizationMode: { kind: 'async', inputSource: 'inline' },
        publishMaxAttempts: 1,
        allowDevMode: true,
        debugFinalize: false,
      },
      {
        store: createMockVoteStore(),
        finalizationQueue: { publish: vi.fn() },
        proofBundleService: { createBundle: vi.fn() },
        getExecutor: () =>
          Promise.resolve({
            type: 'mock',
            version: '1.0',
            execute: vi.fn().mockResolvedValue({
              electionId: '',
              electionConfigHash: '',
              bulletinRoot: '',
              treeSize: 0,
              totalExpected: 0,
              sthDigest: '',
              verifiedTally: [0, 0, 0, 0, 0],
              totalVotes: 0,
              validVotes: 0,
              invalidVotes: 0,
              seenIndicesCount: 0,
              missingSlots: 0,
              invalidPresentedSlots: 0,
              rejectedRecords: 0,
              seenBitmapRoot: '',
              missingIndices: 0,
              invalidIndices: 0,
              countedIndices: 0,
              includedBitmapRoot: '',
              excludedSlots: 0,
              excludedCount: 0,
              inputCommitment: '',
              methodVersion: CURRENT_METHOD_VERSION,
            }),
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(buildZkVMInputFromSessionMock).toHaveBeenCalledTimes(1);
    const sessionForInput = buildZkVMInputFromSessionMock.mock.calls[0]?.[0];
    const options = buildZkVMInputFromSessionMock.mock.calls[0]?.[1];
    expect(sessionForInput?.voting.votes).toBe(votes);
    expect(options).toEqual({ allowSparseVoteIndices: false });
    expect(claimedCounts).not.toEqual({ A: 1, B: 1, C: 1, D: 0, E: 0 });
    const queuedScenarioContext = finalizeAsyncMock.mock.calls[0]?.[0].scenarioContext;
    expect(queuedScenarioContext?.scenarios).toEqual([scenarioId]);
    expect(queuedScenarioContext?.tamperMode).toBe('claim');
    expect(queuedScenarioContext?.claimedCounts).toEqual(claimedCounts);
    expect(queuedScenarioContext?.claimedTotalVotes).toBe(3);

    randomSpy.mockRestore();
  });

  it('persists scenario context before enqueue in async mode', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { buildZkVMInputFromSession } = await import('@stark-ballot/application/zkvm-input/input-builder');
    const { finalizeAsync } = await import('@stark-ballot/application/finalize/usecases/finalize-async');
    const buildZkVMInputFromSessionMock = vi.mocked(buildZkVMInputFromSession);

    const votes = new Map<number, StoredVoteRecord>([
      [0, createVote(0, 'A')],
      [1, createVote(1, 'B')],
      [2, createVote(2, 'C')],
    ]);
    const session = createSession(votes);

    buildZkVMInputFromSessionMock.mockReturnValue(dummyInput);
    (finalizeAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        payload: { finalizationId: 'exec-2', state: { status: 'pending' } },
        state: { status: 'pending' },
      },
    });

    const store = createMockVoteStore();

    const result = await finalizeSessionUsecase(
      {
        sessionId: SESSION_ID,
        identity: session.identity,
        voting: session.voting,
        currentFinalization: null,
        scenarioId: 'S2',
        expectedImageId: '0x' + '33'.repeat(32),
        finalizationMode: { kind: 'async', inputSource: 'inline' },
        publishMaxAttempts: 1,
        allowDevMode: true,
        debugFinalize: false,
      },
      {
        store,
        finalizationQueue: { publish: vi.fn() },
        proofBundleService: { createBundle: vi.fn() },
        getExecutor: () =>
          Promise.resolve({
            type: 'mock',
            version: '1.0',
            execute: vi.fn(),
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(finalizeAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioContext: {
          scenarios: ['S2'],
          tamperMode: 'claim',
          claimedCounts: {
            A: 0,
            B: 2,
            C: 1,
            D: 0,
            E: 0,
          },
          claimedTotalVotes: 3,
          summary: {
            ignoredCount: 0,
            recountedCount: 1,
            userRecountChoice: 'B',
          },
        },
      }),
      expect.any(Object),
    );

    randomSpy.mockRestore();
  });

  it('rejects incomplete identity without minting authority during finalization', async () => {
    const { buildZkVMInputFromSession } = await import('@stark-ballot/application/zkvm-input/input-builder');
    const session = createSession(new Map([[0, createVote(0, 'A')]]));
    const incompleteIdentity = { ...session.identity } as Partial<SessionIdentityRecord>;
    delete incompleteIdentity.electionId;

    const result = await finalizeSessionUsecase(
      {
        sessionId: session.identity.sessionId,
        identity: incompleteIdentity as SessionIdentityRecord,
        voting: session.voting,
        currentFinalization: null,
        scenarioId: 'S0',
        expectedImageId: `0x${'33'.repeat(32)}`,
        finalizationMode: { kind: 'async', inputSource: 'inline' },
        publishMaxAttempts: 1,
        allowDevMode: true,
        debugFinalize: false,
      },
      {
        store: createMockVoteStore(),
        finalizationQueue: { publish: vi.fn() },
        proofBundleService: { createBundle: vi.fn() },
        getExecutor: () => Promise.reject(new Error('must not execute')),
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'api',
        code: 'INTERNAL_ERROR',
        details: { details: 'Session identity is missing or invalid' },
      },
    });
    expect(incompleteIdentity.electionId).toBeUndefined();
    expect(buildZkVMInputFromSession).not.toHaveBeenCalled();
  });
});
