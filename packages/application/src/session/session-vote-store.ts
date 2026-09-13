import type { ApplicationErrorCode, ApplicationExpectedErrorOf, Result } from '@stark-ballot/application';
import type { AddVoteResult, BotVoteCommand, UserVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';

export type SessionVoteStoreError = ApplicationExpectedErrorOf<
  | typeof ApplicationErrorCode.SESSION_NOT_FOUND
  | typeof ApplicationErrorCode.ALREADY_VOTED
  | typeof ApplicationErrorCode.SESSION_FINALIZED
  | typeof ApplicationErrorCode.DUPLICATE_VOTE
  | typeof ApplicationErrorCode.USER_NOT_VOTED
>;

/** Application-owned mutation port. Domain VoteStore remains a read/identity/observation authority. */
export interface SessionVoteMutationStore {
  addVote(sessionId: SessionId, voteData: UserVoteCommand): Promise<Result<AddVoteResult, SessionVoteStoreError>>;

  addBotVotes(sessionId: SessionId, votes: readonly BotVoteCommand[]): Promise<Result<void, SessionVoteStoreError>>;
}

export type ApplicationVoteStore = VoteStore & SessionVoteMutationStore;
