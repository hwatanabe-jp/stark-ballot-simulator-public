import { describe, it, expect } from 'vitest';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import type { SessionData, VoteData } from '@/types/server';
import { buildUserVoteArtifacts, UserVoteArtifactsUnavailableError } from '@/lib/finalize/usecases/user-vote-artifacts';
import { createTestJournal } from '@/lib/testing/test-helpers';

function createSessionWithBulletin(): {
  session: SessionData;
  bulletinRoot: string;
  voteId: string;
  firstVoteRootAtCast: string;
  userVoteRootAtCast: string;
} {
  const voteIdA = '11111111-1111-4111-8111-111111111111';
  const voteIdB = '22222222-2222-4222-8222-222222222222';
  const now = Date.now();
  const board = new SimpleBulletinBoard('0x' + '0'.repeat(64));
  const appendA = board.appendVote(voteIdA, 'a'.repeat(64));
  const appendB = board.appendVote(voteIdB, 'b'.repeat(64));
  const votes = new Map<number, VoteData>([
    [
      0,
      {
        voteId: voteIdA,
        vote: 'A',
        commit: '0x' + 'a'.repeat(64),
        rand: '0x' + '1'.repeat(64),
        path: [],
        timestamp: now,
        rootAtCast: '0x' + appendA.rootAtAppend,
      },
    ],
    [
      1,
      {
        voteId: voteIdB,
        vote: 'B',
        commit: '0x' + 'b'.repeat(64),
        rand: '0x' + '2'.repeat(64),
        path: [],
        timestamp: now,
        rootAtCast: '0x' + appendB.rootAtAppend,
      },
    ],
  ]);

  const session: SessionData = {
    sessionId: 'session-123',
    votes,
    botCount: 2,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    userVoteIndex: 1,
    bulletin: board,
    bulletinRootHistory: [
      {
        root: '0x' + board.getCurrentRoot(),
        timestamp: now,
        treeSize: board.getSize(),
      },
    ],
  };

  return {
    session,
    bulletinRoot: '0x' + board.getCurrentRoot(),
    voteId: voteIdB,
    firstVoteRootAtCast: '0x' + appendA.rootAtAppend,
    userVoteRootAtCast: '0x' + appendB.rootAtAppend,
  };
}

describe('buildUserVoteArtifacts', () => {
  it('builds vote receipt and inclusion proof with normalized hex values', () => {
    const { session, bulletinRoot, voteId, userVoteRootAtCast } = createSessionWithBulletin();
    const journal = createTestJournal();
    const finalizationResult = {
      tally: {
        counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
        totalVotes: 2,
        tamperedCount: 0,
      },
      imageId: '0x' + 'c'.repeat(64),
      journal: {
        ...journal,
        bulletinRoot,
        inputCommitment: '0x' + 'd'.repeat(64),
      },
    };

    const artifacts = buildUserVoteArtifacts({ session, finalizationResult });

    expect(artifacts.voteReceipt.voteId).toBe(voteId);
    expect(artifacts.voteReceipt.commitment).toBe('0x' + 'b'.repeat(64));
    expect(artifacts.voteReceipt.bulletinRootAtCast).toBe(userVoteRootAtCast);
    expect(artifacts.voteReceipt.inputCommitment).toBe('0x' + 'd'.repeat(64));
    expect(artifacts.userVoteProof.proof.leafIndex).toBe(1);
    expect(artifacts.userVoteProof.proof.treeSize).toBe(2);
    expect(artifacts.userVoteProof.proof.merklePath.length).toBe(1);
  });

  it('fails closed when the exact cast-time bulletin root is missing for the user vote', () => {
    const { session, bulletinRoot } = createSessionWithBulletin();
    const userVote = session.votes.get(1);
    if (!userVote) {
      throw new Error('Expected user vote to exist');
    }
    delete userVote.rootAtCast;

    const finalizationResult = {
      tally: {
        counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
        totalVotes: 2,
        tamperedCount: 0,
      },
      imageId: '0x' + 'c'.repeat(64),
      journal: {
        ...createTestJournal(),
        bulletinRoot,
        inputCommitment: '0x' + 'd'.repeat(64),
      },
    };

    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      'Exact cast-time bulletin root is missing for user vote',
    );
  });

  it('fails closed when the user vote index is missing', () => {
    const { session, bulletinRoot } = createSessionWithBulletin();
    delete session.userVoteIndex;

    const finalizationResult = {
      tally: {
        counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
        totalVotes: 2,
        tamperedCount: 0,
      },
      imageId: '0x' + 'c'.repeat(64),
      journal: {
        ...createTestJournal(),
        bulletinRoot,
        inputCommitment: '0x' + 'd'.repeat(64),
      },
    };

    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      UserVoteArtifactsUnavailableError,
    );
    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      'User vote index is missing for finalization',
    );
  });

  it('fails closed when the exact user vote record is missing', () => {
    const { session, bulletinRoot } = createSessionWithBulletin();
    session.votes.delete(1);

    const finalizationResult = {
      tally: {
        counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
        totalVotes: 2,
        tamperedCount: 0,
      },
      imageId: '0x' + 'c'.repeat(64),
      journal: {
        ...createTestJournal(),
        bulletinRoot,
        inputCommitment: '0x' + 'd'.repeat(64),
      },
    };

    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      UserVoteArtifactsUnavailableError,
    );
    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      'Exact user vote record is missing for finalization',
    );
  });

  it('fails closed when the user vote identifier is missing', () => {
    const { session, bulletinRoot } = createSessionWithBulletin();
    const userVote = session.votes.get(1);
    if (!userVote) {
      throw new Error('Expected user vote to exist');
    }
    delete userVote.voteId;

    const finalizationResult = {
      tally: {
        counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
        totalVotes: 2,
        tamperedCount: 0,
      },
      imageId: '0x' + 'c'.repeat(64),
      journal: {
        ...createTestJournal(),
        bulletinRoot,
        inputCommitment: '0x' + 'd'.repeat(64),
      },
    };

    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      UserVoteArtifactsUnavailableError,
    );
    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      'Vote identifier is missing for user vote',
    );
  });

  it('fails closed when bulletin inclusion proofs are unavailable for the user vote', () => {
    const { session, bulletinRoot } = createSessionWithBulletin();
    delete session.bulletin;

    const finalizationResult = {
      tally: {
        counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
        totalVotes: 2,
        tamperedCount: 0,
      },
      imageId: '0x' + 'c'.repeat(64),
      journal: {
        ...createTestJournal(),
        bulletinRoot,
        inputCommitment: '0x' + 'd'.repeat(64),
      },
    };

    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      UserVoteArtifactsUnavailableError,
    );
    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      'Bulletin inclusion proof function unavailable for user vote',
    );
  });

  it('fails closed when the stored cast root does not match the exact cast-time inclusion proof root', () => {
    const { session, bulletinRoot, firstVoteRootAtCast } = createSessionWithBulletin();
    const userVote = session.votes.get(1);
    if (!userVote) {
      throw new Error('Expected user vote to exist');
    }
    userVote.rootAtCast = firstVoteRootAtCast;

    const finalizationResult = {
      tally: {
        counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
        totalVotes: 2,
        tamperedCount: 0,
      },
      imageId: '0x' + 'c'.repeat(64),
      journal: {
        ...createTestJournal(),
        bulletinRoot,
        inputCommitment: '0x' + 'd'.repeat(64),
      },
    };

    expect(() => buildUserVoteArtifacts({ session, finalizationResult })).toThrowError(
      'Stored cast root does not match exact cast-time inclusion proof root',
    );
  });
});
