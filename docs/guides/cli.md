# STARK Ballot Simulator CLI Test Guide

## Purpose

The CLI harness (`scripts/tests/cli-e2e-voting-flow.ts`) exercises the full voting pipeline without
launching a browser: session creation, user and bot votes, tamper scenarios, finalization, zkVM
execution, bundle download, and receipt verification. Use it as the fastest local sanity check for
end-to-end behavior.

This guide is the current operating guide. Dated local run notes and transient
failure evidence are intentionally kept outside the public guide.

## Source of Truth

When this guide and implementation disagree, current code wins. Check these files first:

- `package.json` for wired commands.
- `scripts/tests/cli-e2e-voting-flow.ts` for CLI flags, server startup, ImageID resolution, bundle
  selection, and report persistence.
- `packages/test-support/src/testing/cli-voting-flow-helpers.ts` and `packages/test-support/src/testing/*` for CLI assertions and helper
  behavior.
- `apps/api/src/server/api/handlers/verificationBundles.ts` for authenticated bundle/report delivery.
- repository CI configuration for the current automated CLI smoke coverage.
- `public/imageId-mapping.json` for the current method version and expected ImageID values.

## Recommended Commands

```bash
# Optional when reusing an external server or overriding local defaults.
# The CLI-owned server path loads `.env.local` first, then `scripts/tests/.env.test.defaults`.
export SESSION_CAPABILITY_SECRET='prod-session-capability-secret-0123456789abcdef'

# Direct harness entrypoint. Requires --user-choice; defaults to S0 + S1.
pnpm test:cli -- --user-choice A

# CI/local mock smoke: mock zkVM S0 with choice A.
pnpm test:cli:mock -- --skip-build

# Full mock matrix via the direct harness.
USE_MOCK_STORE=true USE_MOCK_ZKVM=true RISC0_DEV_MODE=1 pnpm test:cli -- --user-choice B --all-scenarios --skip-build

# Real zkVM dev receipts, S0 only.
pnpm test:cli:real-dev -- --skip-build

# Real zkVM production STARK, S0 only.
pnpm test:cli:real-prod:s0 -- --skip-build

# Real zkVM production STARK, S0-S5. Override choice by passing a later --user-choice.
pnpm test:cli:real-prod:all -- --user-choice B --skip-build
```

Notes:

- `--skip-build` requires an existing `pnpm build:ci` output. Omit it to let the CLI run `pnpm build:ci`.
- Real zkVM runs require built Rust binaries (`pnpm run build:zkvm` and
  `pnpm run build:verifier-service`, or `pnpm build`).
- The `test:cli:*` package scripts append their own flags. Repeated flags use the last value parsed by
  the harness, so `-- --user-choice B` can override the script default.
- `pnpm test:cli:mock` hardcodes `--scenario S0`; use the direct harness for a mock
  `--all-scenarios` matrix.

## Options

Derived from `scripts/tests/cli-e2e-voting-flow.ts`.

| Flag                  | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `--user-choice`, `-u` | **Required.** User's ballot (`A`-`E`).                       |
| `--real-zkvm`         | Run against the Rust zkVM host instead of the mock executor. |
| `--zkvm-mode`         | When `--real-zkvm` is set, choose `dev` (default) or `prod`. |
| `--scenario`, `-s`    | Run a single tamper scenario (`S0`...`S5`).                  |
| `--all-scenarios`     | Iterate S0-S5 sequentially.                                  |
| `--output`, `-o`      | Report format (`table`, `json`, `markdown`). Default: table. |
| `--verbose`, `-v`     | Emit detailed step-by-step logs.                             |
| `--skip-build`        | Reuse an existing Vite dist output.                          |
| `--help`, `-h`        | Print usage information.                                     |

Pass CLI flags after the pnpm separator, for example:

```bash
pnpm test:cli -- --user-choice A --skip-build
```

`--skip-build` can also be enabled with `STARK_BALLOT_CLI_SKIP_BUILD=true` or
`CLI_SKIP_BUILD=true`.

## Modes

### Mock

Mock mode uses the JavaScript/mock zkVM path and sets `RISC0_DEV_MODE=1`. It is suitable for fast
flow checks and CI smoke coverage. It does not prove production STARK correctness.

```bash
pnpm test:cli:mock
```

### Real zkVM Dev

Real dev mode runs the Rust zkVM host with `RISC0_DEV_MODE=1`. This checks the TypeScript/Rust
contract with fake receipts. Treat it as a compatibility smoke test, not a real proof.

```bash
pnpm test:cli:real-dev
```

### Real zkVM Prod

Production mode runs the Rust zkVM host without `RISC0_DEV_MODE`. It generates genuine STARK
receipts and can take several minutes.

```bash
pnpm test:cli:real-prod:s0
```

## Environment Resolution

- The CLI imports `.env.local`, then `scripts/tests/.env.test.defaults`.
- If the CLI launches its own local server, it sets `USE_MOCK_STORE=true` unless already configured.
- If `--real-zkvm` is not set, it uses mock zkVM and `RISC0_DEV_MODE=1`.
- If `--real-zkvm --zkvm-mode dev` is set, it uses `USE_MOCK_ZKVM=false` and `RISC0_DEV_MODE=1`.
- If `--real-zkvm --zkvm-mode prod` is set, it uses `USE_MOCK_ZKVM=false` and unsets
  `RISC0_DEV_MODE`.
- Mock or dev-mode zkVM under the CLI-owned local server requires `ALLOW_INSECURE_ZKVM=true`; the harness sets it
  automatically unless you explicitly override it.
- Turnstile bypass is enabled for the CLI-managed server with a non-production runtime marker.
- `EXPECTED_IMAGE_ID` can be set directly, or derived from `public/imageId-mapping.json` with
  `EXPECTED_IMAGE_ID_VARIANT`. Current methodVersion `14` contains target-account `default` / ARM64
  and local `x86_64` trust material. The package CLI scripts explicitly set `x86_64` for local
  real-zkVM checks; target app handoff helpers use the current `default` mapping as compatibility
  evidence. The selected prover release/app deployment record remains the deploy-time authority for
  the digest-pinned prover image plus expected ImageID.
- Real-mode HTTP waits are long by default. Override with `CLI_HEADERS_TIMEOUT_MS`,
  `CLI_BODY_TIMEOUT_MS`, and `CLI_FINALIZE_TIMEOUT_MS` when debugging infrastructure timeouts.
- `VERIFIER_SERVICE_BIN` can pin a verifier binary outside the default
  `verifier-service/target/{release,debug}/verifier-service` path.

Session creation requires a valid 32+ character `SESSION_CAPABILITY_SECRET` after the env files are
loaded, or in the external server environment when `STARK_BALLOT_CLI_BASE_URL` is set.

After session creation, the harness stores the returned `capabilityToken` and sends both
`X-Session-ID` and `X-Session-Capability` for session-scoped calls, including vote submission,
progress polling, finalization, verification fetches, bulletin proofs, and bundle/report downloads.

## Server Startup

The harness starts a production Vite static frontend plus Hono API server unless
`STARK_BALLOT_CLI_BASE_URL` is set. The CLI-owned path spawns
`scripts/dev/static-hono-server.ts` directly; `pnpm start` points at the same entrypoint for manual
use. When the harness owns the server, each run builds first unless `--skip-build` or the skip-build
env flag is present.

When the CLI launches its owned server path, it forces `USE_S3=false` and sets
`VERIFIER_PUBLIC_BASE_URL` to the local server. To exercise S3 bundle downloads, start the app
separately, configure `USE_S3=true`, and point the CLI at it:

```bash
export STARK_BALLOT_CLI_BASE_URL="http://127.0.0.1:3000"
pnpm test:cli -- --user-choice A --skip-build
```

For longer mock/dev-server sessions, `scripts/tests/setup-cli-test.sh` starts `pnpm dev` in tmux:

```bash
bash scripts/tests/setup-cli-test.sh
./scripts/tests/teardown-cli-test.sh
```

That helper is a dev-server convenience. `pnpm dev` reads local defaults from
`.env.local`; with the checked-in `.env.local.example` defaults it is a mock
local UI. Use the CLI-managed `test:cli:real-*` scripts or a separately
configured server for genuine real-zkVM runs.

## Bundle and Report Downloads

After finalization, the CLI derives authenticated local bundle/report URLs from the finalized
response's top-level `verificationExecutionId`. Missing or unsafe selectors are treated as contract
failures; the CLI does not fall back to nested verification result IDs.

The CLI downloads:

- Bundle zip:
  `/api/verification/bundles/:sessionId/:executionId`
- Verification report:
  `/api/verification/bundles/:sessionId/:executionId/report`

The CLI sends both `X-Session-ID` and `X-Session-Capability`. The server authorizes these endpoints
with the path `:sessionId` and session capability.

Downloaded files are written under `.tmp/cli-bundles/<sessionId>/`:

- `bundle-authenticated-endpoint-<epoch-ms>-<uuid>.zip`
- `verification-report-authenticated-endpoint-<epoch-ms>-<uuid>.json`

The CLI computes SHA-256 digests for downloaded artifacts and surfaces them as `verificationHash` and
`verificationReportHash` in the console output and persisted report.

Public bundle archives contain public audit artifacts only:

- `public-input.json`
- `election-manifest.json`
- `close-statement.json`
- `receipt.json`
- `journal.json`
- sync bundles also include `metadata.json`
- optional public bulletin/STH artifacts such as `sth.json` and `consistency-proof.json`

Private artifacts stay out of the public `bundle.zip`: `input.json`, `verification.json`,
`included-bitmap.json`, and `seen-bitmap.json`. `verification.json` is available through the
authenticated report endpoint or can be regenerated with:

```bash
verifier-service verify --bundle <zip> --image-id <expected>
```

## Verification Coverage

The CLI does not assert the full UI verification matrix. It treats this current CLI subset as a
hard-failure boundary on every finalized result:

- Required step IDs: `counted_as_recorded`, `stark_verification`.
- Required check IDs: `counted_expected_vs_tree_size`, `counted_election_manifest_consistent`,
  `counted_close_statement_consistent`, `stark_receipt_verify`.
- The run fails if any required step or check is missing.
- The run fails if any required check is not `success`.
- The run fails if a green step disagrees with one of those required checks.
- The run fails if `journal.methodVersion` diverges from the current contract.
- The run fails if present public/debug count mirrors for `missingSlots`, `invalidPresentedSlots`,
  `validVotes`, or `excludedSlots` disagree with `journal.*`.

CT inclusion proof behavior:

- `/api/finalize` returns CT inclusion data under `userVote.proof.merklePath` and
  `userVote.proof.treeSize` when available.
- The CLI falls back to `/api/bulletin/:voteId/proof` if it still needs finalized proof data.
- `detectTampering` treats the CT inclusion proof as authoritative when `treeSize` is set; CT
  verification errors are treated as "not included".

Verifier-service behavior:

- The CLI shells out to `verifier-service verify` only for real zkVM runs when a bundle is available.
- Dev-mode receipts (`status === 'dev_mode'`) are accepted when running `--zkvm-mode dev`.
- In CLI-managed `--zkvm-mode prod`, the harness unsets `RISC0_DEV_MODE`; any server-side
  `dev_mode` result should be investigated as configuration drift and must not be counted as
  production-proof evidence. When targeting an external server, confirm that server's zkVM
  environment separately.

## CI Usage

- The private source CI runs the mock CLI flow as part of its centralized core
  checks.
- Generated public snapshots provide `.github/workflows/public-cli-tests.yml`
  for `pnpm test:cli:mock` and `.github/workflows/public-core-checks.yml` for
  the format, lint, type, public Vitest, and static-build gates.

## Troubleshooting

- Session creation fails before voting: confirm the server environment has a non-placeholder
  32+ character `SESSION_CAPABILITY_SECRET`.
- `/api/finalize` returns `Invalid ImageID`: capture the expected/actual values and compare them
  against `public/imageId-mapping.json` and the current local host output.
- Bundle or report download returns `401`: confirm the request path uses the intended `:sessionId`
  and carries a valid `X-Session-Capability`.
- Bundle download fails: confirm the finalized payload has a safe top-level
  `verificationExecutionId`.
- The CLI interpretation looks wrong: fetch `verification.json` through the report endpoint or rerun
  `verifier-service verify --bundle <zip> --image-id <expected>`.
- Finalization diagnostics are unclear: run
  `pnpm test:run packages/application/src/finalize/usecases/finalize-session.test.ts packages/application/src/finalize/usecases/finalize-sync.test.ts apps/api/src/server/api/routes/hono.test.ts`.
  Vitest 4.1 does not support `--runInBand`.

## Maintenance Policy

- Keep this file focused on current behavior, current commands, and current contracts.
- Keep dated run notes, transient artifacts, and past failure history outside
  this public operating guide.
- Mark unverified commands explicitly and cite the implementation that must be checked.
- Prefer source-code references over prose when behavior is uncertain.
- Re-audit this guide after guest-image changes, ImageID mapping updates, bundle-auth refactors, CLI
  server bootstrap changes, or CLI verification-contract changes.
