import { describe, it, expect } from 'vitest';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type { SessionVotingRecord, StoredVoteRecord } from '@stark-ballot/domain/types/sessionRecords';
import {
  buildUserVoteArtifacts,
  UserVoteArtifactsUnavailableError,
} from '@stark-ballot/application/finalize/usecases/user-vote-artifacts';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';

function createSessionWithBulletin(): {
  voting: SessionVotingRecord;
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
  const votes = new Map<number, StoredVoteRecord>([
    [
      0,
      {
        voteId: voteIdA,
        vote: 'A',
        commit: '0x' + 'a'.repeat(64),
        rand: '0x' + '1'.repeat(64),
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
        timestamp: now,
        rootAtCast: '0x' + appendB.rootAtAppend,
      },
    ],
  ]);

  const voting: SessionVotingRecord = {
    sessionId: 'session-123',
    votes,
    botCount: 2,
    lastActivityMs: now,
    userParticipation: { status: 'cast', voteIndex: 1 },
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
    voting,
    bulletinRoot: '0x' + board.getCurrentRoot(),
    voteId: voteIdB,
    firstVoteRootAtCast: '0x' + appendA.rootAtAppend,
    userVoteRootAtCast: '0x' + appendB.rootAtAppend,
  };
}

describe('buildUserVoteArtifacts', () => {
  it('builds vote receipt and inclusion proof with normalized hex values', () => {
    const { voting, bulletinRoot, voteId, userVoteRootAtCast } = createSessionWithBulletin();
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

    const artifacts = buildUserVoteArtifacts({ voting, finalizationResult });

    expect(artifacts.voteReceipt.voteId).toBe(voteId);
    expect(artifacts.voteReceipt.commitment).toBe('0x' + 'b'.repeat(64));
    expect(artifacts.voteReceipt.bulletinRootAtCast).toBe(userVoteRootAtCast);
    expect(artifacts.voteReceipt.inputCommitment).toBe('0x' + 'd'.repeat(64));
    expect(artifacts.userVoteProof.proof.leafIndex).toBe(1);
    expect(artifacts.userVoteProof.proof.treeSize).toBe(2);
    expect(artifacts.userVoteProof.proof.merklePath.length).toBe(1);
  });

  it('fails closed when the exact cast-time bulletin root is missing for the user vote', () => {
    const { voting, bulletinRoot } = createSessionWithBulletin();
    const userVote = voting.votes.get(1);
    if (!userVote) {
      throw new Error('Expected user vote to exist');
    }
    Reflect.deleteProperty(userVote, 'rootAtCast');

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

    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      'Exact cast-time bulletin root is missing for user vote',
    );
  });

  it('fails closed when the user vote index is missing', () => {
    const { voting, bulletinRoot } = createSessionWithBulletin();
    voting.userParticipation = { status: 'not_cast' };

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

    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      UserVoteArtifactsUnavailableError,
    );
    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      'User vote index is missing for finalization',
    );
  });

  it('fails closed when the exact user vote record is missing', () => {
    const { voting, bulletinRoot } = createSessionWithBulletin();
    voting.votes.delete(1);

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

    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      UserVoteArtifactsUnavailableError,
    );
    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      'Exact user vote record is missing for finalization',
    );
  });

  it('fails closed when the user vote identifier is missing', () => {
    const { voting, bulletinRoot } = createSessionWithBulletin();
    const userVote = voting.votes.get(1);
    if (!userVote) {
      throw new Error('Expected user vote to exist');
    }
    Reflect.deleteProperty(userVote, 'voteId');

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

    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      UserVoteArtifactsUnavailableError,
    );
    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      'Vote identifier is missing for user vote',
    );
  });

  it('fails closed when bulletin inclusion proofs are unavailable for the user vote', () => {
    const { voting, bulletinRoot } = createSessionWithBulletin();
    Reflect.deleteProperty(voting, 'bulletin');

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

    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      UserVoteArtifactsUnavailableError,
    );
    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      'Bulletin inclusion proof function unavailable for user vote',
    );
  });

  it('fails closed when the stored cast root does not match the exact cast-time inclusion proof root', () => {
    const { voting, bulletinRoot, firstVoteRootAtCast } = createSessionWithBulletin();
    const userVote = voting.votes.get(1);
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

    expect(() => buildUserVoteArtifacts({ voting, finalizationResult })).toThrowError(
      'Stored cast root does not match exact cast-time inclusion proof root',
    );
  });
});
