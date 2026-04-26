import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeCommitment } from '@/lib/zkvm/types';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import type { SessionData, VoteData } from '@/types/server';

const electionId = '550e8400-e29b-41d4-a716-446655440000';

function buildVote(choice: 'A' | 'B', randHex: string): VoteData {
  const choiceNumber = choice.charCodeAt(0) - 'A'.charCodeAt(0);
  const commit = computeCommitment(electionId, choiceNumber, randHex);

  return {
    vote: choice,
    rand: randHex,
    commit,
    path: [],
  };
}

function buildSession(): SessionData {
  const userVote = buildVote('A', '0x' + '1'.repeat(64));
  const now = Date.now();
  const bulletin = new SimpleBulletinBoard('log-123');
  const userVoteId = '11111111-1111-4111-8111-111111111111';
  const appendResult = bulletin.appendVote(userVoteId, userVote.commit.slice(2));
  userVote.voteId = userVoteId;
  userVote.rootAtCast = `0x${appendResult.rootAtAppend}`;

  return {
    sessionId: 'session-123',
    electionId,
    contractGeneration: resolveCurrentContractGeneration(),
    electionConfigHash: '0x' + '2'.repeat(64),
    logId: 'log-123',
    votes: new Map([[0, userVote]]),
    bulletin,
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    userVoteIndex: 0,
    bulletinRootHistory: [
      {
        root: `0x${appendResult.rootAtAppend}`,
        timestamp: appendResult.timestamp,
        treeSize: bulletin.getSize(),
      },
    ],
  };
}

describe('AmplifySessionStore addBotVotes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AMPLIFY_DATA_ENDPOINT: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('reuses a single session fetch and metadata update for batched bot votes', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();

    const executeCalls: string[] = [];
    const executeStub = vi.fn((query: string) => {
      executeCalls.push(query);
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;

    const getSessionSpy = vi.spyOn(store, 'getSession').mockResolvedValue(session);

    const votes: VoteData[] = [buildVote('B', '0x' + '2'.repeat(64)), buildVote('B', '0x' + '3'.repeat(64))];

    await store.addBotVotes(session.sessionId, votes);

    expect(getSessionSpy).toHaveBeenCalledTimes(1);

    const createVoteCalls = executeCalls.filter((query) => query.includes('mutation CreateVote'));
    const updateSessionCalls = executeCalls.filter((query) => query.includes('mutation UpdateVotingSession'));

    expect(createVoteCalls).toHaveLength(2);
    expect(updateSessionCalls).toHaveLength(1);
  });

  it('checkpoints successful bot votes when a later createVote mutation fails', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();

    const createVoteInputs: Array<Record<string, unknown>> = [];
    const updateSessionInputs: Array<Record<string, unknown>> = [];
    let createVoteCount = 0;
    const executeStub = vi.fn((query: string, variables?: { input?: Record<string, unknown> }) => {
      if (query.includes('mutation CreateVote')) {
        createVoteCount += 1;
        createVoteInputs.push(variables?.input ?? {});
        if (createVoteCount === 2) {
          return Promise.reject(new Error('simulated create vote failure'));
        }
        return Promise.resolve({} as Record<string, unknown>);
      }
      if (query.includes('mutation UpdateVotingSession')) {
        updateSessionInputs.push(variables?.input ?? {});
      }
      return Promise.resolve({} as Record<string, unknown>);
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    const votes: VoteData[] = [
      buildVote('B', '0x' + '2'.repeat(64)),
      buildVote('B', '0x' + '3'.repeat(64)),
      buildVote('B', '0x' + '4'.repeat(64)),
      buildVote('B', '0x' + '5'.repeat(64)),
    ];

    await expect(store.addBotVotes(session.sessionId, votes)).rejects.toThrow('simulated create vote failure');

    expect(createVoteInputs).toHaveLength(2);
    expect(updateSessionInputs).toHaveLength(1);
    expect(updateSessionInputs[0]?.botCount).toBe(1);
    expect(updateSessionInputs[0]?.userVoteIndex).toBe(0);

    const persistedHistory = JSON.parse(String(updateSessionInputs[0]?.bulletinRootHistoryJson)) as Array<{
      root: string;
    }>;
    expect(persistedHistory).toHaveLength(2);
    expect(persistedHistory[1]?.root).toBe(createVoteInputs[0]?.rootAtCast);
  });

  it('returns early when no bot votes are provided', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();

    const executeStub = vi.fn(() => ({}));
    (store as unknown as { execute: typeof executeStub }).execute = executeStub;

    const getSessionSpy = vi.spyOn(store, 'getSession').mockResolvedValue(buildSession());

    await store.addBotVotes('session-123', []);

    expect(getSessionSpy).not.toHaveBeenCalled();
    expect(executeStub).not.toHaveBeenCalled();
  });

  it('throws when session is finalized', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();
    session.finalized = true;

    const executeStub = vi.fn(() => ({}));
    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(store.addBotVotes(session.sessionId, [buildVote('B', '0x' + '2'.repeat(64))])).rejects.toThrow(
      'Session already finalized',
    );

    expect(executeStub).not.toHaveBeenCalled();
  });

  it('throws when session is missing electionId', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();
    session.electionId = undefined;

    const executeStub = vi.fn(() => ({}));
    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(store.addBotVotes(session.sessionId, [buildVote('B', '0x' + '2'.repeat(64))])).rejects.toThrow(
      'Session missing electionId',
    );

    expect(executeStub).not.toHaveBeenCalled();
  });

  it('repairs a missing userVoteIndex from the canonical vote at index zero before appending bot votes', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();
    session.userVoteIndex = undefined;

    const executeCalls: string[] = [];
    const executeStub = vi.fn((query: string) => {
      executeCalls.push(query);
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await store.addBotVotes(session.sessionId, [buildVote('B', '0x' + '2'.repeat(64))]);

    const createVoteCalls = executeCalls.filter((query) => query.includes('mutation CreateVote'));
    const updateSessionCalls = executeCalls.filter((query) => query.includes('mutation UpdateVotingSession'));

    expect(createVoteCalls).toHaveLength(1);
    expect(updateSessionCalls).toHaveLength(1);
    expect(session.userVoteIndex).toBe(0);
  });

  it('fails closed when addBotVotes is called before the user vote exists', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();
    session.votes = new Map();
    session.bulletin = new SimpleBulletinBoard('log-123');
    session.bulletinRootHistory = [];
    session.userVoteIndex = undefined;

    const executeStub = vi.fn(() => ({}));
    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(store.addBotVotes(session.sessionId, [buildVote('B', '0x' + '2'.repeat(64))])).rejects.toThrow(
      'USER_VOTE_REQUIRED_BEFORE_BOT_VOTES',
    );

    expect(executeStub).not.toHaveBeenCalled();
  });

  it('fails closed when the stored user vote index is not the canonical index zero', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();
    const existingVote = session.votes.get(0);
    if (!existingVote) {
      throw new Error('Expected user vote at index 0');
    }
    session.votes.set(1, {
      ...existingVote,
      voteId: '33333333-3333-4333-8333-333333333333',
      rand: '0x' + '3'.repeat(64),
      commit: buildVote('B', '0x' + '3'.repeat(64)).commit,
    });
    session.userVoteIndex = 1;

    const executeStub = vi.fn(() => ({}));
    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(store.addBotVotes(session.sessionId, [buildVote('B', '0x' + '2'.repeat(64))])).rejects.toThrow(
      'USER_VOTE_REQUIRED_BEFORE_BOT_VOTES',
    );

    expect(executeStub).not.toHaveBeenCalled();
  });

  it('fails closed when addBotVotes sees sparse vote indices', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();

    session.votes.set(2, buildVote('B', '0x' + '2'.repeat(64)));
    session.botCount = 1;

    const executeStub = vi.fn(() => ({}));
    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(store.addBotVotes(session.sessionId, [buildVote('B', '0x' + '3'.repeat(64))])).rejects.toThrow(
      'NON_CANONICAL_CT_VOTE_INDICES',
    );

    expect(executeStub).not.toHaveBeenCalled();
  });

  it('fails closed when bot votes target a stale live session', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession();
    session.contractGeneration = 'stale-contract-generation';

    const executeStub = vi.fn(() => ({}));
    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(store.addBotVotes(session.sessionId, [buildVote('B', '0x' + '2'.repeat(64))])).rejects.toThrow(
      /Session not found/,
    );

    expect(executeStub).not.toHaveBeenCalled();
  });
});
