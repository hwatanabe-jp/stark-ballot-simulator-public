# Current Contract Generation Boundary Plan

> **Status: WS0 implemented** (commit `a0e0a79`). The shared boot-time
> `contractGeneration` resolver, wrapper-level ownership for live
> sessions and finalized records, async-carrier validation, the three-
> state classification model, and the `UNSUPPORTED_CURRENT_ARTIFACT`
> terminal marker for stale async executions are in place. This doc
> remains the decision record for WS0; subsequent plans build on top of
> it.

## Purpose

This document defines the current-generation boundary that makes one
current-only contract explicit, fail closed, and operationally safe
before route-visible API shaping or canonical cleanup begins.

## This Doc Decides

- what `contractGeneration` means in the current repository
- where current-generation authority is owned for live sessions,
  finalized records, async handoff, and browser-local snapshots
- how stale or malformed state is classified before reads or writes can
  continue
- the enforcement order that prevents stale state from prolonging,
  repairing, or projecting itself
- the rollout constraint for moving to explicit generation ownership

## This Doc Does Not Decide

- route-specific response payloads or final public wire grammar
- the typed authority field model inside supported finalized state
- the supported `public-input.json` schema beyond boundary interaction
- canonical cleanup or deletion targets after hardening

## Core Model

### One Current Contract Only

- The repository supports one current contract only.
- Backward compatibility is not a goal when it would preserve stale
  authority, ambiguous readers, or avoidable compatibility branches.
- Older browser snapshots, live sessions, persisted finalized records,
  and async handoff state may be invalidated, expired, or explicitly
  rejected when the current boundary changes.
- Current-only rollouts must fail closed rather than degrading into
  steady-state generic `INTERNAL_ERROR` behavior.

### What `contractGeneration` Means

- `contractGeneration` is the current-only invalidation boundary for
  live sessions, finalized authority, async handoff, restore paths, and
  browser-local snapshots.
- It is an operational compatibility boundary, not a proof-semantic one.
- `methodVersion` remains the guest and ImageID boundary.
- `public-input.json.version` remains the public-artifact schema
  boundary.

### Boundary Marker Precedence

- Runtime current generation defines what is currently supported.
- Persisted authority generation is the canonical record-level owner.
- Carried async or background-write generation must match that persisted
  authority before a write lands.
- Parsed artifact markers and browser-local copies are comparison-only;
  they may corroborate mismatch but must not repair missing persisted
  authority.

## Boundary Ownership

### Runtime Current-Generation Owner

- One shared TypeScript boot-time resolver owns the runtime current
  generation for authoritative runtimes.
- Non-TypeScript runtimes such as async containers, shell paths, or
  Rust-adjacent helpers may validate the expected generation at boot,
  but they do not become independent owners.
- All authoritative runtimes in one deploy cohort must agree on the
  same current-generation boundary before writer cutover.

### Live Session Owner

- The canonical live-session owner is top-level session
  `contractGeneration`, issued at `POST /api/session` and persisted with
  the session.
- Browser and CLI consumers retain that issued value as comparison-only
  context for later stale clearing.

### Finalized Wrapper Owner

- The canonical finalized owner is top-level finalized-wrapper
  `contractGeneration`, persisted adjacent to finalized authority rather
  than rediscovered from artifacts.
- The finalized wrapper must cover every persisted branch that can still
  change finalized projection, including lifecycle state, supported
  finalized result, and separately persisted scenario context when that
  context can still change claimed tally or tamper-summary projection.
- Separately persisted private artifacts that support finalized
  verification remain subordinate to that wrapper-level owner and do not
  become independent current authority.
- Repairing a stale-current finalized record is not complete unless any
  persisted fail-closed artifact tombstone that still overrides reads is
  cleared together with the wrapper-level generation repair.

### Async Handoff Carrier

- Work messages, callback payloads, and other authoritative write
  envelopes carry `contractGeneration`.
- Sync finalize writes and async/background writes participate in the
  same boundary.
- Tightening carrier requirements is only safe after outstanding queued
  and in-flight executions that may still hold older envelopes are
  drained, expired, or guaranteed to converge fail closed.

### Browser Snapshot as Comparison-Only Context

- Browser-local session and finalized snapshots are provisional caches,
  not current-authority owners.
- They may help explain or clear stale state, but they must not mint or
  repair missing persisted boundary ownership.
- Until a separate explanation-only tombstone snapshot model exists,
  stale, generation-less, or otherwise unsupported browser-local
  finalized state is cleared rather than retained as current-looking
  supported state.

## Classification Model

### `supported`

- Persisted authority is readable and its generation matches the runtime
  current generation.
- Reads may project success-shaped data, and writers may proceed,
  subject to the authority and API rules defined by later documents.

### `unsupported_current_artifact`

- Persisted finalized authority is readable enough to classify and
  explain, but it is stale or otherwise unsupported for the current
  contract.
- This is an explicit fail-closed state, not generic absence and not a
  successful finalized result.

### `corrupt_or_unreadable`

- Persisted finalized authority is malformed, unreadable, or mixed in a
  way that cannot be trusted even as a stale-current tombstone.
- This also fails closed and stays distinct from generic absence and
  from `unsupported_current_artifact`.

## Enforcement Rules

### Classify Before Touch

- Live-session reads and mutations must check generation mismatch before
  refreshing activity, extending TTL, or otherwise letting stale state
  prolong its own lifetime.
- Recovery-critical admission control must not count stale or
  generation-less live sessions as active current sessions.

### Classify Before Project

- Finalized-authority reads must classify persisted state into
  `supported`, `unsupported_current_artifact`, or
  `corrupt_or_unreadable` before any success-shaped projection,
  canonical repair, presigned-URL refresh, or equivalent write-back.
- A finalized record must not repair itself through bundle-path parsing,
  raw artifact parsing, `s3BundleKey` layout, or browser-local mirrors.

### Classify Before Write

- Sync finalize writes, async lifecycle writes, callback writers,
  verifier-service rewrite paths, bundle restore, and other
  authoritative background writes must compare carried generation,
  persisted authority generation, and runtime current generation before
  mutating state.
- Mismatch is fail closed.
- Pure no-op rejection is not enough when it would strand a record in
  resumable-looking `pending` or `running`; stale executions must
  converge into an explicit unsupported terminal path.
- Until the lifecycle model grows a dedicated unsupported-current
  terminal enum, stale async executions may temporarily land in an
  existing terminal lifecycle bucket only when a machine-readable stale-
  current marker or equivalent bounded code preserves the
  unsupported-current meaning.
- That transitional representation must not collapse into generic
  `INTERNAL_ERROR`, and it must not leave polling, restore, or callback
  consumers unable to distinguish stale-current invalidation from an
  ordinary operational failure.

## Recovery Rule

### Stale Live Sessions Recover via Fresh `POST /api/session`

- For this repository, the supported recovery path for stale live
  sessions is a fresh `POST /api/session`.
- Continuity for pre-change live sessions is not guaranteed.
- Stale finalized state may remain explanation-only, but it must not
  continue as supported current authority.

## Rollout Constraint

### Widen, Then Cut Over Writers, Then Tighten

- Widen readers, parsers, browser snapshots, async envelopes, and
  transports first.
- Cut authoritative writers to explicit `contractGeneration` ownership
  second.
- Writer cutover is not complete while first-write paths still mint
  finalized-wrapper generation from ambient session state when a carried
  generation is already available.
- Tighten rejection or tombstoning for generation-less or stale state
  third.
- No authoritative writer should begin requiring or emitting carried
  `contractGeneration` until the downstream parsers and transports it
  depends on can accept and retain that field.

## Handoff To 02 and 03

- The authority-model plan decides which fields and artifacts carry
  supported authority inside this boundary.
- The public API and download plan decides how supported, unsupported,
  corrupt, and capability-loss states are exposed on route, browser, and
  CLI surfaces.
- During transition, the public contract still needs one explicit stale-
  current meaning even if the internal lifecycle representation is using
  an existing terminal bucket temporarily.
