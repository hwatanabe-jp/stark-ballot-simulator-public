# Current Contract Ballot Evaluation Semantics Plan

> **Status: implemented (commit `cd64efe`).** This document defines the
> current proof-bound ballot evaluation vocabulary and the slot-versus-
> record semantics that the surviving guest, host, and mock paths must
> share. It is a current-contract decision record plus convergence plan,
> not a public API change log.

## Purpose

This document defines the current ballot evaluation semantics that sit
under the boundary, authority, public-contract, and canonical-cleanup
work from the first four plans.

Its job is to make one current meaning explicit for:

- which presented records are counted
- which presented records are rejected
- which bulletin slots are counted, invalid-presented, or missing
- which counts are proof-bound authority versus derived compatibility
  mirrors

The repository already has a current proof-bound journal contract and a
shared Rust contract core for several lower-level helpers and contract-
critical types. What remains easy to misread is the evaluation state
machine that turns presented records into tally counts, slot
classifications, and bitmap roots.

This document exists to keep that state machine explicit and to prevent
guest, host, and mock paths from silently drifting into parallel
semantics.

## This Doc Decides

- the canonical current vocabulary for counted, rejected, missing,
  invalid-presented, duplicate, and excluded outcomes
- how record-level and slot-level outcomes are derived from the same
  presented input
- the current proof-bound owner for ballot evaluation semantics
- which journal fields are authoritative for those semantics
- how exact bitmap artifacts and compatibility mirrors relate to that
  proof-bound owner

## This Doc Does Not Decide

- the `contractGeneration` boundary or stale-state model
- public route shapes, bundle delivery, or browser restore behavior
- the standalone verifier packaging or CLI surface
- the eventual extraction vehicle for a shared ballot-evaluation helper
  if one is introduced later
- broad CI or evidence policy beyond the invariants directly attached to
  the current ballot evaluation semantics

## Current Repository Interpretation

### Guest Journal Already Owns The Current Proof-Bound Counts

- The guest `verify_and_tally(...)` path is the current proof-bound
  owner for ballot evaluation semantics.
- The guest evaluates, in order:
  index range, duplicate index, choice range, commitment match,
  duplicate commitment, and RFC 6962 inclusion proof validity.
- The guest journal then commits the current authoritative count and
  bitmap-root fields:
  `verified_tally`, `valid_votes`, `invalid_votes`,
  `seen_indices_count`, `missing_slots`, `invalid_presented_slots`,
  `rejected_records`, `seen_bitmap_root`, `included_bitmap_root`, and
  `excluded_slots`.

### Host Consumes Guest Output And Derives Exact Bitmap Artifacts

- The host may reconstruct exact `seen` and `included` bitmaps from the
  same input records, but those artifacts remain subordinate to the
  guest journal.
- Host-side bitmap artifacts are only valid current support artifacts
  when their recomputed roots match the proof-bound roots in the guest
  output.
- When those recomputed roots do not match, the host must not publish
  the exact bitmap artifact as current-valid support data for that run.
- Host code must not invent alternate count semantics or repair guest
  counts from artifact-side heuristics.

### Mock Shares The Current Vocabulary But Not Yet The Full Cryptographic Path

- The TypeScript mock executor already mirrors the current slot/record
  vocabulary and the main count invariants.
- The mock still simplifies some cryptographic behavior today,
  especially inclusion-proof verification and bitmap-root construction.
- Those simplifications are implementation residue, not an alternate
  current contract. They must not justify different slot or record
  semantics from the guest-owned model.

## Canonical Ballot Evaluation Model

### One Input Produces Both Record And Slot Outcomes

- The input to ballot evaluation is the ordered list of presented
  `votes` inside the zkVM input.
- The current contract intentionally tracks both record-level and
  slot-level outcomes because they answer different questions.
- Record-level outcomes explain what happened to each presented record.
- Slot-level outcomes explain whether each bulletin slot ended up
  counted, invalid-presented, or missing in the proof-bound tally.

### Record Admission Order

For the current contract, each presented record is evaluated in this
order:

1. index range
2. duplicate index
3. choice range
4. commitment match
5. duplicate commitment
6. inclusion proof validity
7. counted

The order matters because later checks are only meaningful after earlier
checks admit the record far enough into the current model.

### Record-Level Outcomes

- A record is **counted** only when it passes every evaluation step and
  contributes one tally unit for its choice.
- A record is **rejected** when it fails any current evaluation step.
- Out-of-range records are rejected immediately and do not create a seen
  slot.
- Duplicate-index records are rejected immediately and do not create a
  second slot-level failure for that index.
- A unique in-range record that later fails choice, commitment,
  duplicate-commitment, or inclusion-proof checks is still a rejected
  record.

### Slot-Level Outcomes

- The current contract treats bulletin slots in `[0, treeSize)` as the
  canonical slot universe.
- A slot becomes **seen** when the first in-range, non-duplicate-index
  record claims it.
- A seen slot becomes **counted** when that first admitted record passes
  all later checks and is included in the tally.
- A seen slot becomes **invalid-presented** when that first admitted
  record exists but fails a later current check.
- A slot is **missing** when no first admitted in-range record ever
  claims it.

### Duplicate Index And Out-of-Range Records Do Not Inflate Slot Failures

- Duplicate-index records are record-level rejections, but they do not
  create additional seen slots.
- Out-of-range records are record-level rejections, but they do not
  correspond to any slot in the current slot universe.
- Because of that, duplicate-index and out-of-range rejections may
  increase `rejected_records` without increasing
  `invalid_presented_slots`.

### Duplicate Commitment And Other In-Range Failures Do Create Slot Failures

- A duplicate commitment on a different unique in-range slot is a
  record-level rejection and also leaves that slot in the
  invalid-presented state.
- The same is true for invalid choice, commitment mismatch, or failed
  inclusion proof after the slot has been admitted as the first
  in-range, non-duplicate-index record for that slot.

## Count Semantics And Invariants

### Current Count Meanings

- `total_votes` is the number of presented input records.
- `valid_votes` is the number of counted slots.
- `invalid_votes` is the number of rejected records in the current guest
  journal layout.
- `seen_indices_count` is the number of unique in-range slots claimed at
  least once by a first admitted record.
- `missing_slots` is the number of slots in `[0, treeSize)` that were
  never seen.
- `invalid_presented_slots` is the number of seen slots that were not
  counted.
- `rejected_records` is the number of rejected records, including
  duplicate-index and out-of-range records.
- `excluded_slots` is the slot-based exclusion count used downstream by
  verification logic.

### Current Invariants

The current ballot evaluation semantics require these invariants:

- `total_votes = valid_votes + rejected_records`
- `valid_votes + invalid_presented_slots + missing_slots = tree_size`
- `excluded_slots = missing_slots + invalid_presented_slots`
- `rejected_records >= invalid_presented_slots`
- `invalid_votes = rejected_records` for the current guest journal
  layout
- counted slots are a subset of seen slots
- the `included` bitmap is a subset of the `seen` bitmap

### Downstream Meaning Of Exclusions

- `excluded_slots > 0` is the proof-bound source of a downstream
  exclusion failure.
- Compatibility mirrors may rename or project that signal, but they must
  not change its slot-based meaning.

## Canonical Owner And Consumer Roles

### Current Proof-Bound Owner

- The current proof-bound owner is the guest ballot evaluation path plus
  the committed `VerificationOutput`.
- Future refactoring may extract the same semantics into a shared owner,
  but that extraction must preserve the guest-defined current behavior
  rather than redefining it.

### Convergence Direction After The Vocabulary Is Locked

- The next convergence target is to shrink duplicated ballot-evaluation
  logic, not to introduce a second semantic owner beside the guest.
- Any later shared extraction should let guest and host consume the same
  ballot-evaluation result shape for count semantics, while preserving
  the guest journal as the proof-bound authority.
- Property or compatibility tests that exercise ballot evaluation should
  prefer the surviving semantic owner rather than preserve duplicate
  evaluator behavior indefinitely.

### Host Role

- The host consumes the proof-bound output and may derive exact bitmap
  artifacts from the same presented records.
- Host-side exact artifacts are evidence for explainability and support
  routes, not alternate count authority.
- Host code must refuse to treat recomputed exact bitmap artifacts as
  current-valid support data when their roots disagree with the proof-
  bound guest output.

### Mock Role

- The mock executor may simulate receipt generation and other non-proof
  mechanics for local development and tests.
- The mock must still preserve the current slot-versus-record
  classification model and the current invariants.
- Mock-specific shortcuts must not become alternate semantics owners for
  ballot evaluation.
- Mock-path simplifications should shrink toward "same ballot-evaluation
  semantics, different receipt-production path" rather than remain a
  long-term excuse for divergent count behavior.

## Proof-Bound Outputs Versus Compatibility Projections

### Proof-Bound Current Outputs

For ballot evaluation semantics, the proof-bound current outputs are the
guest journal fields that directly express tally, slot state, or bitmap
state:

- `verified_tally`
- `valid_votes`
- `invalid_votes`
- `seen_indices_count`
- `missing_slots`
- `invalid_presented_slots`
- `rejected_records`
- `seen_bitmap_root`
- `included_bitmap_root`
- `excluded_slots`

### Compatibility Mirrors

- Compatibility mirrors such as `missingIndices`, `invalidIndices`,
  `countedIndices`, and `excludedCount` remain derived projections from
  the current journal semantics.
- For the current contract, that mirror mapping is fixed:
  `missingIndices -> missing_slots`,
  `invalidIndices -> invalid_presented_slots`,
  `countedIndices -> valid_votes`, and
  `excludedCount -> excluded_slots`.
- In particular, `invalidIndices` is not a mirror of
  `rejected_records`.
- Those fields may remain useful at boundaries while current consumers
  are still being simplified, but they do not own ballot evaluation
  semantics.
- No current supported flow should reinterpret guest semantics by
  preferring a compatibility mirror over the proof-bound journal field
  it mirrors.

## Mock And Tooling Alignment Rules

- Tooling may reconstruct or inspect ballot evaluation outputs, but it
  must derive them from the current slot-versus-record model.
- Simplified mock proof acceptance does not authorize simplified count
  semantics.
- Bitmap reconstruction helpers remain subordinate to proof-bound guest
  roots and must refuse current-valid artifact output on mismatch.
- If a later shared ballot-evaluation helper is introduced, it must be
  measured against the guest-owned current semantics rather than against
  looser mock behavior.

## Migration Direction

- Keep the current vocabulary explicit in tests and docs before moving
  duplicate evaluators.
- Reduce duplicate evaluators by converging them on the guest-owned
  semantics, not by adding fresh adapter semantics between guest, host,
  and mock paths.
- Prefer shrinking semantic duplication over adding fresh compatibility
  names.
- Do not reopen the public route contract or generation boundary as
  part of this work.
- Promote any counterexample found in current ballot evaluation
  invariants into regression coverage before later cleanup obscures the
  original drift.
- If ballot evaluation semantics change the meaning of committed guest
  journal fields or their derived invariants, treat that as a proof-
  semantic contract change and update guest-facing vectors, fixtures,
  and method-version or ImageID coordination together rather than as a
  mock-only cleanup.

## Evidence Expectations

- Guest-owned regression coverage should keep duplicate-index and out-
  of-range records on the record-rejection path without inflating
  `invalid_presented_slots`.
- Guest-owned regression coverage should also keep unique in-range
  failures such as invalid choice, commitment mismatch, duplicate
  commitment, or failed inclusion proof on the slot-failure path.
- Mock parity or property coverage should continue to enforce the slot
  partition and rejection invariants:
  `total_votes = valid_votes + rejected_records`,
  `valid_votes + invalid_presented_slots + missing_slots = tree_size`,
  `excluded_slots = missing_slots + invalid_presented_slots`, and
  `rejected_records >= invalid_presented_slots`.
- Host-side coverage should keep exact seen or included bitmap artifacts
  subordinate to the guest journal by suppressing artifact publication
  when recomputed roots do not match the proof-bound roots.

## Completion Criteria

- one explicit current ballot evaluation vocabulary exists for guest,
  host, and mock paths
- record-space and slot-space invariants are explicit and locked for the
  current contract
- duplicate-index and out-of-range records do not inflate slot-based
  exclusion counts
- unique in-range failures such as invalid choice, commitment mismatch,
  duplicate commitment, or failed proof do produce slot-level invalid-
  presented outcomes
- exact bitmap artifacts stay subordinate to the guest journal and are
  accepted only when their roots match
- compatibility mirrors remain derived boundary fields rather than
  alternate authorities for current ballot evaluation semantics
- compatibility alias mapping is explicit, one-way, and does not
  reinterpret `invalidIndices` as `rejected_records`

## Deliberate Omissions

This document intentionally does not become:

- a route contract inventory
- a bundle or download design document
- a shared-helper extraction checklist
- a full CI policy document
