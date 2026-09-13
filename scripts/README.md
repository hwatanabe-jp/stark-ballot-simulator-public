# Scripts Directory

This directory contains all utility scripts for the STARK Ballot Simulator project, organized by functionality.

`scripts/package.json` is the private `@stark-ballot/repository-tools`
workspace. It owns repository-script runtime dependencies plus local lint,
type-check, and Vitest tasks; root commands remain the complete orchestration
gates. The workspace uses ESM; resolve entrypoint-relative paths through
`import.meta.url`, not CommonJS `__dirname` or `require.main`.

## Directory Structure

- **api-contract/** - API contract baseline and generated OpenAPI helpers
- **build/** - Build and cleanup scripts
- **catalog/** - Backstage catalog and isolated TechDocs validation
- **dev/** - Local static Hono server helpers
- **docs/** - Documentation and license metadata helpers
- **formal/** - Formal audit and vector checks
- **formatting/** - [Shared Oxfmt formatting](./formatting/README.md) for generated JSON and Markdown
- **frontend/** - Frontend build-boundary and artifact scans
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
pnpm type-system:verify                    # Run compiler, checked-JS, and workspace derivation gates
pnpm vitest run \
  tooling/repository/dependency-version-consistency.test.ts \
  tooling/repository/workspace-boundaries.test.ts \
  tooling/repository/toolchain-version-parity.test.ts
```

The tooling tests compare current source files with TypeScript CLI, Vitest,
and Playwright discovery, rejecting missing or duplicate ownership without a
saved file-list update. The focused repository-metadata command above also
checks catalogs, dependency consumers, workspace-cycle rejection, and
toolchain/cache authority. Explicit zkVM, DynamoDB Local, and formal commands
retain their separate execution boundaries.

Package `lint`, `type-check`, and
`test` tasks work both from the package directory and through pnpm filters.

pnpm 12's `tasks` configuration declares these source-based checks independent
of dependency packages' same-name checks. Lint runs one workspace at a time,
type checks run at most two, and recursive tests start only one Vitest process
at a time; Vitest itself parallelizes test files. Inspect the resolved graph
with `pnpm --recursive run --dry-run --json type-check`.

### Dependency Maintenance

`pnpm dependencies:peers` checks peer dependencies from the lockfile without changing
the lockfile. `pnpm dependencies:outdated` reports registry and GitHub Actions
updates; `pnpm dependencies:actions:update` explicitly updates only Actions.
The public export guide covers the generated workflow copies that pnpm cannot
discover inside TypeScript templates.

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
refinement, or transform lacks an honest projection. The catalog check uses
Backstage's entity validators, resolves the complete entity graph and API
definition, and constrains MkDocs to `techdocs/docs/`. These generated portal
inputs do not replace the reviewed public-contract baseline or runtime validators.

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

#### Backend rendering and authorization boundary

```bash
pnpm terraform:backend               # Render legacy/root git-ignored infra/terraform/legacy/backend.local.hcl
pnpm terraform:bootstrap:backend:dev # Render authorized infra/terraform/bootstrap/backend.local.hcl
pnpm terraform:foundation:backend:dev # Render authorized infra/terraform/foundation/backend.local.hcl
pnpm terraform:app:backend:dev       # Render authorized infra/terraform/app/backend.local.hcl
pnpm terraform:bootstrap:init:dev    # Initialize authorized stark-dev/develop/bootstrap state
pnpm terraform:bootstrap:plan:dev    # Plan authorized stark-dev/develop/bootstrap state
pnpm terraform:iam-docs              # Render git-ignored Terraform admin IAM JSON
```

For the develop Bootstrap commands above, render the backend before
initialization. The backend commands derive the exact region, bucket, key,
and KMS alias from the reviewed deployment-target configuration; any optional duplicate supplied
through `.env.local` or the shell must match that authority. The backend
renderer does not consume `TERRAFORM_AWS_ACCOUNT_ID`; that variable belongs to
guarded execution.

The develop local Bootstrap helpers use
`TERRAFORM_WORKING_DIR=infra/terraform/bootstrap` and the
`stark-dev/develop/bootstrap` identity. Foundation and App backend rendering is
authorized for `stark-dev/develop/foundation` and
`stark-dev/develop/app`, but their `init`, `validate`, `plan`, `apply`, and
smoke acceptance runs only through the Bootstrap-managed
CodePipeline/CodeBuild roles and
`scripts/terraform/terraform-guarded.sh`. Do not substitute local Foundation
or App Terraform execution for those saved-plan lanes.

Legacy workspace plan/apply and runtime-shaped tfvars-render commands are not
package scripts. Direct use of `scripts/terraform/terraform-guarded.sh` or
`scripts/terraform/render-local-tfvars.sh` requires explicit authorization.
