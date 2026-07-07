import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import type { SessionData, VoteData } from '@stark-ballot/domain/types/server';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import { createMockVoteStore, type MockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

type MarkQueuedPayload = Parameters<MockVoteStore['markFinalizationQueued']>[1];

const createVote = (vote: VoteData['vote']): VoteData => ({
  vote,
  rand: '0x' + '1'.repeat(64),
  commit: '0x' + '2'.repeat(64),
  path: [],
});

function createSession(votes = new Map<number, VoteData>()): SessionData {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    contractGeneration: resolveCurrentContractGeneration(),
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: getDefaultElectionConfigHash(),
    electionConfig: buildDefaultElectionConfig(),
    votes,
    userVoteIndex: 0,
    botCount: BOT_COUNT,
    finalized: false,
    createdAt: 1730000000000,
    lastActivity: 1730000000000,
  };
}

function createInMemoryStore(session: SessionData) {
  const updateSession = vi.fn((sessionId: string, data?: Partial<SessionData>): Promise<void> => {
    if (sessionId === session.sessionId && data) {
      Object.assign(session, data);
    }
    return Promise.resolve();
  });
  const markFinalizationQueued = vi.fn((_sessionId: string, payload: MarkQueuedPayload): Promise<FinalizationState> => {
    const state: FinalizationState = {
      status: 'pending',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
    };
    session.finalizationState = state as unknown as NonNullable<SessionData['finalizationState']>;
    session.finalizationContractGeneration = payload.contractGeneration;
    if (payload.scenarioContext) {
      session.finalizationScenarioContext = payload.scenarioContext;
    } else {
      delete session.finalizationScenarioContext;
    }
    return Promise.resolve(state);
  });

  return {
    store: createMockVoteStore({
      getSession: (sessionId) => Promise.resolve(sessionId === session.sessionId ? session : null),
      updateSession,
      markFinalizationQueued,
    }),
    updateSession,
    markFinalizationQueued,
  };
}

afterEach(() => {
  delete process.env['TARGET_AWS_RUNTIME'];
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('finalizeSessionUsecase async store boundary', () => {
  it('queues async finalization after persisting scenario context in the mock store', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const buildZkVMInputFromSessionMock = vi.fn();
    vi.doMock('@stark-ballot/application/zkvm-input/input-builder', () => ({
      buildZkVMInputFromSession: buildZkVMInputFromSessionMock,
      CtProofUnavailableError: class CtProofUnavailableError extends Error {},
    }));
    const { finalizeSessionUsecase } = await import('@stark-ballot/application/finalize/usecases/finalize-session');
    const votes = new Map<number, VoteData>([
      [0, createVote('A')],
      [1, createVote('B')],
      [2, createVote('C')],
    ]);
    const session = createSession(votes);
    const { store, markFinalizationQueued } = createInMemoryStore(session);

    const dummyInput: ZkVMInput = {
      electionId: session.electionId ?? 'election-1',
      electionConfigHash: session.electionConfigHash ?? getDefaultElectionConfigHash(),
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: votes.size,
      totalExpected: BOT_COUNT + 1,
      logId: session.logId ?? '0x' + '2'.repeat(64),
      timestamp: 1730000000000,
      votes: [
        {
          index: 0,
          choice: 0,
          random: '0x' + '4'.repeat(64),
          commitment: '0x' + '5'.repeat(64),
          merklePath: ['0x' + '6'.repeat(64)],
        },
      ],
    };

    buildZkVMInputFromSessionMock.mockReturnValue(dummyInput);

    const publish = vi.fn().mockResolvedValue(undefined);

    const result = await finalizeSessionUsecase(
      {
        sessionId: session.sessionId,
        session,
        scenarioId: 'S2',
        expectedImageId: '0x' + '3'.repeat(64),
        asyncMode: true,
        queueUrl: 'https://queue.example.com',
        publishMaxAttempts: 1,
        allowDevMode: true,
        debugFinalize: false,
      },
      {
        store,
        finalizationQueue: { publish },
        proofBundleService: { createBundle: vi.fn() },
        getExecutor: vi.fn().mockRejectedValue(new Error('executor should not be used in async mode')),
        now: () => 1730000000000,
      },
    );

    expect(result.ok).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(markFinalizationQueued).toHaveBeenCalledTimes(1);
    const [queuedSessionId, queuedPayload] = strictDefined(markFinalizationQueued.mock.calls[0]);
    expect(queuedSessionId).toBe(session.sessionId);
    expect(queuedPayload.contractGeneration).toBe(resolveCurrentContractGeneration());
    expect(queuedPayload.scenarioContext).toMatchObject({
      scenarios: ['S2'],
      tamperMode: 'claim',
    });

    const stored = await store.getSession(session.sessionId);
    expect(stored?.finalizationContractGeneration).toBe(resolveCurrentContractGeneration());
    expect(stored?.finalizationState).toMatchObject({
      status: 'pending',
    });
    expect(stored?.finalizationScenarioContext).toEqual({
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
    expect(buildZkVMInputFromSessionMock).toHaveBeenCalledTimes(1);
    expect(dummyInput.totalExpected).toBe(BOT_COUNT + 1);
  });

  it('persists target async prover input before publishing the queue message', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const buildZkVMInputFromSessionMock = vi.fn();
    const persistAsyncProverInputToS3 = vi.fn().mockResolvedValue({
      inputS3Key: 'sessions/session-1/exec-1/input.json',
      outputS3Prefix: 'sessions/session-1/exec-1',
      bundleS3Key: 'sessions/session-1/exec-1/bundle.zip',
    });
    vi.doMock('@stark-ballot/application/zkvm-input/input-builder', () => ({
      buildZkVMInputFromSession: buildZkVMInputFromSessionMock,
      CtProofUnavailableError: class CtProofUnavailableError extends Error {},
    }));
    const { finalizeSessionUsecase } = await import('@stark-ballot/application/finalize/usecases/finalize-session');
    const votes = new Map<number, VoteData>([
      [0, createVote('A')],
      [1, createVote('B')],
      [2, createVote('C')],
    ]);
    const session = createSession(votes);
    const { store } = createInMemoryStore(session);

    const dummyInput: ZkVMInput = {
      electionId: session.electionId ?? 'election-1',
      electionConfigHash: session.electionConfigHash ?? getDefaultElectionConfigHash(),
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: votes.size,
      totalExpected: BOT_COUNT + 1,
      logId: session.logId ?? '0x' + '2'.repeat(64),
      timestamp: 1730000000000,
      votes: [
        {
          index: 0,
          choice: 0,
          random: '0x' + '4'.repeat(64),
          commitment: '0x' + '5'.repeat(64),
          merklePath: ['0x' + '6'.repeat(64)],
        },
      ],
    };
    buildZkVMInputFromSessionMock.mockReturnValue(dummyInput);

    const publish = vi.fn().mockResolvedValue(undefined);
    const result = await finalizeSessionUsecase(
      {
        sessionId: session.sessionId,
        session,
        scenarioId: 'S0',
        expectedImageId: '0x' + '3'.repeat(64),
        asyncMode: true,
        queueUrl: 'https://queue.example.com',
        publishMaxAttempts: 1,
        allowDevMode: true,
        debugFinalize: false,
        targetAwsRuntime: true,
      },
      {
        store,
        finalizationQueue: { publish },
        proofBundleService: { createBundle: vi.fn() },
        getExecutor: vi.fn().mockRejectedValue(new Error('executor should not be used in async mode')),
        persistAsyncProverInput: persistAsyncProverInputToS3,
        now: () => 1730000000000,
      },
    );

    expect(result.ok).toBe(true);
    expect(persistAsyncProverInputToS3).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        contractGeneration: resolveCurrentContractGeneration(),
        zkvmInput: dummyInput,
      }),
    );
    const persistedInput = persistAsyncProverInputToS3.mock.calls[0]?.[0] as { executionId?: string } | undefined;
    const executionId = persistedInput?.executionId;
    expect(executionId).toBeDefined();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        executionId,
      }),
      1,
    );
    const publishedMessage = publish.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(publishedMessage['zkvmInput']).toBeUndefined();
    expect(publishedMessage['electionConfig']).toBeUndefined();
    expect(publishedMessage['zkvmInputCommitment']).toBeUndefined();
    expect(publishedMessage).not.toHaveProperty('artifactKeys');
    expect(publishedMessage).not.toHaveProperty('inputS3Key');
    expect(publishedMessage).not.toHaveProperty('outputS3Prefix');
    expect(publishedMessage).not.toHaveProperty('bundleS3Key');
    expect(publishedMessage['requestMeta']).toBeUndefined();
  });

  it('fails closed instead of minting a missing session contractGeneration', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const buildZkVMInputFromSessionMock = vi.fn();
    vi.doMock('@stark-ballot/application/zkvm-input/input-builder', () => ({
      buildZkVMInputFromSession: buildZkVMInputFromSessionMock,
      CtProofUnavailableError: class CtProofUnavailableError extends Error {},
    }));
    const { finalizeSessionUsecase } = await import('@stark-ballot/application/finalize/usecases/finalize-session');
    const session = createSession(
      new Map<number, VoteData>([
        [0, createVote('A')],
        [1, createVote('B')],
        [2, createVote('C')],
      ]),
    );
    const { store } = createInMemoryStore(session);

    delete session.contractGeneration;

    const result = await finalizeSessionUsecase(
      {
        sessionId: session.sessionId,
        session,
        scenarioId: 'S0',
        expectedImageId: '0x' + '3'.repeat(64),
        asyncMode: true,
        queueUrl: 'https://queue.example.com',
        publishMaxAttempts: 1,
        allowDevMode: true,
        debugFinalize: false,
      },
      {
        store,
        finalizationQueue: { publish: vi.fn() },
        proofBundleService: { createBundle: vi.fn() },
        getExecutor: vi.fn(),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
        details: {
          artifactState: 'unsupported_current_artifact',
          persistedContractGeneration: null,
          carriedContractGeneration: null,
        },
      },
    });
    expect(buildZkVMInputFromSessionMock).not.toHaveBeenCalled();
  });
});
