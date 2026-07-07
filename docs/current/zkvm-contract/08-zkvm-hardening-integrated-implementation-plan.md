# zkVM Hardening Integrated Implementation Plan

> **Status: implemented through the local x86_64 post-change benchmark boundary.** This
> document defines the integrated repository plan for the next zkVM
> hardening program. It supersedes temporary local planning notes for
> this work. It is not a runtime source of truth and does not override
> current code, `docs/current/verification/README.md`, or `zkvm/README.md`.

## Purpose

This plan coordinates the next zkVM contract hardening effort across
bitmap evidence, guest performance, Rust domain typing, TypeScript/Rust
contract parity, ImageID trust material, verification fail-closed
semantics, and user-facing verification explanations.

The goal is to strengthen the proof stack in three dimensions at the
same time:

- make bitmap Merkle evidence meaningful for real multi-leaf trees, not
  only the current one-leaf demo shape
- reduce zkVM execution and proof cost using measured production-guest
  evidence
- move important Rust-side invariants from unstructured primitives into
  semantic types, validated views, and accounting builders without
  accidentally changing the public wire contract

The final repository state must preserve the core product invariant:
the UI must never show `Verified` unless all required cryptographic and
consistency checks pass.

## Scope

This plan covers:

- bitmap root and proof correctness for one-leaf, boundary, and
  multi-leaf bitmaps
- `/api/bitmap-proof` and client-side bitmap verification behavior
- zkVM guest benchmark and profiling evidence
- guest-cycle optimizations that preserve the proof contract
- `zkvm/contract-core` semantic and bounded Rust types
- structural validation before guest tally processing
- tally/accounting invariants before `VerificationOutput`
  serialization
- TypeScript/Rust parity fixtures and generated vectors
- method-version, guest image, and ImageID lifecycle decisions
- verification summary and verify-page fail-closed behavior
- public bundle and private artifact boundaries that are affected by
  proof or bitmap changes

This plan does not cover:

- AWS account migration Plan 02/03 execution, production cutover, or
  legacy account retirement
- production DNS, certificate, or Terraform app deployment decisions
- a new public bundle format unrelated to zkVM proof evidence
- production election hardening beyond the portfolio/demo proof stack
- a privacy-preserving single-bit bitmap proof scheme, which would be a
  separate proof-contract design

## Relationship To Existing Documents

Documents 01-07 remain the settled current-contract baseline.

This document is a follow-up implementation plan on top of that
baseline. It does not rewrite the previous generation-boundary,
authority, public-input, cleanup, ballot-semantics, complexity-pruning,
or public-boundary cutover decisions.

For current behavior, prefer the implementation plus:

- `docs/current/verification/README.md`
- `zkvm/README.md`
- `docs/current/guides/6-zkvm_design/final_design.md` for design intent

For AWS migration sequencing, use:

- `docs/current/aws-account-migration/post-merge/README.md`
- `docs/current/aws-account-migration/post-merge/02-develop-app-prerequisite-definitions-plan.md`
- `docs/current/aws-account-migration/post-merge/03-develop-app-execution-and-validation-plan.md`

This zkVM hardening work may proceed locally, but it must not claim to
satisfy AWS app handoff, app execution, production bootstrap, or cutover
gates. The current AWS migration sequencing, blockers, and handoff
authority remain owned by the AWS migration docs listed above.

## Non-Negotiable Invariants

- `Verified` is allowed only when every required check succeeds.
- Required checks in `failed`, `missing`, `pending`, `not_run`,
  `running`, `unknown`, or omitted states must block full verification.
- `excludedSlots > 0` must block success.
- Legacy `excludedCount > 0`, if encountered only as stale or
  compatibility input, remains fail-closed and must not reenter the
  public current contract.
- `counted_my_vote_included`, `counted_input_commitment_match`,
  `stark_image_id_match`, and `stark_receipt_verify` remain required
  proof or inclusion checks.
- Development-mode receipts must never produce a terminal verdict named
  `Verified`; they need a separate demo-only verdict or equivalent
  non-production state.
- `input.json`, `verification.json`, `included-bitmap.json`, and
  `seen-bitmap.json` must not appear in public `bundle.zip`.
- Bitmap roots must preserve the current LSB-first packing and
  32-byte / 256-bit leaf contract unless the owner deliberately accepts
  a proof-contract change.
- Do not shrink bitmap leaf chunks only to force multi-leaf behavior in
  the current 64-slot demo shape. Any bitmap root format change must
  update the proof contract, method version, vectors, verifier
  assumptions, ImageID trust material, and public evidence semantics
  together.
- Any guest image, method version, journal layout, public input
  encoding, host/guest IO, bitmap root format, or compiler-output change
  that changes the guest image must be synchronized with ImageID trust
  material.
- `RISC0_DEV_MODE=1` evidence is not production STARK evidence.

## Execution Model

The work must land only when the repository is internally consistent,
but it should not be developed as one opaque giant change.

Use a reviewable checkpoint stack with an atomic release gate:

- checkpoints may be developed, reviewed, benchmarked, and tested
  independently
- no checkpoint may be released or described as product-complete if a
  later required checkpoint is still missing
- the final release state must contain the complete compatible set of
  bitmap, guest, Rust type, TypeScript contract, verification, ImageID,
  test, and documentation changes
- urgent security or fail-closed corrections must not be held behind
  speculative optimization work when they can be proven independently

This keeps the repository bisectable and reviewable while preserving
the product requirement that proof-contract changes ship as a coherent
state.

When this document is part of a repository change, include this
maintained `08` plan in the final committed change set together with
the docs indexes that reference it. Temporary source notes such as
`TEMP_ZKVM_BIG_BANG_IMPLEMENTATION_PLAN.md` and `chatgpt_pro.md` should
remain uncommitted unless the owner explicitly chooses to retain or
archive them.

## Checkpoint Order

### 1. Characterization And Measurement Baseline

Add tests and measurement paths before changing behavior.

Required outcomes:

- current bitmap roots and proof behavior are characterized at one-leaf
  and multi-leaf boundaries
- current guest outputs are frozen for normal, invalid, duplicate,
  out-of-range, malformed-proof, and unsorted-input fixtures
- a production-guest measurement path records exact guest cycles,
  execution time, proof time, SHA precompile activity where available,
  receipt size, host parsing/serialization time, and process-startup
  overhead for the largest practical local production-proof fixture
- local production-proof benchmark fixtures are required only up to the
  current 64-slot demo shape unless practical prover hardware is
  available
- 257-slot, 513-slot, and larger multi-leaf shapes are required as
  bitmap vectors, property tests, contract-parity tests, and
  non-production execution evidence, but not as local production-proof
  benchmark blockers
- adversarial measurement fixtures include duplicate-heavy inputs,
  invalid-proof inputs, malformed proof-shape inputs, and the maximum
  accepted work-budget workload in the lightest mode that can exercise
  the affected behavior

Acceptance thresholds must be set before optimization work claims any
performance win. This checkpoint should not claim optimization wins.

### 2. Bitmap Proof Leaf-Position Binding

Fix bitmap proof verification before relying on multi-leaf evidence in
the UI.

The verifier must derive proof position from authenticated context, not
trust server-provided shape alone:

- `treeSize` comes from receipt-authenticated journal context
- `leafIndex = floor(bitIndex / 256)`
- `leafCount = ceil(treeSize / 256)`
- `bitIndex >= treeSize` is rejected
- non-safe integer and impossible index values are rejected before
  proof evaluation
- expected sibling presence and direction are derived locally at every
  level
- wrong direction, extra sibling, missing sibling, wrong tree size,
  wrong leaf, and out-of-range requests fail closed
- the final partial leaf is interpreted with the journal-authenticated
  logical bitmap length

If the API continues returning direction metadata, the client must
compare it with locally derived direction metadata. A future API may
return only sibling hashes and let the client derive directions.

Bitmap proof service work must preserve the private-sidecar evidence
chain. `included-bitmap.json` and `seen-bitmap.json` are private
artifacts, but when `/api/bitmap-proof` or an equivalent proof service
uses them to answer slot-specific proof requests, the service must
independently validate that each sidecar hashes back to the
receipt-authenticated journal root for its bitmap kind before serving or
trusting proofs. Host-side bitmap reconstruction may be optimized only
after this sidecar-root assertion remains explicit, fail-closed, and
covered by tests. Missing or unreadable private sidecars must produce a
stable unavailable or incomplete-evidence result, not a successful
bitmap proof.

### 3. Development-Mode Verdict Separation

Separate development-mode evidence from production verification.

Required outcomes:

- development-mode receipt evidence cannot produce a visible terminal
  verdict named `Verified`
- `stark_receipt_verify` remains non-success or otherwise explicitly
  non-production in development-mode evidence
- verify-page presentation uses a distinct state such as `Demo only`
  for successful demo checks without production STARK proof evidence
- production prover and verifier builds evaluate and, where supported
  by the active RISC Zero dependency stack, enable the
  `disable-dev-mode` feature or equivalent production guard so an
  accidentally set `RISC0_DEV_MODE` cannot weaken production proving or
  verification
- if production builds cannot use RISC Zero's `disable-dev-mode`
  feature, the implementation must document the equivalent guard and
  include tests proving production verification cannot accept
  development-mode receipts as production proof evidence

### 4. Wire/Domain Type Split

Strengthen Rust typing without directly destabilizing serialized wire
schemas.

The target layering is:

```text
stable wire structs
  -> structural validation and typed domain view
  -> tally/accounting state transitions
  -> stable VerificationOutput
```

High-value internal types include:

- `VoteCommitment`
- `Randomness32`
- `SeenBitmapRoot`
- `IncludedBitmapRoot`
- `InputCommitment`
- `BulletinRoot`
- `ElectionConfigHash`
- `LogId`
- `SthDigest`
- `MerkleNodeHash`
- `TreeSize`
- `TotalExpected`
- `VoteCount`
- `BulletinIndex`
- `BitmapBitIndex`
- `BitmapLeafIndex`
- `BitmapBitOffset`
- `ValidatedAuditPath<'a>`
- `PackedBitmap`
- `GuestWorkBudget`

`ValidatedAuditPath<'a>` or its equivalent must be bound to the
authenticated `(TreeSize, BulletinIndex)` context. Structural validation
must derive the exact or tightly bounded audit-path shape from that
context, including expected sibling count and direction at each level.

`GuestWorkBudget` or its equivalent must include:

- an aggregate `total_path_nodes` limit across all submitted records
- a total serialized-input byte limit enforced before executor
  construction
- host/API preflight that rejects over-budget or impossible work before
  building the RISC Zero executor environment
- guest-side fail-closed validation that preserves the same work-bound
  invariants after deserialization

`ValidatedAggregatorInput<'a>` or an equivalent view should mean
structurally safe to process. It should not mean every vote is valid.
Invalid choices, commitment mismatches, duplicate indexes, duplicate
commitments, out-of-range records, and invalid inclusion proofs remain
record-level rejection outcomes unless a later proof-contract decision
intentionally changes that behavior.

Raw `VoteWithProof.choice` must remain representable at the wire
boundary so invalid choices can be rejected and accounted for by the
guest.

All TypeScript numeric fields that cross into Rust must have explicit
units, range boundaries, and deterministic encoding rules. When a field
is represented as a JavaScript `number`, TypeScript validation must
reject non-finite values, non-integers, and values that fail
`Number.isSafeInteger` before serialization or proof-input construction.
If the Rust side uses a wider integer such as `u64`, the contract must
define whether TypeScript carries the value as a safe `number`, a
decimal string, or a `BigInt`, and how it is encoded into the stable
wire bytes. The current `timestamp: number` to Rust `u64` boundary is
standardized as a positive Unix timestamp in milliseconds carried as a
JavaScript safe integer and encoded as little-endian `u64` on the Rust
side.

### 5. Accounting Builder

Introduce a tally/accounting layer that derives output counts from
domain events rather than scattered counter mutation.

The builder should make these invariants explicit before producing
`VerificationOutput`:

- `totalVotes = validVotes + invalidVotes` where the existing contract
  still exposes `invalidVotes`
- `sum(verifiedTally) = validVotes`
- `seenIndicesCount = validVotes + invalidPresentedSlots`
- `treeSize = seenIndicesCount + missingSlots`
- `excludedSlots = missingSlots + invalidPresentedSlots`
- `popcount(includedBitmap) = validVotes`
- `popcount(seenBitmap) = seenIndicesCount`
- `includedBitmap` is a subset of `seenBitmap`

The public slot/record vocabulary from document 05 remains authoritative
unless this plan is explicitly amended.

### 6. Guest Optimizations

Apply optimizations only after the baseline and correctness checkpoints
exist.

Preferred optimization targets:

- remove inspection-only `vote_outcomes` allocation and storage from the
  production guest path
- stream canonical input commitment preimages without constructing
  avoidable complete intermediate buffers
- use a sorted-input fast path only when the full canonical comparator
  proves the records are already in canonical order
- avoid recomputing identical seen and included bitmap roots only under
  a precise invariant such as `includedBitmap` subset `seenBitmap` and
  zero invalid-presented slots
- consider a `PackedBitmap` accumulator if compatibility vectors prove
  identical leaves, roots, padding, and popcounts
- compact bitmap Merkle levels in place while preserving odd-node
  promotion behavior
- replace duplicate-detection data structures only after duplicate and
  tally-order semantics are frozen
- compile out diagnostic formatting and logging allocation from the
  production guest image where possible

Do not replace RISC Zero accelerated SHA paths with generic hashing.

Batch Merkle verification, multiproofs, or complete-tree fast paths are
future proof-contract revisions unless this document is explicitly
updated. They should not be slipped into this hardening pass as
incidental optimization.

### 7. ImageID And Provenance Synchronization

Before any guest-image or proof-contract change is accepted, choose the
ImageID lifecycle policy.

Supported policy choices:

- increment method version for every deployed trusted guest-image
  revision and retain historical mappings
- separate wire-contract version from guest build revision and maintain
  an explicit trusted allowlist of `(contractVersion, ImageID)` pairs

The selected policy must define how existing receipts remain
verifiable, or explicitly state that historical receipt verification is
out of scope for the current portfolio/demo contract.

#### Synchronization Touchpoints

When ImageID trust material, proof-contract encoding, journal shape, or
host/guest IO changes, re-check these owner paths as synchronization
points, not as an exhaustive touched-file checklist:

- ImageID trust: `public/imageId-mapping.json` and
  `packages/verification/src/verification/expected-image-id.ts`
- verifier execution: `apps/api/src/server/api/handlers/verificationRun.ts`
  and `verifier-service/src/lib.rs`
- host and async output: `zkvm/host/src/main.rs` and
  `infra/docker/entrypoint.sh`
- contract parsing and parity: `packages/zkvm-contract/src/zkvm/types.ts`,
  `packages/zkvm-contract/src/zkvm/host-io.ts`,
  `packages/zkvm-contract/src/zkvm/journal-guards.ts`,
  `packages/verification/src/verification/journal-parser.ts`, and
  `packages/verification/src/verification/public-input-contract.ts`
- route-visible shape changes only:
  `packages/api-contract/src/validation/apiSchemas.ts`

Final evidence must include:

- source commit
- `Cargo.lock`
- Rust toolchain
- RISC Zero toolchain
- target, features, and profile
- guest ELF digest
- ImageID
- build-container digest when a container is used
- reproducible ImageID evidence from two clean environments, or an
  explicit documented exception explaining why reproducibility evidence
  is unavailable for this release
- verifier evidence for every supported ImageID variant
- final production receipt evidence verified through `verifier-service`
- fail-closed tests for stale, unknown, or mismatched ImageIDs

### 8. Verification UI And Explainability

The verify page should present bitmap evidence as authenticated leaf
evidence plus selected-bit interpretation.

A bitmap proof authenticates a 32-byte leaf chunk. The selected bit
inside that authenticated chunk may be zero or one. Avoid describing a
zero bit as a standalone Merkle exclusion proof.

Recommended terminal verdict vocabulary:

- `Verified`: all required checks pass, receipt is production
  cryptographic evidence, ImageID matches, and exclusions are zero
- `Not verified`: a required check failed or evidence is inconsistent
- `Verification incomplete`: required evidence is missing, unavailable,
  unknown, or not run
- `Checking evidence`: required checks are genuinely running or pending
- `Demo only`: development-mode evidence was used

Verified-state copy must describe the specific consistency, inclusion,
ImageID, and proof checks that passed. It must not claim broad fraud
absence, including phrases such as `No fraud was detected`. The current
implementation updates both English and Japanese verify-page copy and
keeps translation-consistency tests green.

For one slot, the seen and included bit meanings are:

| Seen bit | Included bit | Meaning                                                |
| -------: | -----------: | ------------------------------------------------------ |
|        1 |            1 | Presented and counted                                  |
|        1 |            0 | Presented to the zkVM but rejected                     |
|        0 |            0 | Not presented to the zkVM                              |
|        0 |            1 | Cryptographic or accounting inconsistency, fail closed |

Advanced evidence drill-down may show:

- bitmap kind, requested slot, authenticated tree size, leaf index, leaf
  count, bit offset, and bit value
- expected path shape derived locally
- computed root and journal root
- receipt authentication state for that root
- trusted ImageID result

Normal UI and API bitmap proof usage should request only the user's own
slot by default. The UI should not prefetch or display neighboring bits.
A 32-byte bitmap leaf reveals neighboring slot status, so arbitrary index
inspection should be treated as deliberate advanced, debug, or operator
behavior and remain session-scoped and rate-limited where applicable.

## Acceptance Evidence

### Bitmap Correctness

Required bitmap fixtures and vectors:

- 1, 255, 256, 257, 511, 512, and 513 bits
- three-leaf and five-leaf trees
- odd promoted tree levels
- sparse high-index set bits
- all-zero and all-one chunks around the 256-bit boundary
- last partial leaves and unused padding bits

Required negative tests:

- proof for a different leaf with the same bit offset
- wrong direction
- extra sibling
- missing sibling
- wrong authenticated tree size
- out-of-range bit index
- non-safe integer index
- nonzero unused padding where padding must be zero
- unavailable authenticated tree size
- `included-bitmap.json` sidecar root mismatch against the
  receipt-authenticated included bitmap root fails closed
- `seen-bitmap.json` sidecar root mismatch against the
  receipt-authenticated seen bitmap root fails closed
- unavailable, unreadable, or missing private bitmap sidecars produce
  the intended unavailable or incomplete-evidence behavior without
  serving a successful bitmap proof

Required property or fuzz coverage:

- bitmap root and proof generation must exercise more than two leaves,
  including odd promoted levels
- proof verification must remain bound to the requested bit position,
  derived leaf index, and authenticated tree shape across generated
  cases
- final partial leaves, unused padding, and logical tree size must be
  checked together so root or proof acceptance cannot confuse different
  bitmap lengths

### Contract Parity

Required parity evidence:

- Rust and TypeScript bitmap roots agree
- Rust and TypeScript bitmap proofs agree
- every TypeScript numeric field that crosses into Rust has an explicit
  unit, safe-integer or wider-integer validation rule, range boundary,
  and deterministic wire encoding, including the Unix-milliseconds
  `timestamp: number` to Rust `u64` boundary
- serialized `AggregatorInput` golden bytes remain expected when the
  wire contract is unchanged
- serialized `VerificationOutput` golden bytes remain expected when the
  wire contract is unchanged
- canonical input-commitment preimages remain byte-for-byte stable
- TypeScript journal parsing and guards accept the new current output
  and reject unsupported stale shapes

### Guest Semantics

Required differential or fixture coverage:

- valid votes
- invalid choices
- commitment mismatches
- invalid Merkle proofs
- duplicate indexes
- duplicate commitments
- unsorted input
- out-of-range records
- duplicate-heavy workloads
- malformed proof-shape workloads
- invalid-proof workloads
- maximum accepted work-budget workloads

Permutation tests must pin duplicate and tally-order semantics before
duplicate-detection optimization is accepted.

Accounting-invariant property tests must cover duplicate and order
semantics, tally/count consistency, and the relationship between seen
slots, included slots, rejected records, valid votes, and final output
counts.

### Performance

Performance reports must measure the final production guest image, not
only an instrumented or diagnostic variant.

Report at least:

- user, paging, reserved, and total cycles where available
- SHA precompile activity where available
- execution time
- proving time
- receipt size
- host JSON parsing and serialization time
- Node-to-Rust process startup overhead
- median and tail latency over repeated runs

The measured production-proof fixture matrix must include a small case
and the current 64-slot demo shape. On local hardware where a 64-slot
production proof already takes several minutes, production-proof
benchmarks above 64 slots are not required to close this plan.

Multi-leaf and larger shapes remain required evidence, but they should
use cheaper proof-contract checks: bitmap vectors, TypeScript/Rust
parity tests, property tests, dev-mode or executor-only measurements,
and adversarial non-production execution where appropriate. Useful
non-production fixture sizes include 257 slots, 513 slots, a larger
practical shape such as 4,096 slots, duplicate-heavy inputs,
invalid-proof inputs, and the maximum accepted work-budget workload.

No optimization should be claimed unless it exceeds measurement noise
and does not regress another accepted fixture in a meaningful way.

### Trust Chain

Required trust-chain evidence:

- final ImageID entries for every supported active variant
- reproducible ImageID evidence from two clean environments, or an
  explicit documented exception explaining why reproducibility evidence
  is unavailable for this release
- complete build manifest
- final production receipt evidence verified through `verifier-service`
- stale, unknown, mismatched, or unavailable ImageID failures remain
  fail-closed
- production builds do not accept development-mode receipts as
  production proof evidence
- production STARK proof evidence covers the largest practical local
  production fixture, currently the 64-slot demo shape on local hardware
  where larger proofs are not practical
- multi-leaf bitmap correctness is still required for 257-or-larger
  shapes through vectors, property tests, contract-parity tests, and
  non-production execution evidence

### Verification And UI

Required fail-closed tests must prove no visible `Verified` text, badge,
icon, or equivalent success styling appears when:

- any required check fails
- a required check is missing
- a required check is pending, running, not run, or unknown
- `excludedSlots > 0`
- ImageID mismatches
- bitmap path verification succeeds locally but STARK authentication is
  pending or failed
- development-mode evidence is used
- an otherwise successful category omits a detailed required check

If verification UI changes are included, run the relevant route or
component tests plus the narrowest useful Playwright smoke and axe
checks.

Privacy-specific acceptance evidence must show that normal verify UI
and API usage requests only the user's own slot by default, does not
prefetch neighboring bitmap leaves or all bitmap leaves, and does not
display neighboring bit values. Any arbitrary-index inspection must be
explicitly advanced, debug, or operator-scoped, remain bound to the
session capability model, and include rate limiting or an equivalent
documented justification.

Public/private artifact acceptance evidence must show that
`included-bitmap.json` and `seen-bitmap.json` stay excluded from public
`bundle.zip` output while remaining available only through the
authenticated private evidence path required for sidecar-root
validation.

## Required Gates

Choose the narrowest useful gates during development, but the integrated
release candidate must have evidence for the affected areas.

Baseline TypeScript and verification gates:

```bash
pnpm format:check
pnpm lint
pnpm type-check
pnpm test:run
pnpm public-safety:scan
```

Rust zkVM gates:

```bash
cd zkvm
cargo fmt --check
RISC0_SKIP_BUILD=1 cargo clippy -p host -- -D warnings
cargo test
```

The supported host lint boundary sets `RISC0_SKIP_BUILD=1` because
`cargo clippy -p host -- -D warnings` without that variable re-enters the
RISC Zero build script and attempts to rebuild/lint the guest target
(`riscv32im-risc0-zkvm-elf`) from the host package path. Guest linting is
covered separately by `cargo clippy -p guest --all-targets -- -D warnings`,
while host linting should not depend on rebuilding the embedded guest image.

Formal and contract-vector gate:

```bash
pnpm formal:verify
```

Flow gates:

```bash
pnpm test:cli:mock
pnpm test:cli:real-dev
```

Production proof evidence is required before claiming production zkVM
correctness for guest-image or proof-contract changes:

```bash
pnpm test:cli:real-prod:s0
```

The normal S0 proof gate satisfies the required local production-proof
evidence when 64 slots are the largest practical production fixture on
the available hardware. It does not, by itself, prove multi-leaf bitmap
correctness; that claim must be supported by the vector, property,
contract-parity, and non-production execution evidence above.

A 257-or-larger production proof is optional capacity evidence. If
practical prover hardware becomes available, the implementation may add
the following package script or document the exact equivalent
257-or-larger production proof command and evidence path:

```bash
pnpm test:cli:real-prod:bitmap-257
```

The optional script or documented equivalent must generate a production
STARK receipt for a bitmap with at least 257 bits and verify the
resulting receipt through `verifier-service`. Until practical prover
capacity exists, the command above is an optional planned gate name
rather than a currently runnable repository script or completion
blocker.

If verifier-service behavior changes:

```bash
pnpm build:verifier-service
cd verifier-service
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

If async bundle generation changes:

```bash
pnpm test:stark-tamper
```

If user-visible verification UI changes:

```bash
pnpm test:e2e:mock --grep @smoke --reporter=list
pnpm test:e2e:axe
```

## Open Decisions

- Whether the normal demo slot count should increase to at least 257 so
  ordinary sessions exercise multi-leaf bitmap roots.
- Whether ImageID lifecycle authority should be method-version-per-image
  or an explicit trusted ImageID allowlist per contract version.
- Whether existing receipt verification across guest-image revisions is
  a maintained requirement or out of scope for this demo contract.
- Whether duplicate/tally semantics are original wire order,
  canonical order, or symmetric duplicate-group rejection.
- Whether `PackedBitmap` becomes the guest accumulator representation.
- Whether production UI should expose an advanced raw bitmap evidence
  drill-down, and which values are safe to show without encouraging
  neighboring-slot inspection.
- Whether any future multiproof or batch Merkle verification design
  belongs in this program or must be a separate method-version plan.

## Completion Criteria

This plan is complete only when:

- bitmap proof verification is bound to the requested bit and
  authenticated tree shape
- development-mode evidence cannot reach a `Verified` verdict
- multi-leaf bitmap vectors and negative proof tests pass in Rust and
  TypeScript
- bitmap root and proof property or fuzz tests cover more than two
  leaves, odd promoted levels, requested-bit and leaf-position binding,
  authenticated tree shape, final partial leaf padding, and logical
  tree size
- guest benchmark evidence exists before and after accepted
  optimizations
- Rust domain types and validation layers reduce misuse without
  accidental public wire churn
- tally/accounting invariants are centralized before
  `VerificationOutput` serialization
- accounting-invariant property tests cover duplicate and order
  semantics plus tally/count consistency
- ImageID trust material and provenance match any changed guest image
- public bundle boundaries still exclude private artifacts
- required verification checks remain fail-closed in API and UI paths
- the relevant TypeScript, Rust, formal, CLI, production-proof, and UI
  gates have been run or explicitly deferred with a documented reason

## Initial Benchmark Baseline - 2026-06-21

First local production-guest baseline before optimization work:

- source commit: `83dbc5e6`
- environment: WSL2 Linux x86_64, Intel Core i7-10700F, 16 logical CPUs
- toolchain: `rustc 1.91.1`, `cargo 1.91.1`, `cargo-risczero 3.0.5`
- build: `cd zkvm && cargo build --release --bin host`
- guest: methodVersion `14`, local ImageID
  `0xf980c152af5270a652de2357620076f635b9935f203bdb9334cab57d3138bebb`
- command: `env -u RISC0_DEV_MODE /usr/bin/time -v ./target/release/host /tmp/zkvm-bench-64.json`
- fixture: generated 64-vote S0-style input, `treeSize=64`,
  `totalExpected=64`, all 64 votes valid
- result: wall `7:16.36`, user `6463.94s`, system `39.98s`,
  CPU `1490%`, max RSS `9608532 KB`
- artifacts: output `2351` bytes, receipt `6911716` bytes, included
  bitmap `844` bytes, seen bitmap `832` bytes
- receipt check:
  `./target/release/verifier-service verify /tmp/zkvm-bench-64-receipt.json --image-id 0xf980c152af5270a652de2357620076f635b9935f203bdb9334cab57d3138bebb`
  returned `status: success`, `duration_ms: 76`,
  `dev_mode_receipt: false`

Supplemental small-fixture measurement: the checked-in 8-vote fixture
ran in production mode with wall `1:06.82`, user `969.94s`, max RSS
`4797136 KB`, and receipt size `1728701` bytes.

Limitations: this pass used direct `host` execution, not the full CLI
flow; guest cycle checkpoints, SHA precompile activity, host JSON
parse/serialization timing, process-startup overhead, and repeated
median/tail latency are not yet captured. The measured local ImageID is
benchmark evidence only and was not synchronized into
`public/imageId-mapping.json`.

## Pre-Post-Change Benchmark Status - 2026-06-21

Implemented before the next benchmark run:

- client bitmap proof verification now binds the proof to the
  receipt-authenticated logical `treeSize`
- non-safe, negative, and out-of-range bit indices fail closed before
  proof evaluation
- expected sibling count and left/right direction are derived locally
  from `(bitIndex, treeSize)`; missing, extra, and wrong-direction
  siblings fail closed
- nonzero unused padding bits in the final partial bitmap leaf fail
  closed when authenticated `treeSize` is available
- `/api/bitmap-proof` now recomputes stored included/seen sidecar roots
  and compares them with the finalized journal roots before serving a
  proof
- normal `/api/bitmap-proof` usage now rejects requested indices other
  than the session user's vote index; no arbitrary-index debug/operator
  path is part of the current contract
- sidecar `treeSize`, bitmap length, and finalized journal `treeSize`
  must match before proof service use
- `counted_my_vote_included` requires authenticated `treeSize` before
  running bitmap proof verification, so missing tree-size evidence cannot
  produce success
- production guest entrypoint now uses an output-only tally path that
  avoids constructing inspection-only `vote_outcomes`
- inspection-only guest tally tests still exercise the detailed rejection
  reasons and prove the output-only path returns the same
  `VerificationOutput`
- input commitment encoding now uses a sorted-input fast path that avoids
  allocating and sorting an index vector when the submitted records are
  already in canonical order
- aggregate Merkle path-node and serialized/structural input byte work
  budgets are enforced in TypeScript preflight, the Rust host before
  executor construction, and the guest after deserialization
- TypeScript proof execution now rejects malformed Rust-wire numeric
  values before serialization and host spawn while preserving
  guest-accounted invalid record outcomes that remain wire-representable
- the STH timestamp contract is documented and tested as Unix timestamp
  milliseconds across TypeScript and Rust
- shared Rust domain wrappers now bind non-empty tree sizes, in-range
  bulletin indices, and RFC 6962 audit-path shape before inclusion proof
  folding
- bitmap vector evidence now covers 511/512/513-bit, three-leaf, and
  five-leaf promoted-tree shapes, with TypeScript/Rust root and proof
  parity fixtures
- the current methodVersion `14` ImageID mapping retains the locally
  refreshed x86_64 ImageID and, after later target-account prover evidence,
  the default/ARM64 ImageID used by the develop app handoff path
- verify-page summary handling now treats admitted development-mode
  receipts as `Demo only`, not `Verified`
- zk-derived verification checks use demo evidence labels when a
  development-mode receipt is admitted
- zk-derived development-mode rows now use demo/warning row styling
  instead of verified/success-equivalent badges or icons
- English and Japanese verify-page copy no longer claims broad fraud
  absence in the verified state and no longer labels exclusion outcomes
  as detected fraud
- counted-as-recorded UI copy now describes bitmap evidence as
  authenticated 32-byte leaf evidence plus selected-bit interpretation

Current verification evidence:

- `pnpm vitest run packages/verification/src/merkle/bitmap-merkle-tree.property.test.ts packages/verification/src/merkle/__tests__/bitmap-merkle-tree.test.ts packages/verification/src/verification/__tests__/bitmap-verifier.test.ts packages/verification/src/verification/build-verification-checks.test.ts apps/api/src/server/api/routes/hono.public-contract.test.ts`
- `pnpm vitest run scripts/api-contract/public-contract-baseline.test.ts`
- `pnpm vitest run packages/verification/src/verification/__tests__/image-id-mapping.test.ts packages/verification/src/verification/__tests__/image-id-verifier.test.ts packages/verification/src/verification/__tests__/expected-image-id.test.ts`
- `pnpm vitest run packages/verification/src/verification/__tests__/verification-summary.test.ts packages/verification/src/verification/build-verification-checks.test.ts apps/web/src/routes/verify/lib/overall-status.test.ts apps/web/src/components/verification/UnifiedVerificationCard.test.tsx apps/web/src/i18n/translation-consistency.test.ts`
- `pnpm test:run`
- `pnpm format:check`
- `pnpm lint`
- `pnpm type-check`
- `cd zkvm && cargo fmt --check`
- `cd zkvm && cargo test`
- `cd zkvm && cargo clippy -p guest --all-targets -- -D warnings`
- `cd zkvm && RISC0_SKIP_BUILD=1 cargo clippy -p host -- -D warnings`
- `cd zkvm && cargo build --release --bin host`
- `cd zkvm && ./target/release/host --print-image-id --json`

The unskipped host clippy command is intentionally not the gate for this
plan: it re-enters the RISC Zero build script and invokes clippy for the
guest target (`riscv32im-risc0-zkvm-elf`) from the host package path. The
guest target itself built successfully through `cargo build -p methods`
and the release host build above; guest clippy and skipped-build host
clippy are tracked as separate gates.

## Post-Change Benchmark Evidence - 2026-06-21

Local x86_64 production-guest measurement after the bitmap, guest,
typing, ImageID, and verification hardening work:

- source state: local hardening worktree on `83dbc5e6dafa`
- environment: WSL2 Linux x86_64, Intel Core i7-10700F, 16 logical CPUs
- toolchain: `rustc 1.91.1`, `cargo 1.91.1`, `cargo-risczero 3.0.5`
- build: existing release host and verifier-service binaries from the
  current local worktree
- guest: methodVersion `14`, local ImageID
  `0xf0ea09b47949a8610f4ba13e5ec36d791983edb899d62eed21bf5bfb6f54e94b`
- command:
  `env -u RISC0_DEV_MODE /usr/bin/time -v ./target/release/host /tmp/zkvm-bench-64.json`
- fixture: generated 64-vote S0-style input, `treeSize=64`,
  `totalExpected=64`, all 64 votes valid
- result: wall `7:19.52`, user `6531.95s`, system `44.81s`,
  CPU `1496%`, max RSS `9616708 KB`
- artifacts: output `2351` bytes, receipt `6912240` bytes, included
  bitmap `844` bytes, seen bitmap `832` bytes
- receipt check:
  `./target/release/verifier-service verify /tmp/zkvm-bench-64-receipt.json --image-id 0xf0ea09b47949a8610f4ba13e5ec36d791983edb899d62eed21bf5bfb6f54e94b`
  returned `status: success`, `duration_ms: 76`,
  `dev_mode_receipt: false`

Supplemental small-fixture measurement: the checked-in 8-vote fixture
ran in production mode with wall `1:06.06`, user `970.17s`, system
`7.39s`, CPU `1479%`, max RSS `4797296 KB`, output size `2336` bytes,
and receipt size `1728493` bytes. Verifying the resulting receipt with
the same ImageID returned `status: success`, `duration_ms: 18`, and
`dev_mode_receipt: false`.

The 64-slot result is roughly unchanged from the initial local baseline
(`7:16.36` before, `7:19.52` after) and does not show a meaningful
local production-proof regression. The 8-vote result is also roughly
unchanged (`1:06.82` before, `1:06.06` after).

The post-change measurement used direct `host` execution, not the full
CLI flow. Guest cycle checkpoints, SHA precompile activity, host JSON
parse/serialization timing, process-startup overhead, and repeated
median/tail latency are still unavailable from the current host CLI. The
benchmark closes the local production-proof evidence gap for the current
64-slot demo shape; it does not provide independent ARM64 ImageID
reproducibility evidence.

Active local x86_64 ImageID trust material is refreshed for the current
guest image. This benchmark record did not itself provide independent ARM64
ImageID reproducibility evidence; later target-account prover evidence
refreshed the current default/ARM64 mapping used by the develop app handoff
path.

The benchmark command used for the 64-slot evidence was:

```bash
cd zkvm
env -u RISC0_DEV_MODE /usr/bin/time -v ./target/release/host /tmp/zkvm-bench-64.json > /tmp/zkvm-bench-64-post-guest-optimization.log 2>&1
```
