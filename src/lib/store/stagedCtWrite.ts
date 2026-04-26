import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { getCanonicalBulletinRootHistory } from '@/lib/store/ctSessionState';
import { normalizeHex } from '@/lib/utils/hex';
import type { RootSnapshot, SessionData, VoteData } from '@/types/server';

export interface IndexedVoteWrite {
  index: number;
  vote: VoteData;
}

export interface StagedVoteWrite {
  index: number;
  voteId: string;
  storedVote: VoteData;
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
    signature: snapshot.signature,
  };
}

export function stageCtVoteWrites(session: SessionData, writes: IndexedVoteWrite[]): StagedCtWriteResult {
  if (!session.bulletin) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }

  const logId = session.logId ?? session.bulletin.getLogId();
  const stagedBulletin = new SimpleBulletinBoard(logId);
  const existingVotes = Array.from(session.votes.entries()).sort((a, b) => a[0] - b[0]);

  for (const [, existingVote] of existingVotes) {
    const existingVoteId = existingVote.voteId;
    if (!existingVoteId) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    stagedBulletin.appendVote(existingVoteId, existingVote.commit.slice(2));
  }

  const bulletinRootHistory = getCanonicalBulletinRootHistory(session, 'CtSessionWrite')
    .slice(0, existingVotes.length)
    .map(cloneRootSnapshot);
  const stagedVotes: StagedVoteWrite[] = [];
  const seenIndices = new Set<number>();
  const orderedWrites = [...writes].sort((a, b) => a.index - b.index);

  for (const { index, vote } of orderedWrites) {
    if (seenIndices.has(index)) {
      throw new Error(`Duplicate staged vote index: ${index}`);
    }
    seenIndices.add(index);

    const voteId = vote.voteId;
    if (!voteId) {
      throw new Error('Vote ID missing after formatting');
    }

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
        ...vote,
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
