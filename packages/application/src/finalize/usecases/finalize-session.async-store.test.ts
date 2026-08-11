import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import { createMockVoteStore, type MockVoteStore } from '../__tests__/support/mockVoteStore';

const buildZkVMInputFromSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/application/zkvm-input/input-builder', () => ({
  buildZkVMInputFromSession: buildZkVMInputFromSessionMock,
  CtProofUnavailableError: class CtProofUnavailableError extends Error {},
}));

import { finalizeSessionUsecase } from '@stark-ballot/application/finalize/usecases/finalize-session';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

type MarkQueuedPayload = Parameters<MockVoteStore['markFinalizationQueued']>[1];

const createVote = (index: number, vote: StoredVoteRecord['vote']): StoredVoteRecord => ({
  voteId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
  vote,
  rand: '0x' + '1'.repeat(64),
  commit: '0x' + (index + 2).toString(16).repeat(64),
  timestamp: 1_730_000_000_000 + index,
  rootAtCast: '0x' + 'a'.repeat(64),
});

function createSession(votes = new Map<number, StoredVoteRecord>()): {
  identity: SessionIdentityRecord;
  voting: SessionVotingRecord;
} {
  const sessionId = '11111111-1111-4111-8111-111111111111';
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
      userParticipation: { status: 'cast', voteIndex: 0 },
      botCount: BOT_COUNT,
      lastActivityMs: 1_730_000_000_000,
    },
  };
}

function createInMemoryStore() {
  const store = createMockVoteStore();
  const applyQueued = store.markFinalizationQueued.bind(store);
  const markFinalizationQueued = vi.fn((sessionId: string, payload: MarkQueuedPayload) =>
    applyQueued(sessionId, payload),
  );
  store.markFinalizationQueued = markFinalizationQueued;

  return {
    store,
    markFinalizationQueued,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('finalizeSessionUsecase async store boundary', () => {
  it('queues async finalization after persisting scenario context in the mock store', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const votes = new Map<number, StoredVoteRecord>([
      [0, createVote(0, 'A')],
      [1, createVote(1, 'B')],
      [2, createVote(2, 'C')],
    ]);
    const session = createSession(votes);
    const { store, markFinalizationQueued } = createInMemoryStore();

    const dummyInput: ZkVMInput = {
      electionId: session.identity.electionId,
      electionConfigHash: session.identity.electionConfigHash,
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: votes.size,
      totalExpected: BOT_COUNT + 1,
      logId: session.identity.logId,
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
        sessionId: session.identity.sessionId,
        identity: session.identity,
        voting: session.voting,
        currentFinalization: null,
        scenarioId: 'S2',
        expectedImageId: '0x' + '3'.repeat(64),
        finalizationMode: { kind: 'async', inputSource: 'inline' },
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
    expect(queuedSessionId).toBe(session.identity.sessionId);
    expect(queuedPayload).not.toHaveProperty('contractGeneration');
    expect(queuedPayload.scenarioContext).toMatchObject({
      scenarios: ['S2'],
      tamperMode: 'claim',
    });

    const stored = await store.getCurrentFinalizationRecord(session.identity.sessionId);
    expect(stored).toMatchObject({
      sessionId: session.identity.sessionId,
      scenarioContext: {
        scenarios: ['S2'],
        tamperMode: 'claim',
      },
      state: {
        status: 'pending',
      },
    });
    expect(stored?.scenarioContext).toEqual({
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
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const persistAsyncProverInputToS3 = vi.fn().mockResolvedValue({
      inputS3Key: 'sessions/session-1/exec-1/input.json',
      outputS3Prefix: 'sessions/session-1/exec-1',
      bundleS3Key: 'sessions/session-1/exec-1/bundle.zip',
    });
    const votes = new Map<number, StoredVoteRecord>([
      [0, createVote(0, 'A')],
      [1, createVote(1, 'B')],
      [2, createVote(2, 'C')],
    ]);
    const session = createSession(votes);
    const { store } = createInMemoryStore();

    const dummyInput: ZkVMInput = {
      electionId: session.identity.electionId,
      electionConfigHash: session.identity.electionConfigHash,
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: votes.size,
      totalExpected: BOT_COUNT + 1,
      logId: session.identity.logId,
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
        sessionId: session.identity.sessionId,
        identity: session.identity,
        voting: session.voting,
        currentFinalization: null,
        scenarioId: 'S0',
        expectedImageId: '0x' + '3'.repeat(64),
        finalizationMode: { kind: 'async', inputSource: 's3' },
        publishMaxAttempts: 1,
        allowDevMode: true,
        debugFinalize: false,
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
        sessionId: session.identity.sessionId,
        zkvmInput: dummyInput,
      }),
    );
    const persistedInput = persistAsyncProverInputToS3.mock.calls[0]?.[0] as { finalizationId?: string } | undefined;
    const finalizationId = persistedInput?.finalizationId;
    expect(finalizationId).toBeDefined();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.identity.sessionId,
        finalizationId,
        inputSource: 's3',
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

  it('fails closed instead of minting missing session identity', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const session = createSession(
      new Map<number, StoredVoteRecord>([
        [0, createVote(0, 'A')],
        [1, createVote(1, 'B')],
        [2, createVote(2, 'C')],
      ]),
    );
    const { store } = createInMemoryStore();
    const incompleteIdentity = { ...session.identity } as Partial<SessionIdentityRecord>;
    delete incompleteIdentity.electionId;

    const result = await finalizeSessionUsecase(
      {
        sessionId: session.identity.sessionId,
        identity: incompleteIdentity as SessionIdentityRecord,
        voting: session.voting,
        currentFinalization: null,
        scenarioId: 'S0',
        expectedImageId: '0x' + '3'.repeat(64),
        finalizationMode: { kind: 'async', inputSource: 'inline' },
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
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: {
          details: 'Session identity is missing or invalid',
        },
      },
    });
    expect(buildZkVMInputFromSessionMock).not.toHaveBeenCalled();
  });
});
