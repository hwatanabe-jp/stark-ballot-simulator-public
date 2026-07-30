# Scripts Directory

This directory contains all utility scripts for the STARK Ballot Simulator project, organized by functionality.

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
pnpm licenses:check              # Verify tracked metadata matches current lockfiles
pnpm licenses:regen              # Regenerate sanitized docs/licenses metadata
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

## Notes

- Scripts now use relative paths from their subdirectories
- Legacy test-data and manual receipt-inspection helpers have been retired
- Browser/WASM verification references should be treated as legacy context
- The maintained verification path is the CLI harness plus `verifier-service`
- All scripts navigate to project root when needed
