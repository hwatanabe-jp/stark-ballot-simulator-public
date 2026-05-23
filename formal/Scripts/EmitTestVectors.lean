import StarkBallotFormal.Bitmap
import StarkBallotFormal.GuestModel
import StarkBallotFormal.InputCommitment
import StarkBallotFormal.VerificationSummary

namespace Scripts.EmitTestVectors

open StarkBallotFormal

def jsonEscapedChar : Char -> String
  | '"' => "\\\""
  | '\\' => "\\\\"
  | c => c.toString

def jsonString (value : String) : String :=
  "\"" ++ String.intercalate "" (value.toList.map jsonEscapedChar) ++ "\""

def jsonBool (value : Bool) : String :=
  if value then "true" else "false"

def jsonNat (value : Nat) : String :=
  value.repr

def jsonNullOption (render : α -> String) : Option α -> String
  | some value => render value
  | none => "null"

def checkStatusString : CheckStatus -> String
  | .success => "success"
  | .not_run => "not_run"
  | .pending => "pending"
  | .running => "running"
  | .failed => "failed"

def summaryStatusString : SummaryStatus -> String
  | .fully_verified => "fully_verified"
  | .in_progress => "in_progress"
  | .missing_evidence => "missing_evidence"
  | .verified_with_limitations => "verified_with_limitations"
  | .user_vote_excluded => "user_vote_excluded"
  | .votes_excluded => "votes_excluded"
  | .votes_excluded_unknown => "votes_excluded_unknown"
  | .recorded_integrity_failed => "recorded_integrity_failed"
  | .published_tally_mismatch => "published_tally_mismatch"
  | .counted_integrity_failed => "counted_integrity_failed"
  | .cast_integrity_failed => "cast_integrity_failed"
  | .proof_verification_failed => "proof_verification_failed"

def summaryToneString : SummaryTone -> String
  | .verified => "verified"
  | .warning => "warning"
  | .failed => "failed"

def checkIdString : CheckId -> String
  | .cast_receipt_present => "cast_receipt_present"
  | .cast_choice_range => "cast_choice_range"
  | .cast_random_format => "cast_random_format"
  | .cast_commitment_match => "cast_commitment_match"
  | .recorded_commitment_in_bulletin => "recorded_commitment_in_bulletin"
  | .recorded_index_in_range => "recorded_index_in_range"
  | .recorded_root_at_cast_consistent => "recorded_root_at_cast_consistent"
  | .recorded_inclusion_proof => "recorded_inclusion_proof"
  | .recorded_consistency_proof => "recorded_consistency_proof"
  | .recorded_sth_third_party => "recorded_sth_third_party"
  | .counted_input_sanity => "counted_input_sanity"
  | .counted_unique_indices => "counted_unique_indices"
  | .counted_unique_commitments => "counted_unique_commitments"
  | .counted_tally_consistent => "counted_tally_consistent"
  | .counted_missing_indices_zero => "counted_missing_indices_zero"
  | .counted_expected_vs_tree_size => "counted_expected_vs_tree_size"
  | .counted_election_manifest_consistent => "counted_election_manifest_consistent"
  | .counted_close_statement_consistent => "counted_close_statement_consistent"
  | .counted_my_vote_included => "counted_my_vote_included"
  | .counted_input_commitment_match => "counted_input_commitment_match"
  | .stark_image_id_match => "stark_image_id_match"
  | .stark_receipt_verify => "stark_receipt_verify"

def checkCategoryString : CheckCategory -> String
  | .cast_as_intended => "cast_as_intended"
  | .recorded_as_cast => "recorded_as_cast"
  | .counted_as_recorded => "counted_as_recorded"
  | .stark_verification => "stark_verification"

def checkRoleString : CheckRole -> String
  | .proof_verification => "proof_verification"
  | .cast_receipt_integrity => "cast_receipt_integrity"
  | .recorded_inclusion => "recorded_inclusion"
  | .recorded_append_only => "recorded_append_only"
  | .tally_input_integrity => "tally_input_integrity"
  | .tally_completeness => "tally_completeness"
  | .user_inclusion => "user_inclusion"
  | .tally_consistency => "tally_consistency"
  | .optional_external_audit => "optional_external_audit"

def criticalityString : Criticality -> String
  | .required => "required"
  | .optional => "optional"

structure SummaryCase where
  name : String
  context : SummaryContext := {}
  checkStatuses : List (CheckId × CheckStatus) := []
  omitChecks : List CheckId := []
  extraKnownChecks : List (CheckId × CheckStatus) := []
  extraUnknownChecks : List (String × CheckStatus) := []

def overrideStatus (overrides : List (CheckId × CheckStatus)) (id : CheckId) : Option CheckStatus :=
  (overrides.find? (fun entry => entry.fst == id)).map (fun entry => entry.snd)

def buildSummaryChecks (testCase : SummaryCase) : List CheckResult :=
  let knownChecks := checkDefinitions.filterMap (fun definition =>
    if testCase.omitChecks.any (fun id => id == definition.id) then
      none
    else
      some {
        id := CheckRef.known definition.id
        status := (overrideStatus testCase.checkStatuses definition.id).getD .success
      })
  let unknownChecks := testCase.extraUnknownChecks.map (fun entry => {
    id := CheckRef.unknown entry.fst
    status := entry.snd
  })
  let extraKnownChecks := testCase.extraKnownChecks.map (fun entry => {
    id := CheckRef.known entry.fst
    status := entry.snd
  })
  knownChecks ++ extraKnownChecks ++ unknownChecks

def expectedSummaryStatus (testCase : SummaryCase) : SummaryStatus :=
  deriveSummaryModel testCase.context (buildSummaryChecks testCase)

def expectedSummaryTone (testCase : SummaryCase) : SummaryTone :=
  (expectedSummaryStatus testCase).tone

def jsonArray (items : List String) : String :=
  "[" ++ String.intercalate ", " items ++ "]"

def jsonObjectBody (fields : List String) : String :=
  String.intercalate ",\n" fields

def renderCheckStatusMap (entries : List (CheckId × CheckStatus)) : String :=
  "{" ++ String.intercalate ", " (entries.map (fun entry =>
    jsonString (checkIdString entry.fst) ++ ": " ++ jsonString (checkStatusString entry.snd))) ++ "}"

def renderCheckDefinition (definition : CheckDefinition) : String :=
  "  {\n" ++ jsonObjectBody [
    "    \"id\": " ++ jsonString (checkIdString definition.id),
    "    \"category\": " ++ jsonString (checkCategoryString definition.category),
    "    \"role\": " ++ jsonString (checkRoleString definition.role),
    "    \"criticality\": " ++ jsonString (criticalityString definition.criticality),
    "    \"requiredWhenSthSourcesConfigured\": " ++
      jsonBool (isRequiredCheck { sthSourcesConfigured := true } definition),
    "    \"requiredWhenSthSourcesNotConfigured\": " ++
      jsonBool (isRequiredCheck { sthSourcesConfigured := false } definition)
  ] ++ "\n  }"

def renderUnknownCheck (entry : String × CheckStatus) : String :=
  "{\n" ++ jsonObjectBody [
    "        \"id\": " ++ jsonString entry.fst,
    "        \"status\": " ++ jsonString (checkStatusString entry.snd)
  ] ++ "\n      }"

def renderSummaryCase (testCase : SummaryCase) : String :=
  "  {\n" ++ jsonObjectBody [
    "    \"name\": " ++ jsonString testCase.name,
    "    \"context\": {\n      \"sthSourcesConfigured\": " ++ jsonBool testCase.context.sthSourcesConfigured ++ "\n    }",
    "    \"checkStatuses\": " ++ renderCheckStatusMap testCase.checkStatuses,
    "    \"omitChecks\": " ++ jsonArray (testCase.omitChecks.map (fun id => jsonString (checkIdString id))),
    "    \"extraKnownChecks\": " ++ jsonArray (testCase.extraKnownChecks.map (fun entry =>
      "{\n" ++ jsonObjectBody [
        "        \"id\": " ++ jsonString (checkIdString entry.fst),
        "        \"status\": " ++ jsonString (checkStatusString entry.snd)
      ] ++ "\n      }")),
    "    \"extraUnknownChecks\": " ++ jsonArray (testCase.extraUnknownChecks.map renderUnknownCheck),
    "    \"expectedStatus\": " ++ jsonString (summaryStatusString (expectedSummaryStatus testCase)),
    "    \"expectedTone\": " ++ jsonString (summaryToneString (expectedSummaryTone testCase))
  ] ++ "\n  }"

def summaryCases : List SummaryCase := [
  { name := "all-required-and-optional-success" },
  { name := "missing-required-check", omitChecks := [.cast_receipt_present] },
  { name := "required-pending", checkStatuses := [(.counted_input_sanity, .pending)] },
  { name := "unknown-check", extraUnknownChecks := [("future_check", .success)] },
  { name := "proof-verification-failed", checkStatuses := [(.stark_receipt_verify, .failed)] },
  { name := "recorded-integrity-failed", checkStatuses := [(.recorded_consistency_proof, .failed)] },
  { name := "user-vote-excluded", checkStatuses := [(.counted_missing_indices_zero, .failed), (.counted_my_vote_included, .failed)] },
  { name := "votes-excluded", checkStatuses := [(.counted_missing_indices_zero, .failed)] },
  { name := "published-tally-mismatch", checkStatuses := [(.counted_tally_consistent, .failed)] },
  { name := "counted-integrity-failed", checkStatuses := [(.counted_input_sanity, .failed)] },
  { name := "cast-integrity-failed", checkStatuses := [(.cast_commitment_match, .failed)] },
  { name := "optional-not-run-limits-verification", checkStatuses := [(.recorded_sth_third_party, .not_run)] },
  { name := "optional-failed-limits-verification", checkStatuses := [(.recorded_sth_third_party, .failed)] },
  { name := "optional-pending-does-not-limit-summary", checkStatuses := [(.recorded_sth_third_party, .pending)] },
  { name := "optional-running-does-not-limit-summary", checkStatuses := [(.recorded_sth_third_party, .running)] },
  {
    name := "duplicate-check-id-uses-worst-status",
    extraKnownChecks := [(.stark_receipt_verify, .failed)]
  },
  {
    name := "sth-configured-promotes-third-party-check",
    context := { sthSourcesConfigured := true },
    checkStatuses := [(.recorded_sth_third_party, .not_run)]
  }
]

inductive DisplayStatus where
  | verified
  | failed
  | warning
  deriving DecidableEq, Repr

inductive DisplayOverrideSource where
  | explicit_server_failure
  | summary
  | hard_failure
  | pending
  deriving DecidableEq, Repr

structure DisplayCase where
  name : String
  verificationStarted : Bool := true
  sequenceComplete : Bool := true
  hasCheckPending : Bool := false
  explicitServerFailureStatus : Option DisplayStatus := none
  summaryTone : Option SummaryTone := none
  hasVerificationChecks : Bool := true
  hardFailureDetected : Bool := false

def displayStatusString : DisplayStatus -> String
  | .verified => "verified"
  | .failed => "failed"
  | .warning => "warning"

def displayOverrideSourceString : DisplayOverrideSource -> String
  | .explicit_server_failure => "explicit_server_failure"
  | .summary => "summary"
  | .hard_failure => "hard_failure"
  | .pending => "pending"

def displayStatusOfSummaryTone : SummaryTone -> DisplayStatus
  | .verified => .verified
  | .warning => .warning
  | .failed => .failed

def resolveDisplayOverride (testCase : DisplayCase) : Option (DisplayOverrideSource × DisplayStatus) :=
  match testCase.explicitServerFailureStatus with
  | some status => some (.explicit_server_failure, status)
  | none =>
    if testCase.hasVerificationChecks && testCase.hardFailureDetected &&
        testCase.summaryTone != some .failed then
      some (.hard_failure, .failed)
    else
      match testCase.summaryTone with
      | some tone => some (.summary, displayStatusOfSummaryTone tone)
      | none =>
        if !testCase.hasVerificationChecks then none
        else if testCase.hasCheckPending then some (.pending, .warning)
        else none

def resolveRenderedStatus (testCase : DisplayCase) : Option DisplayStatus :=
  if !testCase.verificationStarted || !testCase.sequenceComplete || testCase.hasCheckPending then
    none
  else
    (resolveDisplayOverride testCase).map (fun entry => entry.snd)

def expectedOverrideSource (testCase : DisplayCase) : Option DisplayOverrideSource :=
  (resolveDisplayOverride testCase).map (fun entry => entry.fst)

def expectedOverrideStatus (testCase : DisplayCase) : Option DisplayStatus :=
  (resolveDisplayOverride testCase).map (fun entry => entry.snd)

def renderDisplayStatusOption (status : Option DisplayStatus) : String :=
  jsonNullOption (fun value => jsonString (displayStatusString value)) status

def renderDisplaySourceOption (source : Option DisplayOverrideSource) : String :=
  jsonNullOption (fun value => jsonString (displayOverrideSourceString value)) source

def renderDisplayCase (testCase : DisplayCase) : String :=
  "  {\n" ++ jsonObjectBody [
    "    \"name\": " ++ jsonString testCase.name,
    "    \"verificationStarted\": " ++ jsonBool testCase.verificationStarted,
    "    \"sequenceComplete\": " ++ jsonBool testCase.sequenceComplete,
    "    \"hasCheckPending\": " ++ jsonBool testCase.hasCheckPending,
    "    \"explicitServerFailureStatus\": " ++ renderDisplayStatusOption testCase.explicitServerFailureStatus,
    "    \"summaryTone\": " ++ jsonNullOption (fun value => jsonString (summaryToneString value)) testCase.summaryTone,
    "    \"hasVerificationChecks\": " ++ jsonBool testCase.hasVerificationChecks,
    "    \"hardFailureDetected\": " ++ jsonBool testCase.hardFailureDetected,
    "    \"expectedOverrideSource\": " ++ renderDisplaySourceOption (expectedOverrideSource testCase),
    "    \"expectedOverrideStatus\": " ++ renderDisplayStatusOption (expectedOverrideStatus testCase),
    "    \"expectedRenderedStatus\": " ++ renderDisplayStatusOption (resolveRenderedStatus testCase)
  ] ++ "\n  }"

def displayCases : List DisplayCase := [
  { name := "fully-verified-renders-verified", summaryTone := some .verified },
  { name := "missing-required-check-does-not-render-verified", summaryTone := some .warning },
  {
    name := "explicit-proof-failure-overrides-verified-summary",
    explicitServerFailureStatus := some .failed,
    summaryTone := some .verified
  },
  {
    name := "hard-failure-check-overrides-empty-summary",
    summaryTone := none,
    hardFailureDetected := true
  },
  {
    name := "hard-failure-check-overrides-verified-summary",
    summaryTone := some .verified,
    hardFailureDetected := true
  },
  {
    name := "hard-failure-keeps-failed-summary-message",
    summaryTone := some .failed,
    hardFailureDetected := true
  },
  {
    name := "required-pending-suppresses-result",
    hasCheckPending := true,
    summaryTone := some .warning
  },
  { name := "verified-with-limitations-does-not-render-verified", summaryTone := some .warning },
  {
    name := "optional-pending-suppresses-result",
    hasCheckPending := true,
    summaryTone := some .verified
  },
  {
    name := "optional-running-suppresses-result",
    hasCheckPending := true,
    summaryTone := some .verified
  },
  {
    name := "sequence-incomplete-suppresses-result",
    sequenceComplete := false,
    summaryTone := some .verified
  }
]

def hexDigit (value : Nat) : String :=
  match value with
  | 0 => "0"
  | 1 => "1"
  | 2 => "2"
  | 3 => "3"
  | 4 => "4"
  | 5 => "5"
  | 6 => "6"
  | 7 => "7"
  | 8 => "8"
  | 9 => "9"
  | 10 => "a"
  | 11 => "b"
  | 12 => "c"
  | 13 => "d"
  | 14 => "e"
  | _ => "f"

def byteHex (value : Nat) : String :=
  hexDigit ((value / 16) % 16) ++ hexDigit (value % 16)

def bytesHex (bytes : List Nat) : String :=
  String.intercalate "" (bytes.map byteHex)

def hex32 (byte : Nat) : String :=
  "0x" ++ bytesHex (List.replicate 32 byte)

def bytesRange (start count : Nat) : List Nat :=
  (List.range count).map (fun offset => (start + offset) % 256)

def renderVote (vote : CommitmentVote) : String :=
  "{\n" ++ jsonObjectBody [
    "        \"id\": " ++ jsonString vote.id,
    "        \"index\": " ++ jsonNat vote.index,
    "        \"commitment\": " ++ jsonString ("0x" ++ bytesHex vote.commitment),
    "        \"merklePath\": " ++ jsonArray (vote.merklePath.map (fun node => jsonString ("0x" ++ bytesHex node)))
  ] ++ "\n      }"

def renderInputCase (testCase : InputCommitmentCase) : String :=
  "  {\n" ++ jsonObjectBody [
    "    \"name\": " ++ jsonString testCase.name,
    "    \"electionId\": " ++ jsonString testCase.electionIdText,
    "    \"bulletinRoot\": " ++ jsonString ("0x" ++ bytesHex testCase.bulletinRoot),
    "    \"treeSize\": " ++ jsonNat testCase.treeSize,
    "    \"totalExpected\": " ++ jsonNat testCase.totalExpected,
    "    \"votes\": " ++ jsonArray (testCase.votes.map renderVote),
    "    \"expectedCanonicalOrder\": " ++
      jsonArray ((canonicalVotes testCase.votes).map (fun vote => jsonString vote.id)),
    "    \"expectedEncodedBytesHex\": " ++ jsonString (bytesHex (canonicalInputCommitmentPreimage testCase))
  ] ++ "\n  }"

def voteA : CommitmentVote := {
  id := "vote-a-index-5"
  index := 5
  commitment := bytesRange 0x10 32
  merklePath := [bytesRange 0x80 32]
}

def voteB : CommitmentVote := {
  id := "vote-b-index-1"
  index := 1
  commitment := bytesRange 0x20 32
  merklePath := []
}

def voteC : CommitmentVote := {
  id := "vote-c-index-3"
  index := 3
  commitment := bytesRange 0x30 32
  merklePath := [bytesRange 0x90 32, bytesRange 0xa0 32]
}

def duplicateCommitmentHigh : CommitmentVote := {
  id := "dup-commitment-22-path-44"
  index := 3
  commitment := List.replicate 32 0x22
  merklePath := [List.replicate 32 0x44]
}

def duplicateCommitmentLowPathHigh : CommitmentVote := {
  id := "dup-commitment-11-path-55"
  index := 3
  commitment := List.replicate 32 0x11
  merklePath := [List.replicate 32 0x55]
}

def duplicateCommitmentLowPathLow : CommitmentVote := {
  id := "dup-commitment-11-path-33"
  index := 3
  commitment := List.replicate 32 0x11
  merklePath := [List.replicate 32 0x33]
}

def prefixPathShort : CommitmentVote := {
  id := "prefix-path-short"
  index := 4
  commitment := List.replicate 32 0x77
  merklePath := [List.replicate 32 0x66]
}

def prefixPathLongLowerSecondNode : CommitmentVote := {
  id := "prefix-path-long-lower-second-node"
  index := 4
  commitment := List.replicate 32 0x77
  merklePath := [List.replicate 32 0x66, List.replicate 32 0x00]
}

def prefixPathLongHigherSecondNode : CommitmentVote := {
  id := "prefix-path-long-higher-second-node"
  index := 4
  commitment := List.replicate 32 0x77
  merklePath := [List.replicate 32 0x66, List.replicate 32 0x99]
}

def inputCommitmentCases : List InputCommitmentCase := [
  {
    name := "minimal-one-vote"
    electionIdText := "00010203-0405-0607-0809-0a0b0c0d0e0f"
    electionId := bytesRange 0 16
    bulletinRoot := List.replicate 32 0x11
    treeSize := 1
    totalExpected := 1
    votes := [{
      id := "only-vote"
      index := 0
      commitment := List.replicate 32 0xde
      merklePath := []
    }]
  },
  {
    name := "unsorted-votes-canonicalize-by-index"
    electionIdText := "10111213-1415-1617-1819-1a1b1c1d1e1f"
    electionId := bytesRange 0x10 16
    bulletinRoot := List.replicate 32 0x44
    treeSize := 10
    totalExpected := 10
    votes := [voteA, voteB, voteC]
  },
  {
    name := "duplicate-indices-tie-break-by-commitment-and-path"
    electionIdText := "20212223-2425-2627-2829-2a2b2c2d2e2f"
    electionId := bytesRange 0x20 16
    bulletinRoot := List.replicate 32 0x55
    treeSize := 8
    totalExpected := 3
    votes := [duplicateCommitmentHigh, duplicateCommitmentLowPathHigh, duplicateCommitmentLowPathLow]
  },
  {
    name := "merkle-path-prefix-sorts-shorter-path-first"
    electionIdText := "30313233-3435-3637-3839-3a3b3c3d3e3f"
    electionId := bytesRange 0x30 16
    bulletinRoot := List.replicate 32 0x66
    treeSize := 9
    totalExpected := 3
    votes := [prefixPathLongLowerSecondNode, prefixPathLongHigherSecondNode, prefixPathShort]
  }
]

structure BitmapCase where
  name : String
  bitLength : Nat
  trueIndices : List Nat
  probes : List Nat

def bitmapBits (testCase : BitmapCase) : List Bool :=
  (List.range testCase.bitLength).map (fun index => testCase.trueIndices.contains index)

def renderBitmapProbe (bits : List Bool) (bitIndex : Nat) : String :=
  let address := packedAddress bitIndex
  "{\n" ++ jsonObjectBody [
    "        \"bitIndex\": " ++ jsonNat bitIndex,
    "        \"byteIndex\": " ++ jsonNat address.fst,
    "        \"bitIndexInByte\": " ++ jsonNat address.snd,
    "        \"expectedValue\": " ++ jsonBool (packedBitValue bits bitIndex)
  ] ++ "\n      }"

def renderBitmapCase (testCase : BitmapCase) : String :=
  let bits := bitmapBits testCase
  "  {\n" ++ jsonObjectBody [
    "    \"name\": " ++ jsonString testCase.name,
    "    \"bitLength\": " ++ jsonNat testCase.bitLength,
    "    \"trueIndices\": " ++ jsonArray (testCase.trueIndices.map jsonNat),
    "    \"expectedPackedByteLength\": " ++ jsonNat (packedByteCount testCase.bitLength),
    "    \"expectedPackedBytesHex\": " ++ jsonString (bytesHex (packBits bits)),
    "    \"probes\": " ++ jsonArray (testCase.probes.map (renderBitmapProbe bits))
  ] ++ "\n  }"

def bitmapCases : List BitmapCase := [
  { name := "zero-bits", bitLength := 0, trueIndices := [], probes := [] },
  { name := "one-bit-set", bitLength := 1, trueIndices := [0], probes := [0] },
  { name := "seven-bits-edge", bitLength := 7, trueIndices := [0, 6], probes := [0, 1, 6] },
  { name := "eight-bits-full-byte", bitLength := 8, trueIndices := [0, 2, 7], probes := [0, 2, 7] },
  { name := "nine-bits-cross-byte", bitLength := 9, trueIndices := [0, 8], probes := [0, 7, 8] },
  { name := "thirty-one-bits", bitLength := 31, trueIndices := [0, 7, 8, 30], probes := [0, 7, 8, 30] },
  { name := "thirty-two-bits", bitLength := 32, trueIndices := [0, 31], probes := [0, 31] },
  { name := "thirty-three-bits", bitLength := 33, trueIndices := [0, 32], probes := [0, 31, 32] },
  { name := "two-hundred-fifty-seven-bits", bitLength := 257, trueIndices := [0, 255, 256], probes := [0, 254, 255, 256] }
]

def rejectReasonString : RejectReason -> String
  | .out_of_range_index => "out_of_range_index"
  | .duplicate_index => "duplicate_index"
  | .invalid_choice => "invalid_choice"
  | .invalid_commitment => "invalid_commitment"
  | .duplicate_commitment => "duplicate_commitment"
  | .invalid_inclusion_proof => "invalid_inclusion_proof"

structure GuestVectorVote where
  id : String
  index : Nat
  choice : Nat
  randomByte : Nat
  commitment : Nat
  commitmentOk : Bool
  inclusionOk : Bool

def GuestVectorVote.toGuestVote (vote : GuestVectorVote) : GuestVote := {
  index := vote.index
  choice := vote.choice
  random := vote.randomByte
  commitment := vote.commitment
  commitmentOk := vote.commitmentOk
  inclusionOk := vote.inclusionOk
}

structure GuestModelCase where
  name : String
  treeSize : Nat
  votes : List GuestVectorVote

def guestCaseState (testCase : GuestModelCase) : GuestState :=
  processVotes testCase.treeSize (testCase.votes.map GuestVectorVote.toGuestVote)

def guestOutcomesFrom (treeSize : Nat) (state : GuestState) : List GuestVectorVote -> List VoteOutcome
  | [] => []
  | vote :: rest =>
      let guestVote := vote.toGuestVote
      let outcome := classifyVote treeSize state guestVote
      outcome :: guestOutcomesFrom treeSize (applyVoteOutcome state guestVote outcome) rest

def guestOutcomes (testCase : GuestModelCase) : List VoteOutcome :=
  guestOutcomesFrom testCase.treeSize (initialGuestState testCase.treeSize) testCase.votes

def trueIndicesFromAux : List Bool -> Nat -> List Nat
  | [], _ => []
  | bit :: rest, index =>
      let tail := trueIndicesFromAux rest (index + 1)
      if bit then index :: tail else tail

def trueIndicesFrom (bits : List Bool) : List Nat :=
  trueIndicesFromAux bits 0

def renderGuestVectorVote (vote : GuestVectorVote) : String :=
  "{\n" ++ jsonObjectBody [
    "        \"id\": " ++ jsonString vote.id,
    "        \"index\": " ++ jsonNat vote.index,
    "        \"choice\": " ++ jsonNat vote.choice,
    "        \"randomByte\": " ++ jsonNat vote.randomByte,
    "        \"commitment\": " ++ jsonNat vote.commitment,
    "        \"commitmentOk\": " ++ jsonBool vote.commitmentOk,
    "        \"inclusionOk\": " ++ jsonBool vote.inclusionOk
  ] ++ "\n      }"

def renderGuestOutcome (outcome : VoteOutcome) : String :=
  match outcome with
  | .accepted =>
      "{\n" ++ jsonObjectBody [
        "        \"accepted\": true",
        "        \"reason\": null",
        "        \"slotSeen\": true",
        "        \"commitmentReserved\": true"
      ] ++ "\n      }"
  | .rejected reason slotSeen commitmentReserved =>
      "{\n" ++ jsonObjectBody [
        "        \"accepted\": false",
        "        \"reason\": " ++ jsonString (rejectReasonString reason),
        "        \"slotSeen\": " ++ jsonBool slotSeen,
        "        \"commitmentReserved\": " ++ jsonBool commitmentReserved
      ] ++ "\n      }"

def renderGuestTally (tally : CandidateTally) : String :=
  jsonArray [
    jsonNat tally.choice0,
    jsonNat tally.choice1,
    jsonNat tally.choice2,
    jsonNat tally.choice3,
    jsonNat tally.choice4
  ]

def renderGuestModelCase (testCase : GuestModelCase) : String :=
  let state := guestCaseState testCase
  "  {\n" ++ jsonObjectBody [
    "    \"name\": " ++ jsonString testCase.name,
    "    \"treeSize\": " ++ jsonNat testCase.treeSize,
    "    \"votes\": " ++ jsonArray (testCase.votes.map renderGuestVectorVote),
    "    \"expectedOutcomes\": " ++ jsonArray ((guestOutcomes testCase).map renderGuestOutcome),
    "    \"expectedSeenIndicesCount\": " ++ jsonNat state.seenIndices.length,
    "    \"expectedMissingSlots\": " ++ jsonNat (guestMissingSlots testCase.treeSize state),
    "    \"expectedInvalidPresentedSlots\": " ++ jsonNat (guestInvalidPresentedSlots state),
    "    \"expectedRejectedRecords\": " ++ jsonNat state.rejectedRecords,
    "    \"expectedRejectionReasons\": " ++
      jsonArray (state.rejectedReasons.reverse.map (fun reason => jsonString (rejectReasonString reason))),
    "    \"expectedExcludedSlots\": " ++ jsonNat (guestExcludedSlots testCase.treeSize state),
    "    \"expectedValidVotes\": " ++ jsonNat state.validVotes,
    "    \"expectedTally\": " ++ renderGuestTally state.verifiedTally,
    "    \"expectedIncludedBitmapTrueIndices\": " ++
      jsonArray ((trueIndicesFrom state.includedBitmap).map jsonNat)
  ] ++ "\n  }"

def guestModelCases : List GuestModelCase := [
  {
    name := "all-valid"
    treeSize := 3
    votes := [
      { id := "valid-0", index := 0, choice := 0, randomByte := 10, commitment := 10, commitmentOk := true, inclusionOk := true },
      { id := "valid-1", index := 1, choice := 1, randomByte := 11, commitment := 11, commitmentOk := true, inclusionOk := true },
      { id := "valid-2", index := 2, choice := 4, randomByte := 12, commitment := 12, commitmentOk := true, inclusionOk := true }
    ]
  },
  {
    name := "missing-slot"
    treeSize := 3
    votes := [
      { id := "valid-0", index := 0, choice := 0, randomByte := 20, commitment := 20, commitmentOk := true, inclusionOk := true },
      { id := "valid-2", index := 2, choice := 2, randomByte := 22, commitment := 22, commitmentOk := true, inclusionOk := true }
    ]
  },
  {
    name := "out-of-range-index"
    treeSize := 2
    votes := [
      { id := "out-of-range", index := 2, choice := 0, randomByte := 30, commitment := 30, commitmentOk := true, inclusionOk := false }
    ]
  },
  {
    name := "duplicate-index"
    treeSize := 2
    votes := [
      { id := "valid-first", index := 0, choice := 0, randomByte := 40, commitment := 40, commitmentOk := true, inclusionOk := true },
      { id := "duplicate-second", index := 0, choice := 1, randomByte := 41, commitment := 41, commitmentOk := true, inclusionOk := true }
    ]
  },
  {
    name := "invalid-choice"
    treeSize := 1
    votes := [
      { id := "invalid-choice", index := 0, choice := 5, randomByte := 50, commitment := 50, commitmentOk := true, inclusionOk := true }
    ]
  },
  {
    name := "invalid-commitment"
    treeSize := 1
    votes := [
      { id := "invalid-commitment", index := 0, choice := 0, randomByte := 60, commitment := 61, commitmentOk := false, inclusionOk := true }
    ]
  },
  {
    name := "duplicate-commitment"
    treeSize := 2
    votes := [
      { id := "commitment-owner", index := 0, choice := 2, randomByte := 70, commitment := 70, commitmentOk := true, inclusionOk := true },
      { id := "commitment-duplicate", index := 1, choice := 2, randomByte := 70, commitment := 70, commitmentOk := true, inclusionOk := true }
    ]
  },
  {
    name := "invalid-inclusion-proof"
    treeSize := 2
    votes := [
      { id := "invalid-inclusion", index := 0, choice := 3, randomByte := 80, commitment := 80, commitmentOk := true, inclusionOk := false },
      { id := "same-commitment-after-invalid-inclusion", index := 1, choice := 3, randomByte := 80, commitment := 80, commitmentOk := true, inclusionOk := true }
    ]
  },
  {
    name := "extra-record-beyond-tree-size"
    treeSize := 1
    votes := [
      { id := "valid-only-slot", index := 0, choice := 4, randomByte := 90, commitment := 90, commitmentOk := true, inclusionOk := true },
      { id := "extra-record", index := 1, choice := 0, randomByte := 91, commitment := 91, commitmentOk := true, inclusionOk := false }
    ]
  },
  {
    name := "zero-exclusion-complete"
    treeSize := 2
    votes := [
      { id := "complete-0", index := 0, choice := 1, randomByte := 100, commitment := 100, commitmentOk := true, inclusionOk := true },
      { id := "complete-1", index := 1, choice := 3, randomByte := 101, commitment := 101, commitmentOk := true, inclusionOk := true }
    ]
  }
]

def renderJsonArray (items : List String) : String :=
  "[\n" ++ String.intercalate ",\n" items ++ "\n]\n"

def summaryCasesJson : String :=
  renderJsonArray (summaryCases.map renderSummaryCase)

def displayCasesJson : String :=
  renderJsonArray (displayCases.map renderDisplayCase)

def inputCommitmentCasesJson : String :=
  renderJsonArray (inputCommitmentCases.map renderInputCase)

def bitmapCasesJson : String :=
  renderJsonArray (bitmapCases.map renderBitmapCase)

def checkDefinitionsJson : String :=
  renderJsonArray (checkDefinitions.map renderCheckDefinition)

def guestModelCasesJson : String :=
  renderJsonArray (guestModelCases.map renderGuestModelCase)

def generatedVectorsDir : IO System.FilePath := do
  let appPath ← IO.FS.realPath (← IO.appPath)
  let some formalDir := appPath.parent.bind (fun binDir =>
      binDir.parent.bind (fun buildDir =>
        buildDir.parent.bind (fun lakeDir => lakeDir.parent)))
    | throw <| IO.userError s!"could not locate formal directory from executable path: {appPath}"
  pure <| formalDir / ".." / "docs" / "current" / "formal" / "generated-vectors"

end Scripts.EmitTestVectors

def vectorOutputs (outDir : System.FilePath) : List (System.FilePath × String) := [
  (outDir / "verification-summary-cases.json", Scripts.EmitTestVectors.summaryCasesJson),
  (outDir / "verification-display-cases.json", Scripts.EmitTestVectors.displayCasesJson),
  (outDir / "check-definitions.json", Scripts.EmitTestVectors.checkDefinitionsJson),
  (outDir / "input-commitment-cases.json", Scripts.EmitTestVectors.inputCommitmentCasesJson),
  (outDir / "bitmap-cases.json", Scripts.EmitTestVectors.bitmapCasesJson),
  (outDir / "guest-model-cases.json", Scripts.EmitTestVectors.guestModelCasesJson)
]

def findArgValue (name : String) : List String -> Option String
  | [] => none
  | arg :: value :: rest => if arg = name then some value else findArgValue name (value :: rest)
  | _ :: rest => findArgValue name rest

def checkVectorOutput (path : System.FilePath) (expected : String) : IO Unit := do
  let current ← IO.FS.readFile path
  if current = expected then
    pure ()
  else
    throw <| IO.userError s!"formal vector is stale; run pnpm formal:vectors: {path}"

def main (args : List String) : IO Unit := do
  let outDir ← match findArgValue "--out-dir" args with
    | some path => pure (System.FilePath.mk path)
    | none => Scripts.EmitTestVectors.generatedVectorsDir
  if args.contains "--check" then
    for output in vectorOutputs outDir do
      checkVectorOutput output.fst output.snd
    IO.println s!"formal vectors are fresh: {outDir}"
  else
    IO.FS.createDirAll outDir
    for output in vectorOutputs outDir do
      IO.FS.writeFile output.fst output.snd
