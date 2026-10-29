import type { SessionIdentityStore, SessionVotingStore, VerificationObservationStore, VoteStore } from './voteStore';

type Expect<T extends true> = T;
// Voting storage owns these operations; finalization and generic patches are separate authorities.
type StoreKeys =
  | 'createSession'
  | 'getSessionIdentity'
  | 'getVotingRecord'
  | 'getSessionVotingSummary'
  | 'touchSession'
  | 'getActiveSessionCount'
  | 'getVoteById'
  | 'getVoteByIdWithProof'
  | 'getVoteProof'
  | 'recordVerificationObservation';
type CompleteStore = Expect<
  VoteStore extends SessionIdentityStore & SessionVotingStore & VerificationObservationStore ? true : false
>;
type OwnedMethodsOnly = Expect<keyof VoteStore extends StoreKeys ? true : false>;
declare const contracts: [CompleteStore, OwnedMethodsOnly];
void contracts;
