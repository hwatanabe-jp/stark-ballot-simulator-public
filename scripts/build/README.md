# Build Scripts

Small helpers for local build and cleanup tasks.

For the canonical project-level commands, prefer the package scripts in
`package.json`:

```bash
pnpm build:zkvm
pnpm build:verifier-service
pnpm terraform:build-lambdas
pnpm clean:all
```

## Scripts

### build-zkvm.sh

Builds the zkVM host binary in release mode.

- Wrapper around `cd zkvm && cargo build --release`
- Creates binary at `zkvm/target/release/host`

### build-check-image-signature-lambda.mjs

Bundles the Terraform-managed ECR signing-status Lambda.

- Wrapper around `esbuild`
- Reads `terraform/lambda/check-image-signature/index.mjs`
- Writes a self-contained CommonJS handler to `terraform/.tmp/check-image-signature/index.js`
- Run before `terraform plan` / `terraform apply` when the Terraform stack includes
  `lambda_check_image_signature.tf`

### clean-all.sh

Cleanup of common local generated files:

- Next.js build artifacts (`.next`, `out`)
- TypeScript build info
- Test coverage reports
- Terraform generated Lambda bundles (`terraform/.tmp`)
- zkVM temporary files and outputs
- Package manager logs
- Editor swap files
- OS-specific files (`.DS_Store`, etc.)

## Usage

Shell scripts navigate to the project root before executing; JS scripts resolve
paths from the project root.

```bash
# Build zkVM
./scripts/build/build-zkvm.sh

# Clean common local artifacts
./scripts/build/clean-all.sh
```

## Notes

- `build-zkvm.sh` does not run `cargo clean`; use that separately if you need a fresh
  Rust rebuild.
- `clean-all.sh` is broader than `pnpm clean` and also removes generated zkVM outputs.
- Historical browser/WASM verification helpers are no longer documented here because
  they are not part of the current maintained build workflow.
