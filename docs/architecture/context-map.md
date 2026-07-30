# Repository Context Map

This document is the current ownership map for the repository. It describes
where responsibilities live, which components may depend on which workspace
packages, and where runtime boundaries meet. It is not a migration plan or a
deployment inventory. Current code, package manifests, Terraform, and tests
win when this map drifts.

The executable production dependency policy is enforced by the source
repository's `scripts/__tests__/repository-boundaries.test.ts` test.
The workspace inventory is declared in
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml).

## System Shape

```text
Browser
  -> apps/web
  -> API Gateway -> infra/lambdas/public-api
                 -> apps/api
                    -> packages/application use cases
                    -> packages/domain facts and ports
                    -> packages/aws-adapters and packages/node-adapters
                       -> DynamoDB, S3, SQS, Step Functions, and ECS prover

Other infra/lambdas target entrypoints
  -> application, AWS, and Node adapter boundaries
  -> verifier-service through verification-worker

zkvm host + guest
  -> receipt and journal artifacts
  -> verifier-service
  -> packages/verification projections
  -> apps/web verification presentation
```

The browser may present `Verified` only after every required verification
check passes. Proof generation, receipt verification, evidence evaluation, and
UI presentation remain separate responsibilities.

## Workspace And Component Ownership

| Surface                          | Owns                                                                                                                                        | Boundary                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository root                  | Workspace orchestration, lockfile, shared commands, and cross-cutting configuration                                                         | It is not a product-domain package.                                                                                                                                                       |
| `apps/web`                       | Vite/React browser entrypoint, routes, components, i18n, browser API client, and local session/knowledge state                              | Browser-safe imports only; no server handlers, concrete stores, AWS SDK clients, raw server environment reads, or private artifact readers.                                               |
| `apps/api`                       | Framework-neutral route inventory, Hono binding, HTTP middleware, handlers, and runtime composition                                         | Request/response authority comes from `packages/api-contract`; business logic and reusable policy belong in the appropriate package.                                                      |
| `packages/api-contract`          | Public route metadata, request/response schemas, and public error envelopes                                                                 | Public wire shapes are not domain persistence records.                                                                                                                                    |
| `packages/application`           | Cross-context use cases for finalization, bot flow, and zkVM-input orchestration                                                            | Depends on domain facts and injected ports; concrete AWS, filesystem, archive, subprocess, HTTP, and browser adapters stay at the edge.                                                   |
| `packages/aws-adapters`          | DynamoDB, S3, SQS, rate-limit, target config-reference, artifact, and concrete persistence adapters                                         | Server/runtime only. It may compose application ports and shared Node adapters but does not own browser or public-export behavior.                                                        |
| `packages/diagnostics`           | Runtime logging, request-scoped context, request ID extraction, and log-safe hashing                                                        | Diagnostics stay outside deterministic domain behavior.                                                                                                                                   |
| `packages/domain`                | Session, election, vote, bulletin, finalization, verification-observation facts, deterministic operations, and runtime ports                | No concrete AWS/filesystem adapters, runtime config readers, browser cache, API payload ownership, verification projections, or zkVM-input translation.                                   |
| `packages/merkle`                | Pure CT/RFC 6962 tree construction, inclusion/consistency proof behavior, and proof normalization                                           | Depends only on hashing primitives; it does not own domain, API, browser, verification-policy, or concrete adapter behavior.                                                              |
| `packages/node-adapters`         | Node filesystem/archive/process adapters, verifier-service execution, ImageID mapping reads, local bundle persistence, and zkVM execution   | Server, Lambda, CLI, and test consumers only; these concrete adapters stay outside domain and verification core.                                                                          |
| `packages/runtime-config`        | Pure runtime configuration parsing, target-runtime validation, mode classification, and browser-public environment projections              | It does not resolve AWS values itself or import domain orchestration, verification core, API handlers, browser UI, or concrete adapters.                                                  |
| `packages/test-support`          | Shared fixtures, builders, mock stores, and CLI/test harness helpers                                                                        | Test-only. Production packages must not import it from production source.                                                                                                                 |
| `packages/validation`            | Product-neutral schemas and reusable validation primitives                                                                                  | Dependency-light leaf package; it must not depend on product-domain or runtime packages.                                                                                                  |
| `packages/verification`          | Verification checks and summaries, ImageID policy, bitmap/Merkle evidence, and pure bundle/report/private-artifact projections              | No concrete filesystem, archive, AWS, session-store, runtime-config, API-payload, or browser-localized ownership.                                                                         |
| `packages/zkvm-contract`         | TypeScript zkVM wire types, canonical encoding, journal/bitmap helpers, and cross-language vectors                                          | Must remain byte-compatible with Rust and independent of API, UI, session, store, Terraform, and proof-execution concerns.                                                                |
| `zkvm`                           | RISC Zero Rust contract core, guest method, host CLI, proof generation, journal emission, and Rust-side compatibility tests                 | Generates proofs; receipt verification belongs to `verifier-service`. See [`zkvm/README.md`](../../zkvm/README.md).                                                                       |
| `verifier-service`               | Standalone Rust receipt discovery and `Receipt::verify(expected_image_id)`                                                                  | Used by local/server Node adapters and packaged into the target verification-worker Lambda. See [`verifier-service/README.md`](../../verifier-service/README.md).                         |
| `formal`                         | Lean models, proofs, reports, and generated correspondence vectors for selected fail-closed and encoding invariants                         | Does not claim to prove the complete app, cryptographic primitives, RISC Zero soundness, AWS behavior, or React UI. See [`formal/README.md`](../../formal/README.md).                     |
| `infra/lambdas`                  | Target Lambda entrypoints for public API, finalization writer, proof dispatcher, verification worker, semaphore janitor, and image verifier | Lambda handlers adapt events and bootstrap runtime dependencies; reusable policy remains in apps/packages or the dedicated verifier core.                                                 |
| `infra/image-signature-verifier` | Cryptographic Prover-image signature verification core, pinned native-asset manifest, trust root, and deterministic package contract        | The Lambda request/response wrapper is `infra/lambdas/image-signature-verifier`; Terraform owns deployment and aliases. See its [README](../../infra/image-signature-verifier/README.md). |
| `infra/docker`                   | Prover image builds and the async prover entrypoint                                                                                         | The entrypoint owns async artifact conversion, public bundle packaging, private artifact promotion, and upload behavior.                                                                  |
| `infra/terraform`                | Bootstrap, foundation, app, and quarantined legacy infrastructure roots                                                                     | `foundation` owns target prerequisites; `app` owns runtime resources; `legacy` is retirement inventory, not a normal target.                                                              |
| `scripts`                        | Repository guardrails and task-specific build, test, formal, security, public-export, Terraform, and operator automation                    | Scripts may compose multiple owners but do not become runtime business-logic authority.                                                                                                   |
| `tests/e2e`                      | Browser workflow and accessibility tests crossing the frontend and server harnesses                                                         | Stable selectors and page objects live here because the tests span application boundaries.                                                                                                |
| `docs` and `public-book`         | Implementation-oriented contracts and public specifications                                                                                 | Documentation records current behavior but is subordinate to implementation and executable tests.                                                                                         |
| `public`                         | Browser-public static assets and the ImageID mapping trust-chain input                                                                      | Must contain no private verification artifacts or operator-only evidence.                                                                                                                 |

## Production Workspace Dependency Directions

This table is the exact workspace-package allowlist for production source.
Third-party dependencies are outside its scope. Tests have a separate
test-source allowlist; in particular, selected packages may use
`@stark-ballot/test-support`, and verification tests may use
`@stark-ballot/node-adapters`.

| From                           | Allowed production workspace dependencies                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@stark-ballot/api`            | `@stark-ballot/api-contract`, `@stark-ballot/application`, `@stark-ballot/aws-adapters`, `@stark-ballot/diagnostics`, `@stark-ballot/domain`, `@stark-ballot/node-adapters`, `@stark-ballot/runtime-config`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract` |
| `@stark-ballot/web`            | `@stark-ballot/api-contract`, `@stark-ballot/merkle`, `@stark-ballot/runtime-config`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                        |
| `@stark-ballot/api-contract`   | `@stark-ballot/validation`                                                                                                                                                                                                                                                                           |
| `@stark-ballot/application`    | `@stark-ballot/diagnostics`, `@stark-ballot/domain`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                                                         |
| `@stark-ballot/aws-adapters`   | `@stark-ballot/application`, `@stark-ballot/diagnostics`, `@stark-ballot/domain`, `@stark-ballot/node-adapters`, `@stark-ballot/runtime-config`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                             |
| `@stark-ballot/diagnostics`    | `@stark-ballot/validation`                                                                                                                                                                                                                                                                           |
| `@stark-ballot/domain`         | `@stark-ballot/merkle`, `@stark-ballot/validation`                                                                                                                                                                                                                                                   |
| `@stark-ballot/merkle`         | None                                                                                                                                                                                                                                                                                                 |
| `@stark-ballot/node-adapters`  | `@stark-ballot/diagnostics`, `@stark-ballot/validation`, `@stark-ballot/zkvm-contract`                                                                                                                                                                                                               |
| `@stark-ballot/runtime-config` | `@stark-ballot/validation`                                                                                                                                                                                                                                                                           |
| `@stark-ballot/test-support`   | `@stark-ballot/api-contract`, `@stark-ballot/domain`, `@stark-ballot/node-adapters`, `@stark-ballot/validation`, `@stark-ballot/verification`, `@stark-ballot/zkvm-contract`                                                                                                                         |
| `@stark-ballot/validation`     | None                                                                                                                                                                                                                                                                                                 |
| `@stark-ballot/verification`   | `@stark-ballot/merkle`, `@stark-ballot/validation`, `@stark-ballot/zkvm-contract`                                                                                                                                                                                                                    |
| `@stark-ballot/zkvm-contract`  | None                                                                                                                                                                                                                                                                                                 |

The root package may orchestrate all of these boundaries through scripts. That
does not authorize a production package to import back through the root.

## Runtime Contact Points

The route inventory in
[`apps/api/src/server/api/routes/definitions.ts`](../../apps/api/src/server/api/routes/definitions.ts)
is bound into Hono and the API Gateway Lambda runtime. Public schemas and route
metadata live in `packages/api-contract`; the detailed browser-facing contract
is documented in [`docs/ui/api-contract.md`](../ui/api-contract.md).

`POST /api/verification/observation` is an authenticated, owner-scoped
boundary from the browser verification route to the API. It records the first
bounded browser-local cast-check observation for the current execution through
the store's durable compare-and-set behavior. It is telemetry, not verdict
authority: success or failure of the observation request must not change the
browser's verification result. Verification verdict and evidence rules remain
in [`docs/verification/README.md`](../verification/README.md).

The target Lambda set is `public-api`, `finalization-writer`,
`proof-dispatcher`, `verification-worker`, and `semaphore-janitor`. The
dedicated `image-signature-verifier` Lambda is packaged and deployed
separately because its native assets, permissions boundary, immutable
versions, and preflight/runtime aliases form a distinct trust boundary.

## Runtime Configuration Authority

Do not maintain a duplicate environment-variable inventory here. The current
authorities are:

- [`packages/runtime-config/src/env/validate.ts`](../../packages/runtime-config/src/env/validate.ts)
  for application startup constraints;
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
prover-semaphore settings, and semaphore-janitor operations-ledger inputs.
Target runtime values fail closed when required references or deployment
identity fields are missing or inconsistent.

## Cross-Cutting Authorities

- AWS topology and service responsibilities:
  [`docs/architecture/aws-architecture.md`](./aws-architecture.md) and
  [`docs/infrastructure/README.md`](../infrastructure/README.md).
- Deployment-lane selection, approval, live inventory, and snapshot generation
  remain private operator concerns; generated public snapshots intentionally
  omit those procedures.
- Public safety gates:
  [`scripts/security/README.md`](../../scripts/security/README.md).
- CLI and regression harness behavior:
  [`scripts/tests/README.md`](../../scripts/tests/README.md).
- Public/private bundle membership and verification semantics:
  [`docs/verification/README.md`](../verification/README.md).
