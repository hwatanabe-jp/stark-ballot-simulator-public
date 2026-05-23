# Scripts Directory

This directory contains all utility scripts for the STARK Ballot Simulator project, organized by functionality.

## Directory Structure

- \***\*tests**/\*\* - Script-level Vitest coverage
- **amplify/** - Amplify deployment environment helpers
- **aws/** - AWS setup helpers
- **build/** - Build and cleanup scripts
- **docs/** - Documentation and license metadata helpers
- **monitoring/** - Operational monitoring report helpers
- **security/** - Public-safety and secret-leak guard scripts
- **showcase/** - Public repository showcase automation helpers
- **stark-proofs/** - STARK proof generation utilities
- **terraform/** - Local Terraform tfvars rendering and guarded Terraform execution helpers
- **test-data/** - Test data generation scripts
- **tests/** - Maintained CLI and diagnostic test scripts
- **verification/** - Legacy/manual receipt inspection helpers

## Quick Reference

### Build Operations

```bash
./scripts/build/build-zkvm.sh    # Build zkVM binary
pnpm terraform:build-lambdas     # Build Terraform-managed Lambda bundles
./scripts/build/clean-all.sh     # Clean all generated files
```

### Generate Test Data

```bash
npx tsx ./scripts/test-data/generate-sha256-data.ts  # Generate test data with SHA-256
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
node ./scripts/verification/verify-single.js   # Manual receipt inspection helper
```

### Testing

```bash
./scripts/tests/test-zkvm.sh                # Test zkVM integration
npx tsx ./scripts/tests/test-s3-tamper.ts   # Test S3 tamper scenario
npx tsx ./scripts/tests/test-journal-parser.ts  # Test journal parsing
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
pnpm terraform:backend           # Render git-ignored terraform/backend.local.hcl
pnpm terraform:tfvars:develop    # Render git-ignored terraform/develop.local.tfvars
pnpm terraform:tfvars:main       # Render git-ignored terraform/main.local.tfvars
pnpm terraform:build-lambdas     # Build Terraform-managed Lambda bundles
pnpm terraform:plan:develop      # Guarded Terraform plan for the develop workspace
pnpm terraform:apply:develop     # Guarded Terraform apply for the develop workspace
pnpm terraform:plan:main         # Guarded Terraform plan for the main workspace
pnpm terraform:apply:main        # Guarded Terraform apply for the main workspace
pnpm terraform:iam-docs          # Render git-ignored Terraform admin IAM JSON
```

## Notes

- Scripts now use relative paths from their subdirectories
- Old test data generators are archived in `test-data/archive/`
- Browser/WASM verification references should be treated as legacy context
- The maintained verification path is the CLI harness plus `verifier-service`
- All scripts navigate to project root when needed
