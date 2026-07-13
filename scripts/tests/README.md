# Test Scripts

This directory contains a mix of maintained CLI entrypoints and lower-level diagnostic helpers for the STARK Ballot Simulator.

The primary end-to-end entrypoint is `scripts/tests/cli-e2e-voting-flow.ts`.
For the fuller CLI runbook and package-script matrix, see `docs/guides/cli.md`.

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

- The harness runs `pnpm build:ci`, then spawns `scripts/dev/static-hono-server.ts` directly unless
  `STARK_BALLOT_CLI_BASE_URL` is already set. `pnpm start` is the equivalent manual wrapper.
- Real zkVM modes require built Rust binaries.
- `--skip-build` only works when a fresh enough Vite dist output already exists.
- When the harness starts its own production Vite static frontend plus Hono API server, it also fills a test-only local
  `SESSION_CAPABILITY_SECRET` from `scripts/tests/.env.test.defaults` if neither the shell nor
  `.env.local` already provides one.

### Develop gated smoke

`scripts/tests/develop-gated-smoke.ts` is the Plan 03 operator-gated develop
smoke runner. It must run through the gated CloudFront hostname and also probe
the direct API origin for fail-closed rejection. The positive owner flow uses
the CLI real-zkVM production verifier-service path, so deployed develop must
produce and verify production-mode STARK evidence. Develop differs from
production only by access gating, Cloudflare bypass posture, and artifact
retention policy.

The default acceptance matrix is `S0,S1,S2`: normal, one exclusion class, and
one claimed-tally class. Set
`STARK_BALLOT_GATED_SMOKE_SCENARIOS=S0,S1,S2,S3,S4,S5` to exercise the full
scenario set. A configured matrix fails closed unless it includes `S0`, at
least one of `S1`/`S3`/`S5`, and at least one of `S2`/`S4`.

For each scenario, the runner resolves the independent expected ImageID from
the current `default` entry in `public/imageId-mapping.json`, compares the API
ImageID projections with that authority, explicitly starts
`POST /api/verification/run`, requires a newly queued durable AWS verification
run, and polls `/api/verify` to success. It then checks wrong-capability
rejection on both bundle and report endpoints, retrieves both with the owner
capability, and rejects a public ZIP containing `input.json`,
`verification.json`, `included-bitmap.json`, or `seen-bitmap.json`. The STARK
receipt status must succeed for every educational scenario, while the derived
overall verdict must be `fully_verified` only for S0 and fail closed for every
configured tamper scenario.

Use short-lived signed-cookie values from the approved KMS-backed operator
procedure (`pnpm aws:operator-gate:develop -- inspect`, followed by `issue
--probe`). KMS private key material is never exported or read from a secret
store, repository file, or Terraform state. Supply all four issued cookie
values to the smoke runner only through a protected local environment and do
not write them to logs or tracked files.

```bash
STARK_BALLOT_DEVELOP_BASE_URL=https://develop.stark-ballot-sim.hwatanabe.dev \
STARK_BALLOT_DIRECT_API_ORIGIN=https://<api-id>.execute-api.<region>.amazonaws.com \
STARK_BALLOT_OPERATOR_AUTH_HEADER=Cookie \
STARK_BALLOT_OPERATOR_AUTH_VALUE='CloudFront-Policy=<policy>; CloudFront-Signature=<signature>; CloudFront-Key-Pair-Id=<key-pair-id>; CloudFront-Hash-Algorithm=SHA256' \
pnpm test:develop:gated-smoke
```

This command generates production-mode STARK evidence for multiple scenarios
and is intentionally not part of the default local or CI gate. Local contract
tests cover the runner without contacting AWS:

```bash
pnpm exec vitest run scripts/__tests__/develop-gated-smoke.test.ts --reporter=dot
```

The documented operator-gated command does not require
`STARK_BALLOT_SESSION_TURNSTILE_TOKEN`, `STARK_BALLOT_VOTE_TURNSTILE_TOKEN`,
or `STARK_BALLOT_FINALIZE_TURNSTILE_TOKEN`: in target develop, the API skips
server-side session/vote/finalize Turnstile only after the outer CloudFront
operator gate and origin verification have admitted the request. Browser
bypass flags such as `VITE_TURNSTILE_BYPASS` remain disabled in target static
artifacts.

Do not put private key material, raw origin-header secrets, unsigned policy
payloads, or full signed-cookie values in tracked docs, logs, public handoff
summaries, or release artifacts. Local non-acceptance runs may set
`STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE=1`; Plan 03 acceptance must set
`STARK_BALLOT_DIRECT_API_ORIGIN`.

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

Starts `pnpm dev` inside a tmux session named `vite`.

Usage:

```bash
bash scripts/tests/setup-cli-test.sh --mock
bash scripts/tests/setup-cli-test.sh --image-id 0x...
```

Notes:

- Use this when you want a long-lived local dev server and plan to point the CLI harness at it with `STARK_BALLOT_CLI_BASE_URL=http://127.0.0.1:3000`.
- The file is not executable in the current repo, so invoke it with `bash`.
- `pnpm dev` reads local defaults from `.env.local`. With the checked-in
  `.env.local.example` defaults, this helper starts a mock local UI. For genuine
  real-zkVM runs, use the CLI-managed `test:cli:real-*` scripts or point the CLI
  at a separately configured server.

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

### `entrypoint-bundle.test.sh`

Smoke test for the public bundle/archive contract and host timeout wrapper exposed by
`infra/docker/entrypoint.sh`.

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

and that private `input.json` / `verification.json` / `included-bitmap.json` / `seen-bitmap.json`
are excluded from `bundle.zip` while the protected verification report and exact bitmap artifacts
are still retained alongside the uploaded outputs.

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

### `zkvm-full-guest-benchmark.ts`

Opt-in production-mode full-guest zkVM benchmark for the Rust host.

Usage:

```bash
pnpm tsx scripts/tests/zkvm-full-guest-benchmark.ts
pnpm tsx scripts/tests/zkvm-full-guest-benchmark.ts -- --iterations 3 --slots 64 --output .tmp/zkvm-full-guest-benchmark.json
```

Notes:

- Requires a built host binary; use `pnpm build:zkvm` first.
- Runs with `RISC0_DEV_MODE` unset and writes a structured JSON report.
- Use `--keep-artifacts` only when you need to inspect the generated input, output, receipt, and bitmap artifacts.

### `__tests__/`

Vitest regression coverage for the CLI harness lives under `scripts/tests/__tests__/`.

Current files:

- `cli-regression.test.ts`
- `cli-merkle-enforcement.test.ts`
- `read-image-id.test.ts`
- `rfc6962-golden-vectors.test.ts`
- `zkvm-fixtures.test.ts`
- `zkvm-full-guest-benchmark.test.ts`

Run them with the rest of the one-shot Vitest suite:

```bash
pnpm test:run
```

or target them directly:

```bash
pnpm vitest run scripts/tests/__tests__
```

## Prerequisites

- `pnpm install --frozen-lockfile` for reproducible setup, or `pnpm install` for local development
- `pnpm build:zkvm` for scripts that invoke the Rust host binary
- `pnpm build:verifier-service` for real CLI bundle verification
- an existing `pnpm build:ci` output if you pass `--skip-build`
- generated receipt fixtures for `tamper-stark-proof.ts`
- `jq` for `test-zkvm.sh`
- `tmux` and `nc` for `setup-cli-test.sh`
- `python3`, `timeout`, and `unzip` for `entrypoint-bundle.test.sh`

## Current Guidance

- Prefer the `pnpm test:cli*` commands for end-to-end validation.
- Treat `test-zkvm.sh` as a low-level diagnostic.
- When reusing a long-lived dev server, set `STARK_BALLOT_CLI_BASE_URL` explicitly before running the CLI harness.
