import Std

namespace StarkBallotFormal

inductive CheckStatus where
  | success
  | not_run
  | pending
  | running
  | failed
  deriving DecidableEq, Repr

inductive SummaryStatus where
  | fully_verified
  | in_progress
  | missing_evidence
  | verified_with_limitations
  | user_vote_excluded
  | votes_excluded
  | votes_excluded_unknown
  | recorded_integrity_failed
  | published_tally_mismatch
  | counted_integrity_failed
  | cast_integrity_failed
  | proof_verification_failed
  deriving DecidableEq, Repr

inductive SummaryTone where
  | verified
  | warning
  | failed
  deriving DecidableEq, Repr

inductive NonFullySummaryStatus where
  | in_progress
  | missing_evidence
  | verified_with_limitations
  | user_vote_excluded
  | votes_excluded
  | votes_excluded_unknown
  | recorded_integrity_failed
  | published_tally_mismatch
  | counted_integrity_failed
  | cast_integrity_failed
  | proof_verification_failed
  deriving DecidableEq, Repr

def NonFullySummaryStatus.toSummaryStatus : NonFullySummaryStatus -> SummaryStatus
  | .in_progress => .in_progress
  | .missing_evidence => .missing_evidence
  | .verified_with_limitations => .verified_with_limitations
  | .user_vote_excluded => .user_vote_excluded
  | .votes_excluded => .votes_excluded
  | .votes_excluded_unknown => .votes_excluded_unknown
  | .recorded_integrity_failed => .recorded_integrity_failed
  | .published_tally_mismatch => .published_tally_mismatch
  | .counted_integrity_failed => .counted_integrity_failed
  | .cast_integrity_failed => .cast_integrity_failed
  | .proof_verification_failed => .proof_verification_failed

def SummaryStatus.tone : SummaryStatus -> SummaryTone
  | .fully_verified => .verified
  | .in_progress => .warning
  | .missing_evidence => .warning
  | .verified_with_limitations => .warning
  | .user_vote_excluded => .failed
  | .votes_excluded => .failed
  | .votes_excluded_unknown => .failed
  | .recorded_integrity_failed => .failed
  | .published_tally_mismatch => .failed
  | .counted_integrity_failed => .failed
  | .cast_integrity_failed => .failed
  | .proof_verification_failed => .failed

inductive CheckCategory where
  | cast_as_intended
  | recorded_as_cast
  | counted_as_recorded
  | stark_verification
  deriving DecidableEq, Repr

inductive CheckRole where
  | proof_verification
  | cast_receipt_integrity
  | recorded_inclusion
  | recorded_append_only
  | tally_input_integrity
  | tally_completeness
  | user_inclusion
  | tally_consistency
  | optional_external_audit
  deriving DecidableEq, Repr

inductive Criticality where
  | required
  | optional
  deriving DecidableEq, Repr

inductive CheckId where
  | cast_receipt_present
  | cast_choice_range
  | cast_random_format
  | cast_commitment_match
  | recorded_commitment_in_bulletin
  | recorded_index_in_range
  | recorded_root_at_cast_consistent
  | recorded_inclusion_proof
  | recorded_consistency_proof
  | recorded_sth_third_party
  | counted_input_sanity
  | counted_unique_indices
  | counted_unique_commitments
  | counted_tally_consistent
  | counted_missing_indices_zero
  | counted_expected_vs_tree_size
  | counted_election_manifest_consistent
  | counted_close_statement_consistent
  | counted_my_vote_included
  | counted_input_commitment_match
  | stark_image_id_match
  | stark_receipt_verify
  deriving DecidableEq, Repr

inductive CheckRef where
  | known (id : CheckId)
  | unknown (name : String)
  deriving DecidableEq, Repr

structure CheckDefinition where
  id : CheckId
  category : CheckCategory
  role : CheckRole
  criticality : Criticality
  deriving Repr

structure CheckResult where
  id : CheckRef
  status : CheckStatus
  deriving Repr

structure SummaryContext where
  sthSourcesConfigured : Bool := false
  deriving Repr

def isKnownRef : CheckRef -> Bool
  | .known _ => true
  | .unknown _ => false

def statusIsSuccess (status : CheckStatus) : Bool :=
  status == .success

def statusIsInProgress (status : CheckStatus) : Bool :=
  status == .pending || status == .running

def statusBlocksOptionalFullyVerified (status : CheckStatus) : Bool :=
  status == .failed || status == .not_run

end StarkBallotFormal
