# Repository Context Map

This document is the current ownership map for the repository. It describes
where responsibilities live, which components may depend on which workspace
packages, and where runtime boundaries meet. It is not a migration plan or a
deployment inventory. Current code, package manifests, Terraform, and tests
win when this map drifts.

The executable production dependency policy is enforced by the source
repository's `tooling/repository/workspace-boundaries.test.ts` test.
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) selects workspace members;
[`tooling/workspace/workspace-metadata.ts`](../../tooling/workspace/workspace-metadata.ts)
derives package identities, dependencies, and exports from their manifests and
owns the reviewed runtime/test map.

## System Shape

```text
Browser
  -> apps/web
  -> API Gateway -> infra/lambdas/public-api
                 -> apps/api
                    -> packages/application use cases
                    -> packages/domain facts and ports
                    -> packages/aws-adapters and packages/node-adapters
                       -> DynamoDB, S3, SQS, Step Functions, and Batch/Fargate prover

Other App runtime Lambda entrypoints
  -> application, AWS, and Node adapter boundaries
  -> verifier-service through verification-worker

zkvm host + guest
  -> receipt and journal artifacts
  -> verifier-service
  -> packages/verification evidence evaluation + presentation policy
  -> apps/web translated presentation
```

The browser may present `Verified` only after every required verification
check passes. Proof generation, receipt verification, evidence evaluation, and
UI presentation remain separate responsibilities.

## Workspace And Component Ownership

| Surface                                      | Owns                                                                                                                                                                              | Boundary                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository root                              | Workspace orchestration, lockfile, shared commands, and cross-cutting configuration                                                                                               | It is not a product-domain package.                                                                                                                                                       |
| `apps/web`                                   | Vite/React browser entrypoint, routes, components, i18n, browser API client, and local session/knowledge state                                                                    | Browser-safe imports only; no server handlers, concrete stores, AWS SDK clients, raw server environment reads, or private artifact readers.                                               |
| `apps/api`                                   | Runtime route-set selection, Hono binding, HTTP middleware, handlers, and runtime composition                                                                                     | Schema-carrying route and request/response authority comes from `packages/api-contract`; reusable use-case and domain policy belongs in the appropriate package.                          |
| `packages/api-contract`                      | Schema-carrying public route inventory, request/response schemas, route metadata, and public error envelopes                                                                      | Public wire shapes are not domain persistence records or runtime handler implementations.                                                                                                 |
| `packages/application`                       | Cross-context use cases and ports for session reads/mutations, finalization, verification reads and artifact delivery, bot flow, and zkVM-input orchestration                     | Depends on domain facts and injected ports; concrete AWS, filesystem, archive, subprocess, HTTP, and browser adapters stay at the edge.                                                   |
| `packages/aws-adapters`                      | DynamoDB, S3, SQS, rate-limit, target config-reference, artifact, and concrete persistence adapters                                                                               | Server/runtime only. It may compose application ports and shared Node adapters but does not own browser or public-export behavior.                                                        |
| `packages/crypto-primitives`                 | Product-neutral strict hex normalization/conversion and SHA-256 primitives                                                                                                        | Neutral leaf package; it does not own domain commitments, Merkle policy, verification semantics, runtime configuration, or concrete adapters.                                             |
| `packages/deployment-authority`              | Pure reviewed deployment-target configuration and deterministic execution, plan-package, checkpoint, mutation-owner, image, drift, and framework policy                           | No AWS SDK, credential, filesystem, process, Terraform execution, or operator-side effects; those remain in scripts, Lambda adapters, and Terraform roots.                                |
| `packages/diagnostics`                       | Runtime logging, request-scoped context, request ID extraction, and log-safe hashing                                                                                              | Diagnostics stay outside deterministic domain behavior.                                                                                                                                   |
| `packages/domain`                            | Session, election, vote, bulletin, finalization, verification-observation facts, deterministic operations, and runtime ports                                                      | No concrete AWS/filesystem adapters, runtime config readers, browser cache, API payload ownership, verification projections, or zkVM-input translation.                                   |
| `packages/merkle`                            | Pure CT/RFC 6962 tree construction, inclusion/consistency proof behavior, and proof normalization                                                                                 | Depends only on shared cryptographic primitives; it does not own domain, API, browser, verification-policy, or concrete adapter behavior.                                                 |
| `packages/node-adapters`                     | Node filesystem/archive/process adapters, verifier-service execution, ImageID mapping reads, local bundle persistence, and zkVM execution                                         | Server, Lambda, CLI, and test consumers only; these concrete adapters stay outside domain and verification core.                                                                          |
| `packages/runtime-config`                    | Pure runtime-profile selection, configuration parsing, target-runtime validation, mode classification, and browser-public environment projections                                 | It does not resolve AWS values itself or import domain orchestration, verification core, API handlers, browser UI, or concrete adapters.                                                  |
| `packages/test-support`                      | Shared fixtures, builders, mock stores, and CLI/test harness helpers                                                                                                              | Test-only. Production packages must not import it from production source.                                                                                                                 |
| `packages/validation`                        | Product-neutral schemas and reusable validation primitives                                                                                                                        | Dependency-light leaf package; it must not depend on product-domain or runtime packages.                                                                                                  |
| `packages/verification`                      | Verification checks, summaries, display eligibility, browser-local cast calculations, ImageID policy, bitmap/Merkle evidence, and pure bundle/report/private-artifact projections | No concrete filesystem, archive, AWS, session-store, runtime-config, API-payload, browser storage, or localized-copy ownership.                                                           |
| `packages/zkvm-contract`                     | TypeScript zkVM wire types, canonical encoding, journal/bitmap helpers, and cross-language vectors                                                                                | Must remain byte-compatible with Rust and independent of API, UI, session, store, Terraform, and proof-execution concerns.                                                                |
| `zkvm`                                       | RISC Zero Rust contract core, guest method, host CLI, proof generation, journal emission, and Rust-side compatibility tests                                                       | Generates proofs; receipt verification belongs to `verifier-service`. See [`zkvm/README.md`](../../zkvm/README.md).                                                                       |
| `verifier-service`                           | Standalone Rust receipt discovery and `Receipt::verify(expected_image_id)`                                                                                                        | Used by local/server Node adapters and packaged into the target verification-worker Lambda. See [`verifier-service/README.md`](../../verifier-service/README.md).                         |
| `formal`                                     | Lean models, proofs, reports, and generated correspondence vectors for selected fail-closed and encoding invariants                                                               | Does not claim to prove the complete app, cryptographic primitives, RISC Zero soundness, AWS behavior, or React UI. See [`formal/README.md`](../../formal/README.md).                     |
| `infra/lambdas`                              | App runtime entrypoints and the image-signature-verifier wrapper                                                                                                                  | Lambda handlers adapt events and bootstrap runtime dependencies; reusable policy remains in apps/packages or the dedicated verifier cores.                                                |
| `infra/image-signature-verifier`             | Cryptographic Prover-image signature verification core, pinned native-asset manifest, trust root, and deterministic package contract                                              | The Lambda request/response wrapper is `infra/lambdas/image-signature-verifier`; App Terraform owns immutable versions. See its [README](../../infra/image-signature-verifier/README.md). |
| `infra/docker`                               | Prover image builds and the async prover entrypoint                                                                                                                               | The entrypoint owns async artifact conversion, public bundle packaging, private artifact promotion, and upload behavior.                                                                  |
| `infra/terraform`                            | Bootstrap, Foundation and App infrastructure roots                                                                                                                                | `foundation` owns target prerequisites and retained image repositories; `app` owns runtime resources. The deleted legacy account's IaC is retired.                                        |
| `scripts` (`@stark-ballot/repository-tools`) | Repository guardrails and task-specific build, test, formal, security, public-export, Terraform, and operator automation                                                          | May compose multiple owners, including pure deployment authority, but does not become runtime business-logic authority.                                                                   |
| `tests/e2e`                                  | Browser workflow and accessibility tests crossing the frontend and server harnesses                                                                                               | Stable selectors and page objects live here because the tests span application boundaries.                                                                                                |
| `docs` and `public-book`                     | Implementation-oriented contracts and public specifications                                                                                                                       | Documentation records current behavior but is subordinate to implementation and executable tests.                                                                                         |
| `public`                                     | Browser-public static assets and the ImageID mapping trust-chain input                                                                                                            | Must contain no private verification artifacts or operator-only evidence.                                                                                                                 |

## Production Workspace Dependency Directions

This table is the exact workspace-package allowlist for production source.
Third-party dependencies are outside its scope. Tests have a separate
test-source allowlist; in particular, selected packages may use
`@stark-ballot/test-support`. Verification tests remain within their package's
production dependency directions.

| From                                 | Allowed production workspace dependencies                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@stark-ballot/api`                  | `@stark-ballot/api-contract`, `@stark-ballot/application`, `@stark-ballot/aws-adapters`, `@stark-ballot/crypto-primitives`, `@stark-ballot/diagnostics`, `@stark-ballot/domain`, `@stark-ballot/node-adapters`, `@stark-ballot/runtime-config`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                       |
| `@stark-ballot/web`                  | `@stark-ballot/api-contract`, `@stark-ballot/application`, `@stark-ballot/crypto-primitives`, `@stark-ballot/merkle`, `@stark-ballot/runtime-config`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                                                 |
| `@stark-ballot/api-contract`         | `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                                                                                                                                                                                                       |
| `@stark-ballot/application`          | `@stark-ballot/crypto-primitives`, `@stark-ballot/diagnostics`, `@stark-ballot/domain`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                                                                                                               |
| `@stark-ballot/aws-adapters`         | `@stark-ballot/application`, `@stark-ballot/crypto-primitives`, `@stark-ballot/diagnostics`, `@stark-ballot/domain`, `@stark-ballot/node-adapters`, `@stark-ballot/runtime-config`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                   |
| `@stark-ballot/crypto-primitives`    | None                                                                                                                                                                                                                                                                                                                                                                                          |
| `@stark-ballot/deployment-authority` | None                                                                                                                                                                                                                                                                                                                                                                                          |
| `@stark-ballot/diagnostics`          | `@stark-ballot/validation`                                                                                                                                                                                                                                                                                                                                                                    |
| `@stark-ballot/domain`               | `@stark-ballot/crypto-primitives`, `@stark-ballot/merkle`, `@stark-ballot/validation`                                                                                                                                                                                                                                                                                                         |
| `@stark-ballot/merkle`               | `@stark-ballot/crypto-primitives`                                                                                                                                                                                                                                                                                                                                                             |
| `@stark-ballot/node-adapters`        | `@stark-ballot/diagnostics`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                                                                                                                                                                          |
| `@stark-ballot/repository-tools`     | `@stark-ballot/api`, `@stark-ballot/api-contract`, `@stark-ballot/crypto-primitives`, `@stark-ballot/deployment-authority`, `@stark-ballot/diagnostics`, `@stark-ballot/domain`, `@stark-ballot/merkle`, `@stark-ballot/node-adapters`, `@stark-ballot/runtime-config`, `@stark-ballot/test-support`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract` |
| `@stark-ballot/runtime-config`       | `@stark-ballot/validation`                                                                                                                                                                                                                                                                                                                                                                    |
| `@stark-ballot/test-support`         | `@stark-ballot/api-contract`, `@stark-ballot/domain`, `@stark-ballot/node-adapters`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                                                                                                                  |
| `@stark-ballot/validation`           | None                                                                                                                                                                                                                                                                                                                                                                                          |
| `@stark-ballot/verification`         | `@stark-ballot/crypto-primitives`, `@stark-ballot/merkle`, `@stark-ballot/validation`, `@stark-ballot/zkvm-contract`                                                                                                                                                                                                                                                                          |
| `@stark-ballot/zkvm-contract`        | None                                                                                                                                                                                                                                                                                                                                                                                          |

The root package may orchestrate all of these boundaries through scripts. That
does not authorize a production package to import back through the root.

## Runtime Contact Points

The schema-carrying route inventory in
[`packages/api-contract/src/routes/inventory.ts`](../../packages/api-contract/src/routes/inventory.ts)
is selected into runtime modes by
[`apps/api/src/server/api/routes/definitions.ts`](../../apps/api/src/server/api/routes/definitions.ts);
[`apps/api/src/server/api/routes/hono.ts`](../../apps/api/src/server/api/routes/hono.ts)
binds handlers and admits requests for Hono and the API Gateway Lambda runtime.

Hono composition registers root request logging once, keeps public CORS outside
internal callbacks, and mounts session, finalization, verification/artifact and
bulletin child applications. Resource preparation is bound directly to each
method/path. `honoBindings.ts` owns the typed handler registry; one composition
registry checks all mounted children for missing and duplicate routes. Store
resolution remains request-time and bound to the immutable runtime profile.

Handlers receive schema-derived route input separately from admitted context,
which carries trusted transport metadata, dependencies, and validated identifiers.
Ordinary JSON handlers return responses admitted for their exact route;
artifact and conditional handlers use the dedicated raw-response boundary.
The detailed browser-facing contract is documented in
[`docs/ui/api-contract.md`](../ui/api-contract.md).

[`packages/application/src/session/`](../../packages/application/src/session/)
owns session-capacity policy, vote prechecks, and mutation ports. Expected
outcomes use application `Result` values; storage and infrastructure failures
remain exceptional. API handlers translate these outcomes into route-bound
HTTP responses and own transport concerns such as capability issuance.

`POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations`
is an authenticated, owner-scoped boundary from the browser verification route
to the API. It records the first bounded browser-local cast-check observation
for the exact finalization through the store's durable compare-and-set
behavior. It is telemetry, not verdict authority: success or failure of the
observation request must not change the browser's verification result.
Verification verdict and evidence rules remain in
[`docs/verification/README.md`](../verification/README.md).

The App runtime Lambda set is `public-api`, `finalization-writer`,
`proof-dispatcher`, `verification-worker`, and `semaphore-janitor`. The
dedicated `image-signature-verifier` Lambda is packaged separately
because its native assets and permissions boundary form
a distinct trust boundary. The ordinary App Apply publishes its immutable
version, which Step Functions invokes directly. App preparation verifies the
same Prover digest natively before producing the saved plan.
Foundation owns no Lambda workload. Its native ECR lifecycle policy retains
the five newest images per repository and may expire promoted or currently used
images. Missing image dependencies fail closed; direct operator cleanup remains
separately authorized.

## Lifecycle And Utility Constraints

Persistence is lifecycle-owned. Domain owns required `SessionIdentityRecord`
and mutable `SessionVotingRecord`; application owns `FinalizationRecord`,
verification-result records, transitions, and the non-persisted `SessionReadModel`.
Verification observations are separate telemetry keyed by `finalizationId`;
AWS delivery/runtime metadata stays adapter-owned. Session creation writes
complete identity/configuration; reads never mint or repair missing identifiers.
Mock, file, and Dynamo stores persist the same current record families.
File evaluation and writes remain under the exclusive mutation lock. Dynamo
uses exact persisted lifecycle/scenario CAS and bounded reload/re-evaluation.
Adapters emit canonical lifecycle observations only after the durable outcome
is known and must not recreate transition tables.

Persistence admission is a hard cut: no old-shape reader, generation marker,
dual writer, or read-time repair. Invalid retained server state fails closed.
Invalid `starkBallotSession` browser data is cleared together with the knowledge
and per-tab lock state, requiring a new session. Preserve the `starkBallotSession`
key, `stark-ballot-knowledge` panel state, and `sessionStorage` lock; stale tabs
must stop acting if another tab replaces the session.

One `finalizationId` scopes state, verifier work/results, observations, and
bundle/report selection and locators. Sync and async creation use the same
strict resource. Proof-bound journal authority, presentation, gated voter
evidence, artifact availability, and runtime diagnostics remain separate.
Concrete queues, executors, S3, verifier, ImageID, rate limits, and bundle
construction belong in `apps/api/src/server/composition/finalizationDependencies.ts`.
The raw-body callback at
`/api/internal/sessions/:sessionId/finalizations/:finalizationId/callback` is
API-local: exclude it from public inventory, API Gateway/Lambda mounting,
browser CORS, and clients. Authenticate exact bounded bytes before JSON
admission and require path/payload identity equality.

Keep shared leaf utilities with their semantic owners:

- Public API errors and `Content-Range` grammar: `packages/api-contract`.
- Neutral safe segments, unknown values, and ImageID selection: `packages/validation`.
- Browser-safe generic hex/byte/SHA-256: `packages/crypto-primitives`; keep
  protocol framing and zkVM parity with their domain owners.
- Finalization tamper meaning: `packages/verification`; progress projection:
  the browser-safe application module.
- Raw cookie parsing: `apps/web`; bounded request-byte reading: API HTTP
  transport, with endpoint-owned limits and response mapping.
- Generic polling and CLI presentation fixtures: `packages/test-support`,
  for tests/diagnostics only. Production retry policy stays local; benchmark
  batching stays scripts-owned.

## Runtime Configuration Authority

Do not maintain a duplicate environment-variable inventory here. The current
authorities are:

- [`packages/runtime-config/src/env/runtimeProfile.ts`](../../packages/runtime-config/src/env/runtimeProfile.ts)
  for immutable profile selection, profile shape, target/local input admission,
  and adapter posture before composition;
- [`packages/runtime-config/src/env/validate.ts`](../../packages/runtime-config/src/env/validate.ts)
  for startup constraints on the selected profile and resolved environment;
- [`packages/runtime-config/src/env/observability.ts`](../../packages/runtime-config/src/env/observability.ts)
  for target logging, deployment identity, source SHA, and deployment-mode
  validation;
- [`packages/aws-adapters/src/config/awsRuntimeConfigReferenceResolver.ts`](../../packages/aws-adapters/src/config/awsRuntimeConfigReferenceResolver.ts)
  for target SSM and Secrets Manager resolution; and
- [`infra/terraform/app/target_lambdas.tf`](../../infra/terraform/app/target_lambdas.tf)
  plus [`infra/terraform/app/locals.tf`](../../infra/terraform/app/locals.tf)
  for injected values and account/environment-scoped reference paths.

Those authorities cover, among other classes, capability and vote secrets,
Turnstile inputs, the expected CloudFront origin-verification header reference,
log-salt and target observability fields, proof and verification queues,
Batch prover settings and operations-ledger inputs (the existing
`semaphore_janitor` Lambda identity is retained).
Target runtime values fail closed when required references or deployment
identity fields are missing or inconsistent.

## Cross-Cutting Authorities

- AWS topology and service responsibilities:
  [`docs/architecture/aws-architecture.md`](./aws-architecture.md) and
  [`docs/infrastructure/README.md`](../infrastructure/README.md).
- Pure deployment target/lane resolution and semantic admission policy:
  [`packages/deployment-authority`](../../packages/deployment-authority/).
  Foundation compatibility uses explicit resource requirements verified by owning
  Smoke, while source SHA remains execution provenance; no implementation
  dependency scanner participates in consumer admission.
  Bootstrap and diagnostic drift execute locally; Foundation/App remain managed.
  Immutable plan packages bind approval, root checkpoints follow owning Smoke,
  and conditional mutation owners reject stale continuations. Four pipelines and
  13 active projects are source-derived.
  Credential, AWS, filesystem, process, approval submission, live inventory,
  and snapshot generation remain private operator concerns implemented at the
  repository edge; generated public snapshots intentionally omit those
  procedures.
- Public safety gates:
  [`scripts/security/README.md`](../../scripts/security/README.md).
- CLI and regression harness behavior:
  [`scripts/tests/README.md`](../../scripts/tests/README.md).
- Public/private bundle membership and verification semantics:
  [`docs/verification/README.md`](../verification/README.md).

## Finalization Reconciliation

The AWS direct finalization writer also receives an exact scheduled
`{ operation: "reconcile-finalizations" }` invocation every minute. The dispatcher
starts executions, the direct writer stores outcomes, and Batch holds each
prover slot until its attempt terminates. Successful callbacks obtain `startedAtMs`
from the exact stored session/finalization and queued-time record written by
container admission; a running or already-succeeded lifecycle is required.
Transport and Batch timestamps do not replace that lifecycle authority.
The former semaphore-janitor Lambda
now only writes normalized operations-ledger records. Neither GET nor HEAD establishes terminal lifecycle state.

The AWS adapter queries `finalization-expiry-index` (`itemType`, `expiresAt`)
for unexpired FINALIZATION records, in descending expiry order and pages of 25,
projecting only owner and finalization IDs. Each run deduplicates exact
session/finalization pairs across pages. It deliberately does not deduplicate by
session alone: an old ID from the eventually consistent index must not suppress
the current ID. Newer expiries are attempted first to reduce starvation of recent
work when the invocation budget is exhausted. It does not scan session or vote
records. Terminal candidates are skipped after a current-state read. The index is eventually consistent;
subsequent scheduled runs revisit missing candidates. The index is not sparse:
every sessions-table record with both key attributes incurs index storage and
write cost, including non-finalization records. Low-cardinality `itemType` keys
can concentrate traffic, and index write throttling can affect base-table writes.
The separate votes table is unaffected. This preserves the current record shape;
capacity review must consider the extra writes as well as query volume.
Stopped recovery requires the same index on restored sessions tables. Quiesced recovery disables the
schedule as well as both queue consumers; in-flight work must drain before a
pair switch.

`reconcile-finalization.ts` owns the use case and minimal lifecycle/execution
ports. The adapter derives execution ARNs from the trusted target state machine
and admitted finalization ID, normalizing exact SDK errors. Pending work has a
60-second initial grace and the validated dispatch deadline (default 900 seconds).
Missing dispatch beyond that deadline fails; a terminal execution without a
pending outcome records FINALIZATION_OUTCOME_UNRECORDED. Running executions
record timeout, execution failure/abort, or unrecorded outcome, never proof success.
Terminal observations wait 60 seconds for the writer before a transition attempt.
Lifecycle stores retain their existing locks/CAS. A rejected write re-reads
current state, preserving a concurrent success, cancellation, or newer identity.
Storage and observation failures propagate for retry; no unsaved failure is
returned by the API.

The writer has a 120-second invocation budget. Pagination visits every candidate;
a failed candidate does not prevent later candidates from being attempted. The
summary reports `visited` index rows (including skipped/failed rows), not successful
state transitions. Candidate failures log only admitted correlation IDs (session
hashed) and allowlisted error names; messages, causes and raw candidate data are
excluded. The invocation still fails after all candidate errors, including policy
rejections: claiming success would conceal unresolved work. Operators use these
logs and canonical rejection events to distinguish persistent invalid data from
transient failures. This allows Lambda retries and the existing
writer Errors alarm. EventBridge retries delivery twice within five minutes;
its FailedInvocations alarm is passive, and the next schedule repeats the query.
Growing candidate volume or sustained invocation timeouts requires operational
capacity review; there is no claim of an unbounded throughput guarantee.

## Naming

Use a domain noun and an operation, with qualification only where it distinguishes
owners or authority. Module-local names need not repeat their full directory
context. Keep semantic
terms such as `finalization`, `authority`, and `reviewed` when they distinguish
security or lifecycle boundaries. Descriptive invariant test names may be longer.

AWS names use the configured target prefix plus a short purpose suffix. Scheduled
finalization work uses `finalization-sweep`; its delivery alarm uses
`finalization-sweep-delivery`. Validate fully expanded names for every configured
target against the service-specific limits, and keep rule names aligned with the
exact deployment/drift IAM inventory. Existing physical resource names, stored
keys and public wire fields are identities: cosmetic shortening must not silently
replace deployed resources or alter retained authority.
