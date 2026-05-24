# STARK Ballot Formalization

Status: Correspondence hardening added for audit, generated vectors,
bounded count and tally-bucket claims, and CI drift guards

This directory contains the Lean 4 formalization layer for STARK Ballot
Simulator. The first goal is deliberately small: prove structural invariants
that support the product rule that the app must never present an overall
`Verified` result unless all required cryptographic and consistency checks have
passed.

Lean is not intended to prove SHA-256 security, RISC Zero soundness, AWS runtime
behavior, React rendering behavior, or production-election security. Those
remain assumptions or are checked through implementation tests and operational
controls.

## Scope

The Lean workspace focuses on:

- zkVM journal count semantics over a mathematical `Nat` model
- verification summary fail-closed logic
- canonical input commitment encoding order
- LSB-first bitmap packing
- an abstract zkVM guest tally model over presented records

The implementation correspondence is expected to come from generated vectors
consumed by the existing TypeScript and Rust tests.

For the user-facing "never show Verified" claim, summary-model vectors are not
enough by themselves. The generated cases should also exercise the verify page's
overall-status gate, either through a small extracted pure helper or focused
page-level tests, because `src/app/(routes)/verify/page.tsx` combines summary
results with explicit proof failures, hard-failure checks, pending state, and
render timing before passing `verified` to the UI.

## Workspace

The Lean workspace shape is:

```text
formal/
  lean-toolchain
  lakefile.lean
  StarkBallotFormal/
    Basic.lean
    JournalCounts.lean
    VerificationSummary.lean
    InputCommitment.lean
    Bitmap.lean
    GuestModel.lean
  Scripts/
    EmitFormalReport.lean
    EmitTestVectors.lean
```

The Lean workspace now includes journal count semantics, the verification
summary fail-closed model, input commitment and bitmap models, generated vectors
consumed by TypeScript and Rust tests, an abstract guest state machine, and a
stable generated formal report under `docs/current/formal/formal-report.json`.
The guest model tracks a candidate-indexed tally, proves the fold preserves
duplicate-free in-range seen-index invariants and count bounds, and states its
zero-exclusion completeness theorem directly over `processVotes`. Current
hardening adds guest-model vectors, a check-definition drift vector, bounded
count and tally-bucket theorems, proof hygiene audit output, and CI drift guards
for implementation files covered by formal vectors.

The guest correspondence bounds are explicit: `treeSize <= 1,000,000`,
presented vote count `<= 1,000,000`, and each candidate tally bucket
`<= 1,000,000`. Rust rejects inputs beyond those bounds through the same checked
validation-and-tally entry point used by `guest_main` and the guest-vector tests.

## Historical Phase Documents

- [Phase 1: Foundation and Fail-Closed Model](docs/phases/phase-1-foundation-and-fail-closed-model.md)
- [Phase 2: Implementation Correspondence Vectors](docs/phases/phase-2-implementation-correspondence-vectors.md)
- [Phase 3: Public Reporting and Guest Model](docs/phases/phase-3-public-reporting-and-guest-model.md)
- [Phase 4: Formal Correspondence Hardening](docs/phases/phase-4-formal-correspondence-hardening.md)

These notes preserve the implementation plan and historical context.
For the durable current documentation entry point, see
[`docs/current/formal/README.md`](../docs/current/formal/README.md).

## Proof Policy

Committed formal claims should satisfy:

- no `sorry`
- no unreviewed project-specific `axiom`
- theorem dependencies checked with `#print axioms <theorem_name>`
- assumptions listed in the generated formal report and public documentation

Lean may depend on standard-library axioms where expected. The important rule is
that the public claim stays inspectable and does not overstate what was proved.
`pnpm formal:audit` runs the dependency check for the theorem set listed in
`formal-report.json` and records stable dependency summaries in
`docs/current/formal/formal-audit.json`.

## Axiom Dependency Audit

The current theorem dependency set is generated with `#print axioms` by
`pnpm formal:audit` and recorded in
[`docs/current/formal/formal-audit.json`](../docs/current/formal/formal-audit.json).
Keep that audit artifact as the source of truth instead of hand-maintaining
per-theorem axiom tables in this README.

There are no `sorry` terms or hand-written project-specific axioms in the
formal sources. The `pack_bits_get_bit` proof currently relies on
`native_decide` to discharge the exhaustive byte-bit case split, so its trust
base includes Lean's generated native-decision axioms for that helper.

## Guest Model

`StarkBallotFormal/GuestModel.lean` models the guest as an abstract fold over
presented vote records. It deliberately does not translate
`zkvm/methods/guest/src/main.rs` line by line. Instead, `classifyVote` captures
the externally important ordering:

1. out-of-range index rejection
2. duplicate index rejection
3. first in-range index marks the slot as seen
4. invalid choice rejection
5. invalid commitment rejection
6. duplicate commitment rejection
7. first fresh computed commitment reservation
8. invalid inclusion-proof rejection
9. accepted vote tally and bitmap update

The model retains `rejectedReasons`, so rejection classification is inspectable
rather than being derived only from a scalar rejected-record count. The stable
formal report lists the current theorem claims and assumptions.

## Generated Artifacts

Stable generated artifacts live under:

```text
docs/current/formal/
  formal-report.json
  generated-vectors/
    verification-summary-cases.json
    verification-display-cases.json
    input-commitment-cases.json
    bitmap-cases.json
    check-definitions.json
    guest-model-cases.json
  formal-audit.json
```

This follows the repository's existing `docs/current/` freshness convention. If
stable formal artifacts are later moved to a top-level `docs/formal/` directory,
update `docs/README.md` in the same change.

CI-only artifacts should remain ephemeral:

```text
.tmp/formal/
  formal-run-report.json
  formal-run-report.sha256
```

Generated artifacts must not include private proof inputs, private runtime
witness artifacts, `input.json`, `verification.json`, `included-bitmap.json`, or
`seen-bitmap.json`. Synthetic fields in correspondence vectors are allowed when
they are generated for deterministic TypeScript and Rust tests.

Input commitment vectors should include the canonical order and pre-hash encoded
bytes, not only final hash values, so implementation tests can check the byte
layout that Lean modeled.

The input commitment model makes implementation integer widths explicit through
well-formedness assumptions: vote count, vote index, `treeSize`, and
`totalExpected` are encoded as `u32`, and each Merkle path length is encoded as
`u16`. Generated vectors should stay within those bounds unless they are
deliberately testing boundary behavior. The formal permutation claim is over the
hashed vote encoding fields; vector `id` labels exist only to make generated
cases readable and are not part of the pre-hash byte sequence.

## First Commands

Lean is managed with `elan`, which installs the `lean` and `lake` proxies and
then downloads the exact toolchain pinned by `formal/lean-toolchain`.

On Linux/macOS:

```bash
sudo apt install git curl # Ubuntu; use the local equivalent elsewhere
curl https://elan.lean-lang.org/elan-init.sh -sSf | sh
source "$HOME/.elan/env"
```

The workspace currently pins Lean `v4.29.1`, the latest stable release
published when this workspace was introduced. Refresh that pin deliberately in a
small change, because Lean does not promise strong backwards compatibility
between all versions.

After setup:

```bash
cd formal && lake check-build
pnpm formal:build
pnpm formal:report
pnpm formal:vectors
pnpm formal:audit
pnpm formal:verify
```

`lake check-build` should succeed, and `pnpm formal:build` should build actual
Lean targets rather than reporting `0 jobs`.

Keep Lean checks out of the broad `ci:verify` script until the extra runtime is
intentionally accepted there. Dedicated formal workflows may run
`pnpm formal:verify` for changes to the Lean workspace, stable report,
generated vectors, and implementation files guarded by formal vectors.
