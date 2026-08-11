# Test Scripts

This directory contains the maintained browserless voting harness, live acceptance runners,
release-container contract checks, fixture generators, benchmarks, and lower-level diagnostics for the
STARK Ballot Simulator.

The primary local end-to-end entrypoint is `scripts/tests/cli-e2e-voting-flow.ts`. For the fuller CLI
runbook and package-script matrix, see `docs/guides/cli.md`.

## Choose a Test Path

| Purpose                           | Runtime mode                                           | Typical cost                            | Canonical command                                             |
| --------------------------------- | ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------- |
| Normal browserless voting flow    | Local static frontend + Hono, mock store and mock zkVM | Low                                     | `pnpm test:cli:mock`                                          |
| Real host contract smoke          | Local real zkVM with `RISC0_DEV_MODE=1` fake receipts  | Medium                                  | `pnpm test:cli:real-dev`                                      |
| Production proof smoke            | Local real zkVM production proof, S0 only              | High; expect minutes                    | `pnpm test:cli:real-prod:s0`                                  |
| Full production proof matrix      | Local real zkVM, 5 choices × 6 scenarios               | Very high; roughly 3.5 hours            | `./scripts/tests/run-all-real-tests.sh`                       |
| Operator-gated develop acceptance | Live develop, production STARK evidence                | Very high; AWS/operator access required | `pnpm test:develop:gated-smoke`                               |
| Prover candidate posture          | Docker candidate image, no real proof                  | Medium                                  | `scripts/tests/fargate-prover-container-smoke.sh <image-uri>` |
| Prover entrypoint contract        | Local/CI shell harness with stubbed host and AWS calls | Medium                                  | `pnpm test:entrypoint-bundle`                                 |
| Script regression coverage        | Local Vitest                                           | Low                                     | `pnpm vitest run scripts/tests/__tests__`                     |

Use the lightest row that proves the change. Development-mode receipts are not production STARK proofs,
and the live develop acceptance and production-proof rows are intentionally outside the default local or
CI gate.

## Local CLI Flows

### CLI E2E harness

`scripts/tests/cli-e2e-voting-flow.ts` exercises the application flow without a browser:

- creates a session
- submits the user vote and generates bot votes
- finalizes with a selected tamper scenario
- downloads the authenticated verification bundle and protected verification report
- enforces the current CLI verification contract:
  required steps `counted_as_recorded` and `stark_verification`;
  `counted_expected_vs_tree_size`,
  `counted_election_manifest_consistent`,
  `counted_close_statement_consistent`,
  `stark_receipt_verify`,
  the current journal `methodVersion`,
  and journal count mirrors for `missingSlots`, `invalidPresentedSlots`, `validVotes`,
  and `excludedSlots`
- verifies Merkle inclusion and STARK bundle data

Common commands:

```bash
pnpm test:cli -- --user-choice A
pnpm test:cli:mock
pnpm test:cli:real-dev
pnpm test:cli:real-prod:s0
pnpm test:cli:real-prod:all -- --user-choice B --skip-build
```

The harness runs `pnpm build:local-mock`, then spawns `scripts/dev/static-hono-server.ts` directly unless
`STARK_BALLOT_CLI_BASE_URL` is already set. `pnpm start` is the equivalent manual wrapper. Pass
`--skip-build` only when a fresh enough Vite `dist/` output already exists.

Install dependencies with `pnpm install --frozen-lockfile` for reproducible setup or `pnpm install` for
local development. Real zkVM modes also require the Rust host and verifier-service binaries:

```bash
pnpm build:zkvm
pnpm build:verifier-service
```

When the harness starts its own production Vite static frontend plus Hono API server, it fills a
test-only local `SESSION_CAPABILITY_SECRET` from `scripts/tests/.env.test.defaults` if neither the shell
nor `.env.local` already provides one. When reusing a long-lived server, set
`STARK_BALLOT_CLI_BASE_URL` explicitly before running the harness.

### Full production-proof matrix

`run-all-real-tests.sh` wraps the production CLI harness for a long-running batch:

- five CLI invocations, one for each user choice `A` through `E`
- the full `S0` through `S5` scenario set in every invocation
- 30 choice/scenario combinations in total
- logs under `LOG_DIR` (default: `.tmp/test-logs/<date>/`)
- a 60-second pause between invocations

The wrapper passes `--skip-build`, so create a current `pnpm build:local-mock` output and build the real
host and verifier service before starting it.

```bash
./scripts/tests/run-all-real-tests.sh
```

This generates real STARK proofs and is expected to take roughly 3.5 hours.

### Long-lived development server helpers

`setup-cli-test.sh` starts `pnpm dev` inside a tmux session named `vite`:

```bash
bash scripts/tests/setup-cli-test.sh --mock
bash scripts/tests/setup-cli-test.sh --image-id 0x...
```

The file is not executable in the current repository, so invoke it with `bash`. It requires `tmux` and
`nc`. Use it when you want a long-lived local server and plan to run the CLI with
`STARK_BALLOT_CLI_BASE_URL=http://127.0.0.1:3000`.

`pnpm dev` reads local defaults from `.env.local`. With the checked-in `.env.local.example` defaults,
this helper starts a mock local UI. For genuine real-zkVM runs, use the CLI-managed
`test:cli:real-*` scripts or point the CLI at a separately configured server.

`teardown-cli-test.sh` stops the `vite` tmux session and removes `.zkvm-temp/` plus generated
`*-output.json` and `*-receipt.json` files:

```bash
./scripts/tests/teardown-cli-test.sh
```

## Live Develop Acceptance

`scripts/tests/develop-gated-smoke.ts` is the operator-gated develop acceptance runner. It must use the
gated CloudFront hostname and probe the direct API origin for fail-closed rejection. Its positive owner
flow uses the CLI real-zkVM production verifier-service path, so deployed develop must produce and
verify production-mode STARK evidence. Develop differs from production only by access gating,
Cloudflare bypass posture, and artifact-retention policy.

The default acceptance matrix is `S0,S1,S2`: normal, one exclusion class, and one claimed-tally class.
Set `STARK_BALLOT_GATED_SMOKE_SCENARIOS=S0,S1,S2,S3,S4,S5` to exercise the full scenario set. A
configured matrix fails closed unless it includes `S0`, at least one of `S1`/`S3`/`S5`, and at least one
of `S2`/`S4`.

For every scenario, the runner:

- resolves the independent expected ImageID from the current `default` entry in
  `public/imageId-mapping.json` and compares the API ImageID projections with it
- explicitly starts
  `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification` with the strict empty
  body, requires newly queued durable AWS verification work, and polls
  `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification` to success
- requires every server-projected cast-as-intended check to remain `not_run`; it evaluates those checks
  locally from the retained vote opening and fresh receipt fields, merges the local results with the
  grouped `verification.checks`, and only then derives the overall verdict through the shared
  presentation policy
- checks wrong-capability rejection on the authenticated bundle and report endpoints
- downloads the public bundle, rejects `input.json`, `verification.json`, `included-bitmap.json`, and
  `seen-bitmap.json`, and validates the bundled `receipt.json` when present before using it for
  client-side receipt verification
- validates the protected report, including its execution-bound response metadata, status, expected and
  receipt ImageIDs, production-mode marker, and empty error result
- requires STARK receipt verification to succeed for every educational scenario, while the merged
  overall verdict must be `fully_verified` only for S0 and fail closed for every configured tamper
  scenario

Obtain short-lived signed-cookie values through the approved KMS-backed
procedure in the private operator documentation.

KMS private key material is never exported or read from a secret store, repository file, or Terraform
state. Supply all four issued cookie values only through a protected local environment and do not write
them to logs or tracked files.

```bash
STARK_BALLOT_DEVELOP_BASE_URL=https://develop.stark-ballot-sim.hwatanabe.dev \
STARK_BALLOT_DIRECT_API_ORIGIN=https://<api-id>.execute-api.<region>.amazonaws.com \
STARK_BALLOT_OPERATOR_AUTH_HEADER=Cookie \
STARK_BALLOT_OPERATOR_AUTH_VALUE='CloudFront-Policy=<policy>; CloudFront-Signature=<signature>; CloudFront-Key-Pair-Id=<key-pair-id>; CloudFront-Hash-Algorithm=SHA256' \
pnpm test:develop:gated-smoke
```

The operator-gated command does not require `STARK_BALLOT_SESSION_TURNSTILE_TOKEN`,
`STARK_BALLOT_VOTE_TURNSTILE_TOKEN`, or `STARK_BALLOT_FINALIZE_TURNSTILE_TOKEN`. In target develop, the
API skips server-side session, vote, and finalize Turnstile checks only after the outer CloudFront
operator gate and origin verification admit the request. The local-profile Turnstile bypass is not
projected into target static artifacts.

Do not put private key material, raw origin-header secrets, unsigned policy payloads, or full
signed-cookie values in tracked docs, logs, public handoff summaries, or release artifacts. Live
acceptance requires `STARK_BALLOT_DIRECT_API_ORIGIN`; only local non-acceptance runs may set
`STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE=1`.

Local contract coverage does not contact AWS:

```bash
pnpm exec vitest run scripts/__tests__/develop-gated-smoke.test.ts --reporter=dot
```

## Release And Container Contracts

### Prover candidate posture

The prover release buildspec runs `scripts/tests/fargate-prover-container-smoke.sh <image-uri>`
immediately after building the candidate and before ImageID extraction or publication. The smoke starts
the actual image with a read-only root filesystem, all capabilities dropped, an init process, and no
network. It checks UID/GID `10001:10001`, `/opt/risc0` assets including an executable `r0vm --version`,
and the exact writable `/tmp` and `/var/task/output` mounts, then probes entrypoint startup with the
tracked input fixture.

It next mounts a dedicated writable host temporary directory at `/var/task/output`, runs the same
candidate and fixture with `HOST_BIN=/bin/false`, requires a nonzero exit, and validates on the host that
`failure-marker.json` is exactly the unversioned `{"category":"prover_execution"}` object with no
additional fields.

The successful startup probe uses `HOST_BIN=/bin/true`; the failure-marker probe deliberately uses
`/bin/false`. Neither probe proves a real receipt, ImageID correctness, scan/signing status, promotion,
deployed task posture, or live S0 behavior; those remain release/app evidence.

Because the successful stub host deliberately produces no proof artifacts, the entrypoint emits its exact
`No output artifacts detected` warning. The smoke captures and requires that one expected signal, rejects
any additional warning, and republishes only the remaining informational output so candidate build logs stay
warning-free without weakening the entrypoint's runtime diagnostic. The deliberate failure-marker probe
similarly captures and requires its exact prover-execution error plus structured error summary, rejects any
additional warning or error, and emits only a clean harness confirmation after the marker is admitted.

This smoke requires `python3`, Docker, and a built candidate image for the target architecture. Its local
contract test uses a fake Docker executable and does not build or run a real image:

```bash
pnpm exec vitest run scripts/__tests__/fargate-prover-container-smoke.test.ts --reporter=dot
```

### Prover entrypoint contract

`entrypoint-bundle.test.sh` exercises the public bundle/archive contract, bounded host wrapper, and
shutdown behavior exposed by `infra/docker/entrypoint.sh`:

```bash
pnpm test:entrypoint-bundle
```

It verifies that `bundle.zip` contains public artifacts such as:

- `receipt.json`
- `journal.json`
- `public-input.json`
- `election-manifest.json`
- `close-statement.json`

It rejects private `input.json`, `verification.json`, `included-bitmap.json`, and `seen-bitmap.json` from
the public archive while requiring the protected verification report and exact bitmap artifacts to
remain alongside the uploaded outputs.

The harness also exercises TERM/INT forwarding, exact 143/130 interruption exits, the
`infrastructure_interruption` failure marker and summary, bounded kill-after behavior for an
uncooperative host, durable-publication handling, and the rule that an immediate host exit 137 remains a
`prover_execution` failure.

The package script wraps `bash scripts/tests/entrypoint-bundle.test.sh`, so local runs and CI use the same
entrypoint. It requires `python3`, `timeout`, and `unzip`.

## Fixture, Vector, And Proof Diagnostics

### Host fixture smoke

`test-zkvm.sh` is a low-level host diagnostic, not the main application E2E path. It forces
`RISC0_DEV_MODE=1` and runs `zkvm/target/release/host` against:

- `zkvm/test-data/test-fixture-valid.json`
- `zkvm/test-data/test-fixture-tampered.json`

```bash
./scripts/tests/test-zkvm.sh
```

If the host binary is missing, the script builds it before running the fixtures. It requires `jq`, a
working Rust toolchain, and fixtures compatible with the current host contract.

### Host input fixture generator

`generate-zkvm-fixtures.ts` regenerates the checked-in inputs used by `test-zkvm.sh`:

```bash
pnpm tsx scripts/tests/generate-zkvm-fixtures.ts
```

Outputs:

- `zkvm/test-data/test-fixture-valid.json`
- `zkvm/test-data/test-fixture-tampered.json`

### RFC 6962 golden-vector generator

`generate-rfc6962-golden-vectors.ts` regenerates the checked-in TypeScript-to-Rust inclusion-proof
fixture:

```bash
pnpm tsx scripts/tests/generate-rfc6962-golden-vectors.ts
```

It writes `zkvm/contract-core/testdata/rfc6962-ts-golden-vectors.json`.
`scripts/tests/rfc6962-golden-vectors.ts` builds the deterministic cases, Vitest covers them, and Rust
tests in `zkvm/contract-core/src/inclusion_proof.rs` consume the fixture for cross-language RFC 6962
compatibility.

### Receipt tamper generator

`tamper-stark-proof.ts` creates a tampered copy of a valid `Composite` receipt:

```bash
pnpm tsx scripts/tests/tamper-stark-proof.ts
pnpm tsx scripts/tests/tamper-stark-proof.ts SINGLE_VALUE_CHANGE
```

Supported modes are `SINGLE_BIT_FLIP`, `SINGLE_VALUE_CHANGE`, `MULTIPLE_VALUES`, and `ZERO_OUT_RANGE`.
The script reads `zkvm/test-data/test-fixture-valid-receipt.json` and writes
`zkvm/test-data/test-fixture-tampered-stark-receipt.json`. Generate a real receipt first with
`pnpm test:stark-tamper`.

## Benchmarks

### TypeScript performance benchmark

`performance-benchmark.ts` is an opt-in local runner for rough throughput comparisons:

```bash
pnpm test:bench
pnpm test:bench -- --iterations 50
```

It prints timing summaries without enforcing thresholds and is intentionally excluded from
`pnpm test:run` because VM and CI timing noise makes fixed thresholds flaky. Use it for local regression
checks or before/after comparisons when optimizing hot paths.

### Full-guest production benchmark

`zkvm-full-guest-benchmark.ts` is an opt-in production-mode benchmark for the Rust host:

```bash
pnpm tsx scripts/tests/zkvm-full-guest-benchmark.ts
pnpm tsx scripts/tests/zkvm-full-guest-benchmark.ts -- --iterations 3 --slots 64 --output .tmp/zkvm-full-guest-benchmark.json
```

Build the host with `pnpm build:zkvm` first. The benchmark runs with `RISC0_DEV_MODE` unset and writes a
structured JSON report. Use `--keep-artifacts` only when you need to inspect the generated input, output,
receipt, and bitmap artifacts.

## Regression Coverage

### Focused `scripts/tests` coverage

The focused tests under `scripts/tests/__tests__/` are:

- `batch-processor.test.ts`
- `cli-regression.test.ts`
- `cli-merkle-enforcement.test.ts`
- `read-image-id.test.ts`
- `rfc6962-golden-vectors.test.ts`
- `zkvm-fixtures.test.ts`
- `zkvm-full-guest-benchmark.test.ts`

Run them directly or with the full one-shot Vitest suite:

```bash
pnpm vitest run scripts/tests/__tests__
pnpm test:run
```

### Node STH public-runtime smoke

`sth-public-runtime-node-smoke.ts` checks that Node-side runtime configuration resolves public STH
sources and the minimum-match threshold under `tsx` without relying on Vite `import.meta.env`:

```bash
pnpm tsx scripts/tests/sth-public-runtime-node-smoke.ts
```

Its top-level Vitest wrapper is included in `pnpm test:run` and can be run independently:

```bash
pnpm exec vitest run scripts/__tests__/sth-public-runtime-node-smoke.test.ts --reporter=dot
```
