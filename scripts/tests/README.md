# Test Scripts

This directory contains a mix of maintained CLI entrypoints and lower-level diagnostic helpers for the STARK Ballot Simulator.

The primary end-to-end entrypoint is `scripts/tests/cli-e2e-voting-flow.ts`.
For the fuller CLI runbook and package-script matrix, see `docs/current/tests/cli.md`.

## Recommended Entry Points

### CLI E2E harness

`scripts/tests/cli-e2e-voting-flow.ts` exercises the application flow without a browser:

- create session
- submit user vote
- generate bot votes
- finalize with a selected tamper scenario
- fetch verification artifacts and verification bundles
- enforce the current CLI verification contract:
  required steps `counted_as_recorded` and `stark_verification`;
  `counted_expected_vs_tree_size`,
  `counted_election_manifest_consistent`,
  `counted_close_statement_consistent`,
  `stark_receipt_verify`,
  the current journal `methodVersion`,
  and journal count mirrors for `missingSlots`, `invalidPresentedSlots`, `validVotes`,
  and `excludedSlots`
- verify Merkle inclusion and STARK bundle data

Common commands:

```bash
pnpm test:cli -- --user-choice A
pnpm test:cli:mock
pnpm test:cli:real-dev
pnpm test:cli:real-prod:s0
pnpm test:cli:real-prod:all -- --user-choice B --skip-build
```

Notes:

- The harness runs `next build` and `next start` unless `STARK_BALLOT_CLI_BASE_URL` is already set.
- Real zkVM modes require built Rust binaries.
- `--skip-build` only works when a fresh enough Next.js build output already exists.
- When the harness starts its own production Next.js server, it also fills a test-only local
  `SESSION_CAPABILITY_SECRET` from `scripts/tests/.env.test.defaults` if neither the shell nor
  `.env.local` already provides one.

### Batch real-proof run

`run-all-real-tests.sh` wraps the CLI harness for long-running production-mode proof generation:

- five CLI invocations, one for each user choice `A` through `E`
- each invocation runs the full `S0` through `S5` scenario set
- total matrix size: 30 choice/scenario combinations
- logs stored under `LOG_DIR` (default: `.tmp/test-logs/<date>/`)
- 60 second pause between invocations

Usage:

```bash
./scripts/tests/run-all-real-tests.sh
```

This is a real STARK proof run and is expected to take roughly 3.5 hours.

## Support And Diagnostic Scripts

### `setup-cli-test.sh`

Starts `pnpm dev` inside a tmux session named `nextjs`.

Usage:

```bash
bash scripts/tests/setup-cli-test.sh --mock
bash scripts/tests/setup-cli-test.sh --image-id 0x...
```

Notes:

- Use this when you want a long-lived local dev server and plan to point the CLI harness at it with `STARK_BALLOT_CLI_BASE_URL=http://127.0.0.1:3000`.
- The file is not executable in the current repo, so invoke it with `bash`.
- Current limitation: this helper starts `pnpm dev`, and the `dev` script in `package.json` hardcodes `USE_MOCK_ZKVM=true`. In practice this makes the helper a mock-server setup, even if `--real` is passed.

### `teardown-cli-test.sh`

Stops the tmux session created by `setup-cli-test.sh` and removes temporary test artifacts.

Usage:

```bash
./scripts/tests/teardown-cli-test.sh
```

It removes:

- `.zkvm-temp/`
- generated `*-output.json`
- generated `*-receipt.json`

### `test-zkvm.sh`

Low-level Rust host smoke test for the checked-in fixture inputs:

- runs `zkvm/target/release/host`
- forces `RISC0_DEV_MODE=1`
- executes `zkvm/test-data/test-fixture-valid.json`
- executes `zkvm/test-data/test-fixture-tampered.json`

Usage:

```bash
./scripts/tests/test-zkvm.sh
```

Notes:

- This is a host-level diagnostic script, not the main application E2E path.
- If `zkvm/target/release/host` is missing, the script builds it automatically before running the fixtures.
- It still depends on a working Rust toolchain and current fixture compatibility.

### `generate-zkvm-fixtures.ts`

Regenerates the two checked-in host input fixtures used by `test-zkvm.sh`.

Usage:

```bash
pnpm tsx scripts/tests/generate-zkvm-fixtures.ts
```

Outputs:

- `zkvm/test-data/test-fixture-valid.json`
- `zkvm/test-data/test-fixture-tampered.json`

### `generate-rfc6962-golden-vectors.ts`

Regenerates the checked-in TypeScript-to-Rust RFC6962 inclusion-proof fixture.

Usage:

```bash
pnpm tsx scripts/tests/generate-rfc6962-golden-vectors.ts
```

Outputs:

- `zkvm/contract-core/testdata/rfc6962-ts-golden-vectors.json`

Notes:

- `scripts/tests/rfc6962-golden-vectors.ts` builds the deterministic cases used by the generator and Vitest coverage.
- Rust tests in `zkvm/contract-core/src/inclusion_proof.rs` consume the generated fixture to check cross-language RFC6962 compatibility.

### `test-journal-parser.ts`

Parses journal bytes from pre-existing receipt fixtures under `zkvm/test-data/`.

Usage:

```bash
pnpm tsx scripts/tests/test-journal-parser.ts
```

Notes:

- This script looks for files like `zkvm/test-data/test-s0-notamper-receipt.json`.
- Those scenario receipt files are not checked into the repo by default.
- Generate or copy the receipts first, or the script will fail with `ENOENT`.

### `tamper-stark-proof.ts`

Creates a tampered copy of a valid receipt to check proof tamper-evidence behavior.

Usage:

```bash
pnpm tsx scripts/tests/tamper-stark-proof.ts
pnpm tsx scripts/tests/tamper-stark-proof.ts SINGLE_VALUE_CHANGE
```

Supported tamper modes:

- `SINGLE_BIT_FLIP`
- `SINGLE_VALUE_CHANGE`
- `MULTIPLE_VALUES`
- `ZERO_OUT_RANGE`

Notes:

- Reads `zkvm/test-data/test-fixture-valid-receipt.json`
- Writes `zkvm/test-data/test-fixture-tampered-stark-receipt.json`
- Requires a real `Composite` receipt. `pnpm test:stark-tamper` regenerates one first.

### `test-s3-tamper.ts`

Legacy low-level tamper experiment.

Usage:

```bash
pnpm tsx scripts/tests/test-s3-tamper.ts
```

Notes:

- Despite the name, it does not call S3.
- It constructs synthetic vote data in-process and runs the local zkVM host through the TypeScript executor.
- This script is best treated as a manual investigation helper, not a maintained CI entrypoint.

### `entrypoint-bundle.test.sh`

Smoke test for the public bundle creation logic exposed by `docker/entrypoint.sh`.

Usage:

```bash
pnpm test:entrypoint-bundle
```

It verifies that the generated zip contains public artifacts such as:

- `receipt.json`
- `journal.json`
- `public-input.json`
- `election-manifest.json`
- `close-statement.json`

and that private `input.json` / `included-bitmap.json` / `seen-bitmap.json` are excluded
from `bundle.zip` while the exact bitmap artifacts are still retained alongside the uploaded
outputs.

Notes:

- The package script wraps `bash scripts/tests/entrypoint-bundle.test.sh` so local runs and CI use the same entrypoint.

### `performance-benchmark.ts`

Opt-in local benchmark runner for rough throughput comparisons.

Usage:

```bash
pnpm test:bench
pnpm test:bench -- --iterations 50
```

Notes:

- This script prints timing summaries only; it does not enforce pass/fail thresholds.
- It is intentionally excluded from `pnpm test:run` because VM/CI timing noise makes fixed thresholds flaky.
- Use it for local regression checks or before/after comparisons when optimizing hot paths.

### `__tests__/`

Vitest regression coverage for the CLI harness lives under `scripts/tests/__tests__/`.

Current files:

- `cli-regression.test.ts`
- `cli-merkle-enforcement.test.ts`
- `read-image-id.test.ts`
- `rfc6962-golden-vectors.test.ts`
- `zkvm-fixtures.test.ts`

Run them with the rest of the Vitest suite:

```bash
pnpm test
```

or target them directly:

```bash
pnpm vitest run scripts/tests/__tests__
```

## Prerequisites

- `pnpm i`
- `pnpm build:zkvm` for scripts that invoke the Rust host binary
- `pnpm build:verifier-service` for real CLI bundle verification
- an existing `next build` output if you pass `--skip-build`
- generated receipt fixtures for `test-journal-parser.ts` and `tamper-stark-proof.ts`
- `jq` for `test-zkvm.sh`
- `tmux` and `nc` for `setup-cli-test.sh`
- `python3` and `unzip` for `entrypoint-bundle.test.sh`

## Current Guidance

- Prefer the `pnpm test:cli*` commands for end-to-end validation.
- Treat `test-zkvm.sh`, `test-s3-tamper.ts`, and `test-journal-parser.ts` as low-level diagnostics.
- When reusing a long-lived dev server, set `STARK_BALLOT_CLI_BASE_URL` explicitly before running the CLI harness.
