# Current Contract Complexity Pruning Plan

> **Status: internal pruning implemented** (commit `b951166`).
> Public alias and delivery-URL response fields that still survive are
> projection-only deletion debt unless a later explicit 03 cutover
> removes or keeps them. This doc remains the maintained post-01-05
> residue and pruning-status record.

## Completion Memo

- Narrowed `FinalizationResultAuthority` to scoped identity and stopped
  persisting `bundleUrl`, `reportUrl`, `bundlePath`, `reportPath`,
  `bundleArchivePath`, and S3 delivery URLs inside finalized authority,
  nested `verificationResult`, or async succeeded-state metadata.
- Confined legacy delivery URL/path fields to parse-only compatibility
  at storage, file-mock, Amplify, async-callback, and S3-refresh
  boundaries; refresh helpers no longer re-inject delivery URLs into
  nested `verificationResult`.
- Derived trusted-local bundle verification from scoped `sessionId`,
  top-level `verificationExecutionId`, and optional `s3BundleKey`
  under `VERIFIER_WORK_DIR` rather than from nested persisted local
  paths. Sync-finalize `s3BundleUrl` / `s3BundleExpiresAt` survive only
  as transient route-local delivery projections.
- Pointed `SessionData.finalizationResult` at
  `FinalizationResultAuthority`; the loose `FinalizationResult` DTO is
  limited to explicit parse, serialization, projection, and
  legacy-fixture boundaries.
- Removed `PublicInputSummary` from verification-runtime inputs; the
  verify handler now passes a narrow `publicInputAuthority` derived
  from `publicInputArtifact.typedAuthority` plus provenance, preserving
  the pre-admission `artifactState` fail-closed contract.
- Dropped legacy count aliases (`missingIndices`, `invalidIndices`,
  `countedIndices`, `excludedCount`) from canonical `ZkVMJournal` and
  internal result, verify-page, knowledge, and test-helper paths.
  Public route schemas still accept or emit the aliases as one-way
  projection-only output or parse fallback.
- Chose a knowledge-only migration rather than the full schema-bump
  reset: `RETIRED_KNOWLEDGE_KEYS` and `migrateStoredKnowledgeData()`
  drop stale alias keys, hidden `s3BundleUrl` / `s3BundleExpiresAt`
  keys, and stale `proofMode` on read, and canonicalize stored
  RFC 6962 proof bodies.
- Removed `proofMode` from store-owned vote data, exact CT proof
  return types, canonical RFC 6962 proof, browser-local knowledge,
  and internal proof outputs. Boundary parsers may still accept and
  discard compatible `proofMode`.
- Deleted deprecated `ResultSummary`, `DownloadCard`, and
  `VerificationStepsCard` components with their dead exports and
  tests. Shared `pages.verify.stepsCard.*` and
  `pages.verify.resultSummary.*` translation namespaces remain while
  `UnifiedVerificationCard` and the current verify page still
  reference them.

## Purpose

This document defines the remaining complexity-pruning work after the
generation boundary, authority cutover, public-contract tightening,
canonical cleanup, and ballot-semantics alignment from 01-05.

Its job is to make one thing explicit:
the repository already has the main current-contract decisions in
place, but the 2026-04-22 fact check found several
compatibility-shaped types, aliases, projections, and migration-era
documents still surviving inside core runtime paths.

This plan is for deleting that residue, or quarantining it only where a
current public boundary still explicitly requires it, instead of
normalizing it into the long-term architecture.

Its default posture is conservative about accidental public-wire churn:
the repository should prune internal residue first without implicitly
reopening the public route contract established by 03. That conservatism
is not a backward-compatibility promise. Remaining public compatibility
projections are deletion debt unless a later public-contract cutover
intentionally keeps them.

## This Doc Decides

- which remaining compatibility or migration shapes are still real in
  the current repository after 01-05
- how canonical runtime authority is separated from public
  compatibility projections before residue is deleted
- which of those shapes may survive only at explicit parse or
  projection boundaries
- how finalized authority, verification-input ownership, count
  vocabulary, and proof-shape compatibility should be simplified
  further
- how 06 records post-01-05 residue without rewriting fixed historical
  plan docs
- which obviously dead compatibility surfaces should be removed rather
  than preserved "for reference"

## This Doc Does Not Decide

- new proof semantics for the guest, host, or verifier
- a second public bundle or verification contract
- broader AWS, async-finalize, or deployment redesign
- an implicit reopen of the 03 public contract as a side effect of
  internal cleanup
- a backward-compatibility promise for old aliases, caches, or public
  shapes when those only preserve avoidable complexity

## Default Contract Posture

- The default 06 path is internal pruning without accidentally reopening
  the public route contract established by 03.
- Keeping 03 closed during an internal pruning slice is not permission to
  preserve compatibility residue as long-term architecture.
- Changes that remove, rename, or newly require different current
  public wire fields are separate explicit public-contract cutovers.
- Internal pruning that intends to keep 03 closed must first separate
  canonical runtime authority types from public compatibility
  projections and parse-local adapters.
  Otherwise "internal-only" cleanup will silently mutate the same loose
  shared types that still shape current public responses.
- Unless such a cutover is chosen explicitly, remaining public
  compatibility fields may survive only as response-local,
  projection-only, or parse-local compatibility behavior.
  They must not remain persisted authority or canonical internal state.
- Any surviving public compatibility projection is deletion debt:
  new internal consumers must not depend on it, and future work must
  either keep it quarantined at the boundary or remove it through an
  explicit public-contract cutover.

## Relationship To 03 and 04

- 03 and 04 remain fixed historical decision records for the completed
  01-05 rollout.
  06 does not reopen their completed status.
- Even so, some completion-state wording in 03 and 04 now overstates
  how much delivery-URL and compatibility residue has already been
  removed from the current repository.
- This 06 implementation note is therefore the maintained post-01-05
  residue and pruning-status record.
  Because 03 and 04 are fixed historical decision records, if those docs
  and 06 disagree about whether delivery-URL residue or sync-finalize or
  status compatibility projections still survive in code, prefer 06 for
  current-state residue reading.
- There is no planned rewrite of 03 or 04 to absorb this addendum.
  Future current-state changes should update 06, the directory index,
  implementation-oriented docs, or a new follow-up note.

## Implemented Current State

The 2026-04-23 pruning slice implements the default 06 posture:
internal canonical cleanup without implicitly reopening the 03 public
route contract.

- Persisted finalized authority no longer stores route-derived
  `bundleUrl` / `reportUrl`, process-local
  `bundlePath` / `reportPath` / `bundleArchivePath`, or refreshable S3
  delivery URLs inside persisted `verificationResult`.
- Finalized storage, file-mock serialization, Amplify finalization
  serialization, async callback metadata, and S3 refresh now accept
  legacy delivery URL/path fields only at parse or helper boundaries and
  drop them before persistence.
- Trusted local bundle verification is derived from scoped `sessionId`,
  top-level `verificationExecutionId`, and optional `s3BundleKey`
  identity under `VERIFIER_WORK_DIR`, rather than from nested persisted
  local path fields.
- Sync finalize may still return transient `s3BundleUrl` /
  `s3BundleExpiresAt` delivery projections when the existing public
  contract requires them, but those values are not written back into
  finalized authority.
- The primary session contract now advertises
  `FinalizationResultAuthority` for `SessionData.finalizationResult`.
  The loose `FinalizationResult` compatibility DTO is confined to
  explicit parse, storage-serialization, projection, and legacy-fixture
  boundaries.
- `PublicInputSummary` and its helper module have been removed from
  verification-runtime inputs. The verify handler now passes a narrow
  `publicInputAuthority` derived from the admitted
  `publicInputArtifact.typedAuthority` plus provenance.
- Canonical `ZkVMJournal` and current journal validation no longer carry
  legacy count aliases. Internal result, verify-page, knowledge, and
  test-helper paths use `missingSlots`, `invalidPresentedSlots`,
  `rejectedRecords`, `validVotes`, and `excludedSlots`.
- Public `missingIndices` / `invalidIndices` / `countedIndices` /
  `excludedCount` fields may still be emitted or accepted where the 03
  public contract remains closed. They are one-way boundary projections
  or parse fallbacks, not canonical runtime journal fields.
- Browser-local knowledge now migrates stale alias keys to canonical
  names, drops hidden delivery URL keys, removes stale `proofMode`, and
  canonicalizes stored RFC 6962 proof bodies on read.
- `proofMode` is no longer part of store-owned vote data, exact CT proof
  return types, browser-local knowledge, or canonical internal proof
  outputs. Boundary parsers may still accept compatible `proofMode` and
  discard it.
- Deprecated verification compatibility components
  `ResultSummary`, `DownloadCard`, and `VerificationStepsCard` have been
  deleted with their dead exports and tests. Shared translation
  namespaces remain only where the active verification UI still uses
  them.

The fact-check section below is the pre-implementation residue baseline
from 2026-04-22. It remains as rationale for the cleanup and should not
be read as the current runtime state where the implemented-state notes
above say the residue has been pruned.

## Pre-Implementation Fact Check

### Persisted finalized authority still carries delivery and local-path residue

- `VerificationResult` still includes `bundleUrl` and `reportUrl`, and
  current finalize and verification-run paths still build and persist
  those route-derived URLs inside finalized state.
- `VerificationResult` also still requires `bundlePath` and `reportPath`
  and may carry `bundleArchivePath`.
  These are process-local file locators, not public selectors, but they
  are still persisted in nested `verificationResult` and accepted during
  finalized-authority parsing.
- Local bundle restore still uses `verificationResult.bundlePath` as a
  trusted-local bundle discovery input after checking verifier workdir,
  execution identity, and bundle-key identity.
  That makes local-path residue an authority-adjacent restore dependency,
  not merely a presentation field.
- Delivery-URL residue is not limited to top-level finalized wrappers.
  Current finalized authority still persists top-level `s3BundleUrl`
  and `s3BundleExpiresAt`, nested
  `verificationResult.s3BundleUrl` and
  `verificationResult.s3BundleExpiresAt`, and async succeeded-state
  metadata still accepts `bundleMetadata.s3BundleUrl` and
  `bundleMetadata.s3BundleExpiresAt`.
- Current bundle-metadata refresh helpers still mirror refreshed S3
  delivery values back into both top-level finalized authority and
  nested `verificationResult`, so URL residue can reappear even after a
  partial cleanup.
- Current locator authority is already narrower than that residue:
  scoped lookup is anchored by `verificationExecutionId`,
  `s3BundleKey`, and `verificationResult.s3ReportKey`, not by raw URLs.
- Public route behavior is now split:
  `/api/verify` already strips raw URL fields, but sync
  `POST /api/finalize` still returns `s3BundleUrl`-family fields and
  `GET /api/sessions/:id/status` still exposes
  `finalizationState.bundleMetadata.s3BundleUrl`.
- Cleanup of delivery and local-path residue therefore has three distinct
  scopes:
  persisted authority cleanup, trusted-local restore locator cleanup, and
  an optional separate public-schema cutover for the remaining finalize or
  status response fields.

### Runtime and session facades still advertise transitional finalized types

- `FinalizationResultAuthority` exists and is the intended internal
  authority model.
- Persisted finalization storage payloads already center that authority
  type rather than the looser migration-era facade.
- Even so, that authority model is not yet narrow enough:
  current `FinalizationResultAuthority` still carries delivery and
  process-local locator residue such as `s3BundleUrl` and nested
  `VerificationResult` fields such as `bundleUrl`, `reportUrl`,
  `bundlePath`, `reportPath`, and `bundleArchivePath`.
- Even so, `SessionData.finalizationResult` is still typed as
  transitional `FinalizationResult`, so the shared session runtime
  contract still advertises the compatibility shape after persistence
  has already narrowed.
- That means the remaining cleanup here is not only a storage concern.
  It is also a session-boundary and runtime-type cleanup task.
- The remaining work is therefore not just "point the session contract
  at `FinalizationResultAuthority`."
  It also needs a narrower core authority type, or an equivalent split
  between authority and projection roles, before the session boundary
  can safely stop advertising the loose compatibility shape.

### Canonical runtime types and public compatibility projections still overlap

- Current shared runtime contracts still mix canonical authority and
  compatibility projection concerns.
- Verification-engine inputs still advertise adapter-shaped fields such
  as `publicInputSummary` and legacy count aliases, while canonical-
  adjacent journal types still carry compatibility alias fields.
- Public route schemas intentionally still expose some compatibility
  fields at the boundary, but several shared runtime types remain close
  enough to those route shapes that field-by-field pruning can easily
  become accidental public-wire churn.
- As long as the same loose shared types continue to serve both
  canonical runtime code and compatibility projection work, "keep 03
  closed" remains more of an intention than an enforceable design
  boundary.
- 06 therefore needs one explicit type-boundary split before it tries
  to delete residue field by field.

### `PublicInputSummary` no longer owns persistence, but still crosses the runtime

- 02 correctly moved persisted and restored authority onto
  `publicInputArtifact`.
- Even so, current verify-handler and verification-engine inputs still
  reconstruct and pass `PublicInputSummary`.
- The current verify path does not accept every restored artifact
  blindly. It only produces that summary after provenance and context
  admission checks such as `executionId`, `bundleKey`, `bulletinRoot`,
  and `treeSize` agreement.
- That local summary gate is not the whole admission boundary.
  Before `/api/verify` reaches that point, supported finalized reads
  already fail closed when public audit artifacts drift from the
  canonical journal or from each other.
  The current pre-admission consistency surface includes public-input
  authority fields such as `electionId`, `electionConfigHash`,
  `totalExpected`, recomputed input commitment, and `methodVersion`;
  election-manifest identity, expected count, and self-hash agreement;
  and close-statement `logId`, timestamp, bulletin root, tree size, and
  STH digest agreement.
- The current engine only reads fields that are already present in
  `publicInputArtifact.typedAuthority` plus provenance, with
  `summary.valid` effectively standing in for "a supported artifact was
  already restored."
- When provenance or context admission fails, the current handler can
  suppress the summary before the engine runs counted-as-recorded checks.
  The replacement therefore needs an explicit failure mapping so
  admission mismatches do not degrade into harmless-looking missing
  evidence.
- The remaining dependency is not just one helper call:
  the verify handler still builds the adapter, the verification context
  still carries it, and counted-as-recorded checks still read it
  directly.
- That makes `PublicInputSummary` a surviving runtime adapter rather
  than a fully retired boundary artifact.

### `proofMode` is no longer needed on current verify surfaces, but still survives internally

- Current public inclusion-proof schemas no longer require `proofMode`,
  and current `/api/verify` proof payloads do not emit it as part of
  the supported proof body.
- Even so, store interfaces, exact CT proof helpers, client proof
  parsing, verification-engine input types, and knowledge normalization
  still retain or reattach fixed `proofMode: 'rfc6962'`.
- The field also survives on stored vote and session shapes such as
  `VoteData.proofMode`, plus store finalization paths that write it back
  after computing CT paths.
  That makes this a stored-vote and session-boundary cleanup, not only a
  proof-helper interface cleanup.
- That means the remaining residue is not only a public-schema concern.
  It is an internal canonical-proof-shape cleanup task.
- 06 therefore still needs one explicit decision for `proofMode`:
  whether it survives only as boundary-local compatibility acceptance,
  or keeps remaining visible on canonical internal proof objects and
  browser-local knowledge.

### Legacy count aliases still shape internal app and verification code

- The current canonical vocabulary from 05 is slot/record based:
  `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`,
  `excludedSlots`, plus proof-bound journal counts such as
  `validVotes`.
- Legacy aliases such as `missingIndices`, `invalidIndices`,
  `countedIndices`, and `excludedCount` still appear in route schemas,
  client verification payloads, knowledge storage, summary logic,
  fail-closed helpers, stage evaluators, tamper helpers, fixtures, and
  test utilities.
- Those aliases also still survive on canonical-adjacent journal
  surfaces such as `ZkVMJournal`, the current journal route schemas, and
  shared compatibility helpers like `journal-count-compat`.
- The same aliases also still shape browser-side restored finalization
  snapshots and `/verify` payload parsing, so the residue is not only a
  server or docs problem.
- Current route schemas also still expose those aliases, but that is a
  public-boundary concern, not something the default internal 06 track
  should remove implicitly.
- The repository therefore still carries a mixed internal vocabulary
  even though 05 already fixed the current semantics.
- 06 therefore still needs one explicit decision for the journal
  contract surface itself:
  whether legacy aliases survive only at parse or projection boundaries,
  or keep remaining visible on the canonical runtime journal types.

### Browser-local knowledge still persists legacy names

- Result and verify flows still normalize and store legacy count keys in
  `stark-ballot-knowledge`.
- Hidden verify-phase knowledge also still reserves URL-shaped delivery
  keys such as `s3BundleUrl` and `s3BundleExpiresAt`.
- The knowledge panel enumerates stored keys dynamically and falls back
  to the raw key name when a translation disappears.
- Alias retirement therefore is not only a type or route cleanup task:
  it also needs an explicit browser-storage migration, schema-bump
  clearing rule, or equivalent stale-snapshot drop path.
- The repository already has a deterministic client storage schema reset
  path, so this cleanup does not need to invent a second local-storage
  invalidation mechanism unless a key-preserving migration is truly
  preferable.

### Fixed historical docs still need a post-01-05 residue note

- 03 still carries a "During Migration" section for sync finalize raw
  download projections.
- 04 still presents itself as a cleanup plan rather than a completed
  current-state record, even though its workstreams are already marked
  implemented in `index.md`.
- Some 03 and 04 completion-state wording also understates the amount of
  delivery-URL and compatibility residue that still survives in the
  codebase today.
- 03 and 04 remain fixed historical decision records.
  The current-state burden is handled by this 06 addendum and the
  directory index note, not by rewriting those completed docs.

### Several explicit compatibility artifacts now look dead

- `src/components/verification/ResultSummary.tsx` is marked deprecated
  and "kept for reference and backwards compatibility."
- Current repository usage shows test-only references and no runtime
  imports.
- `DownloadCard` is also deprecated and barrel-exported, while
  `VerificationStepsCard` remains as a module-level named export with
  test-only direct imports.
  Both are superseded by `UnifiedVerificationCard` and are part of the
  same runtime-dead compatibility surface audit.
- These are deletion candidates, not compatibility obligations.

## Simplification Decisions

### 1. Separate canonical runtime authority from public compatibility projections

- Internal canonical cleanup should start by making the type boundary
  explicit:
  canonical runtime authority, boundary-local parse helpers, and
  route-local compatibility projections should no longer share the same
  loose DTO shape by default.
- If 03 stays closed, public compatibility fields may still exist at
  explicit route or parser boundaries, but they should no longer define
  shared session authority, verification-engine context, or canonical
  journal-facing helper inputs.
- Such boundary compatibility is a containment mechanism, not a
  compatibility promise for new code.
  New consumers should use the current canonical selectors, names, and
  proof shapes rather than depending on quarantined aliases or raw
  delivery fields.
- Merely renaming or reusing a loose compatibility type as an
  "authority" type is not sufficient cleanup when that type still
  carries route-shaped projections, delivery URLs, or adapter fields.
- The first successful 06 cutover is therefore structural:
  field deletion begins only after the repository has a clear place for
  canonical runtime types and a separate clear place for compatibility
  projection types.

### 2. Persist authority, not delivery values or process-local paths

- Persisted finalized state should retain scoped authority and durable
  storage locators only.
- Route-derived browser URLs such as `bundleUrl` and `reportUrl` are
  delivery projections and should be derived at request time from
  session scope plus `verificationExecutionId`.
- Process-local paths such as `verificationResult.bundlePath`,
  `verificationResult.reportPath`, and
  `verificationResult.bundleArchivePath` are not durable authority.
  They may remain transient verifier execution outputs or trusted-local
  bridge inputs, but they should not define persisted finalized
  authority once local bundle lookup has a dedicated scoped owner.
- Presigned S3 URLs are also delivery values, not long-term finalized
  authority. If refreshable delivery metadata must exist, it should stay
  explicitly ephemeral rather than shaping the core finalized type.
- This rule applies across every persisted authority carrier, not only
  `verificationResult`: top-level finalized S3 URL mirrors, nested
  `verificationResult.s3BundleUrl` and
  `verificationResult.s3BundleExpiresAt`, and async
  `FinalizationState.succeeded.bundleMetadata` URL fields are the same
  class of residue and should be pruned or quarantined together.
- The same structural cleanup must account for nested
  `VerificationResult` local paths.
  Removing URL fields while leaving `bundlePath` as an implicit restore
  selector would keep a different compatibility locator in the authority
  model.
- Repointing `SessionData.finalizationResult` at
  `FinalizationResultAuthority` is not sufficient by itself while that
  authority type still carries delivery or local-path residue and nested
  projection objects.
- The session contract should move only after the core finalized
  authority type is narrowed, or equivalently split, so route-derived
  URLs and compatibility-only delivery state live in explicit route-
  local or projection-local types instead of the shared authority
  model.
- If specific handlers still need an in-memory compatibility result, use
  dedicated route-local or helper-local types instead of keeping the
  loose shape as the shared session contract.
- This plan treats persisted delivery-URL cleanup and public-response
  URL removal as separate decisions.
  `/api/verify` already follows the selector model, while sync finalize
  and status responses still expose some URL-shaped compatibility
  fields.
- The default 06 posture keeps 03 closed.
  Therefore any remaining finalize or status URL-shaped compatibility
  fields must first be decoupled from persisted storage and re-expressed
  as route-local projection-only output derived from scoped authority
  plus fresh delivery generation where needed.
- Only after that decoupling is in place is it safe to delete persisted
  URL fields from finalized authority, nested `verificationResult`, or
  async succeeded-state metadata without breaking current public
  responses.
- Unless the repository explicitly reopens the 03 public contract,
  those remaining public URL fields may survive only as route-local
  compatibility projections.
  They must not be treated as durable authority or restore selectors.
- Surviving URL-shaped projections must not gain new consumers.
  They exist only to avoid accidental public-wire churn while authority
  is being pruned, and should be removed by a later explicit public
  cutover if no maintained consumer still requires them.
- If the repository does choose the public cutover, route schemas,
  response builders, fixtures, `docs/current/verification/README.md`, and
  any new follow-up note must move together as one explicit change rather
  than as an implied side effect of internal pruning.
  03 remains the fixed historical record for the original public-contract
  cutover.
- Any remaining finalize-sync or verification-run helper that needs
  browser delivery URLs should compute them transiently and must not
  serialize them back into persisted `verificationResult` or back into
  top-level finalized authority.
- Bundle-metadata refresh helpers must stop re-injecting refreshable S3
  delivery URLs into nested `verificationResult`; removing only the
  top-level mirrors is not sufficient cleanup.

### 3. Remove `PublicInputSummary` from verification-runtime inputs

- Verification-runtime inputs should consume supported
  `publicInputArtifact` authority directly, or a narrow type derived
  directly from `typedAuthority` and provenance.
- The runtime should not reconstruct `PublicInputSummary` merely to pass
  fields already present in canonical authority.
- Support or corruption decisions remain boundary concerns:
  once a supported artifact exists, the engine should not need a second
  `valid/errors` adapter contract to restate that fact.
- The replacement must preserve the current admissibility gate explicitly.
  Provenance and context checks such as execution identity, bundle
  identity, bulletin root, and tree size agreement should move into one
  named helper or boundary step rather than disappearing implicitly
  during the cutover.
- That helper must not be scoped to only the four local summary
  suppression checks above.
  It must preserve the broader supported-finalized-read admission
  boundary: public-input identity, election configuration, expected
  count, input commitment, and method-version agreement; manifest
  identity and hash agreement; and close-statement log, timestamp,
  bulletin root, tree size, and STH digest agreement.
- That named helper must preserve fail-closed semantics for admission
  mismatches.
  The boundary must distinguish pre-admission artifact failure from
  post-admission verification evidence failure.
  If a mismatched execution identity, bundle identity, bulletin root, or
  tree size means supported finalized authority cannot be restored, the
  route-visible result remains the existing `artifactState` fail-closed
  contract (`unsupported_current_artifact` or
  `corrupt_or_unreadable`) rather than a success-shaped verification
  payload with check results.
  Only mismatches or omissions that still occur after supported
  finalized authority has been admitted should be mapped into stable
  counted-as-recorded check failures.
  In neither case may the mismatch silently become a benign `not_run`
  result indistinguishable from optional missing evidence.
- The replacement should be one narrow current verification input shape
  derived from `publicInputArtifact.typedAuthority` plus provenance-
  owned execution or bundle identity where the checks truly need it.
- That replacement shape should not reintroduce `valid` or `errors`;
  engine entry should mean both boundary restoration and current-context
  admission already succeeded.
- The cutover must be coordinated across three layers together:
  verify-handler assembly, verification-context or check-builder input
  types, and the counted-as-recorded checks that currently read
  `publicInputSummary` directly.
- If a summary-shaped projection remains useful for diagnostics, it
  should stay clearly outside the core verification-engine input model.

### 4. Canonicalize count vocabulary end to end

- Internal runtime code should use slot/record vocabulary only:
  `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`,
  `excludedSlots`, and `journal.validVotes` when a counted-value signal
  is required.
- This internal cutover includes browser knowledge storage, knowledge
  normalization, browser-side restored finalization snapshots,
  client-normalized verify payload models, i18n labels, summary logic,
  fail-closed helpers, and test helpers, not only server-side types.
- It also includes canonical-adjacent internal journal surfaces:
  `ZkVMJournal`, internal helper inputs, check metadata, and shared
  count compatibility helpers should stop advertising legacy aliases as
  first-class runtime journal fields.
- Because current route schemas are part of the public boundary,
  removing alias fields from those schemas is not part of the default 06
  path.
  That is a separate explicit 03 reopen if chosen.
- The intended steady state is boundary-local only.
  If old alias fields still need to be accepted or projected during one
  bounded cutover, that compatibility should live in explicit parse or
  projection helpers rather than on the canonical runtime journal type.
- Because browser-local knowledge survives route transitions, alias
  retirement and any associated hidden delivery-URL residue cleanup must
  ship with one explicit compatibility action:
  migrate stored keys on read or write, clear stale knowledge on a
  schema bump, or drop incompatible snapshots fail closed.
- One available simplification path is the existing client storage
  schema-bump clearing path, especially when preserving old local values
  is not important enough to justify a dedicated migrator.
- The existing schema-bump path clears more than knowledge data: it also
  clears the browser session snapshot and per-tab lock.
  Reuse it only when that full local invalidation is acceptable for the
  rollout.
  If the cleanup only retires knowledge aliases, proof-shape keys, or
  hidden delivery keys, prefer a knowledge-only migration, targeted
  knowledge clear, or explicitly documented reason for invalidating the
  whole browser-local session.
- `missingIndices`, `invalidIndices`, `countedIndices`, and
  `excludedCount` should stop being first-class internal names across
  normalized app state, knowledge storage, restored client snapshots,
  summary logic, and test helpers.
- Public route alias removal is a separate optional cutover.
  If the repository chooses it, that change should be treated as an
  explicit reopen of the 03 public contract rather than as an implicit
  side effect of internal cleanup.
- This internal vocabulary cleanup does not rename stable verification
  check IDs such as `counted_missing_indices_zero` or UI/test selectors
  such as `check-counted_missing_indices_zero`.
  Those remain current app and test contracts unless a separate explicit
  public/UI contract cutover chooses to change them.
- Until that public cutover is chosen explicitly, any remaining public
  alias fields must be one-way projection-only output derived from the
  canonical internal vocabulary.
- They should also be treated as public-boundary deletion debt rather
  than as a vocabulary that new browser, CLI, or test helpers may adopt.
- If a very short-lived compatibility projection is still needed during
  one slice of cleanup, it must be derived in one projection helper and
  must not flow back into normalized internal types or storage.

### 5. Eradicate `proofMode` from internal canonical proof paths

- The canonical internal inclusion-proof body is the RFC 6962 proof data
  itself:
  `leafIndex`, `treeSize`, `merklePath`, and `bulletinRootAtCast`.
- Internal canonical types, exact CT proof helpers, store interfaces,
  stored vote/session shapes, knowledge models, and client-normalized
  proof payloads should stop carrying `proofMode: 'rfc6962'` as if it
  were meaningful runtime state.
- If a boundary still needs to accept `proofMode` during one bounded
  cutover, it should parse and validate the field at the edge, then
  discard it rather than reattaching it to canonical internal proof
  objects or browser-local knowledge.
- Because current public inclusion-proof schemas no longer require
  `proofMode` and current `/api/verify` proof payloads do not depend on
  it, this internal cleanup can proceed without reopening the 03 public
  contract by default.
- If the repository later chooses to remove any remaining public or
  fixture-level `proofMode` references, that is an explicit public-
  boundary follow-up rather than an implied side effect of internal
  pruning.

### 6. Keep completed plan docs fixed and use 06 as the residue addendum

- `index.md` already distinguishes completed 01-05 work from the
  proposed 06 follow-up; preserve that framing rather than reopening it.
- 03 and 04 remain fixed historical decision records and are not planned
  rewrite targets.
- 06 owns the post-01-05 residue reading note when fixed historical docs
  still contain migration-era wording or now-stale completion-state
  phrasing.
- If future implementation work changes the runtime or public contract,
  document that change in 06, the implementation-oriented verification
  docs, or a new follow-up note rather than rewriting 03 or 04.

### 7. Delete dead compatibility surfaces directly

- Deprecated, unreferenced compatibility components should be removed
  instead of exported as museum pieces.
- That includes stale component exports, test-only placeholders, and
  translation or fixture residue that only exists to support deleted
  names.
- The current audit starts with `ResultSummary` and should include
  sibling deprecated verification components such as `DownloadCard` and
  `VerificationStepsCard`, plus barrel exports when they no longer have
  maintained runtime imports.
- Component deletion does not automatically delete shared translation
  namespaces.
  Keys under names such as `pages.verify.stepsCard.*` and
  `pages.verify.resultSummary.*` remain live while
  `UnifiedVerificationCard` or the current verify page still references
  them.
  Translation cleanup is safe only for strings whose maintained runtime
  callers are gone, or as part of an explicit rekeying slice that moves
  the active component and both locale files together.
- A surface should not survive just because it once helped a migration
  land.

## Sequencing

1. Split canonical runtime authority types from public compatibility
   projection types and parse-local compatibility helpers, so 06 can
   keep 03 closed without relying on the same loose shared DTOs for both
   jobs.
2. Narrow the core finalized authority type itself before repointing the
   shared session runtime contract at it, so "authority" no longer means
   "compatibility shape with a new name."
3. Decouple any remaining finalize or status URL-shaped compatibility
   output from persisted URL fields whenever 03 stays closed, so current
   public responses no longer depend on replaying persisted delivery
   URLs.
4. Tighten finalized authority and locator ownership, including
   persisted delivery-URL and local-path residue in top-level finalized
   wrappers, nested `verificationResult`, and async succeeded-state
   metadata.
5. Decide explicitly whether 06 also opens a public-schema cutover for
   the remaining finalize or status URL fields; if not, quarantine them
   as route-local projection-only compatibility output with no new
   consumers.
6. Define the explicit admissibility boundary for
   `publicInputArtifact`-derived verification inputs and the replacement
   verification input shape, preserving the current distinction between
   pre-admission `artifactState` fail-closed responses and post-admission
   counted-as-recorded check failures.
7. Remove `PublicInputSummary` from verification-runtime inputs.
8. Choose one explicit browser-local compatibility action for alias,
   browser proof-shape, and hidden delivery-URL knowledge residue before
   deleting internal compatibility-first names:
   a knowledge-only migration, a targeted knowledge clear, or the
   existing full schema-bump reset when invalidating the browser session
   snapshot and tab lock is acceptable for the rollout.
9. Collapse legacy count aliases out of internal runtime types,
   canonical internal journal types, browser-local knowledge storage,
   restored client snapshots, client-normalized verify payload models,
   check metadata, summary logic, and test helpers in the same cleanup
   slice as the chosen browser-storage action, while keeping stable
   verification check IDs and UI/test selectors unchanged unless a
   separate explicit contract cutover is chosen.
10. Define the server-side persisted vote and session proof-shape
    compatibility policy separately from browser-local storage cleanup.
    A browser schema bump cannot update or invalidate store-owned
    `VoteData.proofMode`, `VoteStore` return types, or mock/file/Amplify
    persisted vote and session records.
11. Collapse `proofMode` out of internal canonical proof types, stored
    vote/session shapes, store interfaces, knowledge models, client
    normalization, and helper outputs, keeping any short-lived
    compatibility acceptance parse-local only.
12. Decide explicitly whether to open separate public-schema cutovers for
    alias-field, proof-shape, or remaining URL-field removal; if not,
    keep those public fields out of canonical internal state and confined
    to explicit boundary-local compatibility projections, tracked as
    public-boundary deletion debt rather than accepted steady state.
13. Keep completed plan docs fixed; update only 06, the directory index,
    implementation docs, or a new follow-up note when post-01-05 residue
    reading changes.
14. Delete dead compatibility surfaces at the point where no maintained
    runtime imports remain, while retaining any translation namespaces
    still referenced by the active verification UI until a separate
    rekeying slice removes those references.

## Evidence Expectations

- 06 is not complete on prose alone.
  Each pruning slice should land with regression coverage that proves
  compatibility fields stay quarantined instead of flowing back into
  authority.
- Finalized storage and restore coverage should prove persisted
  authority no longer depends on stored bundle or report URLs, persisted
  presigned S3 URLs, or persisted process-local bundle/report/archive
  paths, while current finalize or status responses still work when 03
  stays closed.
- If trusted-local bundle verification remains as an implementation of
  the authenticated selector contract, coverage should prove its local
  path input is scoped by session, `verificationExecutionId`, and
  optional bundle key rather than recovered as loose nested
  `VerificationResult` authority.
- Verification-handler and verification-engine coverage should prove the
  explicit `publicInputArtifact` admissibility helper replaces
  `PublicInputSummary` without weakening hard-failure checks such as
  `counted_missing_indices_zero`,
  `counted_expected_vs_tree_size`,
  `counted_election_manifest_consistent`,
  `counted_close_statement_consistent`, and
  `stark_receipt_verify`.
- That coverage should include provenance or context mismatch cases so
  execution identity, bundle identity, bulletin root, or tree size drift
  preserves the current pre-admission `artifactState` fail-closed route
  contract when supported finalized authority cannot be restored, and
  fails through stable counted-as-recorded signals only for
  post-admission evidence failures.
  Neither path may collapse into benign optional missing evidence.
- It should also include representative mismatches from the broader
  public audit artifact boundary, not only the local summary suppression
  fields: public-input `electionId`, `electionConfigHash`,
  `totalExpected`, recomputed input commitment, and `methodVersion`;
  election-manifest identity, count, and hash agreement; and
  close-statement `logId`, timestamp, bulletin root, tree size, and STH
  digest agreement.
- Browser-local knowledge coverage should prove the chosen full
  schema-bump, knowledge-only migration, or targeted knowledge clear
  removes deleted alias, proof-shape, and hidden delivery-URL keys
  instead of surfacing raw fallback labels from stale local state.
  If the full schema-bump reset is used, coverage or rollout notes
  should explicitly acknowledge that the browser session snapshot and
  per-tab lock are also invalidated.
- Store/session proof-shape coverage is separate from that browser-local
  coverage.
  It should prove that `VoteData.proofMode`, `VoteStore` proof return
  types, and mock/file/Amplify persisted vote or session records are
  either migrated, parsed-and-dropped at the store boundary, or rejected
  fail closed according to the chosen server-side compatibility policy.
- Route and client-normalization coverage should prove compatibility
  fields, when still exposed publicly, are derived one way from
  canonical internal state and do not flow back into session authority,
  verification context, or restored client snapshots.
- Deletion of deprecated verification components should land only with
  import-level or render-level evidence that maintained runtime callers
  are gone and barrel exports or module-level named exports no longer
  preserve dead surfaces by accident.
  Translation deletion should be separately justified by active-runtime
  usage, because the replacement verification UI may still use legacy
  namespace names.

## Exit Criteria

- Canonical runtime authority types, boundary-local parse helpers, and
  public compatibility projection types are explicit separate layers.
  Internal pruning no longer relies on mutating one loose shared DTO
  that also defines current public responses.
- Persisted finalization storage continues to center a narrowed
  finalized-authority type, and shared runtime or session contracts no
  longer advertise loose `FinalizationResult` as the primary session
  shape.
- If `FinalizationResultAuthority` remains the name of that authority
  type, it no longer carries route-derived or refreshable delivery URLs,
  process-local bundle/report/archive paths, or nested public-projection
  objects merely because those fields still exist at explicit
  compatibility boundaries.
- If 03 remains closed, current finalize or status URL-shaped
  compatibility fields are route-local projection-only output derived
  from scoped authority and no longer read back from persisted finalized
  authority or async succeeded-state metadata.
- Persisted `verificationResult` no longer stores route-derived
  `bundleUrl` or `reportUrl`.
- Persisted `verificationResult` no longer stores process-local
  `bundlePath`, `reportPath`, or `bundleArchivePath` as durable authority
  or restore selectors.
- Persisted finalized authority, nested persisted `verificationResult`,
  and async succeeded-state metadata no longer store long-lived
  delivery URLs such as `s3BundleUrl`,
  `verificationResult.s3BundleUrl`, or `bundleMetadata.s3BundleUrl` as
  if they were durable authority.
- Core finalized authority does not depend on persisted presigned S3
  URLs or persisted process-local paths to recover bundle or report
  delivery.
- If trusted-local bundle execution remains, it is represented as a
  bounded transient bridge or dedicated scoped locator, not as nested
  `VerificationResult` path authority.
- If sync finalize or status responses still surface URL-shaped
  compatibility fields, those fields are route-local projection-only
  output and never participate in persistence, restore authority, or
  selector ownership.
- Those URL-shaped fields have a no-new-consumer policy and remain
  public-boundary deletion debt unless a later explicit public-contract
  cutover deliberately keeps them.
- If the repository chooses a public delivery-URL cutover,
  `docs/current/verification/README.md`, route schemas, fixtures, and any
  new follow-up note are updated together as one explicit follow-up.
  03 remains fixed.
- Verification-engine inputs no longer depend on `PublicInputSummary`,
  and the replacement path preserves one explicit admissibility gate for
  `publicInputArtifact` provenance and context agreement.
- The replacement preserves the current route-visible boundary:
  pre-admission public-input provenance or context mismatches that make
  finalized authority unsupported or corrupt still return fail-closed
  `artifactState` responses, while post-admission verification evidence
  failures are expressed through check results.
- Internal runtime types, canonical internal journal types, helper
  inputs, browser-local knowledge models, restored client finalization
  snapshots, verify payload parsers, and test helpers no longer treat
  `missingIndices`, `invalidIndices`, `countedIndices`, or
  `excludedCount` as the primary vocabulary.
- If alias parsing or projection survives temporarily, it is confined to
  explicit boundary-local helpers rather than the canonical runtime
  journal contract.
- Alias retirement includes an explicit browser-storage migration,
  schema-bump clear, or equivalent stale-snapshot drop rule, so deleted
  knowledge keys do not resurface as raw panel labels from old local
  state.
- If the repository uses browser-local clearing rather than key-by-key
  migration, the implementation explicitly chooses between a
  knowledge-only clear and the existing schema-versioned storage reset.
  The existing reset is acceptable only when clearing the browser session
  snapshot and per-tab lock is an intended part of the rollout.
- Browser-local knowledge no longer persists hidden URL-shaped delivery
  residue such as `s3BundleUrl` and `s3BundleExpiresAt` as if that data
  were part of the canonical restored verification state.
- If public alias fields still exist, they are projection-only output
  and never flow back into canonical internal or persisted authority.
- They also have a no-new-consumer policy and remain public-boundary
  deletion debt unless a later explicit public-contract cutover
  deliberately keeps them.
- If the repository chooses a public alias-field removal cutover,
  `docs/current/verification/README.md`, route schemas, fixtures, and any
  new follow-up note are updated together as an explicit follow-up.
  03 remains fixed.
- Internal count-vocabulary cleanup does not require renaming stable
  verification check IDs or browser test selectors.
  Any such rename is a separate explicit public/UI contract cutover.
- Internal canonical proof types, exact CT proof helpers, stored vote and
  session shapes, store interfaces, client-normalized proof payloads, and
  browser-local knowledge no longer require or reattach `proofMode`.
- If `proofMode` is still accepted anywhere temporarily, it is confined
  to explicit parse-only boundary helpers and does not survive in
  canonical internal or browser-local proof objects.
- If the repository chooses a public `proofMode` removal cutover,
  `docs/current/verification/README.md`, route schemas, fixtures, relevant
  clients, and any new follow-up note are updated together as an explicit
  follow-up.
  03 remains fixed.
- The directory index and 06 clearly explain that fixed historical docs
  may retain migration-era wording, while 06 owns post-01-05 residue
  reading.
- Dead compatibility components such as the deprecated `ResultSummary`,
  `DownloadCard`, and `VerificationStepsCard` surfaces are removed when
  no maintained runtime caller remains.
- Shared verification translation namespaces are not deleted merely
  because deprecated components are removed; any such deletion waits
  until active `UnifiedVerificationCard` or verify-page references have
  been rekeyed or removed in both locale files.

## Safety Constraints

- `excludedSlots > 0` must continue to fail closed even if
  `excludedCount` is deleted.
- No route or restore path may recover missing authority from raw URLs,
  stale browser caches, or ad hoc artifact parsing.
- Removing `PublicInputSummary` must not convert pre-admission finalized
  artifact failures into success-shaped `/api/verify` payloads.
  The existing `artifactState` fail-closed contract remains the boundary
  for unsupported or corrupt finalized authority unless an explicit
  public-contract cutover says otherwise.
- If 03 stays closed during URL cleanup, route-local compatibility
  output must continue satisfying the current public response contract
  until an explicit public cutover lands.
- Internal count-vocabulary cleanup must not silently rename stable
  verification check IDs or browser test selectors.
  Any such rename is a separate explicit public/UI contract cutover.
- Deleting alias translations or UI labels is not sufficient cleanup on
  its own when stale browser-local knowledge can still surface those
  deleted keys.
- Deleting deprecated verification components must not delete translation
  keys that the maintained verification UI still imports or references.
- Removing `proofMode` must not loosen RFC 6962 inclusion-proof
  validation.
  Only the redundant compatibility tag is pruned; proof-body validation
  and fail-closed behavior remain unchanged.
- Public bundle boundaries remain unchanged:
  private artifacts still do not enter public bundle delivery.
- This pruning work must reduce ambiguity and surface area without
  relaxing any verification hard-failure rule from the existing plans.
