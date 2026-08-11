# Scripts Directory

This directory contains all utility scripts for the STARK Ballot Simulator project, organized by functionality.

`scripts/package.json` is the private `@stark-ballot/repository-tools`
workspace. It owns repository-script runtime dependencies plus local lint,
type-check, and Vitest tasks; root commands remain the complete orchestration
gates. The workspace uses ESM; resolve entrypoint-relative paths through
`import.meta.url`, not CommonJS `__dirname` or `require.main`.

## Directory Structure

- `__tests__/` - Script-level Vitest coverage
- **api-contract/** - API contract baseline helpers
- **build/** - Build and cleanup scripts
- **dev/** - Local static Hono server helpers
- **docs/** - Documentation and license metadata helpers
- **formal/** - Formal audit and vector checks
- **frontend/** - Frontend build-boundary and artifact scans
- **security/** - Public-safety and secret-leak guard scripts
- **showcase/** - Public repository showcase automation helpers
- **stark-proofs/** - STARK proof generation utilities
- **terraform/** - Terraform rendering and guarded execution helpers
- **test-discovery/** - Reviewed test-ownership inventory and verification
- **tests/** - Maintained CLI, fixture, and regression test scripts

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

```bash
./scripts/tests/test-zkvm.sh                # Test zkVM integration
pnpm test:vitest:e2e                       # Explicit zkVM E2E owner; requires a dev-mode host build
pnpm vitest run \
  scripts/__tests__/dependency-version-consistency.test.ts \
  scripts/__tests__/repository-boundaries.test.ts \
  scripts/__tests__/toolchain-version-parity.test.ts
```

The ownership verifier compares current Vitest, TypeScript, Playwright, and
non-Vitest test discovery with
`scripts/test-discovery/reviewed-test-ownership.json`, including reviewed
intentional absences.

The focused repository-metadata Vitest command verifies catalogs, dependency
consumers, workspace-cycle rejection, and toolchain/cache authority.

Package `lint`, `type-check`, and
`test` tasks work both from the package directory and through pnpm filters.

### API contract baseline

```bash
pnpm api-contract:baseline:compare
```

The comparator captures the current route metadata, schema fingerprints,
route mounting, and representative mounted responses on every default
comparison. It compares that fresh snapshot with
`scripts/api-contract/baselines/reviewed-public-contract.json`. Intentional API
cutovers replace the reviewed baseline only after the exact wire diff has been
classified and reviewed.

The stable `scripts/api-contract/public-contract-baseline.ts` entrypoint owns
filesystem, source-materialization, process, and output behavior. Pure
comparison/integrity policy and CLI parsing/rendering live under
`scripts/api-contract/lib/`; production packages must not import those
repository-only modules. Mounted-response probes run in an isolated child
process so expected application request/store logs do not add warning noise to
the comparator's operator output.

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

For target-account bootstrap, render the backend before initialization. The
backend commands derive the exact region, bucket, key, and KMS alias from the
reviewed deployment-target configuration; any optional duplicate supplied
through `.env.local` or the shell must match that authority. The backend
renderer does not consume `TERRAFORM_AWS_ACCOUNT_ID`; that variable belongs to
guarded execution.

The current local Bootstrap helper uses
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
