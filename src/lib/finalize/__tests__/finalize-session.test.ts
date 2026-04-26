import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { BOT_COUNT } from '@/shared/constants';
import type { SessionData, VoteData } from '@/types/server';
import type { ZkVMInput } from '@/lib/zkvm/types';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { finalizeSessionUsecase } from '@/lib/finalize/usecases/finalize-session';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { resolveCurrentContractGeneration } from '@/lib/contract';

vi.mock('@/lib/zkvm/input-builder', () => ({
  buildZkVMInputFromSession: vi.fn(),
  CtProofUnavailableError: class CtProofUnavailableError extends Error {},
}));

vi.mock('@/lib/finalize/usecases/finalize-async', () => ({
  finalizeAsync: vi.fn(),
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
  electionId: 'election-1',
  electionConfigHash: getDefaultElectionConfigHash(),
  electionConfig: buildDefaultElectionConfig(),
  votes,
  botCount: BOT_COUNT,
  finalized: false,
  createdAt: Date.now(),
  lastActivity: Date.now(),
  userVoteIndex: 0,
});

const dummyInput: ZkVMInput = {
  electionId: 'election-1',
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
  it('allows sparse bulletin indices for exclusion tampering (S1)', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { buildZkVMInputFromSession } = await import('@/lib/zkvm/input-builder');
    const { finalizeAsync } = await import('@/lib/finalize/usecases/finalize-async');
    const buildZkVMInputFromSessionMock = vi.mocked(buildZkVMInputFromSession);

    const votes = new Map<number, VoteData>([
      [0, createVote('A')],
      [1, createVote('B')],
      [2, createVote('C')],
    ]);
    const session = createSession(votes);

    buildZkVMInputFromSessionMock.mockReturnValue(dummyInput);
    (finalizeAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        payload: { executionId: 'exec-s1', statusUrl: 'https://example.com/status', state: { status: 'pending' } },
        state: { status: 'pending' },
      },
    });

    const result = await finalizeSessionUsecase(
      {
        sessionId: 'session-1',
        session,
        scenarioId: 'S1',
        expectedImageId: '0x' + '33'.repeat(32),
        publicBaseUrl: 'https://example.com',
        asyncMode: true,
        queueUrl: 'https://queue.example.com',
        publishMaxAttempts: 1,
        clientMeta: { clientIp: '127.0.0.1' },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
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
    expect((sessionForInput as SessionData | undefined)?.votes.has(0)).toBe(false);
    expect((sessionForInput as SessionData | undefined)?.votes.size).toBe(2);
    expect(options).toEqual({ allowSparseVoteIndices: true });

    randomSpy.mockRestore();
  });

  it('uses original votes for outcome tampering (S2)', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { buildZkVMInputFromSession } = await import('@/lib/zkvm/input-builder');
    const { finalizeAsync } = await import('@/lib/finalize/usecases/finalize-async');
    const buildZkVMInputFromSessionMock = vi.mocked(buildZkVMInputFromSession);

    const votes = new Map<number, VoteData>([
      [0, createVote('A')],
      [1, createVote('B')],
      [2, createVote('C')],
    ]);
    const session = createSession(votes);

    buildZkVMInputFromSessionMock.mockReturnValue(dummyInput);
    (finalizeAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        payload: { executionId: 'exec-1', statusUrl: 'https://example.com/status', state: { status: 'pending' } },
        state: { status: 'pending' },
      },
    });

    const result = await finalizeSessionUsecase(
      {
        sessionId: 'session-1',
        session,
        scenarioId: 'S2',
        expectedImageId: '0x' + '33'.repeat(32),
        publicBaseUrl: 'https://example.com',
        asyncMode: true,
        queueUrl: 'https://queue.example.com',
        publishMaxAttempts: 1,
        clientMeta: { clientIp: '127.0.0.1' },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
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
    const sessionForInput = buildZkVMInputFromSessionMock.mock.calls[0]?.[0] as SessionData | undefined;
    const options = buildZkVMInputFromSessionMock.mock.calls[0]?.[1];
    expect(sessionForInput?.votes).toBe(votes);
    expect(options).toEqual({ allowSparseVoteIndices: false });

    randomSpy.mockRestore();
  });

  it('persists scenario context before enqueue in async mode', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { buildZkVMInputFromSession } = await import('@/lib/zkvm/input-builder');
    const { finalizeAsync } = await import('@/lib/finalize/usecases/finalize-async');
    const buildZkVMInputFromSessionMock = vi.mocked(buildZkVMInputFromSession);

    const votes = new Map<number, VoteData>([
      [0, createVote('A')],
      [1, createVote('B')],
      [2, createVote('C')],
    ]);
    const session = createSession(votes);

    buildZkVMInputFromSessionMock.mockReturnValue(dummyInput);
    (finalizeAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        payload: { executionId: 'exec-2', statusUrl: 'https://example.com/status', state: { status: 'pending' } },
        state: { status: 'pending' },
      },
    });

    const updateSession = vi.fn().mockResolvedValue(undefined);
    const store = createMockVoteStore({ updateSession });

    const result = await finalizeSessionUsecase(
      {
        sessionId: 'session-1',
        session,
        scenarioId: 'S2',
        expectedImageId: '0x' + '33'.repeat(32),
        publicBaseUrl: 'https://example.com',
        asyncMode: true,
        queueUrl: 'https://queue.example.com',
        publishMaxAttempts: 1,
        clientMeta: { clientIp: '127.0.0.1' },
        allowDevMode: true,
        debugFinalize: false,
        buildBundleUrl: () => 'https://example.com/bundle',
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
    expect(updateSession).toHaveBeenCalledTimes(1);
    const updatePayload = updateSession.mock.calls[0]?.[1] as Partial<SessionData> | undefined;
    expect(updatePayload?.finalizationScenarioContext).toEqual({
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
    });

    randomSpy.mockRestore();
  });
});
