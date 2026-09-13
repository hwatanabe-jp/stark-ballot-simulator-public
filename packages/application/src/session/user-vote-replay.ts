import type { SessionVoteAuthority } from './session-mutation-policy';
import type { StoredVoteRecord, UserVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { choiceToNumber } from '@stark-ballot/domain/crypto/sha256Commitment';

export type UserVoteReplay =
  | { kind: 'not_cast' }
  | { kind: 'conflict' }
  | { kind: 'replay'; vote: StoredVoteRecord; index: number };

/** A retry identifies the original opening, never a new caller-generated vote ID. */
export function resolveUserVoteReplay(
  authority: Pick<SessionVoteAuthority, 'identity' | 'voting'>,
  requested: Pick<UserVoteCommand, 'vote' | 'rand'>,
): UserVoteReplay {
  const participation = authority.voting.userParticipation;
  if (participation.status === 'not_cast') return { kind: 'not_cast' };
  const stored = authority.voting.votes.get(participation.voteIndex);
  if (!stored || participation.voteIndex !== 0) throw new Error('Invalid stored user vote authority');
  const commitment = computeCommitment(authority.identity.electionId, choiceToNumber(stored.vote), stored.rand);
  if (
    normalizeHex(stored.commit) !== commitment ||
    normalizeHex(stored.rootAtCast) !== normalizeHex(authority.voting.bulletinRootHistory[0]?.root ?? '')
  ) {
    throw new Error('Invalid stored user vote evidence');
  }
  if (stored.vote !== requested.vote || normalizeHex(stored.rand) !== normalizeHex(requested.rand))
    return { kind: 'conflict' };
  return { kind: 'replay', vote: stored, index: participation.voteIndex };
}
