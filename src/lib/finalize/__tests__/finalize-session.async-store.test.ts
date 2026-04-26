import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_COUNT } from '@/shared/constants';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { MockSessionStore } from '@/lib/store/mockSessionStore';
import type { ZkVMInput } from '@/lib/zkvm/types';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import type { VoteData } from '@/types/server';
import { ErrorCode } from '@/lib/errors/apiErrors';

const createVote = (vote: VoteData['vote']): VoteData => ({
  vote,
  rand: '0x' + '1'.repeat(64),
  commit: '0x' + '2'.repeat(64),
  path: [],
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('finalizeSessionUsecase async store boundary', () => {
  it('queues async finalization after persisting scenario context in the mock store', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const buildZkVMInputFromSessionMock = vi.fn();
    vi.doMock('@/lib/zkvm/input-builder', () => ({
      buildZkVMInputFromSession: buildZkVMInputFromSessionMock,
      CtProofUnavailableError: class CtProofUnavailableError extends Error {},
    }));
    const { finalizeSessionUsecase } = await import('@/lib/finalize/usecases/finalize-session');
    const store = new MockSessionStore();
    const session = await store.createSession();
    const votes = new Map<number, VoteData>([
      [0, createVote('A')],
      [1, createVote('B')],
      [2, createVote('C')],
    ]);

    session.votes = votes;
    session.userVoteIndex = 0;
    session.botCount = BOT_COUNT;
    session.electionConfig = buildDefaultElectionConfig();
    session.electionConfigHash = getDefaultElectionConfigHash();

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
    const updateSessionSpy = vi.spyOn(store, 'updateSession');

    const result = await finalizeSessionUsecase(
      {
        sessionId: session.sessionId,
        session,
        scenarioId: 'S2',
        expectedImageId: '0x' + '3'.repeat(64),
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
        finalizationQueue: { publish },
        proofBundleService: { createBundle: vi.fn() },
        getExecutor: vi.fn().mockRejectedValue(new Error('executor should not be used in async mode')),
        now: () => 1730000000000,
      },
    );

    expect(result.ok).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(updateSessionSpy).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({
        finalizationContractGeneration: resolveCurrentContractGeneration(),
      }),
    );

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

  it('fails closed instead of minting a missing session contractGeneration', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const buildZkVMInputFromSessionMock = vi.fn();
    vi.doMock('@/lib/zkvm/input-builder', () => ({
      buildZkVMInputFromSession: buildZkVMInputFromSessionMock,
      CtProofUnavailableError: class CtProofUnavailableError extends Error {},
    }));
    const { finalizeSessionUsecase } = await import('@/lib/finalize/usecases/finalize-session');
    const store = new MockSessionStore();
    const session = await store.createSession();

    session.contractGeneration = undefined;
    session.votes = new Map<number, VoteData>([
      [0, createVote('A')],
      [1, createVote('B')],
      [2, createVote('C')],
    ]);
    session.userVoteIndex = 0;
    session.botCount = BOT_COUNT;
    session.electionConfig = buildDefaultElectionConfig();
    session.electionConfigHash = getDefaultElectionConfigHash();

    const result = await finalizeSessionUsecase(
      {
        sessionId: session.sessionId,
        session,
        scenarioId: 'S0',
        expectedImageId: '0x' + '3'.repeat(64),
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
        getExecutor: vi.fn(),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
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
