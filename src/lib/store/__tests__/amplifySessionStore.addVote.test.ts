import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeCommitment } from '@/lib/zkvm/types';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { encryptVoteSecret } from '@/lib/security/voteSecretCipher';
import type { SessionData, VoteData } from '@/types/server';
import { normalizeHex } from '@/lib/utils/hex';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { buildSessionSummaryFromRecord } from '@/lib/store/amplify/sessionBuilder';
import type { AmplifyVoteRecord } from '@/lib/store/amplify/graphql';

const electionId = '550e8400-e29b-41d4-a716-446655440000';
const electionConfigHash = '0x' + '2'.repeat(64);

function buildVote(voteId: string, choice: 'A' | 'B', randHex: string): VoteData {
  const choiceNumber = choice.charCodeAt(0) - 'A'.charCodeAt(0);
  const commit = computeCommitment(electionId, choiceNumber, randHex);

  return {
    voteId,
    vote: choice,
    rand: randHex,
    commit,
    path: [],
  };
}

function requireVoteId(vote: VoteData): string {
  if (!vote.voteId) {
    throw new Error('Expected voteId to be defined');
  }
  return vote.voteId;
}

function buildSession(logId: string): SessionData {
  const now = Date.now();
  const bulletin = new SimpleBulletinBoard(logId);

  return {
    sessionId: 'session-123',
    electionId,
    contractGeneration: resolveCurrentContractGeneration(),
    electionConfigHash,
    logId,
    votes: new Map(),
    bulletin,
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    userVoteIndex: undefined,
    bulletinRootHistory: [],
  };
}

describe('AmplifySessionStore addVote', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AMPLIFY_DATA_ENDPOINT: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
      VOTE_SECRET_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('persists CT root and marks the first vote as user vote', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const logId = 'log-123';
    const session = buildSession(logId);

    const voteId = '11111111-1111-4111-8111-111111111111';
    const randHex = '0x' + '1'.repeat(64);
    const vote = buildVote(voteId, 'A', randHex);

    const expectedBoard = new SimpleBulletinBoard(logId);
    const { rootAtAppend } = expectedBoard.appendVote(voteId, vote.commit.slice(2));
    const expectedRootAtCast = normalizeHex(rootAtAppend);

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation CreateVote')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    const result = await store.addVote(session.sessionId, vote);

    expect(capturedInput?.rootAtCast).toBe(expectedRootAtCast);
    expect(capturedInput?.isUserVote).toBe(true);
    expect(result).toMatchObject({
      leafIndex: 0,
      bulletinRootAtCast: expectedRootAtCast,
    });
    expect(result.merklePath).toEqual(expect.any(Array));
  });

  it('does not synthesize missing rootAtCast during session rehydration', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const logId = 'log-456';
    const now = Date.now();

    const voteId = '22222222-2222-4222-8222-222222222222';
    const randHex = '0x' + '2'.repeat(64);
    const vote = buildVote(voteId, 'A', randHex);

    const sessionRecord = {
      id: 'session-456',
      electionId,
      electionConfigHash,
      logId,
      botCount: 0,
      finalized: false,
      userVoteIndex: 0,
      ttl: 123,
      createdAt: new Date(now).toISOString(),
      lastActivity: new Date(now).toISOString(),
      finalizationResultJson: null,
      bulletinRootHistoryJson: JSON.stringify([
        { timestamp: now, root: normalizeHex('0x' + '3'.repeat(64)), treeSize: 1 },
      ]),
    } as const;

    const votes = [
      {
        id: voteId,
        sessionId: sessionRecord.id,
        voteIndex: 0,
        choice: encryptVoteSecret('A'),
        random: encryptVoteSecret(randHex),
        commitment: vote.commit,
        timestamp: new Date(now).toISOString(),
        rootAtCast: null,
        isUserVote: true,
      },
    ];

    const sessionData = await (
      store as unknown as {
        buildSessionData: (session: typeof sessionRecord, records: typeof votes) => Promise<SessionData>;
      }
    ).buildSessionData(sessionRecord, votes);
    const storedVote = sessionData.votes.get(0);

    expect(storedVote?.rootAtCast).toBeUndefined();
  });

  it('reconciles stale persisted botCount from stored vote records', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const now = Date.now();
    const userVote = buildVote('11111111-1111-4111-8111-111111111111', 'A', '0x' + '1'.repeat(64));
    const botVote = buildVote('22222222-2222-4222-8222-222222222222', 'B', '0x' + '2'.repeat(64));

    const sessionRecord = {
      id: 'session-stale-bot-count',
      electionId,
      contractGeneration: resolveCurrentContractGeneration(),
      electionConfigHash,
      logId: 'log-stale-bot-count',
      botCount: 0,
      finalized: false,
      userVoteIndex: 0,
      ttl: 123,
      createdAt: new Date(now).toISOString(),
      lastActivity: new Date(now).toISOString(),
      finalizationResultJson: null,
      bulletinRootHistoryJson: JSON.stringify([]),
    } as const;

    const votes = [
      {
        id: requireVoteId(userVote),
        sessionId: sessionRecord.id,
        voteIndex: 0,
        choice: encryptVoteSecret('A'),
        random: encryptVoteSecret(userVote.rand),
        commitment: userVote.commit,
        timestamp: new Date(now).toISOString(),
        rootAtCast: normalizeHex('0x' + '3'.repeat(64)),
        isUserVote: true,
      },
      {
        id: requireVoteId(botVote),
        sessionId: sessionRecord.id,
        voteIndex: 1,
        choice: encryptVoteSecret('B'),
        random: encryptVoteSecret(botVote.rand),
        commitment: botVote.commit,
        timestamp: new Date(now + 1).toISOString(),
        rootAtCast: normalizeHex('0x' + '4'.repeat(64)),
        isUserVote: false,
      },
    ];

    const sessionData = await (
      store as unknown as {
        buildSessionData: (session: typeof sessionRecord, records: typeof votes) => Promise<SessionData>;
      }
    ).buildSessionData(sessionRecord, votes);

    expect(sessionData.botCount).toBe(1);
    expect(sessionData.votes.size).toBe(2);
  });

  it('rebuilds stale persisted bulletin root history from stored vote records', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const now = Date.now();
    const userVote = buildVote('11111111-1111-4111-8111-111111111111', 'A', '0x' + '1'.repeat(64));
    const botVote = buildVote('22222222-2222-4222-8222-222222222222', 'B', '0x' + '2'.repeat(64));
    const expectedBoard = new SimpleBulletinBoard('log-stale-history');
    const firstAppend = expectedBoard.appendVote(requireVoteId(userVote), userVote.commit.slice(2));
    const secondAppend = expectedBoard.appendVote(requireVoteId(botVote), botVote.commit.slice(2));

    const sessionRecord = {
      id: 'session-stale-history',
      electionId,
      contractGeneration: resolveCurrentContractGeneration(),
      electionConfigHash,
      logId: 'log-stale-history',
      botCount: 1,
      finalized: false,
      userVoteIndex: 0,
      ttl: 123,
      createdAt: new Date(now).toISOString(),
      lastActivity: new Date(now).toISOString(),
      finalizationResultJson: null,
      bulletinRootHistoryJson: JSON.stringify([
        { timestamp: now - 5_000, root: '0x' + 'f'.repeat(64), treeSize: 1 },
        { timestamp: now - 4_000, root: '0x' + 'e'.repeat(64), treeSize: 2, signature: 'stale-sig' },
      ]),
    } as const;

    const votes: AmplifyVoteRecord[] = [
      {
        id: requireVoteId(userVote),
        sessionId: sessionRecord.id,
        voteIndex: 0,
        choice: encryptVoteSecret('A'),
        random: encryptVoteSecret(userVote.rand),
        commitment: userVote.commit,
        timestamp: new Date(now).toISOString(),
        rootAtCast: normalizeHex(firstAppend.rootAtAppend),
        isUserVote: true,
      },
      {
        id: requireVoteId(botVote),
        sessionId: sessionRecord.id,
        voteIndex: 1,
        choice: encryptVoteSecret('B'),
        random: encryptVoteSecret(botVote.rand),
        commitment: botVote.commit,
        timestamp: new Date(now + 1_000).toISOString(),
        rootAtCast: normalizeHex(secondAppend.rootAtAppend),
        isUserVote: false,
      },
    ];

    const sessionData = await (
      store as unknown as {
        buildSessionData: (session: typeof sessionRecord, records: typeof votes) => Promise<SessionData>;
      }
    ).buildSessionData(sessionRecord, votes);

    expect(sessionData.bulletinRootHistory).toEqual([
      {
        timestamp: now,
        root: normalizeHex(firstAppend.rootAtAppend),
        treeSize: 1,
      },
      {
        timestamp: now + 1_000,
        root: normalizeHex(secondAppend.rootAtAppend),
        treeSize: 2,
      },
    ]);
    expect(sessionData.bulletin?.getCurrentRoot()).toBe(secondAppend.rootAtAppend);
    expect(sessionData.bulletin?.getSize()).toBe(2);
  });

  it('fails closed when persisted vote records reuse a vote index', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const now = Date.now();
    const userVote = buildVote('11111111-1111-4111-8111-111111111111', 'A', '0x' + '1'.repeat(64));
    const duplicateVote = buildVote('22222222-2222-4222-8222-222222222222', 'B', '0x' + '2'.repeat(64));

    const sessionRecord = {
      id: 'session-duplicate-index',
      electionId,
      contractGeneration: resolveCurrentContractGeneration(),
      electionConfigHash,
      logId: 'log-duplicate-index',
      botCount: 1,
      finalized: false,
      userVoteIndex: 0,
      ttl: 123,
      createdAt: new Date(now).toISOString(),
      lastActivity: new Date(now).toISOString(),
      finalizationResultJson: null,
      bulletinRootHistoryJson: JSON.stringify([]),
    } as const;

    const votes: AmplifyVoteRecord[] = [
      {
        id: requireVoteId(userVote),
        sessionId: sessionRecord.id,
        voteIndex: 0,
        choice: encryptVoteSecret('A'),
        random: encryptVoteSecret(userVote.rand),
        commitment: userVote.commit,
        timestamp: new Date(now).toISOString(),
        rootAtCast: normalizeHex('0x' + '3'.repeat(64)),
        isUserVote: true,
      },
      {
        id: requireVoteId(duplicateVote),
        sessionId: sessionRecord.id,
        voteIndex: 0,
        choice: encryptVoteSecret('B'),
        random: encryptVoteSecret(duplicateVote.rand),
        commitment: duplicateVote.commit,
        timestamp: new Date(now + 1).toISOString(),
        rootAtCast: normalizeHex('0x' + '4'.repeat(64)),
        isUserVote: false,
      },
    ];

    await expect(
      (
        store as unknown as {
          buildSessionData: (session: typeof sessionRecord, records: typeof votes) => Promise<SessionData>;
        }
      ).buildSessionData(sessionRecord, votes),
    ).rejects.toThrow('NON_CANONICAL_CT_VOTE_INDICES');

    expect(() => buildSessionSummaryFromRecord(sessionRecord.id, sessionRecord, votes)).toThrow(
      'NON_CANONICAL_CT_VOTE_INDICES',
    );
  });

  it('retains persisted bulletin root history timestamps and signatures when they match reconstructed CT state', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const now = Date.now();
    const userVote = buildVote('33333333-3333-4333-8333-333333333333', 'A', '0x' + '3'.repeat(64));
    const botVote = buildVote('44444444-4444-4444-8444-444444444444', 'B', '0x' + '4'.repeat(64));
    const expectedBoard = new SimpleBulletinBoard('log-matching-history');
    const firstAppend = expectedBoard.appendVote(requireVoteId(userVote), userVote.commit.slice(2));
    const secondAppend = expectedBoard.appendVote(requireVoteId(botVote), botVote.commit.slice(2));

    const sessionRecord = {
      id: 'session-matching-history',
      electionId,
      contractGeneration: resolveCurrentContractGeneration(),
      electionConfigHash,
      logId: 'log-matching-history',
      botCount: 1,
      finalized: false,
      userVoteIndex: 0,
      ttl: 123,
      createdAt: new Date(now).toISOString(),
      lastActivity: new Date(now).toISOString(),
      finalizationResultJson: null,
      bulletinRootHistoryJson: JSON.stringify([
        { timestamp: now - 5_000, root: normalizeHex(firstAppend.rootAtAppend), treeSize: 1, signature: 'sig-1' },
        { timestamp: now - 4_000, root: normalizeHex(secondAppend.rootAtAppend), treeSize: 2, signature: 'sig-2' },
      ]),
    } as const;

    const votes = [
      {
        id: userVote.voteId,
        sessionId: sessionRecord.id,
        voteIndex: 0,
        choice: encryptVoteSecret('A'),
        random: encryptVoteSecret(userVote.rand),
        commitment: userVote.commit,
        timestamp: new Date(now).toISOString(),
        rootAtCast: normalizeHex(firstAppend.rootAtAppend),
        isUserVote: true,
      },
      {
        id: botVote.voteId,
        sessionId: sessionRecord.id,
        voteIndex: 1,
        choice: encryptVoteSecret('B'),
        random: encryptVoteSecret(botVote.rand),
        commitment: botVote.commit,
        timestamp: new Date(now + 1_000).toISOString(),
        rootAtCast: normalizeHex(secondAppend.rootAtAppend),
        isUserVote: false,
      },
    ];

    const sessionData = await (
      store as unknown as {
        buildSessionData: (session: typeof sessionRecord, records: typeof votes) => Promise<SessionData>;
      }
    ).buildSessionData(sessionRecord, votes);

    expect(sessionData.bulletinRootHistory).toEqual([
      {
        timestamp: now - 5_000,
        root: normalizeHex(firstAppend.rootAtAppend),
        treeSize: 1,
        signature: 'sig-1',
      },
      {
        timestamp: now - 4_000,
        root: normalizeHex(secondAppend.rootAtAppend),
        treeSize: 2,
        signature: 'sig-2',
      },
    ]);
  });

  it('fails closed when addVote targets a stale live session', async () => {
    const { AmplifySessionStore } = await import('../amplifySessionStore');
    const store = new AmplifySessionStore();
    const session = buildSession('log-stale');
    session.contractGeneration = 'stale-contract-generation';

    const executeStub = vi.fn(() => ({}));
    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await expect(
      store.addVote(session.sessionId, buildVote('33333333-3333-4333-8333-333333333333', 'A', '0x' + '3'.repeat(64))),
    ).rejects.toThrow(/Session not found/);

    expect(executeStub).not.toHaveBeenCalled();
  });
});
