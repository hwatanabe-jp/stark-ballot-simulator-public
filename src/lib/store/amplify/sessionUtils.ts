import { VOTE_CHOICES } from '@/shared/constants';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { generateVoteId } from '@/lib/vote/voteId';
import { computeCommitment } from '@/lib/zkvm/types';
import { normalizeHex } from '@/lib/utils/hex';
import type { SessionData, VoteData } from '@/types/server';
import type { VoteChoice } from '@/shared/constants';

export function buildTimestamp(): number {
  return Date.now();
}

export function formatVoteData(session: SessionData, vote: VoteData): VoteData {
  if (!session.electionId) {
    throw new Error('Session missing electionId');
  }
  const normalizedRandom = normalizeHex(vote.rand, { allowEmpty: true });
  const choiceNumber = vote.vote.charCodeAt(0) - 'A'.charCodeAt(0);
  const commitment = computeCommitment(session.electionId, choiceNumber, normalizedRandom);

  return {
    ...vote,
    voteId: vote.voteId ?? generateVoteId(),
    rand: normalizedRandom,
    commit: commitment,
    timestamp: vote.timestamp ?? buildTimestamp(),
    path: vote.path,
  };
}

export function applyVoteToSession(session: SessionData, index: number, vote: VoteData): SessionData {
  const updatedSession: SessionData = {
    ...session,
    votes: new Map(session.votes),
    bulletin: session.bulletin ? new SimpleBulletinBoard(session.logId) : undefined,
    bulletinRootHistory: session.bulletinRootHistory ? [...session.bulletinRootHistory] : [],
    botCount: session.botCount,
    lastActivity: buildTimestamp(),
  };

  const sortedVotes = Array.from(session.votes.entries()).sort((a, b) => a[0] - b[0]);
  for (const [, existingVote] of sortedVotes) {
    if (updatedSession.bulletin) {
      const existingVoteId = existingVote.voteId;
      if (!existingVoteId) {
        throw new Error('Vote ID missing for existing vote');
      }
      updatedSession.bulletin.appendVote(existingVoteId, existingVote.commit.slice(2));
    }
  }

  if (!updatedSession.bulletin || !vote.voteId) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }

  const appendResult = updatedSession.bulletin.appendVote(vote.voteId, vote.commit.slice(2));
  const rootAtCast = normalizeHex(appendResult.rootAtAppend, { allowEmpty: true });
  updatedSession.bulletinRootHistory = updatedSession.bulletin.getRootHistory().map((snapshot) => ({
    timestamp: snapshot.timestamp,
    root: normalizeHex(snapshot.root, { allowEmpty: true }),
    treeSize: snapshot.treeSize,
    signature: snapshot.signature,
  }));

  let ctProof;
  try {
    const ctTreeSize = index + 1;
    ctProof = updatedSession.bulletin.getInclusionProof(vote.voteId, ctTreeSize);
  } catch {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }

  if (!ctProof) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }

  const merklePath = ctProof.proofNodes.map((node) => normalizeHex(node, { allowEmpty: true }));

  updatedSession.votes.set(index, {
    ...vote,
    rootAtCast,
    path: merklePath,
    treeSize: ctProof.treeSize,
  });

  if (index === 0) {
    updatedSession.userVoteIndex = 0;
  } else {
    updatedSession.botCount = index;
  }

  return updatedSession;
}

export function deriveTallies(votes: Map<number, VoteData>): Record<VoteChoice, number> {
  const counts: Record<VoteChoice, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
  };
  for (const vote of votes.values()) {
    if (VOTE_CHOICES.includes(vote.vote)) {
      counts[vote.vote] += 1;
    }
  }
  return counts;
}
