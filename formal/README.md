# STARK Ballot Formalization

This directory contains the Lean 4 formalization layer for STARK Ballot
Simulator. It proves selected structural invariants that support the product
rule that the app must never present an overall `Verified` result unless all
required cryptographic and consistency checks have passed. Generated vectors
connect the summary, display, check-definition, input-commitment, bitmap, and
guest models to targeted TypeScript and Rust tests; the worker model uses source
checks described below.

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
- on-demand AWS Batch admission, distinct active attempts, conditional worker
  bounds, and two-attempt/drain reachability

Generated vectors exercise the corresponding TypeScript and Rust behavior for
verification summaries and display decisions, check definitions, canonical
input commitment encoding, bitmap packing, and the abstract guest model. For the
user-facing "never show Verified" claim, the generated display cases exercise
the shared
`packages/verification/src/verification/verification-presentation-policy.ts`
gate alongside focused page-level behavior in
`apps/web/src/routes/verify/page.tsx`. The shared policy combines summary results
with explicit proof failures, required-check failures, pending state, and render
timing before the UI may receive `verified`.

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
    WorkerConcurrency.lean
  Scripts/
    EmitFormalReport.lean
    EmitTestVectors.lean
```

The workspace builds the formal library, test-vector emitter, and formal-report
emitter as Lake default targets. Stable reports and generated vectors live under
`docs/formal/`; the sections below describe their trust boundaries and consumers.

## Historical Phase Documents

- [Phase 1: Foundation and Fail-Closed Model](docs/phases/phase-1-foundation-and-fail-closed-model.md)
- [Phase 2: Implementation Correspondence Vectors](docs/phases/phase-2-implementation-correspondence-vectors.md)
- [Phase 3: Public Reporting and Guest Model](docs/phases/phase-3-public-reporting-and-guest-model.md)
- [Phase 4: Formal Correspondence Hardening](docs/phases/phase-4-formal-correspondence-hardening.md)

These notes preserve the implementation plan and historical context.
For the durable current documentation entry point, see
[`docs/formal/README.md`](../docs/formal/README.md).

## Proof and Trust Policy

Committed formal claims should satisfy:

- no `sorry`
- no unreviewed project-specific `axiom`
- theorem dependencies checked with `#print axioms <theorem_name>`
- assumptions listed in the generated formal report and public documentation

Lean may depend on standard-library axioms where expected. The important rule is
that the public claim stays inspectable and does not overstate what was proved.
`pnpm formal:audit` invokes `#print axioms` for the theorem set listed in
`formal-report.json` and records stable dependency summaries in
[`docs/formal/formal-audit.json`](../docs/formal/formal-audit.json).
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

The guest fold tracks a candidate-indexed tally and preserves duplicate-free,
in-range seen indices together with `validVotes <= seenIndices.length`. Those
invariants imply the seen-index count cannot exceed `treeSize`; the
zero-exclusion completeness theorem is stated directly over `processVotes`.

The Lean guest correspondence theorem assumes two input bounds:
`treeSize <= 1,000,000` and presented vote count `<= 1,000,000`. Under these
assumptions, Lean proves that modeled seen, valid, rejected, and per-candidate
tally bucket counts remain within the Rust `u32` domain. It also proves each
candidate tally bucket `<= 1,000,000` as a consequence of the fold invariants;
that bucket bound is not an additional input assumption. Rust enforces the
tree-size and vote-count bounds through the validation-and-tally path shared by
`guest_main` and the guest-vector tests, and uses checked counter increments.

## Worker Concurrency

`WorkerConcurrency.lean` models one target's on-demand Batch prover jobs.
Every admitted single-container attempt consumes one unit of the same two-unit
replenishable resource. Each transition preserves distinct active attempts and
the capacity bound; the reachable-state theorem carries both properties from
an empty initial state. Two jobs can be admitted together and then drain to zero.

The model counts an attempt from Batch `STARTING` until the provider releases
its resource on `SUCCEEDED` or `FAILED` after computation stops. Queueing,
cancellation requests, Step Functions timeouts, application callbacks, and
ledger notifications alone do not release capacity. The model assumes correct
provider accounting and excludes bypass launches and detached computation.
It proves neither fairness nor eventual termination. Source correspondence and
its limits are described in the
[worker contract](../docs/formal/README.md#worker-concurrency-claims); there are
no generated worker vectors or proofs of AWS runtime behavior.

## Generated Artifacts

Stable generated artifacts live under:

```text
docs/formal/
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

The stable formal artifacts live under the public `docs/formal/` area. Keep
`docs/README.md`, the emitters, scripts, tests, and workflow filters aligned if
that contract changes.

`Scripts/EmitTestVectors.lean` owns the contents of the six generated-vector
files. `pnpm formal:vectors` formats its emitted JSON with the shared Oxfmt
configuration before retaining it. `pnpm formal:vectors:check` applies that
same formatting to newly emitted comparison files before comparing their bytes
with the committed files. The emitter produces an unnumbered exact-current envelope:
the current discriminator, the path-bound vector kind, modeled runtime bounds,
the kind-specific payload, and a canonical SHA-256 fingerprint. The fingerprint
covers the recursively key-sorted, whitespace-free envelope body without the
fingerprint field itself. Consumers reject unknown or missing keys, a wrong
discriminator or kind, metadata that differs from current TypeScript/Rust
constants, and content whose fingerprint is stale. Retired shapes have no
fallback reader.

This bridge does not turn Lean into a runtime-code generator. The Lean models
and emitter stay independent of the TypeScript and Rust implementations;
runtime admission and constant-equality assertions make disagreement visible in
tests. `Scripts/EmitFormalReport.lean` separately owns the exhaustive
generated-vector path-to-kind registry included in the stable report, and the
formal audit hashes the committed bytes of those registered files. The audit
writer also uses the shared formatting helper. `pnpm formal:verify` checks
Oxfmt formatting for the report, audit, and vectors in addition to their
respective freshness checks.

Freshness checks generate comparison vectors and temporary `#print axioms`
sources in self-cleaning directories under the operating system's temporary
directory. They do not create stable repository artifacts.

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

The workspace currently pins Lean `v4.35.0`, the latest stable release
published when this workspace was last refreshed. Refresh that pin deliberately in a
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
generated vectors, and implementation files guarded by formal vectors. The
source repository's public-release workflow always builds Lean and runs
`pnpm formal:verify` before generating the public snapshot, so stale or failing
formal artifacts block that release. The generated public repository has its
own path-filtered formal workflow for formal-contract changes.
