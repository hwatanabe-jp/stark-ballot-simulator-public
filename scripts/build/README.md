# Build Scripts

This directory contains local Rust build wrappers, deployment Lambda artifact
packagers, and the repository-wide cleanup script.

## Canonical Commands

Prefer the package scripts in `package.json` for normal project-level use:

```bash
pnpm build:zkvm
pnpm build:verifier-service
pnpm terraform:build-lambdas
pnpm clean:all
```

`pnpm terraform:build-lambdas` aliases
`pnpm terraform:build-lambda:target-runtime`. The target-runtime command builds
`verifier-service` first, then runs `build-target-lambdas.mjs`.

## Build and Packaging Scripts

### build-zkvm.sh

Builds the zkVM host binary in release mode.

- Wrapper around `cd zkvm && cargo build --release -p host --features production`
- Creates binary at `zkvm/target/release/host`
- Does not run `cargo clean`; run that separately for a fresh Rust rebuild

### build-target-lambdas.mjs

Builds the complete six-artifact target-owned Lambda package set:

- public API
- finalization writer
- proof dispatcher
- verification worker, including the prebuilt `verifier-service` binary
- semaphore janitor
- cryptographic image-signature verifier

It writes deterministic ZIP packages plus a checksum-bound manifest under
`.tmp/target-lambdas/`. The image-signature-verifier entry also records its
asset-manifest and trust-root digests.

This script is the implementation behind
`pnpm terraform:build-lambda:target-runtime`; use the canonical aggregate
command above unless a pipeline or diagnostic step specifically requires the
direct script.

### build-image-signature-verifier-lambda.mjs

Builds the dedicated cryptographic image-signature-verifier Lambda package. It
bundles the handler, installs the checksum-pinned native verifier assets,
validates their allowlist and native executability, and emits
`image-signature-verifier.zip` plus `manifest.json`.

The app signature-preflight CodeBuild definition invokes it directly:

```bash
node scripts/build/build-image-signature-verifier-lambda.mjs \
  --platform linux-amd64 \
  --output .tmp/image-signature-verifier-lambda
```

The CLI accepts only `linux-amd64`. It requires network access for the pinned
external assets, the `tar` and `unzip` tools, and matching Linux amd64 so the
native load and version checks can execute. The explicit output path must not
already exist and must not resolve to the filesystem root or current working
directory. Successful output is deterministic and checksum-bound.

### install-image-signature-verifier-assets.mjs

Internal building block used by the image-signature-verifier Lambda builder. It
downloads the asset-manifest-authorized Notation CLI, AWS Signer plugin, ECR
credential helper, licenses, notices, and trust root; verifies their pinned
checksums and exact archive contents; then publishes an installation manifest.

It also has a direct CLI for packaging diagnostics:

```bash
node scripts/build/install-image-signature-verifier-assets.mjs \
  --architecture <amd64|arm64> \
  --output <directory>
```

The selected architecture must match the Linux host for the native checks. As
with the Lambda builder, the explicit output directory must not already exist
and must not be the filesystem root or current working directory.

Repository-owned inputs in these JavaScript scripts are located from the
repository root. Explicit CLI output paths are resolved from the process working
directory; invoke the documented commands from the repository root unless a
pipeline deliberately supplies another working directory.

## Cleanup

### clean-all.sh

Cleanup of common local generated files:

- Frontend build artifacts (`dist`) and retired Next.js artifacts (`.next`, `out`)
- TypeScript build info
- Test coverage reports
- Playwright and test result outputs
- Terraform generated Lambda bundles (`infra/terraform/legacy/.tmp` and
  `.tmp/target-lambdas`)
- Terraform local generated backend/tfvars/json files and ignored plan outputs
  (`infra/terraform/**/*.local.hcl`, `infra/terraform/**/*.local.tfvars`,
  `infra/terraform/**/*.local.json`, `infra/terraform/**/*.tfplan`, and
  `infra/terraform/app/tfplan*`)
- zkVM temporary files and outputs, including local verifier bundles
  (`.verifier-bundles`)
- Package manager logs
- Editor swap files
- OS-specific files (`.DS_Store`, etc.)

The shell script first navigates to the project root. It removes more generated
artifact categories than `pnpm clean`, including generated zkVM outputs, but it
does not run `cargo clean`.

```bash
# Build zkVM
./scripts/build/build-zkvm.sh

# Clean common local artifacts
./scripts/build/clean-all.sh
```
