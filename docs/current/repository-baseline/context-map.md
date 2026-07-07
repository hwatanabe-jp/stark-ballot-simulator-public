# Repository Context Map

This file is the repository baseline record for the post-dead-code restructure.
It records ownership, vocabulary, allowed dependency directions, and path
migration evidence without changing API behavior or verification semantics.

## Target Workspace Areas

| Area                      | Owner boundary                                                                                            | Target implementation anchor                                                                                | Notes                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                | Browser app, routes, components, i18n, local session and knowledge state                                  | `apps/web/src/main.tsx`, `apps/web/src/routes/**`, `apps/web/src/components/**`, browser-safe app libraries | Browser entry points use explicit package exports; broad root aliases are not part of the final import contract.                                                                                                          |
| `apps/api`                | Public API runtime and route binding                                                                      | `apps/api/src/server/api/**`, `apps/api/src/server/http/**`, `infra/lambdas/public-api`                     | Hono is an adapter detail, not the package name.                                                                                                                                                                          |
| `packages/api-contract`   | Route contracts, API schemas, and public error payloads                                                   | `packages/api-contract/src/**`                                                                              | Public API payloads are not domain authority records; shared schema primitives live in `packages/validation`.                                                                                                             |
| `packages/validation`     | Neutral schema, exact-optional, safe-segment, ImageID policy, and duplicate-detection helpers             | `packages/validation/src/**`                                                                                | Owns reusable validation primitives used across apps, packages, lambdas, scripts, and tests without depending on product-domain packages.                                                                                 |
| `packages/domain`         | Session, election, vote, bulletin, finalization facts, deterministic operations, and port/interface types | `packages/domain/src/**`                                                                                    | This must not become a catch-all shared-types bucket. Concrete persistence, AWS artifact-key layouts, browser cache, runtime config readers, verification projections, zkVM-input translation, and API adapters stay out. |
| `packages/application`    | Cross-context use cases and orchestration                                                                 | `packages/application/src/**`                                                                               | Composes domain facts, verification policy, zkVM contract helpers, and injected runtime adapter ports without owning concrete AWS, Node, runtime-config, or public API response adapters.                                 |
| `packages/diagnostics`    | Runtime logging, request log context, and log-safe request/key hashing                                    | `packages/diagnostics/src/**`                                                                               | Owns server/runtime diagnostics helpers that must stay outside domain facts and deterministic domain operations.                                                                                                          |
| `packages/runtime-config` | Runtime configuration parsing and browser-public/server-only config projections                           | `packages/runtime-config/src/**`                                                                            | Owns pure config parsing/classification. AWS SSM/Secrets resolution lives in `packages/aws-adapters/config`.                                                                                                              |
| `packages/aws-adapters`   | Shared server/runtime concrete AWS and persistence adapters                                               | `packages/aws-adapters/src/**`                                                                              | Owns DynamoDB, S3, SQS, rate-limit stores, store implementations, and AWS-backed config reference resolution.                                                                                                             |
| `packages/merkle`         | Pure CT/RFC6962 Merkle implementation and proof normalization                                             | `packages/merkle/src/**`                                                                                    | Owns the single production CT/RFC6962 implementation and must not import domain, verification, browser, API, runtime, or concrete adapters.                                                                               |
| `packages/node-adapters`  | Shared Node/process/filesystem/archive/subprocess adapters                                                | `packages/node-adapters/src/**`                                                                             | Owns verifier-service subprocess execution and local bundle/archive filesystem mechanics used by API, Lambda, and CLI/test helpers.                                                                                       |
| `packages/verification`   | Verification checks, summaries, ImageID policy, bitmap Merkle evidence, and pure artifact projections     | `packages/verification/src/**`, `packages/verification/src/merkle/**`                                       | Public bundle, protected report, private artifact, CT proof consumption, and bitmap Merkle vocabulary stay distinct. Concrete persistence and runtime delivery stay outside verification.                                 |
| `packages/zkvm-contract`  | TS zkVM input wire types, journal, bitmap, and TS/Rust vectors                                            | `packages/zkvm-contract/src/**`                                                                             | Wire formats remain byte-compatible with Rust; session/store-to-input adapters stay outside this package.                                                                                                                 |
| `packages/test-support`   | Shared test fixtures and harness utilities                                                                | `packages/test-support/src/**`, `tests/**` helpers                                                          | Production code must not import this package.                                                                                                                                                                             |
| `infra/lambdas`           | Target Lambda runtime adapters                                                                            | `infra/lambdas/{public-api,finalization-writer,proof-dispatcher,verification-worker,image-signature-gate}`  | Runtime component names are not domain service names.                                                                                                                                                                     |
| `infra/terraform`         | Target and legacy Terraform roots                                                                         | `infra/terraform/{bootstrap,foundation,app,legacy}`                                                         | `foundation` owns target-account prerequisites; `app` owns runtime resources; `legacy` is quarantined from target state roots.                                                                                            |
| `infra/docker`            | Prover container build and entrypoint                                                                     | `infra/docker/**`                                                                                           | Public/private bundle boundary remains enforced by the entrypoint tests.                                                                                                                                                  |

## Path And Update Map

| Current path or name                                                                                                                         | Target path or name                                    | Owner                                | Update surfaces                                                          | Evidence                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Browser app files under `src/main.tsx`, `src/components/**`, `src/routes/**`, `src/styles/**`, and browser-only `src/lib/**` groups          | `apps/web/src/**`                                      | Browser app                          | Vite root/input, aliases, browser import scan, Playwright selectors      | `pnpm frontend:import-boundary`, `pnpm build:ci`, UI tests  |
| API route/runtime files under `src/server/**`                                                                                                | `apps/api/src/server/**`                               | API runtime                          | Lambda bundling, dev static server, route tests, no browser imports      | API route tests, target Lambda build                        |
| API contract schemas, route metadata, public errors, and public API types                                                                    | `packages/api-contract/src/**`                         | API contract                         | Route inventory, response-shape tests, public export                     | API schema/contract tests, public snapshot tests            |
| Neutral schema, exact-optional, safe verifier segment, ImageID policy, and duplicate-detector helpers                                        | `packages/validation/src/**`                           | Validation primitives                | App/package/lambda imports, public export, package-boundary guardrails   | validation tests, repository-boundary tests, type-check     |
| Verification checks, evidence projections, ImageID verification, and bitmap Merkle helpers                                                   | `packages/verification/src/**`                         | Verification/evidence                | Verify UI adapters, API handlers, bundle/report scans, formal consumers  | verification tests, formal vector tests, CLI mock flow      |
| CT/RFC6962 Merkle tree and consistency-proof helpers                                                                                         | `packages/merkle/src/**`                               | Shared Merkle primitives             | Bulletin generation, verification consumption, browser proof normalize   | Merkle, bulletin, and verification regression tests         |
| Local bundle persistence, archive creation, verifier subprocess, and other Node/process/filesystem adapters                                  | `packages/node-adapters/src/**`                        | Node adapters                        | API verifier run, verification worker, CLI/test helpers                  | node-adapter and verifier-run tests                         |
| Target proof-artifact S3 key layout, DynamoDB/S3/SQS/rate-limit stores, AWS reference resolution, and other concrete runtime adapters        | `packages/aws-adapters/src/**`                         | AWS/runtime adapters                 | API/Lambda imports, Terraform env injection, bundle delivery, store flow | boundary guardrails, adapter/store tests, type-check        |
| Finalization, bot, and zkVM-input orchestration                                                                                              | `packages/application/src/**`                          | Application orchestration            | API handlers, CLI/test helpers, finalization tests                       | boundary guardrails, finalization tests, type-check         |
| Runtime logging, request log context, request ID extraction, and log-safe hashes                                                             | `packages/diagnostics/src/**`                          | Diagnostics                          | API handlers, HTTP middleware, Lambda/runtime adapters                   | diagnostics tests, boundary guardrails                      |
| Runtime config parsing, target runtime references, browser-public env helpers, and runtime mode classification                               | `packages/runtime-config/src/**`                       | Runtime config                       | API/Lambda validation, browser-safe env reads, target-runtime tests      | env validation tests, frontend import boundary              |
| zkVM public/private input wire types, journal helpers, bitmap helpers, and TS/Rust vectors                                                   | `packages/zkvm-contract/src/**`                        | zkVM contract                        | TS/Rust compatibility, formal vector consumers, host/prover references   | zkVM/formal vector tests; Rust gates when contract changes  |
| Test fixtures and harness utilities                                                                                                          | `packages/test-support/src/**`, `tests/**`             | Test support                         | Vitest fixtures, test-only import rules, public export                   | affected Vitest and E2E suites                              |
| Remaining shared/domain libraries under `src/lib/**`, `src/shared/**`, `src/types/**`, `src/constants/**`, and `src/bin/**` after the splits | `packages/domain/src/**`                               | Domain facts and deterministic logic | Domain tests, API/runtime consumers, CLI tests                           | `pnpm type-check`, `pnpm test:run`, CLI mock flow           |
| Public/private repository guardrail code                                                                                                     | `scripts/security/public-boundary-scan.ts`             | Repository guardrails                | API contract public fixtures, public safety scan, public export          | public-boundary scanner tests, API schema contract tests    |
| Prover container build and entrypoint                                                                                                        | `infra/docker/**`                                      | Prover runtime infra                 | BuildSpecs, Docker contexts, entrypoint bundle tests, docs               | `pnpm test:entrypoint-bundle`, Docker/path tests            |
| Terraform roots                                                                                                                              | `infra/terraform/{bootstrap,foundation,app,legacy}/**` | Terraform infra                      | Guard scripts, backend/tfvars renderers, CodeBuild rendered commands     | Terraform guard/render tests, foundation/app pipeline tests |
| Target Lambda adapters and legacy Lambda names                                                                                               | `infra/lambdas/<canonical-runtime-component>/**`       | Runtime adapters                     | Lambda build manifest, Terraform artifact keys, IAM/output references    | Lambda handler tests, `pnpm terraform:build-lambdas`        |

Compatibility aliases for old `@/...` import specifiers are no longer part of
the production import contract. Production source imports must use explicit
package exports such as `@stark-ballot/web/session`,
`@stark-ballot/aws-adapters/store/storeInstance`, or
`@stark-ballot/application/finalize/usecases/finalize-session`.

## Package Exports And Dependency Matrix

| Package                        | Export class                                                                           | Runtime consumers                                           | Boundary rule                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@stark-ballot/web`            | Browser entry, routes, UI, browser-safe session/local knowledge state                  | Vite/browser only                                           | May import browser-safe API-contract, validation, verification, zkVM, Merkle, and runtime-config projections; must not import domain, server handlers, AWS SDK clients, or raw env reads. |
| `@stark-ballot/api`            | Server route binding and HTTP adapters                                                 | Lambda handlers, local static server                        | Composes API contract, application use cases, domain facts, runtime config, AWS/node adapters, validation, verification, and zkVM helpers; must not import browser local state.           |
| `@stark-ballot/api-contract`   | Public schemas, route contracts, public errors                                         | Browser API clients, API runtime                            | Owns public HTTP shapes and may depend on neutral validation primitives; must not import persistence records, AWS SDK clients, domain facts, or verifier process execution.               |
| `@stark-ballot/validation`     | Neutral schema, exact-optional, safe-segment, ImageID policy, and duplicate detection  | Apps, packages, lambdas, scripts                            | Must stay dependency-light and product-neutral; must not import domain, API runtime, browser UI, AWS SDK clients, runtime config, verification, or zkVM contract code.                    |
| `@stark-ballot/domain`         | Domain facts, value objects, deterministic operations, and port/interface types        | API/application/runtime adapters                            | May use Merkle and validation primitives; must not own concrete AWS, store, rate-limit, runtime config, verifier subprocess, browser cache, verification projections, or API payloads.    |
| `@stark-ballot/application`    | Cross-context use cases and orchestration                                              | API runtime                                                 | Composes domain facts/ports, verification policy, zkVM contract helpers, diagnostics, validation helpers, and injected ports; concrete runtime behavior is injected at the edge.          |
| `@stark-ballot/diagnostics`    | Runtime logging, request log context, and log-safe diagnostics helpers                 | API runtime, infra lambdas, application, AWS adapters       | Owns mutable logger configuration, request-scoped log context, JSON/text formatting, request ID extraction, and log-safe hashing.                                                         |
| `@stark-ballot/runtime-config` | Pure runtime config parsing/classification and browser-public env readers              | Browser, API, Lambda, adapters                              | May use validation primitives; must not import AWS SDK clients, domain orchestration, verification core, browser UI, API handlers, or concrete adapters.                                  |
| `@stark-ballot/aws-adapters`   | Concrete AWS/persistence/runtime adapters                                              | API runtime, infra lambdas, application composition         | May import AWS SDK clients, runtime-config parsers, diagnostics, validation, application ports, domain facts/ports, verification projection types, and zkVM public helpers.               |
| `@stark-ballot/merkle`         | Pure CT/RFC6962 Merkle tree and proof normalization                                    | Domain bulletin, verification, browser proof normalization  | Owns the production CT/RFC6962 implementation. May import hash/hex primitives only.                                                                                                       |
| `@stark-ballot/node-adapters`  | Node subprocess/filesystem/archive/subprocess adapters                                 | API runtime, infra lambdas, CLI/test helpers                | Owns verifier-service execution, local verification-bundle persistence, and zip/archive adapters; must stay outside domain and verification core.                                         |
| `@stark-ballot/verification`   | Verification checks, bitmap Merkle evidence, bundle/report projections, ImageID policy | Browser verification adapters, API runtime, verifier worker | Owns pure evidence/report projections; concrete filesystem/archive/AWS upload/invocation clients stay in API, Lambda, node, or AWS adapters.                                              |
| `@stark-ballot/zkvm-contract`  | TS zkVM wire input/journal/bitmap helpers and vectors                                  | Domain finalization, verification, scripts                  | Must preserve byte-compatible wire formats and avoid API/UI/session/store dependencies.                                                                                                   |
| `@stark-ballot/test-support`   | Fixtures, builders, harness helpers                                                    | None in production                                          | Production packages must not depend on it at runtime.                                                                                                                                     |

The root package remains a repository orchestration surface for commands,
lockfile ownership, public export, and cross-cutting guardrail scripts. It is
not a domain package.

## Type Boundary Refresh

Wire, persisted, and public API payloads remain plain JSON-compatible strings.
Internal constructors now brand generated or validated high-risk identifiers at
the owning boundary:

- `packages/domain/src/types/identifiers.ts` owns domain/runtime brands such as
  `SessionId`, `CapabilityToken`, `ExecutionId`, `S3Key`, `AccountAlias`,
  `DeploymentEnvironment`, and `StateScope`.
- `packages/zkvm-contract/src/zkvm/identifiers.ts` owns zkVM wire-adjacent
  brands such as `ElectionId`, `LogId`, `ImageId`, and `InputCommitment`.
- Generated execution IDs, finalization artifact S3 keys, generated election
  IDs, generated log IDs, and computed input commitments pass through these
  adapters before being used internally.

Compatibility adapters should continue to validate and brand at ingress or
creation points rather than changing public wire formats.

## Public Snapshot Evidence Gate

The source-SHA-bound generated public snapshot gate exports
`.tmp/target-public-repo`, runs the public-safety scan against that generated
tree, installs dependencies from inside the generated tree with
`pnpm install --frozen-lockfile`, and runs the generated `pnpm test:public`
command there.

## Support-Surface Ownership Map

| Surface                                                     | Owner                                              | Location decision                                                       | Required evidence                                               |
| ----------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `scripts/**`                                                | Repository guardrails and task-specific automation | Stays root-owned; scripts become layout-aware for apps/packages/infra   | script unit tests, public-safety scan, build/test command smoke |
| `tests/e2e/**`, Playwright config                           | Browser workflow tests                             | Stays root-owned because it crosses app and server test harnesses       | mock E2E smoke when UI selectors or route paths change          |
| `.github/**`, `buildspec*.yml`, root `package.json` scripts | CI/CD orchestration                                | Stays root-owned                                                        | rendered/static pipeline tests and buildspec path checks        |
| `docs/current/**`, `public-book/**`                         | Documentation and public specs                     | Stays under docs/specs roots; historical docs may keep historical terms | docs book build for public spec changes                         |
| `public/**`                                                 | Browser-public static assets and ImageID mapping   | Stays root-public for Vite/public export stability                      | frontend build/artifact scan and ImageID tests                  |
| `infra/lambdas/**`                                          | Runtime adapters                                   | Stays under infra, separate from API package source                     | Lambda build manifest and handler tests                         |
| Root guidance/config files                                  | Repository governance                              | Stays root-owned; `AGENTS.md` remains a symlink to `CLAUDE.md`          | symlink check, format/lint/type-check                           |

## Runtime Env And Config Inventory

Target runtime references are lane-aware and must match Terraform-rendered
paths for the account lane:

- `stark-dev/develop/app`
- `stark-prod/main/app`

Secret and config reference variables are:

- `SESSION_CAPABILITY_SECRET_REF`
- `VOTE_SECRET_ENCRYPTION_KEY_REF`
- `SESSION_CAPABILITY_TTL_SECONDS_REF`
- `TURNSTILE_SECRET_KEY_REF`
- `LOG_IP_HASH_SALT_REF`
- `VITE_TURNSTILE_SITE_KEY_REF`

Target Lambda runtime inputs that must stay covered by validation or Terraform
injection tests include:

- `DYNAMODB_SESSIONS_TABLE`
- `DYNAMODB_VOTES_TABLE`
- `EXPECTED_IMAGE_ID`
- `FINALIZE_ASYNC_MODE`
- `HONO_CORS_ALLOW_ORIGINS`
- `PROVER_STATE_MACHINE_ARN`
- `PROVER_STEP_FUNCTIONS_ENABLED`
- `PROVER_WORK_QUEUE_URL`
- `RATE_LIMIT_COUNTERS_TABLE`
- `RATE_LIMIT_EVENTS_TABLE`
- `RATE_LIMIT_STORE`
- `RUNTIME_DEPLOYMENT_ENV`
- `S3_PROOF_BUCKET`
- `S3_PROOF_PREFIX`
- `SESSION_CREATE_TURNSTILE_REQUIRED`
- `SESSION_LIVE_TTL_SECONDS`
- `TARGET_AWS_RUNTIME`
- `TARGET_PUBLIC_SESSION_CREATE_ENABLED`
- `TRUSTED_PROXY`
- `TURNSTILE_ALLOWED_HOSTNAMES`
- `USE_MOCK_STORE`
- `USE_S3`
- `VERIFICATION_ARTIFACT_TTL_SECONDS`
- `VERIFICATION_WORK_QUEUE_URL`
- `VERIFICATION_WORKER_FUNCTION_NAME`
- `VERIFIER_PUBLIC_BASE_URL`
- `VERIFIER_SERVICE_BIN`
- `VOTE_DUPLICATE_DETECTOR_TTL_SECONDS`

Additional validated or AWS-provided runtime inputs include:

- `API_REQUEST_BODY_LIMIT_BYTES`
- `AWS_ACCOUNT_ID`
- `AWS_LAMBDA_FUNCTION_NAME`
- `AWS_REGION` / `AWS_DEFAULT_REGION`
- `FINALIZE_CALLBACK_BODY_LIMIT_BYTES`
- `VITE_SESSION_CREATE_TURNSTILE_REQUIRED`

Raw secret values remain local/test-only inputs. Target AWS runtime uses
reference variables and a resolver; unresolved placeholders, legacy paths,
raw placeholders, wrong account IDs, and wrong regions fail closed.

## Pipeline Contract Migration Ledger

| Surface                                | Canonical target                                                                                                                                | Compatibility or history decision                                                                      | Static/rendered evidence                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Lane identity                          | `develop -> stark-dev/develop/{bootstrap,foundation,app}`; `main -> stark-prod/main/app`                                                        | Production bootstrap remains unauthorized; protected-production app checks are non-mutating evidence   | Terraform guard tests for backend init, validate, plan/apply handoff, smoke command rendering                    |
| Lambda artifact manifest               | `.tmp/target-lambdas/manifest.json` keys `public_api`, `finalization_writer`, `proof_dispatcher`, `verification_worker`, `image_signature_gate` | Old handler path keys are not canonical                                                                | Lambda build manifest tests and generated `pipeline.auto.tfvars` checks                                          |
| Terraform roots                        | `infra/terraform/bootstrap`, `infra/terraform/foundation`, `infra/terraform/app`, and quarantined `infra/terraform/legacy`                      | Root `terraform/` is historical only and may appear only through legacy quarantine                     | guard script tests, backend/tfvars renderer tests, foundation/app pipeline tests                                 |
| BuildSpec and CodeBuild commands       | `infra/terraform/*`, `infra/lambdas/*`, `infra/docker/*`, `dist/` frontend output                                                               | Old paths may appear only in historical docs/scanners                                                  | app-lane pipeline tests for package, upload, validate, plan, apply, static deploy, smoke, and evidence retention |
| Accepted markers and retained evidence | Account-lane-specific pipeline marker/evidence paths                                                                                            | No old artifact-key compatibility is required unless a test records it as historical                   | protected-production static/rendered contract tests                                                              |
| Runtime locators                       | `VERIFICATION_WORKER_*` canonical env names                                                                                                     | Retired `VERIFIER_SERVICE_RUNNER_*` names are not accepted by production config or Terraform injection | runtime validation, invocation client, Terraform env injection tests                                             |

## Allowed Dependency Directions

| From           | May import                                                                                                                                                    | Must not import                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser app    | browser-safe API client, i18n, UI, local state, validation helpers, runtime-config browser projections, verification projections, Merkle, zkVM public helpers | domain, server handlers, store adapters, AWS SDK clients, raw `process.env`, private artifact readers                                                      |
| API runtime    | API contract, validation, application use cases, domain facts, verification orchestration, diagnostics, AWS/node adapters, runtime config                     | browser local state, Playwright fixtures, public-export scripts                                                                                            |
| API contract   | validation primitives and public error payload helpers                                                                                                        | domain facts, store records, AWS SDK clients, verifier-service process execution                                                                           |
| Validation     | standard library primitives only                                                                                                                              | product-domain packages, runtime config, browser UI, API handlers, AWS SDK clients, verifier subprocesses                                                  |
| Application    | domain facts/ports, validation helpers, verification policy/projections, zkVM contract helpers, diagnostics, application-owned messages, injected ports       | API-contract public response/error ownership, browser local state, AWS SDK clients directly, concrete AWS/Node adapters, runtime-config readers, Terraform |
| Diagnostics    | Node runtime primitives and validation helpers needed for request-scoped diagnostics and log-safe hashing                                                     | domain facts as an owner dependency, browser UI/local state, AWS SDK clients                                                                               |
| Runtime config | config primitives, validation helpers, and Node/browser env projections                                                                                       | AWS SDK clients, domain orchestration, verification core, browser UI, API handlers                                                                         |
| AWS adapters   | AWS SDK clients, runtime-config parsers, diagnostics, validation, application ports/messages, domain facts/ports, verification projection types, zkVM helpers | browser UI/local state, public-export scripts                                                                                                              |
| Merkle         | local hash/hex helpers and pure CT/RFC6962 proof types                                                                                                        | domain, verification, API-contract payload authority, runtime-config readers, browser modules, concrete filesystem/archive/AWS adapters                    |
| Node adapters  | Node/process/filesystem/archive/subprocess APIs, validation helpers, local bundle persistence, and zip creation                                               | verification core ownership of subprocess execution or domain-owned concrete adapters                                                                      |
| Domain         | domain facts, value objects, deterministic operations, Merkle helpers, cryptographic/hash helpers, validation primitives, explicit domain policy inputs       | API-contract payload authority, diagnostics logging, runtime-config readers, verification projections, zkVM-input translation, browser cache, Terraform    |
| Verification   | verification checks, public bundle/protected report/private artifact projections, validation helpers, Merkle helpers, bitmap Merkle helpers, zkVM helpers     | API-contract payload authority, runtime-config readers, browser localized strings, domain/session/store details, concrete filesystem/archive/AWS adapters  |
| zkVM contract  | canonical encoding helpers and generated vectors                                                                                                              | API route handlers, browser UI, Terraform                                                                                                                  |
| Test support   | fixtures and test-only builders                                                                                                                               | production packages as runtime dependencies                                                                                                                |
| Infra Lambdas  | API/runtime adapters, validation, diagnostics, and server-safe packages                                                                                       | browser UI modules and browser local state                                                                                                                 |

## Canonical Runtime Component Names

| Component              | Terraform key          | Handler path                         | Legacy source name        |
| ---------------------- | ---------------------- | ------------------------------------ | ------------------------- |
| `public-api`           | `public_api`           | `infra/lambdas/public-api`           | `hono-api`                |
| `finalization-writer`  | `finalization_writer`  | `infra/lambdas/finalization-writer`  | `finalize-callback`       |
| `proof-dispatcher`     | `proof_dispatcher`     | `infra/lambdas/proof-dispatcher`     | `prover-dispatch`         |
| `verification-worker`  | `verification_worker`  | `infra/lambdas/verification-worker`  | `verifier-service-runner` |
| `image-signature-gate` | `image_signature_gate` | `infra/lambdas/image-signature-gate` | `check-image-signature`   |

All canonical Lambda physical names use:

```text
stark-ballot-simulator-<account_alias>-<deployment_environment>-<component>
```

The executable length gate in
`scripts/__tests__/bootstrap-terraform-policy.app-runtime.test.ts` covers both
`stark-dev/develop` and `stark-prod/main` prefixes.

## Runtime Env Contract

`VERIFICATION_WORKER_FUNCTION_NAME` and `VERIFICATION_WORKER_ARN` are the
canonical verification-worker locators. The old
`VERIFIER_SERVICE_RUNNER_FUNCTION_NAME` / `VERIFIER_SERVICE_RUNNER_ARN` inputs
are retired from production runtime validation, API invocation resolution, and
Terraform injection.

## Behavior Boundary

This baseline does not change route paths, HTTP payloads, journal semantics,
proof semantics, DynamoDB key semantics, authorization behavior, verification
display logic, or public/private artifact membership.
