# Build Scripts

Small helpers for local build and cleanup tasks.

For the canonical project-level commands, prefer the package scripts in
`package.json`:

```bash
pnpm build:zkvm
pnpm build:verifier-service
pnpm clean:all
```

## Scripts

### build-zkvm.sh

Builds the zkVM host binary in release mode.

- Wrapper around `cd zkvm && cargo build --release`
- Creates binary at `zkvm/target/release/host`

### clean-all.sh

Comprehensive cleanup of all generated files:

- Next.js build artifacts (`.next`, `out`)
- TypeScript build info
- Test coverage reports
- zkVM temporary files and outputs
- Package manager logs
- Editor swap files
- OS-specific files (`.DS_Store`, etc.)

## Usage

All scripts automatically navigate to the project root before executing.

```bash
# Build zkVM
./scripts/build/build-zkvm.sh

# Clean all artifacts
./scripts/build/clean-all.sh
```

## Notes

- `build-zkvm.sh` does not run `cargo clean`; use that separately if you need a fresh
  Rust rebuild.
- `clean-all.sh` is broader than `pnpm clean` and also removes generated zkVM outputs.
- Historical browser/WASM verification helpers are no longer documented here because
  they are not part of the current maintained build workflow.
