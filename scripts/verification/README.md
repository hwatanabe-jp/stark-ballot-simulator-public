# Verification Script Notes

This directory contains legacy and manual helpers for inspecting receipt fixtures under
`zkvm/test-data/`. It is not the primary verification workflow for the current repo.

For maintained workflows, prefer:

- `pnpm test:cli*` via `scripts/tests/cli-e2e-voting-flow.ts`
- `verifier-service/README.md` for authoritative STARK receipt verification
- `scripts/stark-proofs/README.md` for real production-mode scenario runs through
  the maintained CLI harness

## Current Status

### verify-single.js

Ad-hoc helper for loading a single legacy raw `test-<scenario>-receipt.json` file
and printing basic journal-derived counts.

- Useful for quick fixture inspection while debugging
- Confirms the file can be loaded and parsed
- Expects the old top-level `inner.Composite` plus `journal.bytes` receipt shape
- Does not support the current host-generated `{ receipt, image_id }` receipt
  envelope
- Does not replace the Rust verifier or the maintained CLI E2E flow

Usage:

```bash
node ./scripts/verification/verify-single.js s0-notamper
node ./scripts/verification/verify-single.js s3-ignore-bot
```

### test-cli.sh

Historical shell wrapper for the older fixture-verification flow.

- Kept for reference while the legacy helpers remain in the tree
- Not the recommended entrypoint for current development
- Intentionally disabled: it exits non-zero and points to the maintained
  `scripts/tests` and `verifier-service` workflows

## Recommended Workflows

### End-to-end verification

Use the maintained CLI harness documented in `scripts/tests/README.md`:

```bash
pnpm test:cli -- --user-choice A
pnpm test:cli:mock
pnpm test:cli:real-dev
pnpm test:cli:real-prod:s0
```

### Authoritative STARK receipt verification

Use the Rust verifier documented in `verifier-service/README.md`:

```bash
pnpm build:verifier-service
cd verifier-service
./target/release/verifier-service verify /path/to/bundle --image-id 0x...
```

### Real scenario runs

Use the compatibility wrappers documented in `scripts/stark-proofs/README.md`
when you need production-mode S0-S5 scenario runs:

```bash
./scripts/stark-proofs/generate-all.sh
```

Those wrappers delegate to the maintained CLI harness and write stable outputs
under `.tmp/cli-bundles/`. They do not generate legacy
`zkvm/test-data/test-<scenario>-receipt.json` fixtures for `verify-single.js`.

## Notes

- Scenario receipt fixtures such as `zkvm/test-data/test-s0-notamper-receipt.json` are
  not guaranteed to be checked into the repo.
- There is no maintained current command whose stable output contract is the
  legacy `test-<scenario>-receipt.json` fixture set.
- Browser/WASM verification references elsewhere in the repository should be treated as
  historical context. The current real verification path is server-backed Rust
  verification.
