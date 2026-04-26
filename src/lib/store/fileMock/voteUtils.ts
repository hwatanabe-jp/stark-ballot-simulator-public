import type { SessionData, VoteData } from '@/types/server';
import { generateVoteId } from '@/lib/vote/voteId';
import { computeCommitment } from '@/lib/zkvm/types';
import { normalizeHex } from '@/lib/utils/hex';

export function normaliseSiblingHex(sibling: unknown): string {
  if (typeof sibling === 'bigint') {
    return '0x' + sibling.toString(16).padStart(64, '0');
  }
  if (typeof sibling === 'number') {
    return '0x' + BigInt(sibling).toString(16).padStart(64, '0');
  }
  if (typeof sibling === 'string') {
    return normalizeHex(sibling, { allowEmpty: true });
  }
  if (Array.isArray(sibling) && sibling.length > 0) {
    return normaliseSiblingHex(sibling[0]);
  }
  if (sibling && typeof (sibling as { toString: () => string }).toString === 'function') {
    const value = (sibling as { toString: () => string }).toString();
    if (value.startsWith('0x') || /^[0-9a-fA-F]+$/.test(value)) {
      return normalizeHex(value, { allowEmpty: true });
    }
  }
  throw new Error(`[FileMockStore] Unable to normalise sibling value: ${String(sibling)}`);
}

export function formatVoteData(session: SessionData, vote: VoteData): VoteData {
  if (!session.electionId) {
    throw new Error('Session missing electionId');
  }
  const electionId = session.electionId;
  const normalizedRandom = normalizeHex(vote.rand, { allowEmpty: true });
  const choiceNumber = vote.vote.charCodeAt(0) - 'A'.charCodeAt(0);
  const commitment = computeCommitment(electionId, choiceNumber, normalizedRandom);

  return {
    ...vote,
    voteId: vote.voteId ?? generateVoteId(),
    rand: normalizedRandom,
    commit: commitment,
    timestamp: vote.timestamp ?? Date.now(),
  };
}
