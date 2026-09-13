import { resolveUserVoteReplay } from './user-vote-replay';
import { ApplicationErrorCode, type ApplicationExpectedErrorOf, type Result } from '@stark-ballot/application';
import type { SessionVoteAuthority } from './session-mutation-policy';
import { choiceToNumber } from '@stark-ballot/domain/crypto/sha256Commitment';
import type { UserVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';

export type SubmitVotePrecheckError = ApplicationExpectedErrorOf<
  | typeof ApplicationErrorCode.ALREADY_VOTED
  | typeof ApplicationErrorCode.SESSION_FINALIZED
  | typeof ApplicationErrorCode.INVALID_COMMITMENT
>;

export interface PrepareUserVoteSubmissionInput {
  readonly voteId: string;
  readonly timestamp: number;
  readonly vote: UserVoteCommand['vote'];
  readonly rand: string;
  readonly commitment: string;
}

export interface PreparedUserVoteSubmission {
  readonly commitment: string;
  readonly command: UserVoteCommand;
}

/** Evaluate request-independent vote policy before rate limiting and persistence. */
export function prepareUserVoteSubmission(
  authority: SessionVoteAuthority,
  input: PrepareUserVoteSubmissionInput,
): Result<PreparedUserVoteSubmission, SubmitVotePrecheckError> {
  const normalizedRandom = normalizeHex(input.rand);
  const normalizedCommitment = normalizeHex(input.commitment);
  const expectedCommitment = computeCommitment(
    authority.identity.electionId,
    choiceToNumber(input.vote),
    normalizedRandom,
  );
  if (expectedCommitment !== normalizedCommitment) {
    return { ok: false, error: { code: ApplicationErrorCode.INVALID_COMMITMENT } };
  }
  const replay = resolveUserVoteReplay(authority, input);
  if (replay.kind === 'conflict') return { ok: false, error: { code: ApplicationErrorCode.ALREADY_VOTED } };
  if (replay.kind === 'not_cast' && authority.finalization !== null) {
    return { ok: false, error: { code: ApplicationErrorCode.SESSION_FINALIZED } };
  }

  return {
    ok: true,
    value: {
      commitment: normalizedCommitment,
      command: {
        voteId: input.voteId,
        timestamp: input.timestamp,
        vote: input.vote,
        rand: normalizedRandom,
      },
    },
  };
}
