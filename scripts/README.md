# Scripts Directory

This directory contains all utility scripts for the STARK Ballot Simulator project, organized by functionality.

`scripts/package.json` is the private `@stark-ballot/repository-tools`
workspace. It owns repository-script runtime dependencies plus local lint,
type-check, and Vitest tasks; root commands remain the complete orchestration
gates. The workspace uses ESM; resolve entrypoint-relative paths through
`import.meta.url`, not CommonJS `__dirname` or `require.main`.

## Workspace Tooling Contract

Keep JavaScript toolchain authority centralized: root `engines.node` bounds
the supported Node major, `.nvmrc` selects it, and only root `packageManager`
pins the exact pnpm release and integrity hash. Shared setup resolves it with
Corepack and caches only the pnpm store; install and `pnpm ignored-builds`
still run on cache hits. `pnpm-workspace.yaml` owns global-virtual-store
behavior and fail-closed command-time dependency verification. Stale installs
require explicit `pnpm install`, never implicit repair.

The workspace configuration rejects cycles and owns exact named catalogs for
repeated dependency families. Catalog-owned dependencies cannot use direct
manifest versions. Every dependency declaration needs an evidenced production
or test/tool consumer. `pnpm dependencies:outdated` is the explicit report-only
package and exact-SHA Actions audit; its findings never authorize updates.

`tooling/workspace/workspace-metadata.ts` derives package names, roots,
dependencies, and exports from manifests; its reviewed runtime/test map holds
only facts manifests cannot express. Every workspace exposes local lint,
type-check, and test tasks; root commands remain the complete gates.

TypeScript and Vitest ownership is explicit by workspace/repository scope;
only web tests use jsdom/browser setup. Keep root Vite/Vitest config native
ESM, with explicit `.ts` relative imports under the two scoped no-emit
tsconfigs that permit them. Local Vite forwards browser warnings/errors and
unhandled errors to the terminal, not routine logs.

API-contract and public-export policy/transformation code stays in each task's
`lib/` directory, with thin stable CLI/filesystem/process entrypoints. Production
packages must not import repository-tool policy or test support.

## Directory Structure

- **api-contract/** - API contract baseline, OpenAPI, and Gateway projection helpers
- **build/** - Build and cleanup scripts
- **catalog/** - Backstage catalog and isolated TechDocs validation
- **ci/** - Private Core Checks source-validation evidence; omitted from public snapshots
- **dev/** - Local static Hono server helpers
- **docs/** - Documentation and license metadata helpers
- **formal/** - Formal audit and vector checks
- **formatting/** - [Shared Oxfmt formatting](./formatting/README.md) for generated JSON and Markdown
- **frontend/** - Frontend build-boundary and artifact scans
- **platform/** - Private local platform dispatcher for the independent sibling checkout; omitted from public snapshots
- **security/** - Public-safety and secret-leak guard scripts
- **showcase/** - Public repository showcase automation helpers
- **source-analysis/** - [Oxc parsing and compiler-project admission](./source-analysis/README.md) for repository policy tools
- **stark-proofs/** - STARK proof generation utilities
- **terraform/** - Terraform rendering and guarded execution helpers
- **test-discovery/** - Test placement checks
- **tests/** - Maintained CLI, fixture, and regression test scripts
- **type-system/** - Private-source JavaScript ownership and TypeScript risk policies; omitted from public snapshots

## Quick Reference

### Build Operations

```bash
./scripts/build/build-zkvm.sh    # Build zkVM binary
pnpm terraform:build-lambdas     # Build Terraform-managed Lambda bundles
./scripts/build/clean-all.sh     # Clean all generated files
pnpm rust:verifier:format && pnpm rust:verifier:clippy && pnpm rust:verifier:test
pnpm rust:zkvm:format && pnpm rust:zkvm:clippy && pnpm rust:zkvm:test
```

Run these commands from the repository root. The build wrappers locate
repository-owned inputs from that root, and `clean-all.sh` navigates there
before removing generated artifacts.

### STARK Proof Generation

```bash
./scripts/stark-proofs/generate-all.sh  # Generate proofs for all scenarios
./scripts/stark-proofs/test-single.sh   # Test single scenario (S3)
```

Legacy test-data and manual receipt-inspection helpers have been retired.

### Verification

```bash
pnpm test:cli -- --user-choice A               # Maintained CLI E2E flow
pnpm test:cli:mock                             # Mock store + mock zkVM
pnpm test:cli:real-dev                         # Real Rust zkVM with dev receipts
pnpm test:cli:real-prod:s0                     # Real STARK proof for S0
```

The maintained script-level verification path is the CLI harness together
with `verifier-service`; Browser/WASM verification script references are
legacy context.

### Testing

Vitest tests live beside their owning script or contract as `*.test.ts`.
Keep local shared helpers and fixtures in the owner's `test-support/`
directory. `scripts/tests/` owns executable test harnesses and their adjacent
tests; other script tests stay with their task directory. See the
[repository test placement convention](./tests/README.md#test-placement).

```bash
./scripts/tests/test-zkvm.sh                # Test zkVM integration
pnpm test:vitest:e2e                       # Explicit zkVM E2E owner; requires a dev-mode host build
pnpm type-system:verify                    # Run this checkout's complete type-system checks
```

`type-system:verify` runs the TypeScript and checked-JavaScript compiler checks.
The private source checkout also checks source ownership and workspace
derivations; the public snapshot uses its exported compiler configuration.
Explicit zkVM, DynamoDB Local, and formal commands retain their separate
execution boundaries.

Package `lint`, `type-check`, and
`test` tasks work both from the package directory and through pnpm filters.

pnpm 12's `tasks` configuration declares recursive workspace checks independent
of dependency packages' same-name checks. Recursive lint runs one workspace at
a time, type checks run at most two, and recursive tests start only one Vitest
process at a time. Root `pnpm lint` runs one repository-wide `oxlint .` invocation;
root `pnpm test:run` runs the complete Vitest suite, which parallelizes test files.
Inspect the recursive task graph with
`pnpm --recursive run --dry-run --json type-check`.

For repeated local type checks, `pnpm type-check:cached` runs the experimental
pnpm `local-types` pipeline. It selects only the root `type-system:verify`
task, with the complete root gate as one cache entry. The default inputs cover
all tracked and untracked, non-ignored repository files, including shared
TypeScript configuration and every workspace's source. The lockfile, runtime,
and declared `NODE_OPTIONS`, `NODE_PATH`, and `CI` values also enter the key.
Do not narrow these inputs to individual package directories: workspace
exports point directly at source files.

The command performs pnpm's frozen install before executing or restoring the
task. Command-time dependency verification still rejects stale installs;
run `pnpm install` explicitly after manifest changes. Use
`pnpm type-check:cached --no-cache` to execute without reading or writing the
task cache, and `pnpm type-check:cached --dry-run --json` to inspect selection.
This is optional local feedback. Completion and CI continue to execute
`pnpm type-system:verify` directly, with no task-cache reuse. No remote cache,
run publication, or pnpm-managed Cargo/toolchain integration is configured.

### Dependency Maintenance

`pnpm dependencies:peers` checks peer dependencies from the lockfile without changing
the lockfile. `pnpm dependencies:outdated` reports registry and GitHub Actions
updates; `pnpm dependencies:actions:update` explicitly updates only Actions.
The public export guide covers the generated workflow copies that pnpm cannot
discover inside TypeScript templates.

`trustPolicyExcludePrune` removes unused exact-version trust exceptions during
installs and dependency add/update/remove operations. It does not relax `no-downgrade`,
the release-age window, or the explicit build-script allowlist.

`pnpm dependencies:sbom` writes a combined CycloneDX JavaScript dependency
inventory for all workspaces, including the root, to
`.tmp/sbom/javascript.cdx.json`. It reads the lockfile without installing or
updating dependencies and includes development and optional dependencies.
The file is a local, ignored report; it is not automatically published or
included in the public export. Generate it from the exact checkout being
reviewed. It complements the license reports, does not describe which packages
survive bundling into a deployment artifact, and does not inventory Rust crates.

The current pnpm release can print `Cannot identify as no node_modules found`
from `pnpm ignored-builds` when the module manifest exists but its empty
`ignoredBuilds` field is omitted. This is a
[reporting defect](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/cli_args/ignored_builds.rs#L26-L67);
`strictDepBuilds` and the explicit `allowBuilds` policy still govern installation.
Keep the CI review command and the pnpm-generated module manifest intact.

### API contract and developer-portal inputs

```bash
pnpm api-contract:baseline:compare
pnpm api-contract:openapi:check
pnpm api-contract:gateway:check
pnpm catalog:check
```

The baseline comparator captures current route metadata, schema fingerprints,
mounting, and representative responses, then compares that fresh snapshot with
`scripts/api-contract/baselines/reviewed-public-contract.json`. Intentional wire
changes require classification and review before replacing the baseline;
metadata-only classifications bind the unchanged baseline and one exact current
contract hash. They do not authorize later changes.

`scripts/api-contract/public-contract-baseline.ts` owns CLI and I/O behavior;
pure comparison and transformation policy lives in `scripts/api-contract/lib/`.
Production packages must not import those repository-only modules. See the
[API contract guide](../docs/ui/api-contract.md) for the current routes and
request/response boundaries.

The OpenAPI check projects the route inventory and schema-owned declarative
metadata, validates the OpenAPI 3.1 result, and compares regenerated bytes with
`openapi/stark-ballot-api.openapi.json`. It fails closed when a route, runtime
refinement, or transform lacks an honest projection.

`pnpm api-contract:gateway:generate` writes `infra/terraform/app/gateway-contract.json`
from the typed target inventory and request descriptors. The Gateway check verifies
deterministic freshness in CI/App Plan and requires
`scripts/api-contract/baselines/reviewed-gateway-contract.json` to bind the reviewed
Hono baseline and exact deployment/probe inputs: the generated artifact, Terraform
transport, public API Lambda handler, and Gateway validation smoke probe. Regeneration
alone does not satisfy that review boundary. The bounded draft-4 projector fails on
unreviewed schema features and records Hono-only string constraints. The artifact
contains no integration ARN/account information.

The catalog check uses Backstage's entity validators, resolves the complete entity
graph and API definition, and constrains MkDocs to `techdocs/docs/`. These generated
portal and deployment inputs do not replace the reviewed public-contract baseline
or runtime validators.

### Security

```bash
pnpm public-safety:scan          # Scan tracked files
pnpm public-safety:scan:staged   # Scan staged files, used by pre-commit hook
```

### Public Showcase

```bash
pnpm tsx scripts/showcase/public-weekly-monitor.ts --output .tmp/public-weekly-monitor.md
```

### License Metadata

```bash
pnpm licenses:check              # Verify tracked metadata matches current lockfiles
pnpm licenses:regen              # Regenerate sanitized docs/licenses metadata
```

### Terraform

`pnpm terraform:policy:check` renders Bootstrap IAM documents for both reviewed
deployment targets with the pinned Terraform/AWS provider. It checks every
managed policy against 6,144 characters and the sum of inline policies per role
against 10,240 characters. The isolated Terraform test mocks AWS resources,
uses configured resource names and full-length ARNs, and runs the provider's
local policy JSON renderer. It requires Node (the repository pin), Python 3,
and Terraform (the exact active-root pin); provider installation needs network
access. It uses no AWS credentials, backend, or live resources.
`pnpm ci:verify` and Core Checks include this gate.

#### Backend rendering and authorization boundary

```bash
pnpm terraform:bootstrap:backend:dev # Render authorized infra/terraform/bootstrap/backend.local.hcl
pnpm terraform:foundation:backend:dev # Render authorized infra/terraform/foundation/backend.local.hcl
pnpm terraform:app:backend:dev       # Render authorized infra/terraform/app/backend.local.hcl
```

Bootstrap uses the reviewed local operation documented in the private AWS runbook
and the separate new-target initializer. The old unreviewed shell Bootstrap
init/plan commands are removed. The backend commands derive the exact region, bucket, key,
and KMS alias from the reviewed deployment-target configuration; any optional duplicate supplied
through `.env.local` or the shell must match that authority. The backend
renderer does not consume `TERRAFORM_AWS_ACCOUNT_ID`; that variable belongs to
guarded execution.

The guarded shell rejects Bootstrap execution for both targets. Foundation and App
mutation and acceptance use their managed CodePipeline/CodeBuild roles and
`scripts/terraform/terraform-guarded.sh`. After target cutover, the separate local
read-only drift operation reproduces an accepted checkpoint under its root read role;
it does not replace a managed Foundation/App saved-plan lane.

The deleted legacy account's root, workspace-only execution and dedicated
tfvars/IAM generators are retired. Guarded execution requires a reviewed target
identity and explicit `TERRAFORM_WORKING_DIR`; backend rendering requires all
three state identity values. Neither helper selects a legacy default.
