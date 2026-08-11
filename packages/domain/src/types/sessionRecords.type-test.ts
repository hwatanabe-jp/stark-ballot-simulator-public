import type { SessionIdentityRecord, SessionVotingRecord, StoredVoteRecord, VoteData } from './sessionRecords';

function assertSessionRecordBoundaries(
  identity: SessionIdentityRecord,
  voting: SessionVotingRecord,
  vote: VoteData,
): void {
  // @ts-expect-error - stable identity fields are required rather than repaired during reads.
  const incompleteIdentity: SessionIdentityRecord = { sessionId: identity.sessionId };
  void incompleteIdentity;

  const identityWithFinalization: SessionIdentityRecord = {
    ...identity,
    // @ts-expect-error - application-owned finalization authority does not enter identity records.
    finalizationResult: {},
  };
  void identityWithFinalization;

  const votingWithObservation: SessionVotingRecord = {
    ...voting,
    // @ts-expect-error - verification observations remain outside voting authority.
    verificationObservation: {},
  };
  void votingWithObservation;

  // @ts-expect-error - persisted votes require the store-owned cast fields.
  const incompleteStoredVote: StoredVoteRecord = vote;
  void incompleteStoredVote;
}

void assertSessionRecordBoundaries;
