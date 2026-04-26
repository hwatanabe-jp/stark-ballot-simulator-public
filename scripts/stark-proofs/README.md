# STARK Proof Scripts

Compatibility wrappers for running production-mode zkVM proofs through the
maintained CLI E2E harness.

These scripts no longer generate legacy scenario fixture files directly. They
delegate to `scripts/tests/cli-e2e-voting-flow.ts` via `pnpm test:cli`, which
creates a session, casts the user vote, generates bot votes, finalizes the
selected scenario(s), downloads authenticated verification artifacts, and runs
`verifier-service` when a bundle is available.

## Scripts

### generate-all.sh

Runs the real zkVM production path for all 6 tamper scenarios (`S0` through
`S5`) for one user choice.

Behavior:

- Sets `USE_MOCK_STORE=true` and `USE_MOCK_ZKVM=false`
- Calls `pnpm test:cli -- --real-zkvm --zkvm-mode prod --all-scenarios`
- Defaults to `--user-choice A`
- Accepts `--user-choice` / `-u`
- Forwards extra arguments to the CLI harness, such as `--skip-build`,
  `--verbose`, or `--output markdown`

Production proofs are slow. Current local x86_64 runs can take roughly 6
minutes per 64-vote scenario, so the full S0-S5 matrix is a long run. The
wrapper does not skip scenarios that already have receipts; every selected CLI
test case is executed.

### test-single.sh

Runs the real zkVM production path for one scenario.

Behavior:

- Sets `USE_MOCK_STORE=true` and `USE_MOCK_ZKVM=false`
- Calls `pnpm test:cli -- --real-zkvm --zkvm-mode prod --scenario <scenario>`
- Defaults to `--scenario S3`
- Defaults to `--user-choice A`
- Accepts `--scenario` / `-s` and `--user-choice` / `-u`
- Forwards extra arguments to the CLI harness, such as `--skip-build`,
  `--verbose`, or `--output json`

## Usage

```bash
# Run production real-zkVM proofs for all S0-S5 scenarios
./scripts/stark-proofs/generate-all.sh

# Run production real-zkVM proof for the default S3 scenario
./scripts/stark-proofs/test-single.sh

# Override the scenario and user choice
./scripts/stark-proofs/test-single.sh --scenario S0 --user-choice B

# Reuse an existing Next.js build output
./scripts/stark-proofs/generate-all.sh --skip-build

# Show the underlying CLI options
./scripts/stark-proofs/test-single.sh --help
```

## Outputs

The maintained CLI flow writes artifacts under `.tmp/cli-bundles/`.

Typical outputs include:

- `.tmp/cli-bundles/run-<timestamp>/report.json` - structured CLI run report
- `.tmp/cli-bundles/run-<timestamp>/report.txt` or `report.md` - formatted CLI
  report when the selected output format is not `json`
- `.tmp/cli-bundles/<sessionId>/bundle-authenticated-endpoint-*.zip` -
  authenticated public verification bundle download
- `.tmp/cli-bundles/<sessionId>/verification-report-authenticated-endpoint-*.json`
  - authenticated verifier report download
- `.tmp/cli-bundles/<sessionId>/extracted/<executionId>-authenticated-endpoint/`
  - extracted public bundle artifacts

Raw host files such as `*-output.json`, `*-receipt.json`, `*-bitmap.json`, and
`*-seen-bitmap.json` may be created transiently by the zkVM executor, but they
are not the stable output contract for these wrappers.

## Important Notes

1. **Production mode**: These scripts pass `--zkvm-mode prod`, so the CLI
   unsets `RISC0_DEV_MODE` for real STARK receipts.
2. **Builds**: The CLI runs `next build` unless you pass `--skip-build` or set
   `STARK_BALLOT_CLI_SKIP_BUILD=true` / `CLI_SKIP_BUILD=true`.
3. **Prerequisites**:
   - Dependencies must be installed (`pnpm install`)
   - zkVM binary must be built (`pnpm build:zkvm`)
   - verifier-service binary must be built (`pnpm build:verifier-service`)
   - an existing `next build` output is required when using `--skip-build`
4. **No legacy test-data step**: `scripts/test-data/generate-sha256-data.ts` is
   no longer supported. These wrappers generate votes through the CLI flow.
5. **Bundle boundary**: Public bundles must not include private artifacts such
   as `input.json`, `verification.json`, `included-bitmap.json`, or
   `seen-bitmap.json`.

## Scenarios

- **S0**: No tampering (baseline)
- **S1**: Exclude your vote
- **S2**: Tamper claimed tally (your vote)
- **S3**: Exclude bot votes
- **S4**: Tamper claimed tally (bot votes)
- **S5**: Random error injection

For the full CLI contract, package-script matrix, ImageID notes, and bundle
download behavior, see `docs/current/tests/cli.md`.
