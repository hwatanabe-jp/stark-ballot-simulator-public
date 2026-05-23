# Phase 1: Foundation and Fail-Closed Model

> Status: completed in commit `89e79744`. The Lean workspace, the eight
> required theorems, the summary/display generated vectors, and the targeted
> Vitest connections are all in place. `lake check-build` and `lake build`
> exercise the formal library and the `emitTestVectors` executable as default
> targets, and the verify page consumes the extracted `overall-status.ts`
> helper. Treat this document as historical context for Phase 2 onwards.

## Purpose

Create the Lean 4 workspace and prove the first P0 invariants that directly
support the project's "never show Verified unless required checks pass" rule.

This phase combines the minimal workspace, zkVM journal count semantics, and the
verification summary model so the first formal change has enough substance to
be reviewed as a meaningful vertical slice.

## Implementation Sources

- `zkvm/methods/guest/src/main.rs`
- `zkvm/contract-core/src/types.rs`
- `src/lib/zkvm/types.ts`
- `src/lib/verification/verification-summary.ts`
- `src/lib/verification/verification-checks.ts`
- `src/app/(routes)/verify/page.tsx`
- `docs/current/verification/README.md`

## Deliverables

- `formal/lean-toolchain`
- `formal/lakefile.lean`
- `formal/StarkBallotFormal/Basic.lean`
- `formal/StarkBallotFormal/JournalCounts.lean`
- `formal/StarkBallotFormal/VerificationSummary.lean`
- `formal/Scripts/EmitTestVectors.lean`
- theorem: `excluded_zero_implies_no_slot_loss`
- theorem: `excluded_zero_implies_all_seen_slots_counted`
- theorem: `slot_partition_total`
- theorem: `fully_verified_implies_all_required_present`
- theorem: `fully_verified_implies_all_required_success`
- theorem: `fully_verified_implies_no_unknown_checks`
- theorem: `fully_verified_implies_required_roles_success`
- theorem: `sth_configured_promotes_third_party_check`
- generated `docs/current/formal/generated-vectors/verification-summary-cases.json`
- generated `docs/current/formal/generated-vectors/verification-display-cases.json`
- a targeted Vitest connection for summary vectors
- a targeted Vitest or page-level connection for the verify page's final
  overall-status gate
- package scripts: `formal:build` and `formal:vectors`

`formal/lean-toolchain` should pin a concrete Lean release rather than
`stable`. Phase 1 uses `leanprover/lean4:v4.29.1`, the latest stable release at
the time this workspace was introduced, so future Lean upgrades are deliberate
reviewable changes.

## Journal Count Model

The Lean model should use `Nat`, not Rust `u32`, and make these slot invariants
explicit:

```text
validVotes <= seenIndicesCount
seenIndicesCount <= treeSize
missingSlots = treeSize - seenIndicesCount
invalidPresentedSlots = seenIndicesCount - validVotes
excludedSlots = missingSlots + invalidPresentedSlots
```

The component-zero theorem should prove:

```text
excludedSlots = 0
  -> missingSlots = 0 and invalidPresentedSlots = 0
```

The stronger partition theorem should keep the count definitions and boundary
assumptions visible while deriving the boundary equalities:

```text
missingSlots = treeSize - seenIndicesCount
  -> invalidPresentedSlots = seenIndicesCount - validVotes
  -> excludedSlots = missingSlots + invalidPresentedSlots
  -> excludedSlots = 0
  -> validVotes <= seenIndicesCount
  -> seenIndicesCount <= treeSize
  -> seenIndicesCount = treeSize
  and validVotes = seenIndicesCount
  and validVotes = treeSize
```

`validVotes = treeSize` must not be presented as a consequence of
`excludedSlots = 0` alone. It depends on the count definitions plus the
guest-processing invariants. In particular, the theorem statement should expose
the `missingSlots`, `invalidPresentedSlots`, and `excludedSlots` definitions as
premises instead of treating `excludedSlots = 0` as a standalone fact.

## Verification Summary Model

The summary model should include:

- check IDs
- check roles
- check categories
- required vs optional criticality
- `recorded_sth_third_party` promotion when `sthSourcesConfigured = true`
- statuses: `success`, `not_run`, `pending`, `running`, `failed`
- summary statuses, especially `fully_verified`

The main guarantee should have this shape:

```text
deriveSummaryModel ctx checks = fully_verified
  -> every currently required check is present
  -> every currently required check is success
  -> no unknown check exists
  -> proof_verification role is success
  -> tally_completeness role is success
  -> user_inclusion role is success
  -> no optional check has status failed or not_run
```

Optional evidence should match current TypeScript behavior:

- optional `failed` blocks `fully_verified`
- optional `not_run` blocks `fully_verified`
- optional `success` is accepted
- optional `pending` and `running` currently do not block `fully_verified`

If that product behavior changes, change TypeScript first, then update the Lean
model and generated vectors.

## Display Gate Connection

The summary model is not the final UI decision by itself. The verify page
combines `deriveVerificationSummary` with explicit server/proof failures,
hard-failure checks, pending checks, and result timing before it passes an
overall `verified` status to the UI.

Phase 1 should therefore add generated display vectors and connect them to one
of these implementation surfaces:

- a small extracted pure helper for the verify page's overall-status decision;
  or
- focused page-level Vitest coverage in `src/app/(routes)/verify/page.test.tsx`.

The display vectors should confirm that missing required checks, explicit proof
failures, hard-failure checks, pending checks, and
`verified_with_limitations` cannot render the page's overall status as
`verified`.

Include both required and optional pending/running cases in those display
vectors. The summary model currently permits optional `pending` and `running`
checks to remain compatible with `fully_verified`, but the verify page suppresses
result rendering while any check is still pending or running. That UI gate is
part of the product claim and should be tested separately from summary
derivation.

## Test Connection

Add a Vitest file near the implementation, for example:

```text
src/lib/verification/__tests__/formal-summary-vectors.test.ts
```

The test should load the generated vectors and assert that
`deriveVerificationSummary` returns the modeled status for each case.

## Acceptance

```bash
cd formal && lake check-build
cd formal && lake build
pnpm formal:vectors
pnpm test:run src/lib/verification/__tests__/formal-summary-vectors.test.ts
pnpm test:run 'src/app/(routes)/verify/lib/overall-status.test.ts'
```

Acceptance criteria:

- `lake check-build` succeeds, proving at least one default target is configured.
- `lake build` succeeds and builds the formal library/executable instead of
  reporting `0 jobs`.
- Theorems use no project-specific axioms.
- Committed Lean files contain no `sorry`.
- The targeted Vitest connection succeeds.
- A deliberate missing-required-check vector maps to `missing_evidence`, never
  `fully_verified`.
- A deliberate missing-required-check vector cannot render the verify page's
  overall status as `verified`.
- Display-gate vectors cover explicit proof failure, hard-failure checks,
  pending checks, missing evidence, `verified_with_limitations`, and
  `fully_verified`.
- Display-gate vectors include optional `pending` and optional `running` cases
  and confirm they do not render the page's overall status as `verified`.
- Documentation states that the count proof is a `Nat` model and does not yet
  prove Rust `u32` overflow behavior.

## Review Notes

Do not modify `ci:verify` in this phase. Lean availability and vector
consumption should stabilize before CI promotion.

Lean/Lake setup is documented in `formal/README.md` and
`docs/current/formal/README.md`. Use `elan`; `lake` comes from the selected Lean
toolchain and should not be installed as an unrelated system package.
