# Current Public Boundary Cutover Plan

> **Status: implemented (commit `930026f`).** This document defines the
> explicit public-contract cutover that removes the remaining
> projection-only and parse-only public compatibility residue left after
> the internal 06 pruning slice. It is a follow-up to 03 and 06, not a
> rewrite of either historical decision record.

## Completion Memo

- Removed public count aliases (`missingIndices`, `invalidIndices`,
  `countedIndices`, `excludedCount`) from finalize, status, and verify
  response schemas, server projections, mock fixtures, and browser/CLI
  parsers. `FinalizationResultPublicProjection` and `ZkVMJournal` no
  longer carry them.
- Stripped raw delivery URLs and S3 locator metadata
  (`s3BundleUrl`, `s3BundleKey`, `s3UploadedAt`, `s3BundleExpiresAt`,
  `s3ReportKey`) from finalize sync, verify, and session-status public
  payloads, including nested `finalizationState.bundleMetadata`. Durable
  S3 keys remain server-internal authority only.
- Deleted the `refreshS3BundleMetadata` helper and its tests, dropped
  the `refreshS3=1` verify query path, and removed the
  `S3UrlExpiredError` fallback; authenticated bundle and report
  endpoints are now the sole browser/CLI download authority.
- Hardened `toCanonicalRfc6962Proof` to reject any candidate carrying
  `proofMode`, applied `.strict()` to `inclusionProofSchema`, and
  removed `proofMode` parse acceptance from verify payloads, CLI
  fixtures, knowledge normalization, and local-knowledge migration.
- Fixed `respondWithSchema` to emit the schema-parsed payload instead
  of the original response object, so schema-absent fields cannot leak
  through successful validation.
- Renamed internal slot/record vocabulary (`CompletenessResult.details`,
  `TamperDetectionResult.details`, `excluded-count` resolver notes) to
  the current 05 terms and marked `fail-closed-status` legacy-alias
  inputs as one-way fail-closed quarantine only.
- Added schema/runtime contract tests (`RETIRED_PUBLIC_BOUNDARY_KEYS`
  scan, `BulletinProofResponseSchema` `proofMode` rejection,
  `respondWithSchema` round-trip, nested `bundleMetadata` stripping on
  every finalization-state status), plus CLI count-mirror journal
  consistency checks.
- CLI harness now downloads both the authenticated bundle and the
  authenticated report for every run (mock included) and reports
  `verificationBundleDelivery`, `verificationHash`, and
  `verificationReportHash`. Mock fixture builders drop delivery URL,
  locator, and legacy count fields before emitting responses.

## Purpose

This document defines the current-only public API, browser restore, CLI,
inclusion-proof, and download boundary after the internal complexity
pruning work.

The goal is to stop exposing or accepting legacy count aliases, raw
delivery URL projections, URL-refresh behavior, and parse-only
`proofMode` compatibility as current public behavior now that supported
clients derive bundle and report downloads from session context plus
`verificationExecutionId`.

This is an explicit public-contract cutover. It is not a backward-
compatibility promise for older response shapes, browser caches, CLI
fixtures, or download URL assumptions.

## This Doc Decides

- which remaining public response fields are removed from the current
  contract
- which public count vocabulary survives at route boundaries
- how browser, CLI, mock fixtures, route schemas, and runtime response
  evidence cut over together
- how authenticated bundle and report routes remain the only supported
  browser and CLI download authority
- that dead raw-URL refresh helpers are deleted rather than retained as
  latent public behavior
- that `proofMode` parse-only compatibility is removed from the current
  public proof boundary in the same cutover
- how durable S3 locator metadata is suppressed from browser and CLI
  response payloads without diagnostic public-field exceptions

## This Doc Does Not Decide

- zkVM guest, host, or verifier proof semantics
- the current `contractGeneration` boundary
- the supported `public-input.json` schema
- persisted finalized-authority storage rules already handled by 01,
  02, and 06
- durable S3 locator ownership inside server-side authority
- public bundle contents or private artifact boundaries
- the protected `verification.json` report artifact body, except that
  report delivery remains authenticated and scoped by
  `sessionId + verificationExecutionId`
- renaming stable verification check IDs or UI/test selectors such as
  `counted_missing_indices_zero`

## Current Repository Interpretation

### 06 Completed Internal Pruning But Left Public Deletion Debt

The 06 pruning slice removed legacy count aliases, delivery URLs, and
`proofMode` from most canonical internal paths.

Even so, current public route schemas and response builders still expose
or accept compatibility-shaped public fields such as
`missingIndices`, `invalidIndices`, `countedIndices`, `excludedCount`,
`s3BundleUrl`, `s3BundleExpiresAt`, `s3BundleKey`, and `s3UploadedAt`.

Public-leak guard targets also include locator metadata that may already
exist server-side without being part of the maintained public response
shape, such as `s3ReportKey`. The cutover should prevent those fields
from becoming new diagnostic or convenience public fields while removing
the fields that are already exposed.

Current public proof parsing also still accepts parse-only
`proofMode` compatibility in some browser or helper paths even though
the maintained proof body no longer needs it.

Those fields are projection-only or parse-only deletion debt. They are
not proof-bound authority, selector authority, or durable storage
authority.

### Supported Downloads Already Have A Current Selector Model

The supported browser and CLI download model is session context plus
`verificationExecutionId`.

The authenticated bundle endpoint and authenticated report endpoint are
the public download authority:

- `/api/verification/bundles/:sessionId/:executionId`
- `/api/verification/bundles/:sessionId/:executionId/report`

Raw delivery URLs, URL refresh query parameters, and route-local S3 URL
projections must not remain alternate public selector models.

### Current Public Count Mirrors Are Slot And Record Counts

The current ballot evaluation model is the 05 slot/record vocabulary.

Public responses may expose current top-level exclusion and completeness
count mirrors of the canonical journal for browser ergonomics, but those
mirrors must use current names:

- `missingSlots`
- `invalidPresentedSlots`
- `rejectedRecords`
- `excludedSlots`

This count-mirror cutover does not remove other proof-bound public
journal or public-input fields such as `verifiedTally`, `totalExpected`,
`treeSize`, or `seenIndicesCount`.

When a counted-vote total is needed, current consumers should use
`journal.validVotes` when the journal is available. If a top-level total
must be derived outside the journal, it may be derived only from already
admitted proof-bound current tally data, such as a `verifiedTally` mirror
that has been checked against the canonical journal. It must not be
derived from claimed tally data, and consumers should not require
`countedIndices`.

## Target Public Contract

### Count Fields

Current public exclusion and completeness count mirrors:

- `missingSlots`
- `invalidPresentedSlots`
- `rejectedRecords`
- `excludedSlots`

Removed public count aliases:

- `missingIndices`
- `invalidIndices`
- `countedIndices`
- `excludedCount`

The removed aliases must not be used by browser restore, CLI helpers,
mock fixture builders, route schemas, or response mappers.

Other proof-bound public fields are outside this alias-removal target.

Fail-closed behavior must derive from `excludedSlots` and the current
slot/record context. A stale `excludedCount` fallback must not be capable
of reviving a successful current verification path.

### Download Fields

Current public selector:

- `verificationExecutionId`

Removed public delivery and locator fields that are currently exposed or
historically treated as browser/CLI delivery assumptions:

- `verificationBundleUrl`
- `verificationReportUrl`
- `s3BundleUrl`
- `s3BundleExpiresAt`
- `s3BundleKey`
- `s3UploadedAt`

Public-leak guard fields that must not be introduced as public browser
or CLI diagnostics:

- `s3ReportKey`

Removed public refresh behavior:

- `refreshS3=1` query behavior
- `refreshS3` as a public route, helper, fixture, or client flag

Browser and CLI consumers build authenticated bundle and report endpoint
URLs locally from the session context plus `verificationExecutionId`.

### S3 Metadata

`s3BundleKey`, `s3ReportKey`, and `s3UploadedAt` may remain server-side
storage or diagnostic metadata, but they are not public browser or CLI
response fields.

The current public boundary suppresses durable storage locator metadata
from browser and CLI response payloads. `s3BundleKey`, `s3ReportKey`,
and `s3UploadedAt` must not leave the server boundary as browser or CLI
response fields. This suppression applies to nested status payloads as
well as top-level finalize, status, verify, and verification-run
payloads; for example, `finalizationState.bundleMetadata.s3BundleKey`
and `finalizationState.bundleMetadata.s3UploadedAt` must not remain
public locator or diagnostic leaks.

Internal authority may continue to store durable S3 keys. This public
cutover does not delete server-side storage locator ownership.

### Protected Report Artifact

This cutover governs public route payloads, browser and CLI selector
inputs, mock fixtures, and response projections. It does not redefine the
protected `verification.json` report artifact body served through the
authenticated report endpoint.

That protected report may continue following the verifier-service report
contract. Public finalize, status, verify, verification-run, mock, and CLI
merged payloads must not copy server-side locator metadata from storage or
report internals into browser or CLI response fields.

### Inclusion Proof Shape

The bulletin proof response remains shaped as `{ voteId, proof }`.
The canonical public `proof` body is:

- `leafIndex`
- `treeSize`
- `merklePath`
- `bulletinRootAtCast`

`proofMode` is already not needed by current supported proof payloads.
This cutover removes parse-only `proofMode` acceptance from the current
public proof boundary. Maintained public proof responses, browser-local
proof storage, CLI fixtures, and proof parsers use only the proof body
above.

## Route Cutover Scope

### `POST /api/finalize`

Sync finalize responses return current count fields only.

They do not return raw bundle or report URLs. If verification material
exists, they return `verificationExecutionId` so the browser or CLI can
derive authenticated bundle and report endpoints.

They do not expose storage locator metadata such as `s3BundleKey`,
`s3ReportKey`, or `s3UploadedAt`.

### `GET /api/sessions/:sessionId/status`

When a finalized result is exposed, it uses the same current-only
projection as finalize and verify.

`finalizationResult` must not expose legacy count aliases, raw delivery
URLs, or storage locator fields.

`finalizationState.bundleMetadata` must not expose durable storage
locator or diagnostic fields such as `s3BundleKey` or `s3UploadedAt`.

Unsupported or corrupt finalized state remains fail closed and must not
project current-looking download authority.

### `GET /api/verify`

Verify responses return current count fields only.

They do not include URL-shaped download fields or storage locator fields
as browser download authority.

They also do not include durable S3 locator metadata as diagnostics.

Verification summary, check construction, and final user-facing verdict
must use current `excludedSlots` semantics, not legacy alias fallback.

### `GET /api/bulletin/:voteId/proof`

Bulletin vote-proof responses keep the current `{ voteId, proof }`
envelope, and the nested `proof` object contains the canonical proof body
only.

They do not emit `proofMode`, and route/schema evidence must fail if a
maintained fixture or response reintroduces it.

### `POST /api/verification/run`

The verification-run response remains selector-shaped:

- `verificationStatus`
- `verificationExecutionId`
- timing and idempotency fields

It does not introduce bundle or report URL projections or storage
locator metadata.

### Bundle And Report Routes

Authenticated bundle and report routes remain the only maintained public
download contract.

These routes continue to enforce session capability, safe execution
identity, finalized-authority admission, and bundle/report scoping before
returning success-shaped data or redirecting to S3.

## Browser And CLI Cutover

### Browser Restore And Verification UI

Browser-local finalized snapshots and verify payload parsers must stop
accepting legacy public aliases as current fallback fields.

The verify UI derives download candidates only from the current session
context plus a safe `verificationExecutionId`.

Browser-local knowledge must not reintroduce retired count aliases,
hidden delivery URLs, or `proofMode` as current knowledge keys.

Stale local snapshots that still contain retired public keys must be
sanitized, cleared, or dropped fail closed. Sanitization may delete
retired keys or canonicalize a proof body, but it must not recover
current verification state from retired aliases, raw delivery URLs, or
`proofMode`.

### CLI Harness

CLI finalize and verify helpers must require current count fields.

The CLI download path should call the authenticated bundle and report
endpoints derived from `sessionId + verificationExecutionId`. It should
not look for `verificationBundleUrl`, `verificationReportUrl`,
`s3BundleUrl`, storage locator metadata, or URL refresh metadata in
public payloads.

CLI proof fixtures and helper parsers must not require or emit
`proofMode`.

### Mock API And Fixtures

Mock fixtures must represent the current public contract exactly.

Fixture builders may still use helper-local variables while deriving
current counts, but emitted mock responses must not include removed
aliases, delivery URL fields, storage locator fields, URL-refresh flags,
or `proofMode`.

Schema and runtime contract tests should fail if removed public fields
reappear.

## Cleanup Targets

### Public Projection Helpers

Remove legacy count projection from public response builders once route
schemas and clients no longer accept the aliases.

If a helper exists only to produce removed public aliases, delete it or
confine it to legacy-fixture parsing tests that are themselves scheduled
for deletion.

### Raw URL Refresh Path

Delete `refreshS3BundleMetadata` and its tests when no maintained
production caller remains. A helper that exists only for tests or old
`refreshS3` behavior is dead public-compatibility code.

Download refresh must not be modeled as public URL refresh. The current
model is to request the authenticated bundle or report endpoint again
and let the server derive fresh delivery behavior internally.

If any helper survives, it must be server-internal delivery plumbing for
the authenticated bundle or report routes, not a public `refreshS3`
compatibility path.

### Schema And Runtime Guards

Removing fields from a schema is not sufficient evidence if the response
path validates and then returns the original unparsed payload.

This cutover needs either strict response schemas that reject and prevent
unknown public fields at the affected boundaries, or explicit contract
tests that inspect emitted handler or fixture payloads and assert that
removed fields are absent.

## Sequencing

1. Add or tighten schema/runtime absence tests so removed public fields
   become visible failures in affected public payloads.
2. Remove route schemas and mock fixture fields for aliases, raw
   delivery URLs, storage locator fields, URL-refresh flags, and
   `proofMode`.
3. Remove server-side public projection of legacy count aliases.
4. Remove finalize, status, verify, and bulletin proof response fields
   for aliases, raw delivery URLs, storage locator metadata, URL-refresh
   behavior, and `proofMode`, including nested status metadata such as
   `finalizationState.bundleMetadata.s3BundleKey` and
   `finalizationState.bundleMetadata.s3UploadedAt`.
5. Remove browser, CLI, and test-helper fallback parsing from legacy
   aliases, raw URL fields, storage locator metadata, and `proofMode`.
6. Delete dead S3 URL refresh code once no maintained server-internal
   caller remains.

## Evidence Expectations

- Route schema and runtime contract tests reject or detect removed
  public fields.
- Actual emitted finalize, status, verify, and bulletin proof payloads
  do not contain removed aliases, raw delivery fields, storage locator
  fields, URL-refresh flags, or `proofMode`.
- Status payloads do not expose durable locator keys through nested
  metadata such as `finalizationState.bundleMetadata.s3BundleKey`, and
  do not expose `s3UploadedAt` as public diagnostic metadata.
- Mock fixtures contain only current public count, proof, and download
  selector fields.
- Browser verify parsing does not fall back from current count names to
  legacy aliases.
- Browser download candidates are derived only from session context plus
  safe `verificationExecutionId`.
- CLI mock flow downloads bundle and report material through
  authenticated endpoints.
- Required verification checks cannot pass because a stale alias field
  filled a missing current field.
- Public proof payloads and browser-local proof storage do not require
  or emit `proofMode`.

## Completion Criteria

- Public response schemas no longer expose legacy count aliases.
- Public finalize, status, and verify responses no longer include raw
  delivery URL fields.
- Public browser and CLI responses do not expose `s3BundleKey` or
  `s3ReportKey`, and do not expose `s3UploadedAt`.
- Status responses do not expose durable storage locator fields through
  `finalizationState.bundleMetadata`.
- Public proof responses and browser-local proof storage no longer emit
  or require `proofMode`.
- Browser and CLI consumers do not parse alias, raw URL, storage locator,
  URL-refresh, or `proofMode` fallbacks.
- Authenticated bundle and report endpoints are the only maintained
  browser and CLI download path.
- Dead URL refresh code is deleted or explicitly justified as
  maintained server-internal behavior for authenticated bundle or report
  routes.

## Documentation Sync Note

This cutover does not require rewriting historical decision records such
as 03 or 04.

Non-`zkvm-contract` documentation, including
`docs/current/verification/README.md`, may intentionally lag during the
runtime cutover and be synchronized in a later documentation batch.

During that gap, prefer the implemented code, route schemas, runtime
contract tests, this 07 cutover note, and the directory index for the
post-cutover public boundary. Existing implementation-oriented docs should
be read as pre-cutover snapshots anywhere they still mention removed
aliases, raw delivery fields, storage locator response fields,
URL-refresh behavior, or `proofMode` compatibility.

## Deliberate Omissions

This document intentionally does not become a full implementation
checklist.

Detailed touched-file lists, route-by-route fixture diffs, and command
logs belong in task notes or PR descriptions. This document only owns
the public-boundary decision and the evidence expected when that
decision is implemented.
