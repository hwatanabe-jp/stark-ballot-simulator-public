# Phase 4: Formal Correspondence Hardening

> Status: planned. This phase responds to Phase 3 external review feedback: the
> formal layer is already connected to CI, generated reports, and
> TypeScript/Rust vector tests, but the abstract guest model, integer-bound
> assumptions, proof hygiene, and drift guards need stronger implementation
> correspondence before the public claim should be made stronger.

## Purpose

Harden the Phase 1-3 formal layer from "Lean models with generated vectors" into
a more explicit implementation-correspondence system.

The main goal is not to claim full formal verification of the deployed voting
application. The goal is to make model-to-implementation drift easier to detect,
especially for the abstract guest tally model and the fail-closed verification
surface.

## Review Baseline

The Phase 3 review did not find that the Lean files are merely decorative:

- `formal/` is a Lake workspace.
- `formal:*` scripts exist in `package.json`.
- dedicated formal CI runs `pnpm formal:verify`.
- `docs/current/formal/formal-report.json` is generated and checked.
- summary, display, input-commitment, and bitmap vectors are consumed by
  TypeScript and Rust tests.

The remaining risk is narrower:

- `GuestModel.lean` is currently connected to the formal report, but it does not
  yet emit generated vectors consumed by Rust guest-equivalence tests.
- the Lean count and guest models use mathematical `Nat` values, while the Rust
  guest uses bounded integer counters and some saturating arithmetic.
- CI path filters do not yet cover every implementation file that formal
  vectors are intended to guard.
- proof hygiene and theorem dependency checks are documented, but not fully
  enforced by scripts.
- formal report claim text is inspectable, but still partly hand-maintained.

## Implementation Sources

- `formal/StarkBallotFormal/*.lean`
- `formal/Scripts/EmitTestVectors.lean`
- `formal/Scripts/EmitFormalReport.lean`
- `zkvm/methods/guest/src/main.rs`
- `zkvm/contract-core/src/encoding.rs`
- `zkvm/contract-core/src/bitmap.rs`
- `src/lib/zkvm/types.ts`
- `src/lib/zkvm/bitmap.ts`
- `src/lib/merkle/bitmap-merkle-tree.ts`
- `src/lib/verification/verification-checks.ts`
- `src/lib/verification/verification-summary.ts`
- `src/app/(routes)/verify/lib/overall-status.ts`
- `.github/workflows/public-formal-checks.yml`
- the public workflow generator
- the public export tests
- `docs/current/formal/README.md`

## Deliverables

- generated `docs/current/formal/generated-vectors/guest-model-cases.json`
- Rust test coverage that consumes `guest-model-cases.json`
- a narrow guest-equivalent pure test surface for rejection classification if
  the current guest entry point cannot expose those classifications directly
- formal bounds contract for guest counters and input sizes
- Rust fail-closed validation or checked arithmetic for those bounds
- theorem: `no_overflow_under_guest_bounds` or an equivalent Nat-to-bounded
  correspondence theorem
- package script: `formal:audit`
- `formal:verify` includes `formal:audit`
- formal CI path filters include all implementation files guarded by formal
  vectors
- TS/Lean drift guard for verification check definitions
- explicit handling of summary `null`, empty, and all-unknown cases
- enriched formal report or audit artifact with theorem/audit/vector freshness
  data
- public documentation table separating `proved`, `vector-tested`, `assumed`,
  and `not claimed`

## Non-Goals

Phase 4 still does not prove:

- SHA-256 collision resistance
- RISC Zero receipt soundness
- Rust compiler correctness
- the deployed AWS runtime
- React rendering correctness as a whole
- full production election security

Do not describe the outcome as "the voting system is formally verified." The
accurate claim is that selected safety models are proved in Lean and connected
to implementation tests through generated vectors and CI drift guards.

## P4-1: Formal CI Path Filters

Expand `.github/workflows/public-formal-checks.yml` so implementation files covered by
formal vectors trigger the formal workflow. Keep the generated public workflow
template in the public workflow generator aligned, because the public
snapshot emits `.github/workflows/public-formal-checks.yml` separately.

Path-filter coverage alone is not enough. The implementation-correspondence
tests that consume generated vectors must run in a clearly identified gate.
Choose one CI enforcement model:

```text
Option A: extend the formal workflow or `formal:verify` to run the targeted
TypeScript and Rust vector-consuming tests.

Option B: keep `formal:verify` focused on Lean/report/vector freshness, but
document and test that the core and Rust workflows are the enforcement point for
the same implementation files.
```

Do not claim that the formal workflow detects implementation drift unless it
actually executes the relevant vector-consuming tests or is paired with a
documented, path-filter-aligned implementation-test gate.

Add these path candidates unless the workflow is intentionally replaced by a
broader always-run formal check:

```text
src/lib/zkvm/types.ts
src/lib/zkvm/bitmap.ts
src/lib/merkle/bitmap-merkle-tree.ts
src/app/(routes)/verify/lib/overall-status.ts
zkvm/contract-core/src/encoding.rs
zkvm/contract-core/src/bitmap.rs
zkvm/methods/guest/src/main.rs
```

Acceptance criteria:

- changing the input-commitment encoder triggers the formal workflow
- changing bitmap packing or bitmap Merkle behavior triggers the formal workflow
- changing the verify page overall-status helper triggers display-vector checks
- changing Rust encoding, bitmap, or guest code triggers the formal workflow
- the CI plan identifies where each generated-vector consumer runs:
  summary/display TypeScript tests, input-commitment TypeScript and Rust tests,
  bitmap TypeScript and Rust tests, bitmap Merkle tests, and guest-model Rust
  tests
- if vector-consuming tests are not added to `formal:verify`, the core and Rust
  workflow path filters must be updated and tested so the same implementation
  files run the corresponding implementation tests
- the path list is duplicated consistently for `push` and `pull_request`, or is
  factored so the two triggers cannot drift
- the public export template emits matching formal path filters for the public
  snapshot, with export tests covering the generated workflow

## P4-2: Proof Hygiene Audit

Add a script that makes proof hygiene part of the formal gate instead of only a
manual review note.

The audit should check:

```text
formal/**/*.lean contains no `sorry`
formal/**/*.lean contains no unreviewed project-specific `axiom`
formal/**/*.lean contains no `admit`
formal/**/*.lean contains no `unsafe`
theorem dependency output is recorded or checked against an allowlist
`native_decide` dependencies are explicit and allowlisted
```

Use the narrowest robust implementation. A script may start with source scanning
and a checked allowlist artifact, then become more precise over time.

Acceptance criteria:

- `pnpm formal:audit` runs locally without requiring private state
- `pnpm formal:verify` includes `pnpm formal:audit`
- the audit permits expected Lean core axioms such as `propext`, `Quot.sound`,
  and the already documented `native_decide` dependency only where explicitly
  allowlisted
- any new hand-written project-specific axiom fails the audit unless it is
  deliberately added to the public assumptions and allowlist in the same change
- README axiom tables and the audit artifact cannot silently contradict each
  other

## P4-3: Guest Model Vectors

Extend `formal/Scripts/EmitTestVectors.lean` to emit:

```text
docs/current/formal/generated-vectors/guest-model-cases.json
```

The vectors should exercise the externally important guest ordering from
`GuestModel.lean`, especially the cases where a record is rejected after it has
already changed `seenIndices` or reserved a commitment.

Required cases:

| Case                            | Expected coverage                                                        |
| ------------------------------- | ------------------------------------------------------------------------ |
| `all-valid`                     | `validVotes = treeSize`, `excludedSlots = 0`                             |
| `missing-slot`                  | `missingSlots > 0`, `excludedSlots > 0`                                  |
| `out-of-range-index`            | rejection increases, `seenIndicesCount` does not                         |
| `duplicate-index`               | duplicate rejection, no double-counted seen slot                         |
| `invalid-choice`                | slot is seen, vote is not valid                                          |
| `invalid-commitment`            | slot is seen, commitment is not reserved                                 |
| `duplicate-commitment`          | duplicate commitment is rejected                                         |
| `invalid-inclusion-proof`       | commitment is reserved, vote is not valid                                |
| `extra-record-beyond-tree-size` | record rejection and slot exclusion remain distinct                      |
| `zero-exclusion-complete`       | `excludedSlots = 0` implies all slots are counted under guest invariants |

Rust should consume these vectors through an explicitly named inspection
surface. The plan for that surface must state which fields come from each layer:

- the checked production guest path used by `guest_main`, for journal/output
  fields that are already observable in `VerificationOutput`
- a production-shared classification surface, factored from the same vote-fold
  logic used by the checked guest path, for rejection classifications and any
  ordering state that `VerificationOutput` does not expose
- a production-shared bitmap/state snapshot, or a deliberately exposed
  diagnostic result from the same checked fold, for raw included-bitmap bits and
  intermediate state that cannot be recovered from bitmap Merkle roots alone

Avoid introducing a second Rust model that can agree with Lean while the actual
guest path drifts. Any pure helper should be a production-shared classification
or state-inspection surface, not a test-only reimplementation of the guest
ordering. If a helper exists only for tests, it is not sufficient for Phase 4
correspondence unless it is mechanically coupled to the production guest path in
a way that makes drift fail tests.

Rejection-classification and raw bitmap-bit assertions must be checked through
the explicit production-shared inspection surface. Do not infer
classifications from aggregate `verify_and_tally` counts, and do not infer raw
bitmap bits from roots, unless the production surface is deliberately changed to
expose those stable fields.

Acceptance criteria:

- Lean generates stable `guest-model-cases.json`
- `formal:vectors` writes and formats the new vector file
- `formal-report.json` lists the guest vector artifact
- Rust tests consume `guest-model-cases.json`
- tests compare `seenIndicesCount`, `missingSlots`, `invalidPresentedSlots`,
  `rejectedRecords`, rejection classifications, `excludedSlots`, tally, and
  included bitmap bits
- direct checked-guest-path tests cover all observable output fields represented
  by the vectors; non-observable classifications, bitmap bits, and intermediate
  state are covered only through a named production-shared inspection surface
- rejection classifications are compared through the explicit pure/testable
  classification surface, and that surface is production-shared or mechanically
  coupled to the production guest path
- all guest-vector tests exercise the same validation boundary used by
  `guest_main`, or a production-shared checked tally entry point that `guest_main`
  also uses, so direct helper tests cannot bypass the fail-closed contract
- the invalid-inclusion case checks the Phase 3 ordering claim that a fresh
  computed commitment is reserved before inclusion-proof rejection
- a deliberate Rust change that moves duplicate-index rejection after marking a
  slot causes a vector test failure

## P4-4: Guest Bounds and Rust `u32` Correspondence

Close the gap between the mathematical `Nat` model and Rust bounded counters.

The preferred approach is implementation guardrails plus a small formal
correspondence theorem:

```text
guest input bounds hold
counter increments remain below u32::MAX
Nat model transition = Rust bounded transition
```

Rust should fail closed when the formal bounds are violated. Prefer explicit
validation and `checked_add`-style behavior for guest counters where practical.
If `saturating_add` remains, document why it is unreachable under the validated
bounds and test the boundary behavior.

The bounds check must be part of the same checked tally entry point exercised by
`guest_main` and the Phase 4 guest-vector tests. Adding validation only as a
standalone helper is not sufficient if correspondence tests can still call
unchecked tally logic that uses saturating arithmetic or lossy casts internally.
If lower-level helpers remain directly testable, their tests must either call
the checked wrapper or be explicitly scoped to implementation internals rather
than satisfying the formal correspondence contract.

Acceptance criteria:

- guest input validation states the maximum supported `treeSize`, vote count,
  and tally count for the formal correspondence claim
- production guest execution and guest-vector/boundary tests go through the same
  checked validation-and-tally path, or through a production-shared checked
  entry point used by both
- Rust guest counters cannot silently saturate under accepted inputs
- conversions such as vote count to `u32` are checked before accepted inputs can
  produce journal fields
- Lean includes `no_overflow_under_guest_bounds` or an equivalent theorem
- the theorem connects the relevant `Nat` counts to the bounded Rust domain
- `formal-report.json` removes the broad "Rust u32 overflow behavior is not
  proved" assumption or narrows it to the remaining non-claim
- boundary tests confirm oversized inputs fail closed rather than producing a
  misleading successful verification result

## P4-5: Verification Check Definition Drift Guard

Prevent Lean and TypeScript check definitions from drifting independently.

Choose one approach:

```text
Option A: Lean emits check-definitions.json and TypeScript tests compare it with
VERIFICATION_CHECK_DEFINITIONS.

Option B: a shared JSON file becomes the source of truth, with Lean and
TypeScript both validating against it.
```

The first pass should prefer Option A unless the shared-source migration is
small and clearly reduces maintenance risk.

The first pass is scoped to the summary-model fields currently represented in
Lean: ID, category, role, default criticality, and the
`recorded_sth_third_party` promotion behavior. TypeScript-only definition fields
such as `evidence`, `inputs`, and `derivedFrom` remain outside this drift guard
unless the formal summary model is deliberately expanded.

Acceptance criteria:

- check ID, category, role, and default criticality are compared mechanically
- `recorded_sth_third_party` promotion behavior is covered
- changing a TypeScript check definition without updating the formal side fails
  a formal or targeted test
- changing the Lean check definition without updating TypeScript fails a formal
  or targeted test
- documentation states which artifact is the current source of truth

## P4-6: Summary `null`, Empty, and Unknown Cases

Make the remaining difference between the Lean summary model and the TypeScript
`deriveVerificationSummary` API explicit.

TypeScript returns `null` only when no known checks can be resolved:

```text
empty checks
only unknown checks
```

If at least one known check is present, including optional-known-plus-unknown or
known checks with no required known checks, the API should produce a non-null
warning result rather than `null`.

Choose one approach:

```text
Option A: change the Lean model to return `Option SummaryStatus`.

Option B: keep the Lean theorem scoped to non-empty known checks and add
explicit TypeScript-only vectors/tests for the null cases.
```

Acceptance criteria:

- empty checks are covered by tests
- all-unknown checks are covered by tests
- optional-known-plus-unknown behavior is covered by tests and remains non-null
- known-checks-with-no-required-known behavior is covered by tests and remains
  non-null
- docs state whether the Lean model covers these cases directly or treats them
  as an API-boundary precondition
- none of these cases can render the verify page overall status as `verified`
- focused page-level tests, or tests for a helper extracted from
  `src/app/(routes)/verify/page.tsx`, cover the real user-facing `verified`
  rendering gate that combines summary status with explicit proof failures,
  hard-failure checks, pending state, and render timing

## P4-7: Formal Report Claim Drift

Strengthen `formal-report.json` so it is harder for claim text and theorem
statements to drift.

Add at least one theorem-statement/source binding:

- theorem statement hash
- theorem source snippet hash

Additional useful freshness data may include:

- generated vector artifact hashes
- proof hygiene audit summary
- explicit `proved`, `vector-tested`, `assumed`, and `not claimed` categories

Acceptance criteria:

- changing a theorem statement requires regenerating the report or audit
  artifact
- changing generated vectors requires regenerating the report or vector hash
  artifact, if hashes are adopted
- claim text changes remain reviewable as claim changes, not hidden formatting
  churn
- public documentation includes a compact table distinguishing what Lean proves,
  what vectors test, what is assumed, and what is out of scope

## Portfolio Claim Guidance

Preferred wording after Phase 4:

```text
Lean 4 models prove selected fail-closed verification-summary, journal-count,
canonical input-encoding, bitmap-packing, and abstract guest tally invariants.
Lean-generated vectors are consumed by TypeScript and Rust tests, including
guest-model correspondence cases, so CI can detect drift between the formal
models and the implementation surfaces they are intended to guard. SHA-256,
RISC Zero soundness, runtime infrastructure, UI rendering as a whole, and
production election security remain explicit assumptions or non-claims.
```

Avoid:

```text
The whole voting system is formally verified.
The Rust zkVM guest is completely proved correct in Lean.
Lean proves RISC Zero proof soundness.
```

## Acceptance

```bash
pnpm formal:audit
pnpm formal:vectors
pnpm formal:report
pnpm formal:verify
pnpm test:run
```

If Rust guest or contract-core code changes, prefer the repository-supported
workspace-level zkVM checks used by CI:

```bash
cargo fmt --all --manifest-path zkvm/Cargo.toml --check
cargo +risc0 clippy --manifest-path zkvm/Cargo.toml --all-targets -- -D warnings
cargo +risc0 test --manifest-path zkvm/Cargo.toml
```

Narrower package checks such as `cargo test -p contract-core` or
`cargo test -p guest` are acceptable during local iteration when the change is
clearly isolated, but final Phase 4 acceptance for guest/contract-core
correspondence changes should use the workspace-level checks above. If the local
RISC Zero toolchain cannot run the workspace-level command, record that
constraint and cover the guest path with the narrowest supported package checks
plus the relevant zkVM build or flow checks below.

If `zkvm/methods/guest/src/main.rs` changes in a way that affects proof input,
journal format, tally semantics, or ImageID behavior, follow the repository
testing matrix and run the appropriate zkVM build and real-dev/prod verification
path before treating the implementation work as complete.

Acceptance criteria:

- formal CI runs for all implementation files guarded by formal vectors
- proof hygiene is checked by `formal:verify`
- GuestModel-generated vectors are stable and consumed by Rust tests
- GuestModel vectors cover duplicate-index, invalid-choice, invalid-commitment,
  duplicate-commitment, invalid-inclusion, missing-slot, and zero-exclusion
  behavior
- accepted Rust inputs satisfy the formal guest bounds, or fail closed before
  counters can overflow
- check definition drift between Lean and TypeScript is mechanically detected
- summary null/empty/all-unknown cases are tested and cannot produce a verified
  UI status, including through the verify page's actual `verified` rendering
  gate or an extracted equivalent helper
- formal report or audit artifacts expose theorem, vector, and proof-hygiene
  freshness
- public docs avoid overclaiming and clearly distinguish proved, tested,
  assumed, and non-claimed behavior
