import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { buildZkVMInputFromSession } from './input-builder';
import type { SessionData, VoteData } from '@/types/server';
import { BOT_COUNT } from '@/shared/constants';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { buildDefaultElectionConfig, hashElectionConfig } from './election-config';
import { NON_CANONICAL_CT_VOTE_INDICES } from '@/lib/store/ctSessionState';

const SNAPSHOT_TIMESTAMP = 1_695_000_000_000;

function createVoteData(overrides?: Partial<VoteData>): VoteData {
  return {
    vote: 'A',
    rand: '0x' + '1'.repeat(64),
    commit: '0x' + '2'.repeat(64),
    path: ['0x' + '3'.repeat(64), '0x' + '4'.repeat(64)],
    ...overrides,
  };
}

function createSession(overrides?: Partial<SessionData>): SessionData {
  const electionConfig = buildDefaultElectionConfig();
  const votes = new Map<number, VoteData>([
    [
      0,
      createVoteData({
        voteId: '550e8400-e29b-41d4-a716-446655440000',
        vote: 'A',
        commit: '0x' + '2'.repeat(63) + '0',
        timestamp: SNAPSHOT_TIMESTAMP - 1,
      }),
    ],
    [
      1,
      createVoteData({
        voteId: '550e8400-e29b-41d4-a716-446655440001',
        vote: 'B',
        commit: '0x' + '3'.repeat(63) + '1',
        path: ['0x' + '5'.repeat(64), '0x' + '6'.repeat(64)],
        timestamp: SNAPSHOT_TIMESTAMP,
      }),
    ],
  ]);
  const bulletin = new SimpleBulletinBoard('0x' + 'b'.repeat(64));
  for (const vote of votes.values()) {
    if (!vote.voteId) {
      throw new Error('Expected voteId to be defined');
    }
    bulletin.appendVote(vote.voteId, vote.commit.slice(2));
  }

  const session: SessionData = {
    sessionId: 'session-test',
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    votes,
    bulletin,
    botCount: BOT_COUNT,
    finalized: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    bulletinRootHistory: bulletin.getRootHistory().map((snapshot, index) => ({
      timestamp: index === 0 ? SNAPSHOT_TIMESTAMP - 1 : SNAPSHOT_TIMESTAMP,
      root: snapshot.root,
      treeSize: snapshot.treeSize,
    })),
    electionConfigHash: hashElectionConfig(electionConfig),
    electionConfig,
    logId: '0x' + 'b'.repeat(64),
  };

  return {
    ...session,
    ...overrides,
  };
}

describe('buildZkVMInputFromSession', () => {
  let consoleWarnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('prefers CT inclusion proofs from bulletin board when available', () => {
    const baseSession = createSession();
    const votes = new Map<number, VoteData>([
      [
        0,
        {
          ...createVoteData({ vote: 'A' }),
          voteId: 'vote-0',
          path: ['0x' + '1'.repeat(64)], // should be ignored
        },
      ],
      [
        1,
        {
          ...createVoteData({ vote: 'B' }),
          voteId: 'vote-1',
          path: ['0x' + '2'.repeat(64)], // should be ignored
        },
      ],
    ]);

    const nodeA = 'a'.repeat(64);
    const nodeB = 'b'.repeat(64);
    const nodeC = 'c'.repeat(64);
    const ctProofs: Record<string, { proofNodes: string[]; leafIndex: number } | undefined> = {
      'vote-0': { proofNodes: [nodeA, nodeB], leafIndex: 0 },
      'vote-1': { proofNodes: [nodeC], leafIndex: 1 },
    };

    const bulletin = baseSession.bulletin;
    if (!bulletin) {
      throw new Error('Expected bulletin to be available in session');
    }
    vi.spyOn(bulletin, 'getVoteByIndex').mockImplementation((index: number) => {
      const vote = votes.get(index);
      return vote
        ? {
            voteId: vote.voteId ?? `vote-${index}`,
            commitment: vote.commit,
            index,
            timestamp: vote.timestamp ?? Date.now(),
            rootAtAppend: vote.rootAtCast ?? '0x' + '0'.repeat(64),
          }
        : undefined;
    });
    const getInclusionProof = vi.spyOn(bulletin, 'getInclusionProof').mockImplementation((voteId: string) => {
      const proof = ctProofs[voteId];
      if (!proof) {
        return undefined;
      }
      return {
        proofNodes: proof.proofNodes,
        leafIndex: proof.leafIndex,
        treeSize: votes.size,
        rootHash: '0x' + 'a'.repeat(64),
      };
    });

    const session = createSession({
      ...baseSession,
      votes,
      bulletin,
    });

    const input = buildZkVMInputFromSession(session);

    expect(input.votes).toHaveLength(2);
    expect(input.votes[0].merklePath).toEqual([`0x${nodeA}`, `0x${nodeB}`]);
    expect(input.votes[1].merklePath).toEqual([`0x${nodeC}`]);
    expect(getInclusionProof).toHaveBeenCalledWith('vote-0', votes.size);
    expect(getInclusionProof).toHaveBeenCalledWith('vote-1', votes.size);
    expect(input.electionConfigHash).toBe(session.electionConfigHash);
    expect(input.logId).toBe(session.logId);
    expect(input.totalExpected).toBe(BOT_COUNT + 1);
    expect(input.timestamp).toBeGreaterThan(0);
    const snapshots = session.bulletinRootHistory ?? [];
    const snapshot = snapshots[snapshots.length - 1];
    expect(input.treeSize).toBe(snapshot.treeSize);
  });

  it('uses totalExpected from the authoritative session election config', () => {
    const electionConfig = {
      ...buildDefaultElectionConfig(),
      totalExpected: 17,
    };
    const votes = new Map<number, VoteData>([
      [0, createVoteData({ treeSize: 2 })],
      [1, createVoteData({ vote: 'B', treeSize: 2 })],
    ]);
    const session = createSession({
      electionConfig,
      electionConfigHash: hashElectionConfig(electionConfig),
      votes,
    });

    const input = buildZkVMInputFromSession(session);

    expect(input.totalExpected).toBe(17);
  });

  it('throws when authoritative election config is missing', () => {
    const session = createSession({
      electionConfig: undefined,
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('Missing electionConfig for session');
  });

  it('throws when authoritative election config does not match the stored hash', () => {
    const session = createSession({
      electionConfig: buildDefaultElectionConfig(),
      electionConfigHash: '0x' + 'd'.repeat(64),
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError(
      'Session electionConfig does not match electionConfigHash',
    );
  });

  it('throws when STH snapshot data is missing', () => {
    const session = createSession({
      votes: new Map(),
      bulletinRootHistory: [],
      bulletin: undefined,
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('Missing STH snapshot data');
  });

  it('throws when CT proofs are unavailable', () => {
    const missingPathVotes = new Map<number, VoteData>([
      [0, createVoteData({ path: [] })],
      [1, createVoteData({ vote: 'B', path: [] })],
    ]);

    const session = createSession({
      votes: missingPathVotes,
      bulletin: undefined,
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('CT proof unavailable for vote index 0');
  });

  it('throws when bulletin proof leafIndex does not match the stored vote index', () => {
    const session = createSession();
    const bulletin = session.bulletin;
    if (!bulletin) {
      throw new Error('Expected bulletin to be available in session');
    }

    vi.spyOn(bulletin, 'getInclusionProof').mockImplementation(() => ({
      proofNodes: ['a'.repeat(64)],
      leafIndex: 1,
      treeSize: session.votes.size,
      rootHash: '0x' + 'a'.repeat(64),
    }));

    expect(() => buildZkVMInputFromSession(session)).toThrowError('CT proof unavailable for vote index 0');
  });

  it('throws when stored CT proof treeSize mismatches canonical tree size', () => {
    const session = createSession({
      bulletin: undefined,
      votes: new Map<number, VoteData>([
        [
          0,
          createVoteData({
            path: ['0x' + '3'.repeat(64)],
            treeSize: 1,
          }),
        ],
        [
          1,
          createVoteData({
            vote: 'B',
            path: ['0x' + '4'.repeat(64)],
            treeSize: 2,
          }),
        ],
      ]),
      bulletinRootHistory: [],
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('CT proof unavailable for vote index 0');
  });

  it('rebuilds bulletin snapshots from votes when persisted root history is stale', () => {
    const session = createSession({
      votes: new Map<number, VoteData>([
        [0, createVoteData({ voteId: 'vote-0', timestamp: 1000, treeSize: 2 })],
        [1, createVoteData({ vote: 'B', voteId: 'vote-1', timestamp: 1001, treeSize: 2 })],
      ]),
      bulletinRootHistory: [
        {
          timestamp: SNAPSHOT_TIMESTAMP - 500,
          root: '0x' + 'f'.repeat(64),
          treeSize: 0,
        },
      ],
    });

    const input = buildZkVMInputFromSession(session);

    expect(input.treeSize).toBe(session.votes.size);
    expect(input.bulletinRoot).not.toBe('0x' + 'f'.repeat(64));
    expect(input.timestamp).toBe(1001);
  });

  it('fails closed when stored vote indices are sparse', () => {
    const session = createSession({
      bulletin: undefined,
      votes: new Map<number, VoteData>([
        [
          0,
          createVoteData({
            voteId: '550e8400-e29b-41d4-a716-446655440000',
            timestamp: SNAPSHOT_TIMESTAMP - 1,
          }),
        ],
        [
          2,
          createVoteData({
            voteId: '550e8400-e29b-41d4-a716-446655440002',
            vote: 'B',
            commit: '0x' + '3'.repeat(63) + '1',
            timestamp: SNAPSHOT_TIMESTAMP,
          }),
        ],
      ]),
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError(NON_CANONICAL_CT_VOTE_INDICES);
  });

  it('allows sparse vote indices for exclusion projections when explicitly enabled', () => {
    const baseSession = createSession();
    const bulletin = baseSession.bulletin;
    if (!bulletin) {
      throw new Error('Expected bulletin to be available in session');
    }

    const remainingVote = baseSession.votes.get(1);
    if (!remainingVote) {
      throw new Error('Expected vote at index 1 to exist');
    }

    const session = createSession({
      votes: new Map<number, VoteData>([[1, { ...remainingVote }]]),
      bulletin,
      bulletinRootHistory: [],
    });

    const input = buildZkVMInputFromSession(session, { allowSparseVoteIndices: true });

    expect(input.treeSize).toBe(2);
    expect(input.timestamp).toBe(SNAPSHOT_TIMESTAMP);
    expect(input.votes).toHaveLength(1);
    expect(input.votes[0]?.index).toBe(1);
  });

  it('throws when vote data is missing for a known index', () => {
    const session = createSession();
    const votes = session.votes as Map<number, VoteData> & {
      get: (index: number) => VoteData | undefined;
    };
    const originalGet = votes.get.bind(votes);
    votes.get = vi.fn((index: number) => {
      if (index === 0) {
        return undefined;
      }
      return originalGet(index);
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('Vote data not found for index 0');
  });

  it('validates hex inputs and throws helpful errors', () => {
    const session = createSession({
      votes: new Map<number, VoteData>([
        [
          0,
          createVoteData({
            rand: 'not-a-hex-value',
            path: ['0x1234', 'invalid-hex-node'],
          }),
        ],
      ]),
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError(/Invalid hex value/);
  });

  it('throws when no bulletin roots are available at all', () => {
    const session = createSession({
      votes: new Map(),
      bulletinRootHistory: [],
      bulletin: undefined,
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('Missing STH snapshot data');
  });

  it('throws when no tree size metadata is available at all', () => {
    const session = createSession({
      votes: new Map(),
      bulletinRootHistory: [],
      bulletin: undefined,
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('Missing STH snapshot data');
  });

  it('throws when CT proof is missing', () => {
    const session = createSession({
      votes: new Map<number, VoteData>([[0, createVoteData({ path: [] })]]),
      bulletin: undefined,
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('CT proof unavailable for vote index 0');
  });

  it('throws when logId is missing from the session', () => {
    const session = createSession({
      logId: undefined,
      bulletin: undefined,
      bulletinRootHistory: [
        {
          timestamp: SNAPSHOT_TIMESTAMP,
          root: '0x' + 'a'.repeat(64),
          treeSize: 2,
        },
      ],
    });

    expect(() => buildZkVMInputFromSession(session)).toThrowError('Missing logId for session');
  });
});
