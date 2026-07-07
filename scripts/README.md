# Scripts Directory

This directory contains all utility scripts for the STARK Ballot Simulator project, organized by functionality.

## Directory Structure

- `__tests__/` - Script-level Vitest coverage
- **api-contract/** - API contract baseline helpers
- **aws/** - AWS operator helpers
- **build/** - Build and cleanup scripts
- **dev/** - Local static Hono server helpers
- **docs/** - Documentation and license metadata helpers
- **formal/** - Formal audit and vector checks
- **frontend/** - Frontend build-boundary and artifact scans
- **security/** - Public-safety and secret-leak guard scripts
- **showcase/** - Public repository showcase automation helpers
- **skills/** - Agent skill mirror verification helpers
- **stark-proofs/** - STARK proof generation utilities
- **terraform/** - Terraform rendering and guarded execution helpers
- **tests/** - Maintained CLI, fixture, and regression test scripts

## Quick Reference

### Build Operations

```bash
./scripts/build/build-zkvm.sh    # Build zkVM binary
pnpm terraform:build-lambdas     # Build Terraform-managed Lambda bundles
./scripts/build/clean-all.sh     # Clean all generated files
```

### STARK Proof Generation

```bash
./scripts/stark-proofs/generate-all.sh  # Generate proofs for all scenarios
./scripts/stark-proofs/test-single.sh   # Test single scenario (S3)
```

### Verification

```bash
pnpm test:cli -- --user-choice A               # Maintained CLI E2E flow
pnpm test:cli:mock                             # Mock store + mock zkVM
pnpm test:cli:real-dev                         # Real Rust zkVM with dev receipts
pnpm test:cli:real-prod:s0                     # Real STARK proof for S0
```

### Testing

```bash
./scripts/tests/test-zkvm.sh                # Test zkVM integration
```

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
pnpm licenses:regen              # Regenerate sanitized docs/current/licenses metadata
```

### Terraform

```bash
pnpm terraform:backend               # Render legacy/root git-ignored infra/terraform/legacy/backend.local.hcl
pnpm terraform:bootstrap:backend:dev # Render authorized infra/terraform/bootstrap/backend.local.hcl
pnpm terraform:foundation:backend:dev # Render authorized infra/terraform/foundation/backend.local.hcl
pnpm terraform:app:backend:dev       # Render authorized infra/terraform/app/backend.local.hcl
pnpm terraform:bootstrap:init:dev    # Initialize authorized stark-dev/develop/bootstrap state
pnpm terraform:bootstrap:plan:dev    # Plan authorized stark-dev/develop/bootstrap state
pnpm terraform:build-lambdas         # Build Terraform-managed Lambda bundles
pnpm terraform:iam-docs              # Render git-ignored Terraform admin IAM JSON
```

### AWS Operator Helpers

```bash
pnpm aws:release-artifacts:generate:develop -- --help # Generate toolchain/prover artifact records and accepted pointers
pnpm aws:release-manifest:publish:develop -- --help # Validate/publish the Plan 02 release manifest object
pnpm aws:app-deployment-record:generate:develop -- --help # Generate selected app deployment record + manifest bridge
pnpm aws:foundation-pipeline:develop                 # Start the approved stark-dev/develop/foundation saved-plan lane
pnpm aws:prover-release-pipeline:develop -- --help   # Validate/start the prover candidate/approval/evidence CodePipeline lane
pnpm aws:release-candidate-preflight:develop         # Start the legacy preflight-only source/check lane
pnpm aws:app-pipeline:develop -- --help              # Validate/start stark-dev/develop/app pipeline invocation
pnpm aws:runtime-references:validate:develop -- --help # Metadata-only Plan 02 runtime reference check
```

`aws:release-artifacts:generate:develop` and
`aws:app-deployment-record:generate:develop` are local/private generators. They
validate retained evidence and write JSON outputs when requested, but they do
not publish S3 objects or update accepted channel pointers. The
`aws:release-candidate-preflight:develop` lane is intentionally preflight-only;
it is not image build, promotion, or app deployment authority.
Use `aws:prover-release-pipeline:develop` for the current prover-specific
candidate/approval/evidence lane; it starts CodePipeline, defaults to the
accepted toolchain pointer, and does not promote accepted pointers or deploy
app resources.

Legacy workspace plan/apply and runtime-shaped tfvars-render commands are
intentionally not exposed as package scripts. They require explicit
authorization and direct use of `scripts/terraform/terraform-guarded.sh` or
`scripts/terraform/render-local-tfvars.sh`.

For target-account bootstrap, run `pnpm terraform:bootstrap:backend:dev` before
`pnpm terraform:bootstrap:init:dev`; the package script supplies the authorized
`stark-dev/develop/bootstrap` identity and writes
`infra/terraform/bootstrap/backend.local.hcl`.

Run the current authorized target bootstrap helper with
`TERRAFORM_WORKING_DIR=infra/terraform/bootstrap` and the
`stark-dev/develop/bootstrap` identity.

Target foundation and app backend rendering are authorized for
`stark-dev/develop/foundation` and `stark-dev/develop/app`, but they do not
expose local foundation/app Terraform execution. Foundation and app `init`,
`validate`, `plan`, `apply`, and smoke are accepted only from the
bootstrap-managed AWS CodePipeline/CodeBuild role identities through
`scripts/terraform/terraform-guarded.sh`.
Before starting the foundation lane, verify the active target account identity:

```bash
AWS_PROFILE=${AWS_PROFILE:-stark-dev-admin} aws sts get-caller-identity --region ap-northeast-1 --output json --no-cli-pager
pnpm aws:foundation-pipeline:develop
```

Do not substitute local foundation Terraform `apply` for this saved-plan lane.
Production bootstrap and live production app execution remain deferred and
require a later authorization record. Repository-only protected-production app
lane contract rendering is static evidence and does not authorize mutation.

## Notes

- Scripts now use relative paths from their subdirectories
- Legacy test-data and manual receipt-inspection helpers have been retired
- Browser/WASM verification references should be treated as legacy context
- The maintained verification path is the CLI harness plus `verifier-service`
- All scripts navigate to project root when needed
