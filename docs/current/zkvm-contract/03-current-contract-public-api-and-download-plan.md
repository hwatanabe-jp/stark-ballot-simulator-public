# Current Contract Public API and Download Plan

> **Status: Route-visible contract and download authority implemented**
> (commit `eaf034f`, on top of the preparatory `653602f` slice).
> `verificationExecutionId` is the only public selector, finalized reads
> share a single fail-closed admission gate, and raw URL authority is
> removed from persisted state, browser snapshots, and `/api/verify`.
> This doc remains the decision record for the route-visible fail-closed
> and download contract.

## Completion Memo

- Moved browser and CLI download selection onto the authenticated
  `sessionId + verificationExecutionId` route model so
  `/api/verification/bundles/:sessionId/:executionId` is the public
  download authority consumed by current clients.
- Centralized bundle URL/path derivation in shared helpers and removed
  route-local duplication in the verifier run path.
- Left raw download URL fields in place only as compatibility
  projections rather than as selector or restore authority.
- Locked the current behavior with targeted route/browser/CLI regression
  coverage and updated the current implementation doc to match the
  shipped contract.
- Required a safe top-level `verificationExecutionId` for supported
  finalized state and enforced `(sessionId, executionId)` scope across
  top-level and nested locators; missing or unsafe values fail closed as
  `CORRUPT_OR_UNREADABLE_FINALIZED_STATE`.
- Unified finalized read handlers onto a single admission gate and
  switched `/api/verify` fail-closed responses to `200` plus `error` and
  `artifactState`, with polling no longer silently downgrading to
  `X-Session-ID`-only and client invalidation split between
  finalized-projection and session-authority clearers.

## Purpose

This document defines the route-visible contract that sits on top of the
boundary and authority decisions from the first two plans.

Its job is to make unsupported current-only state, corrupt finalized
state, and authenticated download behavior explicit and stable for
browser and CLI consumers.

## This Doc Decides

- the route-visible vocabulary for unsupported, corrupt, and capability-
  loss states
- how verify, status, finalized verification-support, and live-session
  routes fail closed
- the browser and CLI restore contract on top of those route-visible
  states
- the authenticated bundle and report download contract

## This Doc Does Not Decide

- who owns the runtime current-generation boundary
- which internal fields hold authority inside supported finalized state
- canonical cleanup or deletion targets after hardening

## Public State Vocabulary

### `UNSUPPORTED_CURRENT_ARTIFACT`

- This names finalized state that is readable enough to classify and
  explain, but is unsupported for the current contract.
- It is explicit fail-closed state, not generic absence and not a
  successful finalized result.

### `CORRUPT_OR_UNREADABLE_FINALIZED_STATE`

- This names finalized state that is malformed, unreadable, or mixed in
  a way that cannot be trusted even as a stale-current tombstone.
- It stays distinct from unsupported-current state and from generic
  absence.

### `SESSION_CAPABILITY_LOSS`

- Capability loss is the route-visible auth-loss family for capability-
  gated live-session ingress.
- Current wire codes may still distinguish missing, invalid, and expired
  capability cases during migration; this document treats them as one
  contract family rather than as unsupported-finalized state.
- It is not an unsupported-finalized verdict and must not be normalized
  into the unsupported tombstone contract.

## Route Family Contracts

### Verification Surfaces

- `GET /api/verify` and `POST /api/verification/run` consume the same
  normalized finalized-state boundary decisions before any success-
  shaped projection or write-back.
- `GET /api/verify` remains structured fail-closed `200` behavior for
  finalized-session scope.
- Unsupported or corrupt finalized state must not project current-
  looking verification selectors, resumable download authority, or other
  success-shaped proof-material fields.

### Status Surface

- `GET /api/sessions/:sessionId/status` is a hybrid status surface.
- If a finalized branch exists, it is normalized first.
- Explicit stale live-session behavior is reserved for records that
  remain live-session-only after that classification.
- The status contract must let restore consumers distinguish supported
  finalized authority, unsupported-current finalized state,
  corrupt-or-unreadable finalized state, and live-session-only stale
  outcomes.

### Authenticated Bundle and Report Delivery

- Authenticated bundle and report endpoints are the only public download
  contract consumed by browser and CLI flows.
- These routes consume the same supported-versus-unsupported
  classification before returning success-shaped data.

### Sync Finalize Response During Migration

- `POST /api/finalize` may temporarily continue returning raw download
  fields as compatibility projections while browser and CLI consumers
  move to the authenticated bundle and report endpoints.
- Those compatibility projections are not selector authority, restore
  authority, or the steady-state public download contract.
- Removal of finalize-time raw download projections is a client-cutover
  task, not a prerequisite for defining the steady-state route family
  contract in this document.

### Finalized Verification-Support Routes

- Finalized verification-support routes such as consistency proof,
  vote-proof, bitmap, STH, botdata, and zkVM-input-hash surfaces must
  classify supported versus unsupported finalized authority before they
  return success-shaped data.
- Sidecar artifacts must not keep these routes on a success path after
  wrapper-level authority has become unsupported or unreadable.

### Live-Session Mutation Routes

- Live-session mutation and progress routes stay on the possession-
  proven session-capability contract.
- Capability loss remains capability loss.
- These routes do not reuse the unsupported-finalized tombstone
  contract.

## Response Shape Rules

### Fail-Closed Responses

- Unsupported and corrupt finalized responses must stay explanation-
  friendly but fail closed.
- They must not imply resumable verification, downloadable proof
  material, or a successful overall verdict.

### Suppressed Current-Looking Fields

- Unsupported or corrupt finalized responses must suppress current-
  looking authority fields such as top-level selector authority, raw
  download URLs, resumable download state, or journal data that is not
  actually available.
- If journal availability needs to be expressed, omission and
  unavailability must remain distinct.

### Explanation-Only Metadata

- Responses may retain bounded explanation-only metadata such as stale
  execution identity under tombstone-only diagnostics.
- Explanation metadata must not become alternate selector or download
  authority.

## Browser and CLI Contract

### Restore Behavior

- Browser-local finalized snapshots are provisional caches.
- Browser and CLI restore must revalidate them against current server
  authority before supported-current flows continue.
- Unsupported or corrupt responses must not be written back as fresh
  supported verification data.
- Until a dedicated explanation-only tombstone snapshot model exists,
  browser-local finalized restore remains a supported-current-only cache
  path rather than a place that preserves unsupported or corrupt
  finalized state.

### Polling and Helper Behavior

- Verification polling and other session-bound helper fetches must stop
  or clear continuation state after stale or capability-loss
  invalidation.
- They must not silently downgrade to `X-Session-ID`-only fallback after
  current authority is lost.

### Local Clearing Rules

- Capability loss clears live-session authority and continuation
  markers.
- Until a separate explanation-only tombstone snapshot model is
  introduced explicitly, unsupported-current, corrupt, or capability-
  loss invalidation clears browser-local finalized snapshots instead of
  retaining current-looking supported verification data.
- Any future explanation-only finalized snapshot must remain separate
  from supported-current restore data and must not restore current
  authority by itself.

## Download Contract

### `verificationExecutionId` as the Only Public Selector

- `verificationExecutionId` is the stable public selector for bundle and
  report delivery.
- Supported current-generation finalized state must carry a safe top-level
  `verificationExecutionId`. Missing or unsafe values are
  `CORRUPT_OR_UNREADABLE_FINALIZED_STATE`, not a consumer fallback point.
- Browser and CLI consumers derive authenticated endpoint URLs locally
  from session context plus `verificationExecutionId`.

### No Raw URL Authority

- Raw URL mirrors such as `verificationBundleUrl`,
  `verificationReportUrl`, `s3BundleUrl`, `refreshS3`, or similar
  browser-consumable URLs are removed from persisted authority, browser
  snapshots, CLI helpers, and public responses.
- Internal storage locators may remain server-side, but they are not
  public selector authority.
- If temporary raw URL fields still exist during migration, they are
  derived compatibility projections only. New or migrated consumers must
  not require them as selector or restore authority.
- During that migration window, `POST /api/finalize` may still surface
  raw download fields as compatibility projections, but browser and CLI
  cutover still targets session context plus `verificationExecutionId`
  as the only public selector model.

## Transition Notes

### Temporary Compatibility Branches

- Temporary compatibility handling is allowed only to bridge client
  cutover from older parsing and download assumptions.
- Boundary and authority rules from the first two plans still win:
  compatibility branches must not recreate stale success paths.

### Client Cutover Order

- Teach browser and CLI consumers to parse explicit unsupported and
  corrupt states first.
- Move them onto locally derived authenticated downloads second.
- Remove raw URL and mirror-based assumptions last.
- Raw URL retirement is complete only after browser download selection,
  CLI download helpers, mock fixtures, and route schemas can all derive
  authenticated bundle or report requests from session context plus
  `verificationExecutionId` without depending on
  `verificationBundleUrl`, `verificationReportUrl`, or `s3BundleUrl`.

## Handoff To 04

- Once the public contract is explicit and browser or CLI consumers no
  longer rely on mirror fields or raw URLs, the cleanup plan can remove
  legacy helpers and parallel paths without reopening public-contract
  ambiguity.
