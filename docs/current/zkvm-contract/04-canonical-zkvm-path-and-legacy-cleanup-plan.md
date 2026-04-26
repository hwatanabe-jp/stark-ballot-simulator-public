# Canonical zkVM Path and Legacy Cleanup Plan

> **Status: refreshed after the 01-03 cutover.** This document now
> reflects the current repository state after the generation boundary,
> authority, and public-contract work landed. It is a cleanup and
> canonicalization plan, not a completion memo.

## Purpose

This document defines the cleanup and canonicalization work that follows
the current-contract hardening plans.

Its job is no longer to speculate abstractly about a future cleanup. It
now names the concrete architectural convergence work that should happen
in the current repository once the boundary, authority, and public
contract are already stable.

In particular, this document is where the repository commits to:

- deleting dead or legacy tree paths instead of preserving them for
  backward compatibility
- simplifying the runtime model so one canonical path is obvious
- improving cross-language consistency between Rust and TypeScript
- concentrating deeper test investment on the intentionally canonical
  implementations that remain

This plan is organized around five implementation workstreams (`WS1`
through `WS5`) plus a cross-cutting evidence and CI track. The
workstreams are the delivery shape; the evidence strategy remains
cross-cutting and attaches to the workstream that makes a path
canonical.

## This Doc Decides

- what the canonical implementation path is for contract-critical zkVM
  logic after 01-03
- how the supported app verification path is distinguished from
  tooling-only verifier entrypoints after 01-03
- which TypeScript domains remain intentionally canonical
- which legacy or duplicate paths become explicit deletion targets
- how cleanup work should be sequenced into workstreams without losing
  deletion pressure or evidence quality
- what the canonical shared ImageID resolution policy target is after
  caller-specific heuristics are removed
- what parity-vector and property-based evidence is worth keeping after
  cleanup

## This Doc Does Not Decide

- the active generation boundary
- the public wire contract for unsupported, corrupt, or capability-loss
  state
- temporary migration behavior needed only to complete the first three
  plans
- whether a future product scope change should reintroduce currently
  deleted compatibility paths

## Current Repository Interpretation

### CT Bulletin Path Is Already the Product Story

- The current user-facing recorded-as-cast and append-only verification
  story is RFC 6962 / CT based.
- `rootAtCast`, inclusion proofs, consistency proofs, and STH snapshots
  belong to the bulletin-board path.
- Cleanup should therefore make the CT bulletin path structurally
  obvious instead of preserving parallel tree models that tell a
  different story.

### Fixed-Depth SHA-256 Session Trees Are Now Legacy

- The older fixed-depth SHA-256 session-tree stack is no longer the
  canonical contract path.
- It should be treated as deletion-bound compatibility code, not as a
  second first-class implementation.
- Parts of the session and store layers still carry it today, so cleanup
  must cut real consumers first and only then delete the stack.
- Keeping both the CT bulletin model and the fixed-depth session-tree
  model alive invites ambiguity, duplicate tests, and accidental
  fallback behavior.

### Public-Input Authority Cutover Is Complete

- The repository now treats `publicInputArtifact` as the public-input
  authority across persistence, restore, and supported current reads.
- `PublicInputSummary` is an internal adapter only.
- Cleanup should continue shrinking adapter-shaped internal code rather
  than letting the adapter remain a hidden long-term authority model.

### Authenticated Bundle-Backed Verification Is the Authoritative App Path

- The supported application contract is authenticated bundle-backed
  verification selected by session context plus
  `verificationExecutionId`.
- That app path may execute through `verifier-service-runner` for S3-
  backed bundles or through direct `verifier-service` invocation for
  trusted local bundles.
- `verifier-service-runner` payload `mode = direct` remains a bounded
  tooling or bridge path, not public selector authority and not a
  second production verification model.
- Legacy raw download URL fields such as `verificationBundleUrl` and
  `verificationReportUrl` are removed from current sync finalize
  responses and CLI-facing merged artifacts.
- Where S3 bundle metadata still surfaces on explicit current routes, it
  remains bounded storage metadata rather than selector authority or the
  target public contract.
- Cleanup should remove assumptions that blur the trusted local-bundle
  app path with runner direct mode or keep runner direct looking like an
  equal public authority path.

## Canonical Contract Path

### Canonical Session and Bulletin Path

- Session-scoped vote casting and cast-time proof capture should have
  one authoritative tree model: the CT bulletin board path.
- `rootAtCast`, inclusion proof identity, consistency proof identity,
  and historical roots should derive from bulletin-board state and
  stored CT artifacts, not from a secondary fixed-depth session tree.
- `session.merkleTree` and similar parallel state are not part of the
  desired long-term architecture.

### Canonical Rust Contract Owner

- Contract-critical Rust logic should converge on one shared contract
  core at least for host and guest semantics.
- The shared Rust owner should cover the logic that currently risks
  semantic drift when copied by hand, especially:
  commitment computation, input-commitment encoding, CT inclusion-proof
  folding, bitmap root construction, and contract-critical data shapes.
- Verifier-side Rust code should consume shared contract or trust-chain
  helpers when it truly needs them, rather than quietly redefining them
  locally.

### Bounded Canonical TypeScript Domains

- TypeScript remains intentionally canonical only where the browser or
  app runtime genuinely needs native implementation.
- After cleanup, the intended canonical TypeScript domains are:
  browser or app-side CT append-only verification, browser or app-side
  bitmap proof verification, and the TypeScript semantic owner for the
  supported `public-input.json` contract.
- TypeScript helpers that duplicate deprecated fixed-depth tree logic or
  obsolete compatibility semantics do not remain canonical.

### Canonical Trust-Chain Ownership

- Supported finalized authority should continue to center on explicit
  top-level owners such as `verificationExecutionId`, `s3BundleKey`,
  `publicInputArtifact`, and the proof-bound journal.
- Report delivery should remain scoped by
  `verificationResult.s3ReportKey` under that same `(sessionId,
verificationExecutionId)` authority rather than becoming an
  independent selector model.
- Raw URLs, mirror fields, and caller-specific heuristics should not
  remain alternate authority.
- Bundle and report locators may remain server-side storage metadata,
  but they are authoritative only when they stay consistent with the
  scoped finalized authority.
- ImageID resolution should converge on one shared resolver with
  explicit variant ownership rather than retaining caller-specific auto-
  selection behavior.
- Because ImageID legitimately differs by built guest binary and runtime
  environment, canonicalization does not mean one repository-wide fixed
  ImageID value.
- The canonical contract is one shared selection policy:
  active `methodVersion` plus explicit variant ownership resolves the
  expected ImageID for the relevant execution environment.
- Architecture-specific or environment-specific variants should be
  chosen only through explicit configuration or an equally explicit
  runtime boundary, and unavailable chosen variants fail closed.

## Cleanup Targets

### Delete the Fixed-Depth SHA-256 Tree Stack

- Delete the fixed-depth SHA-256 session-tree path once the session and
  store layers no longer rely on it.
- Delete associated compatibility-only inclusion-proof and consistency-
  proof helpers that exist only to support that stack.
- Delete characterization-only scaffolding that exists purely to prove
  compatibility with the deleted stack once safe removal is complete.

### Delete Parallel Session-Tree State

- Remove `session.merkleTree` and equivalent per-store rebuilding of a
  second tree only after every supported store and runtime can persist
  or reconstruct cast-time proof identity from the CT bulletin path
  itself.
- Do not delete the legacy tree while any supported writer still relies
  on it to mint `rootAtCast`, inclusion-proof identity, or equivalent
  cast-time evidence when bulletin state is absent.
- Remove fallback derivations of `rootAtCast` or proof material from the
  fixed-depth tree once the bulletin path is the only supported owner of
  that identity.
- Keep only the session data that materially serves the CT bulletin
  model and current verification flow.

### Shrink Compatibility Adapters and Mirrors

- Move current server-side verification flows toward direct use of
  `publicInputArtifact` typed authority plus provenance instead of
  carrying `PublicInputSummary` deeper into the runtime.
- Until the verification engine accepts typed authority directly,
  `PublicInputSummary` remains a bounded internal adapter derived from
  `publicInputArtifact` at the boundary, not a parallel authority model.
- No new supported server flow should introduce fresh semantic
  dependence on `PublicInputSummary`; migration should keep summary-
  shaped usage flat or shrinking, not expanding.
- Continue shrinking journal-derived compatibility mirrors and finalize-
  time raw download projections such as `verificationBundleUrl` and
  `verificationReportUrl` once current consumers no longer need them.
- In the current repository, those raw URL fields still exist as
  compatibility projections in sync finalize responses and CLI/report
  handling, so cleanup must remove the remaining consumers before the
  fields themselves are deleted.
- Keep compatibility parsing at boundaries only; do not let transitional
  shapes become the internal default model.

### Separate App Verification From Runner Direct Mode

- Keep authenticated bundle-backed verification as the only supported
  app selector contract.
- Treat trusted local bundle verification inside the app as one
  implementation of that contract, not as a second selector model.
- Isolate `verifier-service-runner` direct payload mode and
  `VerifierServiceRunnerDirectPayload` to intentionally maintained
  tooling or bridge surfaces, or delete them if no maintained caller
  remains.

### Remove Caller-Specific ImageID Policy Branches

- Consolidate ImageID resolution policy so app/runtime paths, CLI flows,
  and helper scripts all call the same shared resolver and explicit
  variant contract.
- Treat ImageID selection as `methodVersion + variant` resolution, not
  as selection of one repository-wide fixed value.
- Remove per-caller auto-selection branches that choose different
  variants for the same execution context, such as the current
  app/runtime WSL-sensitive branch and the CLI's local `x64` preference.
- Remove compatibility fallbacks that turn mapping or variant resolution
  failure into implicit success-shaped defaults, including
  `DEFAULT_POC_IMAGE_ID` fallback behavior once the shared resolver
  contract is in place everywhere that matters.
- Fail closed when the chosen shared policy cannot resolve the expected
  ImageID for the active current contract.

### Isolate or Delete Experimental Non-Production zkVM Paths

- Experimental or benchmark-only zkVM paths that are not part of the
  supported contract story should be isolated from the main production
  narrative.
- If those paths are not intentionally maintained, removal is preferable
  to letting them look canonical by accident.

## Workstream Structure

Cleanup proceeds through five workstreams rather than a larger number of
small batches. The goal is to keep each workstream accountable for one
coherent convergence step while preserving deletion pressure and
evidence quality.

The intended execution order is:

1. `WS1` establishes the aligned current-contract baseline.
2. `WS2` removes the legacy session-tree path and narrows the
   intentional TypeScript surface to the CT-first runtime path.
3. `WS3` aligns canonical vocabulary, shrinks pre-shared-core
   compatibility residue, and fixes the extraction boundary for the
   later shared Rust core.
4. `WS4` converges Rust host and guest semantics on a shared contract
   core.
5. `WS5` cleans up trust-chain ownership, ImageID policy, adapter
   residue, and remaining public-contract compatibility projections.

`WS2` and `WS3` may overlap once `WS1` has closed known contract drift,
but `WS4` should begin only after `WS3` has fixed the intended shared-
core boundary, and `WS5` should begin only after the prior work no
longer depends on the deleted or compatibility-only paths it intends to
retire.

### WS1: Contract Drift Alignment and Canonical Baseline

> **Status: implemented (commit `f0d6456`).** Input-commitment canonical
> ordering (index → commitment bytes → Merkle path bytes) is aligned
> across TypeScript and Rust, parity vectors are refreshed on both
> sides, and the initial input-commitment PBT has landed.

- close any active TypeScript or Rust drift in contract-critical current
  semantics before wider cleanup lands
- align input-commitment ordering and tie-break behavior, CT proof
  folding rules, and bitmap hashing or proof rules wherever both
  languages implement the same current contract
- refresh parity vectors and regression coverage from the aligned
  behavior before deletion-oriented workstreams continue
- land the initial input-commitment PBT needed to expose ordering or
  duplicate-index drift before larger refactors hide the source of a
  mismatch
- do not defer a known current-contract mismatch behind tree deletion or
  larger refactors

Implementation note for the current repository baseline:

- the active WS1 semantic drift was in input-commitment ordering and
  duplicate-index tie-break behavior
- current CT inclusion-proof folding and bitmap hashing already matched
  across the maintained TS and Rust paths, so WS1 evidence there is
  exact parity or regression coverage refresh rather than a semantic
  contract change
- broader CT append-only and bitmap PBT investment still lands in `WS2`
  as planned once the surviving canonical paths are smaller and more
  explicit

### WS2: CT-Only Session and Store Simplification

> **Status: implemented (commit `16dfb94`).** `session.merkleTree` and the
> `@zk-kit/incremental-merkle-tree` dependency are gone, the fixed-depth
> SHA-256 stack (`sha256MerkleTree`, `proof`, `sha256-consistency-proof`)
> is deleted, and all stores (amplify/fileMock/mock) converge on
> `ctSessionState` + `stagedCtWrite`. Bulletin/progress handlers and the
> zkVM input builder use the canonical snapshot helpers. CT append-only
> and bitmap PBT coverage has landed on the surviving canonical
> implementations.

- make the bulletin-board path the only authoritative cast-time tree
  model in session and store code
- begin deletion of session-tree state only after supported stores no
  longer require fixed-depth fallback to mint cast-time roots or proof
  identity
- remove `session.merkleTree` and equivalent store-local rebuild paths
- stop deriving cast-time roots or proof identity from the fixed-depth
  SHA-256 tree stack
- delete fixed-depth SHA-256 tree helpers and deprecated proof helpers
  after the session and store layers no longer consume them
- collapse duplicate TypeScript hashing or chunking logic in bitmap and
  CT-related helpers where the runtime still needs a native
  implementation
- keep the intentionally canonical TypeScript path small and explicit
- keep only the characterization coverage needed to delete the old tree
  path safely
- attach the main CT append-only and bitmap PBT investment to the
  canonical implementations that survive this workstream, not to helpers
  already marked for deletion

### WS3: Canonical Vocabulary and Pre-Shared-Core Cleanup

> **Status: implemented (commit `b63ca9b`).** Maintained paths use
> RFC 6962 / CT vocabulary, internal proof handling converges on a
> canonical RFC 6962 adapter, `verifier-service-runner` direct payload
> mode is deleted (no maintained caller remained), and the shared-core
> law inventory plus Rust-side property harness are in place for `WS4`.

- align intentionally maintained repository vocabulary on RFC 6962 / CT
  terminology and remove current-path `Google` naming where it implies
  a second semantic model rather than historical provenance
- shrink proof-shape and tooling-shape compatibility residue before
  shared-core extraction so the current canonical path is easier to name
  and harder to misread
- treat `proofMode` as a boundary-compatibility field only while
  current public schemas still surface it; internal canonical paths
  should not preserve fresh semantic branching on a field whose only
  supported value is `rfc6962`
- inventory and isolate `verifier-service-runner` direct payload mode
  and similar bridge-only surfaces so `WS4` extracts the shared Rust
  core against the supported app path, not against transitional tooling
- fix the extraction boundary for `WS4` by naming what belongs in the
  shared Rust contract core versus host-only, guest-only, verifier-
  service-only, or tooling-only code
- prepare the Rust-side property-testing harness and law inventory
  around that shared-core target so generative coverage lands on the
  owner that survives cleanup
- do not use this workstream to reopen the public route contract,
  retire boundary fields that current clients still require, or preempt
  the trust-chain cleanup reserved for `WS5`

### WS4: Shared Rust Contract Core

> **Status: implemented (commit `654ba8e`).** Commitment, canonical
> input-commitment encoding, RFC 6962 inclusion-proof folding, bitmap
> root helpers, and contract-critical types live in a dedicated no_std
> `zkvm/contract-core/` crate. Host and guest consume that shared owner
> directly, the transitional `pub use` re-exports are gone, and the
> Rust property and compatibility tests import from `contract_core::*`
> so the shared crate is the only canonical owner.

- extract a shared Rust contract core for host and guest
- move duplicated host and guest helpers onto that core
- reduce handwritten duplicate definitions of contract-critical types
  and helpers
- leave verifier-service-specific bundle or receipt orchestration code
  outside that core unless it truly owns shared contract semantics
- refresh exact parity vectors and Rust-side property coverage from the
  shared owner whenever practical
- continue the cross-language input-commitment and contract-core
  hardening work after the shared owner lands so Rust and TypeScript do
  not silently drift again

### WS5: Trust-Chain and Adapter Cleanup

> **Status: implemented (commit `7f1d1df`).** ImageID resolution now flows
> through one shared explicit variant policy across app, CLI, and helper
> tooling; implicit resolver fallback to `DEFAULT_POC_IMAGE_ID` is
> removed; maintained current responses no longer rely on public
> `proofMode` or legacy `verificationBundleUrl` /
> `verificationReportUrl` compatibility projections; and the journal
> invariant property test has landed on the surviving current contract
> surface.

- unify ImageID resolution policy across app, CLI, and helper tooling
  around one shared explicit variant resolver keyed by current
  `methodVersion` plus selected variant, not around one globally fixed
  ImageID
- remove compatibility fallback behavior that hides ImageID resolution
  failure behind implicit defaults such as `DEFAULT_POC_IMAGE_ID`
- keep authenticated bundle-backed verifier-service verification as the
  authoritative app path, whether backed by S3 runner execution or
  trusted local bundle invocation
- isolate or remove runner direct payload mode where it is not an
  intentionally maintained tooling surface
- retire compatibility-only proof-shape fields such as `proofMode` only
  after browser, CLI, schemas, fixtures, and docs no longer rely on
  them at public boundaries
- reduce remaining compatibility-only raw URL, mirror-field, and
  adapter-field assumptions, including finalize-time download
  projections once current consumers no longer need them
- explicitly retire `verificationBundleUrl` and `verificationReportUrl`
  only after browser, CLI, schemas, fixtures, and docs no longer rely on
  them as compatibility output
- continue shrinking `PublicInputSummary` toward a bounded edge adapter
  so supported server code prefers direct authority-shaped finalized
  models end-to-end, with compatibility handling confined to parse or
  serialization boundaries
- complete the journal or count invariant evidence and the remaining
  schema, fixture, and compatibility-field cleanup needed for the
  steady-state current contract, without reopening the public route
  contract established by 03

## Cross-Workstream Evidence and CI Track

Fixture, PBT, and CI consolidation are not cleanup afterthoughts and
not a sixth implementation workstream. They are the standing evidence
track that follows the canonical path as it becomes smaller and more
explicit.

- align parity vectors, fixtures, and CI checks with the canonical path
  that remains
- retire fixtures that only describe deleted implementations
- increase generative coverage for the intentionally canonical
  implementations that survive cleanup
- keep deletion-bound helpers on minimal characterization coverage only
- promote shrunk counterexamples into checked fixtures, vectors, or
  targeted regression tests before later workstreams continue
- finish the last CI and fixture pruning only after `WS5` settles the
  steady-state current contract surface

## Evidence Strategy

The evidence model in this document is not decorative. It is part of
how the repository earns confidence that the paths it keeps as canonical
are actually robust under edge cases, not just cleanly described.

### Exact Parity Vectors

- Keep exact-value TypeScript and Rust parity vectors for contract-
  critical helpers that still have both-language implementations.
- Generate or refresh those vectors from the canonical owner whenever
  practical.
- Do not let one-off scripts or handwritten compatibility tests become
  permanent alternate authorities for vector generation.
- The main refresh points are `WS1` before deletion-oriented work starts
  and `WS4` after shared Rust ownership changes what the canonical owner
  is.

### Property-Based Testing for CT Append-Only Logic

- Property-test the canonical CT implementation for random leaf
  sequences, historical tree sizes, and odd-size trees.
- Cover at least these properties:
  inclusion proof round-trip succeeds for every generated leaf, proof
  tampering fails, consistency proof succeeds for every
  `oldSize <= newSize`, and tampered consistency proofs fail.
- Explicitly retain odd-tree and promoted-right-edge cases such as 3, 5,
  and 7 leaves in the permanent regression corpus.
- The main landing point for this investment is `WS2`, because that is
  where the surviving canonical CT path becomes explicit.

### Property-Based Testing for Bitmap Root and Proof Logic

- Property-test bitmap packing, chunking, Merkle proof generation, and
  verification for random bitmap lengths and random bit indices.
- Cover at least these properties:
  extracted bit equals the source bitmap value, proof round-trip
  succeeds, tampered chunk or audit path fails, and single-leaf versus
  multi-leaf boundaries stay stable.
- Keep explicit boundary emphasis around 0, 1, 7, 8, 255, 256, 257,
  511, and 512 bits.
- The main landing point for this investment is also `WS2`, where the
  canonical TypeScript bitmap path is intentionally kept and duplicate
  compatibility logic is removed.

### Property-Based Testing for Input-Commitment Encoding

- Property-test that input commitment is invariant under permutation of
  votes that should compare equal after canonical ordering.
- Property-test deterministic ordering behavior when duplicate indices
  exist, using the same tie-break semantics in both TypeScript and Rust
  for the active current contract.
- Property-test that changing any authoritative encoded field changes
  the resulting commitment unless the change is intentionally normalized
  away by the canonical encoding rules.
- This work starts in `WS1` to expose current drift early and continues
  in `WS4` once the shared Rust contract core becomes the long-term
  owner.

### Property-Based Testing for Journal and Count Invariants

- Property-test the current journal invariants that must hold for
  supported current semantics.
- Cover at least these properties:
  `validVotes + invalidPresentedSlots + missingSlots = treeSize`,
  `excludedSlots = missingSlots + invalidPresentedSlots`, and
  `rejectedRecords >= invalidPresentedSlots`.
- Keep deterministic regression fixtures for any previously found
  counterexamples involving duplicates, out-of-range records, or mixed
  valid and invalid presented slots.
- This coverage is typically completed in `WS5`, because it depends on
  the supported trust-chain and adapter cleanup path that survives the
  earlier workstreams.

### Counterexample Promotion Rule

- Shrunk counterexamples found by PBT should not remain ephemeral local
  failures.
- Promote them into checked fixtures, vectors, or targeted regression
  tests so the permanent corpus becomes stronger over time.
- Do not invest heavy PBT in helpers scheduled for deletion; keep those
  on minimal characterization coverage only.
- Promotion should happen inside the same workstream that found the
  counterexample, before later deletion or cleanup obscures the root
  cause.

## Architectural Consequences

- The repository should become easier to explain: one CT bulletin path,
  one supported public-input authority model, one authoritative app
  verifier path, and one shared Rust contract owner for the core logic
  that must not drift.
- Store and session code should become smaller because they no longer
  maintain a second tree model just to preserve legacy proof behavior.
- Cross-language review becomes easier when Rust and TypeScript no
  longer each carry avoidable duplicate implementations of the same
  semantics.
- Fail-closed behavior becomes easier to preserve when compatibility
  branches stop minting alternate authority or silently reviving deleted
  paths.

## Completion Criteria

- there is one clear canonical session and bulletin path for cast-time
  proof identity
- contract-critical current semantics match across TypeScript and Rust,
  including input-commitment ordering and duplicate-index tie-break
  behavior
- fixed-depth SHA-256 tree paths and other dead tree code have been
  deleted rather than preserved for backward compatibility
- host and guest no longer retain handwritten duplicate contract-
  critical Rust helpers where a shared owner should exist
- intentional native TypeScript domains are explicit, small, and backed
  by the right parity-vector and PBT investment
- `PublicInputSummary` remains, at most, a bounded edge adapter rather
  than a hidden long-term authority model
- authenticated bundle-backed verification is the only supported app
  selector model, and trusted local bundle verification is not confused
  with runner direct mode
- raw URL compatibility projections no longer shape the supported public
  contract
- ImageID resolution follows one shared explicit
  `methodVersion + variant` policy across app, CLI, and helper tooling
- ImageID resolution failure no longer falls back to implicit defaults
  such as `DEFAULT_POC_IMAGE_ID`
- `verifier-service-runner` direct mode is not quietly preserved as
  shadow production authority
