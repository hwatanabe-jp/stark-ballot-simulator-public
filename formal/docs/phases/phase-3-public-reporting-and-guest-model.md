# Phase 3: Public Reporting and Guest Model

> Status: completed in commit `491afb87`. The abstract guest fold in
> `StarkBallotFormal/GuestModel.lean`, the four required theorems plus
> supporting fold invariants and ordering lemmas, the stable
> `docs/current/formal/formal-report.json`, the `formal:report` /
> `formal:report:check` / `formal:verify` scripts, and the schema test in
> `scripts/__tests__/formal-report.test.ts` are all in place. Follow-up CI
> integration uses dedicated formal workflows rather than adding Lean to the
> broad `ci:verify` path.

## Purpose

Promote the formal layer from internal proof files into public, auditable
project evidence, then add the challenge-track guest model if the earlier
models are stable.

This phase combines formal reporting, CI integration, and the abstract zkVM
guest tally model.

## Implementation Sources

- `formal/StarkBallotFormal/*.lean`
- `zkvm/methods/guest/src/main.rs`
- `docs/current/verification/README.md`
- package scripts in `package.json`

## Deliverables

- `formal/StarkBallotFormal/GuestModel.lean`
- `formal/Scripts/EmitFormalReport.lean`
- theorem: `accepted_votes_count_tally`
- theorem: `valid_votes_count_accepted`
- theorem: `rejected_records_classification`
- theorem: `zero_exclusion_guest_model_complete`
- `docs/current/formal/formal-report.json`
- package scripts: `formal:report` and `formal:verify`
- dedicated CI integration for `formal:verify` after Lean installation and
  vector consumption are stable

## Guest Model

Do not translate Rust directly into Lean. Define an abstract guest state machine
as a fold over presented records.

Record model:

```text
Vote:
  index
  choice
  commitment
  random
  commitmentOk
  inclusionOk
```

State model:

```text
GuestState:
  seenIndices
  seenCommitments
  includedBitmap
  validVotes
  rejectedRecords
  rejectedReasons
  verifiedTally
```

`rejectedRecords` may be a scalar count, but the model must also retain enough
classification data to prove and report `rejected_records_classification`. Use a
reason list or reason-indexed counts rather than deriving all rejected behavior
from the scalar count alone.

The model must preserve the current implementation ordering:

```text
1. out-of-range index is rejected
2. duplicate index is rejected
3. first in-range index marks the slot as seen
4. invalid choice is rejected
5. invalid commitment is rejected
6. duplicate commitment is rejected
7. first computed commitment is inserted before inclusion proof
8. invalid inclusion proof is rejected
9. accepted vote increments tally and included bitmap
```

This ordering matters because records can be rejected after their slot is marked
as seen, which affects `invalidPresentedSlots`, and because the first record
with a valid computed commitment reserves that commitment before inclusion proof
verification.

## Formal Report

The stable checked-in report should avoid volatile fields such as `generatedAt`
or `repoCommit`.

Stable formal artifacts should live under `docs/current/formal/` so they follow
the repository's existing current-vs-archive documentation map. If a future
change intentionally uses a top-level `docs/formal/` directory, update
`docs/README.md` in the same change.

Example:

```json
{
  "schema": "stark-ballot:formal-report|v1",
  "leanToolchain": "leanprover/lean4:<pinned-version>",
  "theorems": [
    {
      "name": "excluded_zero_implies_no_slot_loss",
      "source": "formal/StarkBallotFormal/JournalCounts.lean",
      "claim": "excludedSlots = 0 implies no missing or invalid-presented slots"
    }
  ],
  "assumptions": [
    "SHA-256 collision resistance is assumed, not proved",
    "RISC Zero receipt soundness is assumed, not proved",
    "Rust and TypeScript implementation correspondence is checked by generated vectors and tests"
  ]
}
```

CI-only run reports may include `repoCommit`, `generatedAt`, and the SHA-256
digest of the stable report.

## CI Integration

Keep `formal:verify` out of the broad `ci:verify` script until:

- Lean installation requirements are documented.
- CI environment has Lean/Lake available via `elan` and the repository-pinned
  `formal/lean-toolchain`.
- Generated vectors are consumed by at least one TypeScript or Rust test.

The current integration point is a dedicated formal workflow for private CI and
the generated public snapshot CI. If this check later needs to become part of
the monolithic local gate, prepend it to the existing `ci:verify` script:

```text
pnpm formal:verify && pnpm format:check && pnpm lint && pnpm type-check && pnpm test:run && pnpm test:e2e:axe && pnpm test:e2e:mock
```

## Acceptance

```bash
(cd formal && lake build)
pnpm formal:report
pnpm formal:verify
```

Acceptance criteria:

- The guest model explicitly covers duplicate index semantics.
- The guest model explicitly covers invalid presented slot semantics.
- The guest model retains rejection classifications, not only a total rejected
  record count, so `rejected_records_classification` is inspectable.
- `formal:report` regenerates the stable checked-in report.
- `formal:verify` checks the Lean build, report generation, and any stable
  generated vectors included in the formal layer.
- The report lists theorem claims and assumptions.
- The checked-in report schema is exercised by either `formal:verify` or a
  targeted fixture/schema test, so a missing or stale report cannot satisfy this
  phase by accident.
- Public documentation distinguishes the abstract guest model from direct Rust
  verification.
- No public-facing claim says Lean proves cryptographic soundness or production
  election security.
