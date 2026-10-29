import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  buildZkVMInputFromSession,
  type ZkVMInputSessionRecords,
} from '@stark-ballot/application/zkvm-input/input-builder';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { buildDefaultElectionConfig, hashElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { NON_CANONICAL_CT_VOTE_INDICES } from '@stark-ballot/domain/bulletin/ctSessionState';
import { asBulletinIndex, asLeafIndex } from '@stark-ballot/domain/types/identifiers';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const SNAPSHOT_TIMESTAMP = 1_695_000_000_000;

type TestVoteFixture = Omit<StoredVoteRecord, 'voteId' | 'timestamp' | 'rootAtCast'> &
  Partial<Pick<StoredVoteRecord, 'voteId' | 'timestamp' | 'rootAtCast'>> & {
    path?: string[];
    treeSize?: number;
  };
type SessionOverrides = {
  sessionId?: string;
  electionId?: string | undefined;
  electionConfigHash?: string | undefined;
  electionConfig?: SessionIdentityRecord['electionConfig'] | undefined;
  logId?: string | undefined;
  votes?: Map<number, TestVoteFixture>;
  bulletin?: SimpleBulletinBoard | undefined;
  botCount?: number;
  bulletinRootHistory?: SessionVotingRecord['bulletinRootHistory'];
};

function createVoteId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function createVoteData(overrides?: Partial<TestVoteFixture>): TestVoteFixture {
  const vote = overrides?.vote ?? 'A';
  const commitmentDigit = vote === 'A' ? '2' : '3';
  return {
    vote,
    rand: '0x' + '1'.repeat(64),
    commit: '0x' + commitmentDigit.repeat(64),
    path: ['0x' + '3'.repeat(64), '0x' + '4'.repeat(64)],
    ...overrides,
  };
}

function createSession(overrides: SessionOverrides = {}): ZkVMInputSessionRecords {
  const defaultElectionConfig = buildDefaultElectionConfig();
  const electionConfig = Object.prototype.hasOwnProperty.call(overrides, 'electionConfig')
    ? overrides.electionConfig
    : defaultElectionConfig;
  const rawVotes =
    overrides.votes ??
    new Map<number, TestVoteFixture>([
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
  const bulletin = createFixtureBulletin(overrides, rawVotes);
  const storedVotes = createStoredVoteFixtures(rawVotes);
  const sessionId = overrides.sessionId ?? 'session-test';
  const identity = createIdentityFixture(overrides, electionConfig, defaultElectionConfig, sessionId);
  const voting = createVotingFixture(overrides, sessionId, storedVotes, bulletin);
  return { identity, voting };
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
    const votes = new Map<number, TestVoteFixture>([
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

    const bulletin = baseSession.voting.bulletin;
    vi.spyOn(bulletin, 'getVoteByIndex').mockImplementation((index: number) => {
      const vote = votes.get(index);
      return vote
        ? {
            voteId: vote.voteId ?? `vote-${index}`,
            commitment: vote.commit,
            index: asBulletinIndex(index),
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
        leafIndex: asLeafIndex(proof.leafIndex),
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
    expect(strictDefined(input.votes[0]).merklePath).toEqual([`0x${nodeA}`, `0x${nodeB}`]);
    expect(strictDefined(input.votes[1]).merklePath).toEqual([`0x${nodeC}`]);
    expect(getInclusionProof).toHaveBeenCalledWith('vote-0', votes.size);
    expect(getInclusionProof).toHaveBeenCalledWith('vote-1', votes.size);
    expect(input.electionConfigHash).toBe(session.identity.electionConfigHash);
    expect(input.logId).toBe(session.identity.logId);
    expect(input.totalExpected).toBe(BOT_COUNT + 1);
    expect(input.timestamp).toBeGreaterThan(0);
    const snapshots = session.voting.bulletinRootHistory;
    const snapshot = snapshots[snapshots.length - 1];
    if (!snapshot) {
      throw new Error('Expected a bulletin root snapshot');
    }
    expect(input.treeSize).toBe(snapshot.treeSize);
  });

  it('uses totalExpected from the authoritative session election config', () => {
    const electionConfig = {
      ...buildDefaultElectionConfig(),
      totalExpected: 17,
    };
    const votes = new Map<number, TestVoteFixture>([
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

    expect(() => buildZkVMInputFromSession(session)).toThrow('Missing electionConfig for session');
  });

  it('throws when authoritative election config does not match the stored hash', () => {
    const session = createSession({
      electionConfig: buildDefaultElectionConfig(),
      electionConfigHash: '0x' + 'd'.repeat(64),
    });

    expect(() => buildZkVMInputFromSession(session)).toThrow(
      'Session electionConfig does not match electionConfigHash',
    );
  });

  it('throws when STH snapshot data is missing', () => {
    const session = createSession({
      votes: new Map(),
      bulletinRootHistory: [],
    });

    expect(() => buildZkVMInputFromSession(session)).toThrow('Missing STH snapshot data');
  });

  it('throws when CT proofs are unavailable', () => {
    const missingPathVotes = new Map<number, TestVoteFixture>([
      [0, createVoteData({ path: [] })],
      [1, createVoteData({ vote: 'B', path: [] })],
    ]);

    const session = createSession({
      votes: missingPathVotes,
    });
    vi.spyOn(session.voting.bulletin, 'getInclusionProof').mockReturnValue(undefined);

    expect(() => buildZkVMInputFromSession(session)).toThrow('CT proof unavailable for vote index 0');
  });

  it('throws when bulletin proof leafIndex does not match the stored vote index', () => {
    const session = createSession();
    const bulletin = session.voting.bulletin;

    vi.spyOn(bulletin, 'getInclusionProof').mockImplementation(() => ({
      proofNodes: ['a'.repeat(64)],
      leafIndex: asLeafIndex(1),
      treeSize: session.voting.votes.size,
      rootHash: '0x' + 'a'.repeat(64),
    }));

    expect(() => buildZkVMInputFromSession(session)).toThrow('CT proof unavailable for vote index 0');
  });

  it('does not fall back to legacy proof fields on vote data', () => {
    const session = createSession({
      votes: new Map<number, TestVoteFixture>([
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
    });
    vi.spyOn(session.voting.bulletin, 'getInclusionProof').mockReturnValue(undefined);

    expect(() => buildZkVMInputFromSession(session)).toThrow('CT proof unavailable for vote index 0');
  });

  it('rebuilds bulletin snapshots from votes when persisted root history is stale', () => {
    const session = createSession({
      votes: new Map<number, TestVoteFixture>([
        [0, createVoteData({ voteId: createVoteId(0), timestamp: 1000, treeSize: 2 })],
        [1, createVoteData({ vote: 'B', voteId: createVoteId(1), timestamp: 1001, treeSize: 2 })],
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

    expect(input.treeSize).toBe(session.voting.votes.size);
    expect(input.bulletinRoot).not.toBe('0x' + 'f'.repeat(64));
    expect(input.timestamp).toBe(1001);
  });

  it('fails closed when stored vote indices are sparse', () => {
    const session = createSession({
      bulletin: undefined,
      votes: new Map<number, TestVoteFixture>([
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

    expect(() => buildZkVMInputFromSession(session)).toThrow(NON_CANONICAL_CT_VOTE_INDICES);
  });

  it('allows sparse vote indices for exclusion projections when explicitly enabled', () => {
    const baseSession = createSession();
    const bulletin = baseSession.voting.bulletin;

    const remainingVote = baseSession.voting.votes.get(1);
    if (!remainingVote) {
      throw new Error('Expected vote at index 1 to exist');
    }

    const session = createSession({
      votes: new Map<number, TestVoteFixture>([[1, { ...remainingVote, path: [] }]]),
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
    const votes = session.voting.votes as Map<number, StoredVoteRecord> & {
      get: (index: number) => StoredVoteRecord | undefined;
    };
    const originalGet = votes.get.bind(votes);
    votes.get = vi.fn((index: number) => {
      if (index === 0) {
        return undefined;
      }
      return originalGet(index);
    });

    expect(() => buildZkVMInputFromSession(session)).toThrow('Vote data not found for index 0');
  });

  it('validates hex inputs and throws helpful errors', () => {
    const session = createSession({
      votes: new Map<number, TestVoteFixture>([
        [
          0,
          createVoteData({
            rand: 'not-a-hex-value',
            path: ['0x1234', 'invalid-hex-node'],
          }),
        ],
      ]),
    });

    expect(() => buildZkVMInputFromSession(session)).toThrow(/Invalid hex value/);
  });

  it('throws when no bulletin roots are available at all', () => {
    const session = createSession({
      votes: new Map(),
      bulletinRootHistory: [],
    });

    expect(() => buildZkVMInputFromSession(session)).toThrow('Missing STH snapshot data');
  });

  it('throws when no tree size metadata is available at all', () => {
    const session = createSession({
      votes: new Map(),
      bulletinRootHistory: [],
    });

    expect(() => buildZkVMInputFromSession(session)).toThrow('Missing STH snapshot data');
  });

  it('throws when CT proof is missing', () => {
    const session = createSession({
      votes: new Map<number, TestVoteFixture>([[0, createVoteData({ path: [] })]]),
    });
    vi.spyOn(session.voting.bulletin, 'getInclusionProof').mockReturnValue(undefined);

    expect(() => buildZkVMInputFromSession(session)).toThrow('CT proof unavailable for vote index 0');
  });

  it('throws when logId is missing from the session', () => {
    const session = createSession({
      logId: undefined,
    });

    expect(() => buildZkVMInputFromSession(session)).toThrow('Missing logId for session');
  });
});

function createFixtureBulletin(
  overrides: SessionOverrides,
  rawVotes: Map<number, TestVoteFixture>,
): SimpleBulletinBoard | undefined {
  const bulletin = Object.prototype.hasOwnProperty.call(overrides, 'bulletin')
    ? overrides.bulletin
    : new SimpleBulletinBoard('0x' + 'b'.repeat(64));
  if (bulletin && !Object.prototype.hasOwnProperty.call(overrides, 'bulletin')) {
    for (const [index, vote] of rawVotes) {
      bulletin.appendVote(vote.voteId ?? createVoteId(index), vote.commit.slice(2));
    }
  }
  return bulletin;
}

function createStoredVoteFixtures(rawVotes: Map<number, TestVoteFixture>): Map<number, StoredVoteRecord> {
  const storedVotes = new Map<number, StoredVoteRecord>();
  for (const [index, vote] of rawVotes) {
    storedVotes.set(index, {
      voteId: vote.voteId ?? createVoteId(index),
      vote: vote.vote,
      rand: vote.rand,
      commit: vote.commit,
      timestamp: vote.timestamp ?? SNAPSHOT_TIMESTAMP + index,
      rootAtCast: vote.rootAtCast ?? `0x${'a'.repeat(64)}`,
    });
  }
  return storedVotes;
}

function createIdentityFixture(
  overrides: SessionOverrides,
  electionConfig: SessionOverrides['electionConfig'],
  defaultElectionConfig: SessionIdentityRecord['electionConfig'],
  sessionId: string,
): SessionIdentityRecord {
  const identity = {
    sessionId,
    electionId: overrides.electionId ?? '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: overrides.electionConfigHash ?? hashElectionConfig(electionConfig ?? defaultElectionConfig),
    electionConfig,
    logId: Object.prototype.hasOwnProperty.call(overrides, 'logId') ? overrides.logId : `0x${'b'.repeat(64)}`,
    createdAtMs: SNAPSHOT_TIMESTAMP - 10,
  } as SessionIdentityRecord;
  return identity;
}

function createVotingFixture(
  overrides: SessionOverrides,
  sessionId: string,
  storedVotes: Map<number, StoredVoteRecord>,
  bulletin: SimpleBulletinBoard | undefined,
): SessionVotingRecord {
  const voting = {
    sessionId,
    votes: storedVotes,
    bulletin,
    botCount: overrides.botCount ?? BOT_COUNT,
    userParticipation: { status: 'cast', voteIndex: 0 },
    lastActivityMs: SNAPSHOT_TIMESTAMP,
    bulletinRootHistory:
      overrides.bulletinRootHistory ??
      bulletin?.getRootHistory().map((snapshot, index) => ({
        timestamp: index === 0 ? SNAPSHOT_TIMESTAMP - 1 : SNAPSHOT_TIMESTAMP,
        root: snapshot.root,
        treeSize: snapshot.treeSize,
      })) ??
      [],
  } as SessionVotingRecord;
  return voting;
}
