# Build Scripts

Small helpers for local build and cleanup tasks.

For the canonical project-level commands, prefer the package scripts in
`package.json`:

```bash
pnpm build:zkvm
pnpm build:verifier-service
pnpm terraform:build-lambdas
pnpm terraform:build-lambda:target-runtime
pnpm clean:all
```

## Scripts

### build-zkvm.sh

Builds the zkVM host binary in release mode.

- Wrapper around `cd zkvm && cargo build --release -p host --features production`
- Creates binary at `zkvm/target/release/host`

### build-image-signature-gate-lambda.mjs

Bundles the Terraform-managed ECR signing-status Lambda.

- Wrapper around `esbuild`
- Reads `infra/lambdas/image-signature-gate/index.mjs`
- Writes a self-contained CommonJS handler to `infra/terraform/legacy/.tmp/image-signature-gate/index.js`
- Run before `terraform plan` / `terraform apply` when the Terraform stack includes
  `lambda_check_image_signature.tf`

### build-target-lambdas.mjs

Builds the target-owned Lambda packages for the public API, finalization writer,
proof dispatcher, verification worker, `image_signature_gate`, and
`semaphore_janitor` runtimes.

- Invoked by `pnpm terraform:build-lambda:target-runtime`
- Writes immutable zip packages and a manifest under `.tmp/target-lambdas/`
- `pnpm terraform:build-lambdas` remains the aggregate command that builds both
  the signing-status Lambda and the target runtime Lambda packages

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
