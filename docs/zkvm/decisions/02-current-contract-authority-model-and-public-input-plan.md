# Current Contract Authority Model and Public-Input Plan

> **Status: Coordinated `1.1 + contractGeneration` cutover implemented**
> (commit `3a02a08`). The repository now treats `publicInputArtifact` as
> the only persisted and restored public-input authority, requires
> explicit `contractGeneration` at finalized and bundle-generation write
> boundaries, and classifies pre-cutover finalized wrappers as
> `unsupported_current_artifact` when their wrapper generation remains
> readable. This doc remains the decision record for the authority and
> public-input contract; subsequent plans build on top of it.

## Cutover Completion Memo

- Introduced one internal `public-input` contract model that separates
  typed input-side authority, compatibility markers, and provenance.
- Kept `PublicInputSummary` only as an internal adapter for in-memory
  verification inputs; it no longer defines persisted, restore, or
  public API boundaries.
- Moved sync bundle generation, S3 restore, and local bundle restore
  onto the same canonical parser path for current `public-input.json`
  acceptance.
- Moved `GET /api/zkvm-input-hash` onto a shared canonical
  private-input build-and-validate helper so it no longer preserves its
  own acceptance contract.
- Closed the coordinated cutover by bumping the current
  `contractGeneration`, requiring it at finalized and bundle-generation
  write boundaries, and classifying stale readable wrappers separately
  from current corrupt wrappers.
- The current boundary now resolves to `2026-04-zkvm-current-v3`; tests
  keep `v2` as the last readable stale generation so boundary
  classification stays covered after the cutover.

## Purpose

This document defines the authority model inside the generation boundary
established by the boundary plan.

Its job is to make one semantic owner, one typed persisted authority
model, and one supported `public-input.json` contract explicit for
current readers and writers.

## This Doc Decides

- which fields and artifacts hold authority for current
  public-input-derived semantics
- the supported `public-input.json` contract
- how parsing, persistence, provenance, selector ownership, and
  bundle-location ownership are separated
- how consumers migrate away from cross-boundary `PublicInputSummary`
  semantics

## This Doc Does Not Decide

- route-specific stale-state matrices or wire contracts
- browser restore and polling behavior as user-visible API behavior
- canonical cleanup and deletion targets after hardening
- the shared Rust contract core

## Authority Map

### Typed Input-Side Authority

- Parsing supported `public-input.json` yields dedicated typed
  input-side authority used for current authoritative checks.
- The first-phase minimal typed authority is limited to the field set
  that currently feeds authoritative checks:
  `electionId`, `electionConfigHash`, `methodVersion`, `bulletinRoot`,
  `treeSize`, `totalExpected`, `votesCount`, `uniqueIndices`,
  `uniqueCommitments`, `logId`, `timestamp`, and
  `recomputedInputCommitment`.
- This typed authority does not own compatibility markers such as
  `schema`, `version`, or `contractGeneration`.

### Compatibility Marker

- Parsed `public-input.json` compatibility markers own `schema`,
  `version`, and `contractGeneration` on the artifact itself.
- Those markers describe compatibility state, but they do not own
  proof-bound output, selector authority, or persisted boundary
  authority.

### Provenance Authority

- Provenance explicitly owns whether persisted public-input-derived
  authority came from sync-generated output, bundle restore, or a later
  equivalent trusted origin.
- Transitional provenance markers may exist during migration, but the
  target model is one explicit provenance owner rather than loose
  `source` semantics.

### Selector Authority

- The canonical selector owner is persisted
  `verificationExecutionId` on supported finalized authority.
- Tombstone-only diagnostics may retain stale execution identity for
  explanation, but that does not become selector authority.

### Bundle-Locator Authority

- The canonical persisted bundle-locator owner is one dedicated field.
- In the current repository, that owner is top-level `s3BundleKey`.
- Runtime-local filesystem paths such as local `bundlePath` remain
  process-local convenience only; they are not persisted
  bundle-locator authority.

## Supported `public-input.json` Contract

### Supported Shape

- `public-input.json` is the primary public-artifact carrier for
  `contractGeneration` across sync and async bundle paths.
- The steady-state supported shape is:
  `schema = stark-ballot.public_input`, `version = 1.1`, plus required
  top-level `contractGeneration`.
- In the current repository, this cutover spans more than one emitter
  and validator: the canonical TypeScript parser, the sync bundle
  writer, the async bundle writer, and the async artifact validator.
- Steady-state `1.1` support is not achieved by updating only one of
  those surfaces. The supported-current rollout requires all of them to
  accept and emit the same `1.1 + contractGeneration` shape within the
  same rollout window before strict rejection becomes safe.

### Required Interpretation

- Supported parsing produces two products:
  one typed input-side authority and one compatibility marker.
- Bundle restore must parse `public-input.json` first, before later
  readers touch derived execution metadata or mirror fields.

### Unsupported Shapes

- Legacy or partial shapes from older generations are not supported as
  current authority. If the finalized wrapper still exposes a readable
  stale generation, they fail closed as
  `unsupported_current_artifact` rather than as successful current
  data.
- Current-generation wrappers that cannot restore supported authority
  fail closed as `corrupt_or_unreadable`.
- Parsed `public-input.json.contractGeneration` may corroborate restore
  eligibility, but it must not backfill missing persisted authority or
  overrule runtime current generation plus carried write markers.

## Parsing and Persistence Model

### Parse Once, Normalize Once

- Finalize-time and restore-time public-artifact handling normalize once
  into typed authority or unsupported state.
- Later steady-state readers do not attempt ad hoc repair by re-parsing
  raw public artifacts, minting missing identifiers, or reconstructing
  supported authority from partial artifact sets.

### Typed Authority vs Compatibility Marker

- Typed input-side authority owns current public-input-derived fields
  used for authoritative checks.
- Compatibility markers remain separate so readers do not smuggle
  `schema`, `version`, or `contractGeneration` through business fields
  that are supposed to represent supported authority.

### No Reader-Side Repair

- `verificationResult`, `finalizationState`, raw URLs, restore-time path
  parsing, and similar mirrors are projections only.
- They must not mint or repair selector authority, bundle-locator
  authority, or supported typed authority when the canonical owner is
  absent.

## Semantic Ownership

### One TypeScript Semantic Owner

- The repository should designate one canonical TypeScript semantic
  owner for current contract acceptance rules.
- Private `ZkVMInput` validation and supported `public-input.json`
  parsing may use different entry points, but they must consume the same
  semantic-owner model.

### Shared Acceptance Rules for Sync and Async Paths

- Sync and async validation must stay under the same acceptance rules.
- `GET /api/zkvm-input-hash` must consume the canonical private-input
  validator path instead of preserving a separate acceptance contract.
- Async container validation and `public-input.json` generation must not
  become hidden secondary contract owners that accept or emit a
  different current contract from the canonical TypeScript path.

## Migration Rule

### Internal Adapter for `PublicInputSummary`

- `PublicInputSummary` is now an internal adapter only.
- Persisted finalized authority, restore output, and public bundle or
  report boundaries use `publicInputArtifact` as the sole public-input-
  derived authority.
- Internal verification code may still derive `PublicInputSummary` from
  `publicInputArtifact` where the summary-shaped input is convenient.

### Coordinated Cutover, Then Reject

- The repository now treats `schema = stark-ballot.public_input`,
  `version = 1.1`, and explicit top-level `contractGeneration` as the
  supported current artifact contract across sync and async production,
  restore, and validation.
- Finalized wrapper classification now reads wrapper-generation
  ownership separately from supported-current authority restoration so
  stale readable wrappers can fail closed as stale, not as corrupt.
- The repository does not prolong the compatibility layer for
  `publicInputSummary` across persisted or restore boundaries.

## Handoff To 03 and 04

- The public API and download plan consumes these ownership rules to
  remove mirror-driven public behavior and define route-visible fail-
  closed responses.
- The cleanup plan consumes these ownership rules to remove duplicated
  helpers without reopening authority ambiguity.
