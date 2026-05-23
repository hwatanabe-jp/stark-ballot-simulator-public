import StarkBallotFormal.Bitmap
import StarkBallotFormal.GuestModel
import StarkBallotFormal.InputCommitment
import StarkBallotFormal.VerificationSummary

namespace Scripts.EmitFormalReport

def hexDigitString : Nat -> String
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
  | 15 => "f"
  | _ => "0"

def jsonUnicodeEscape (code : Nat) : String :=
  "\\u" ++
    hexDigitString ((code / 4096) % 16) ++
    hexDigitString ((code / 256) % 16) ++
    hexDigitString ((code / 16) % 16) ++
    hexDigitString (code % 16)

def jsonEscapedChar : Char -> String
  | '"' => "\\\""
  | '\\' => "\\\\"
  | '\n' => "\\n"
  | '\r' => "\\r"
  | '\t' => "\\t"
  | c =>
      if c.toNat < 32 then
        jsonUnicodeEscape c.toNat
      else
        c.toString

def jsonString (value : String) : String :=
  "\"" ++ String.intercalate "" (value.toList.map jsonEscapedChar) ++ "\""

def jsonArray (items : List String) : String :=
  "[\n" ++ String.intercalate ",\n" items ++ "\n  ]"

def jsonObjectBody (fields : List String) : String :=
  String.intercalate ",\n" fields

structure TheoremReport where
  name : String
  source : String
  claim : String

def renderStringArray (values : List String) : String :=
  jsonArray (values.map (fun value => "    " ++ jsonString value))

def renderTheorem (theoremReport : TheoremReport) : String :=
  "    {\n" ++ jsonObjectBody [
    "      \"name\": " ++ jsonString theoremReport.name,
    "      \"source\": " ++ jsonString theoremReport.source,
    "      \"claim\": " ++ jsonString theoremReport.claim
  ] ++ "\n    }"

def theoremReports : List TheoremReport := [
  {
    name := "excluded_zero_implies_no_slot_loss"
    source := "formal/StarkBallotFormal/JournalCounts.lean"
    claim := "excludedSlots = 0 implies both missingSlots and invalidPresentedSlots are zero in the Nat count model"
  },
  {
    name := "slot_partition_total"
    source := "formal/StarkBallotFormal/JournalCounts.lean"
    claim := "under the slot partition definitions, excludedSlots = 0 forces seenIndicesCount = treeSize and validVotes = treeSize"
  },
  {
    name := "fully_verified_implies_all_required_success"
    source := "formal/StarkBallotFormal/VerificationSummary.lean"
    claim := "the summary model can return fully_verified only when every required check succeeds"
  },
  {
    name := "fully_verified_implies_no_unknown_checks"
    source := "formal/StarkBallotFormal/VerificationSummary.lean"
    claim := "the summary model can return fully_verified only when no unknown checks are present"
  },
  {
    name := "fully_verified_implies_required_roles_success"
    source := "formal/StarkBallotFormal/VerificationSummary.lean"
    claim := "proof verification, tally completeness, and user inclusion roles must all succeed for fully_verified"
  },
  {
    name := "canonical_vote_order_total"
    source := "formal/StarkBallotFormal/InputCommitment.lean"
    claim := "the abstract input-commitment vote ordering relation is total"
  },
  {
    name := "canonical_encoding_permutation_invariant"
    source := "formal/StarkBallotFormal/InputCommitment.lean"
    claim := "canonical input-commitment encoding is invariant under permutation of the modeled vote encodings"
  },
  {
    name := "pack_bits_length"
    source := "formal/StarkBallotFormal/Bitmap.lean"
    claim := "LSB-first bitmap packing emits exactly ceil(bitLength / 8) bytes"
  },
  {
    name := "pack_bits_get_bit"
    source := "formal/StarkBallotFormal/Bitmap.lean"
    claim := "for in-range bits, unpacking the modeled packed byte at i / 8 and i % 8 returns the source bit"
  },
  {
    name := "accepted_votes_count_tally"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "the abstract guest fold keeps the candidate-indexed tally total equal to validVotes"
  },
  {
    name := "acceptVote_increments_selected_candidate"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "accepting a well-formed vote increments the candidate bucket selected by the vote choice"
  },
  {
    name := "valid_votes_count_accepted"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "the abstract guest fold's validVotes count equals the stateful accepted-record count"
  },
  {
    name := "rejected_records_classification"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "rejectedRecords equals the length of the retained rejection-reason classification list"
  },
  {
    name := "duplicate_index_rejected_before_marking"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "a duplicate in-range index is rejected before the presented slot is marked again"
  },
  {
    name := "invalid_choice_marks_seen_slot"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "a fresh in-range record with an invalid choice marks the slot as seen but does not increment validVotes"
  },
  {
    name := "invalid_inclusion_reserves_commitment"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "a record with a valid fresh computed commitment reserves that commitment before inclusion-proof rejection"
  },
  {
    name := "processVotes_fold_invariant"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "the abstract guest fold preserves duplicate-free seen indices, in-range seen indices, and validVotes <= seen-index count"
  },
  {
    name := "processVotes_seen_indices_length_le_treeSize"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "duplicate-free in-range seen indices produced by the guest fold cannot exceed treeSize"
  },
  {
    name := "zero_exclusion_guest_model_complete"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "excludedSlots = 0 over processVotes forces the fold output to have no missing slots and no invalid presented slots"
  },
  {
    name := "no_overflow_under_guest_bounds"
    source := "formal/StarkBallotFormal/GuestModel.lean"
    claim := "under explicit guest tree-size, vote-count, and candidate tally-bucket bounds of 1,000,000, modeled seen, valid, rejected, and candidate tally bucket counts remain inside the Rust u32 domain"
  }
]

def assumptions : List String := [
  "SHA-256 collision resistance is assumed, not proved by Lean",
  "RISC Zero receipt soundness is assumed, not proved by Lean",
  "Rust and TypeScript implementation correspondence is checked by generated vectors and tests",
  "The guest model is an abstract state machine over presented records, not a direct Rust verification",
  "Rust bounded-counter correspondence is claimed only for accepted guest inputs satisfying the explicit Phase 4 guest bounds: treeSize <= 1,000,000, vote count <= 1,000,000, and each candidate tally bucket <= 1,000,000"
]

def nonClaims : List String := [
  "Lean does not prove SHA-256 collision resistance",
  "Lean does not prove RISC Zero receipt soundness",
  "Lean does not prove AWS runtime behavior",
  "Lean does not prove React rendering behavior",
  "Lean does not prove production-election security"
]

def generatedVectorArtifacts : List String := [
  "docs/current/formal/generated-vectors/verification-summary-cases.json",
  "docs/current/formal/generated-vectors/verification-display-cases.json",
  "docs/current/formal/generated-vectors/check-definitions.json",
  "docs/current/formal/generated-vectors/input-commitment-cases.json",
  "docs/current/formal/generated-vectors/bitmap-cases.json",
  "docs/current/formal/generated-vectors/guest-model-cases.json"
]

def formalReportJson : String :=
  "{\n" ++ jsonObjectBody [
    "  \"schema\": " ++ jsonString "stark-ballot:formal-report|v1",
    "  \"leanToolchain\": " ++ jsonString "leanprover/lean4:v4.29.1",
    "  \"reportKind\": " ++ jsonString "stable",
    "  \"modelModules\": " ++ renderStringArray [
      "formal/StarkBallotFormal/JournalCounts.lean",
      "formal/StarkBallotFormal/VerificationSummary.lean",
      "formal/StarkBallotFormal/InputCommitment.lean",
      "formal/StarkBallotFormal/Bitmap.lean",
      "formal/StarkBallotFormal/GuestModel.lean"
    ],
    "  \"theorems\": " ++ jsonArray (theoremReports.map renderTheorem),
    "  \"generatedVectorArtifacts\": " ++ renderStringArray generatedVectorArtifacts,
    "  \"formalAuditArtifact\": " ++ jsonString "docs/current/formal/formal-audit.json",
    "  \"assumptions\": " ++ renderStringArray assumptions,
    "  \"nonClaims\": " ++ renderStringArray nonClaims
  ] ++ "\n}\n"

def formalReportPath : IO System.FilePath := do
  let appPath ← IO.FS.realPath (← IO.appPath)
  let some formalDir := appPath.parent.bind (fun binDir =>
      binDir.parent.bind (fun buildDir =>
        buildDir.parent.bind (fun lakeDir => lakeDir.parent)))
    | throw <| IO.userError s!"could not locate formal directory from executable path: {appPath}"
  pure <| formalDir / ".." / "docs" / "current" / "formal" / "formal-report.json"

def checkFormalReport (outPath : System.FilePath) : IO Unit := do
  let current ← IO.FS.readFile outPath
  if current = formalReportJson then
    IO.println s!"formal report is fresh: {outPath}"
  else
    throw <| IO.userError s!"formal report is stale; run pnpm formal:report"

end Scripts.EmitFormalReport

def main (args : List String) : IO Unit := do
  let outPath ← Scripts.EmitFormalReport.formalReportPath
  if args.contains "--check" then
    Scripts.EmitFormalReport.checkFormalReport outPath
  else
    if let some parent := outPath.parent then
      IO.FS.createDirAll parent
    IO.FS.writeFile outPath Scripts.EmitFormalReport.formalReportJson
