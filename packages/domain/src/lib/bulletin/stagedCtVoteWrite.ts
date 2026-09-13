import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import {
  assertCanonicalCtVoteIndices,
  getCanonicalBulletinRootHistory,
  NON_CANONICAL_CT_VOTE_INDICES,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import type {
  PreparedVote,
  RootSnapshot,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export type CtVoteWriteAuthority = Pick<
  SessionVotingRecord,
  'sessionId' | 'votes' | 'bulletin' | 'bulletinRootHistory'
>;

export interface IndexedVoteWrite {
  index: number;
  vote: PreparedVote;
}

export interface StagedVoteWrite {
  index: number;
  voteId: string;
  storedVote: StoredVoteRecord;
}

export interface StagedCtWriteResult {
  bulletin: SimpleBulletinBoard;
  bulletinRootHistory: RootSnapshot[];
  votes: StagedVoteWrite[];
}

function cloneRootSnapshot(snapshot: RootSnapshot): RootSnapshot {
  return {
    timestamp: snapshot.timestamp,
    root: snapshot.root,
    treeSize: snapshot.treeSize,
    ...omitUndefinedProperties({ signature: snapshot.signature }),
  };
}

export function stageCtVoteWrites(
  authority: CtVoteWriteAuthority,
  writes: readonly IndexedVoteWrite[],
): StagedCtWriteResult {
  const bulletin: unknown = authority.bulletin;
  if (!(bulletin instanceof SimpleBulletinBoard)) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }
  const logId = bulletin.getLogId();
  const stagedBulletin = new SimpleBulletinBoard(logId);
  const existingVotes = Array.from(authority.votes.entries()).sort((a, b) => a[0] - b[0]);
  const nextIndex = assertCanonicalCtVoteIndices(authority.votes.keys());

  for (const [, existingVote] of existingVotes) {
    const existingVoteId = existingVote.voteId;
    if (!existingVoteId) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    stagedBulletin.appendVote(existingVoteId, existingVote.commit.slice(2));
  }

  const bulletinRootHistory = getCanonicalBulletinRootHistory(authority)
    .slice(0, existingVotes.length)
    .map(cloneRootSnapshot);
  const stagedVotes: StagedVoteWrite[] = [];
  const seenIndices = new Set<number>();
  const orderedWrites = [...writes].sort((a, b) => a.index - b.index);

  for (const { index } of orderedWrites) {
    if (seenIndices.has(index)) {
      throw new Error(`Duplicate staged vote index: ${index}`);
    }
    seenIndices.add(index);
  }

  for (const [offset, { index, vote }] of orderedWrites.entries()) {
    if (index !== nextIndex + offset) {
      throw new Error(NON_CANONICAL_CT_VOTE_INDICES);
    }
    const voteId = vote.voteId;

    const appendResult = stagedBulletin.appendVote(voteId, vote.commit.slice(2));
    bulletinRootHistory.push({
      timestamp: appendResult.timestamp,
      root: appendResult.rootAtAppend,
      treeSize: stagedBulletin.getSize(),
    });

    stagedVotes.push({
      index,
      voteId,
      storedVote: {
        voteId,
        vote: vote.vote,
        rand: vote.rand,
        commit: vote.commit,
        timestamp: appendResult.timestamp,
        rootAtCast: normalizeHex(appendResult.rootAtAppend, { allowEmpty: true }),
      },
    });
  }

  return {
    bulletin: stagedBulletin,
    bulletinRootHistory,
    votes: stagedVotes,
  };
}
