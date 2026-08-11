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
# Direct harness entrypoint. Requires --user-choice; defaults to S0 + S1.
pnpm test:cli -- --user-choice A

# CI/local mock smoke: static-mock-e2e profile, S0 with choice A.
pnpm test:cli:mock

# Full mock matrix via the direct harness.
pnpm test:cli -- --user-choice B --all-scenarios

# Real zkVM dev receipts, S0 only.
pnpm test:cli:real-dev

# Real zkVM production STARK, S0 only.
pnpm test:cli:real-prod:s0

# Real zkVM production STARK, S0-S5. Override choice by passing a later --user-choice.
pnpm test:cli:real-prod:all -- --user-choice B
```

Notes:

- `--skip-build` reuses the existing `dist/`; it must already have been built
  with the same local runtime profile as the requested CLI run. Omit the flag
  to let the harness run `pnpm build:local-mock` with its selected profile.
- Before a real development-evidence run, build
  `pnpm build:zkvm:dev-mode` and
  `pnpm build:verifier-service:dev-mode`.
- Before a production-proof run, build `pnpm build:zkvm` and
  `pnpm build:verifier-service`.
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

Mock mode selects `static-mock-e2e`: file-backed session records, synchronous
finalization, local artifacts, and the JavaScript mock executor. It is
suitable for fast flow checks and CI smoke coverage. The generated mock
receipt is not a STARK proof.

```bash
pnpm test:cli:mock
```

### Real zkVM Dev

Real dev mode selects `local-proof-development` and runs the Rust host in
development-evidence mode. This checks the current TypeScript/Rust contract
with fake receipts. Treat it as a cross-implementation smoke test, not a real
proof.

```bash
pnpm test:cli:real-dev
```

### Real zkVM Prod

Production mode selects `local-proof-production`. The adapter runs the
production-feature Rust host and verifier and generates genuine STARK
receipts; the run can take several minutes.

```bash
pnpm test:cli:real-prod:s0
```

## Environment Resolution

- Environment precedence is the existing shell, then `.env.local`, then
  `scripts/tests/.env.test.defaults`; each file fills only values that are
  still unset.
- The harness clears replaced runtime selectors and target-only runtime inputs,
  then sets both `RUNTIME_PROFILE` and `VITE_RUNTIME_PROFILE` to one semantic
  local profile:

  | CLI selection                  | Runtime profile           | Proof evidence           |
  | ------------------------------ | ------------------------- | ------------------------ |
  | no `--real-zkvm`               | `static-mock-e2e`         | mock; no STARK proof     |
  | `--real-zkvm --zkvm-mode dev`  | `local-proof-development` | fake development receipt |
  | `--real-zkvm --zkvm-mode prod` | `local-proof-production`  | production STARK receipt |

- The resolved profile—not a matrix of store/proof/artifact flags—selects the
  file or memory store, executor, synchronous finalization, local artifact
  reader, in-process/child-process adapter, rate-limit store, and local
  Turnstile posture.
- `EXPECTED_IMAGE_ID` can be set directly, or derived from `public/imageId-mapping.json` with
  `EXPECTED_IMAGE_ID_VARIANT`. Current methodVersion `14` contains target-account `default` / ARM64
  and local `x86_64` trust material. The package CLI scripts explicitly set `x86_64` for local
  real-zkVM checks; target app handoff helpers use the current `default`
  mapping and its accepted-release provenance. The selected prover
  release/app deployment record remains the deploy-time authority for
  the digest-pinned prover image plus expected ImageID.
- Real-mode HTTP waits are long by default. Override with `CLI_HEADERS_TIMEOUT_MS`,
  `CLI_BODY_TIMEOUT_MS`, and `CLI_FINALIZE_TIMEOUT_MS` when debugging infrastructure timeouts.
- `VERIFIER_SERVICE_BIN` can pin a verifier binary outside the default
  `verifier-service/target/{release,debug}/verifier-service` path.

## CLI Request and Authentication Flow

The harness follows one path-authoritative session and finalization flow:

1. `POST /api/sessions` returns `sessionId`, `capabilityToken`, `electionId`,
   `electionConfigHash`, and `logId`. The harness retains the session ID,
   capability, and election ID needed by later requests.
2. Vote submission and progress polling use
   `/api/sessions/:sessionId/votes` and
   `/api/sessions/:sessionId/progress`. The session ID comes from the path;
   authenticated session requests carry `X-Session-Capability` and do not send
   the retired `X-Session-ID` header.
3. The harness creates a finalization with
   `POST /api/sessions/:sessionId/finalizations`. If the returned
   `FinalizationResource` is not terminal, it polls
   `GET /api/sessions/:sessionId/finalizations/current` and requires the same
   `finalizationId` throughout.
4. After success, it reads
   `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification?include=journal`.
   It requires an available grouped resource, the requested journal, and the
   same finalization identity. This harness does not start verification or
   submit verification observations.
5. It uses that same `sessionId` and `finalizationId` for authenticated bundle
   and report downloads. If finalized voter evidence lacks a usable CT path,
   it may fetch
   `GET /api/sessions/:sessionId/votes/:voteId/inclusion-proof`.

The session path and capability remain the session authority. For an external
server behind an additional operator gate, set
`STARK_BALLOT_OPERATOR_AUTH_HEADER` and
`STARK_BALLOT_OPERATOR_AUTH_VALUE` together. The helper adds that outer-gate
header to session creation and later requests without replacing
`X-Session-Capability`.

Public non-artifact JSON responses use `{ data, meta: { requestId } }` for
success and `{ error: { code, message, details? }, meta: { requestId } }` for
errors. The CLI reads the nested error code and does not expect an HTTP
`statusCode` field in JSON.

## Server Startup

The harness starts a production Vite static frontend plus Hono API server unless
`STARK_BALLOT_CLI_BASE_URL` is set. The CLI-owned path spawns
`scripts/dev/static-hono-server.ts` directly; `pnpm start` points at the same entrypoint for manual
use. When the harness owns the server, each run builds first unless `--skip-build` or the skip-build
env flag is present.

The owned server uses profile-selected local storage, a fresh per-run file
store when applicable, and a test-only `SESSION_CAPABILITY_SECRET` supplied by
`scripts/tests/.env.test.defaults` when no shell or `.env.local` value exists.
The harness sets `VERIFIER_PUBLIC_BASE_URL` to the owned server and removes the
temporary file store during teardown.

### External server runs

Setting `STARK_BALLOT_CLI_BASE_URL` skips local build and server startup. The
selected CLI mode then governs only local proof interpretation; it does not
reconfigure or attest the external server. That server owns capability-secret
resolution and must independently prove its runtime profile, proof evidence,
artifact storage, and expected ImageID. Set `EXPECTED_IMAGE_ID` to the
deployment-authorized value when it differs from the package scripts' local
`x86_64` mapping, and configure the optional operator-gate header pair above
when the endpoint requires it.

To exercise S3-backed bundle delivery, start an independently authorized
`target-aws-async` server and point the CLI at it:

```bash
export STARK_BALLOT_CLI_BASE_URL="https://<authorized-target-host>"
export EXPECTED_IMAGE_ID="<deployment-authorized-image-id>"
pnpm test:cli -- --user-choice A --real-zkvm --zkvm-mode prod --scenario S0
```

For longer mock/dev-server sessions, `scripts/tests/setup-cli-test.sh` starts `pnpm dev` in tmux:

```bash
bash scripts/tests/setup-cli-test.sh
./scripts/tests/teardown-cli-test.sh
```

Set `STARK_BALLOT_CLI_BASE_URL=http://127.0.0.1:3000` before pointing the
direct harness at that long-lived server. The helper is a dev-server
convenience: `pnpm dev` reads local defaults from `.env.local`, and the
checked-in `.env.local.example` starts a mock local UI. Use the CLI-managed
`test:cli:real-*` scripts or a separately configured server for genuine
real-zkVM runs.

## Bundle and Report Downloads

After finalization, the CLI derives authenticated local bundle/report URLs from the finalized
response's top-level `finalizationId`. Missing or unsafe selectors are treated as contract
failures; the CLI does not fall back to nested verification result IDs.

The CLI downloads:

- Bundle zip:
  `/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`
- Verification report JSON:
  `/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`

The server authorizes both endpoints from the path `:sessionId`, exact
`:finalizationId`, and matching session capability. Requests may also carry
the separately configured outer operator-gate header described above.

Bundle transfer is bounded and fail-closed. The CLI first requests at most a
4 MiB byte range. For a ranged response, it requires a valid `Content-Range`
starting at byte zero, an exact body length, and a representation identity
from `ETag`, `X-Amz-Version-Id`, or both. It clamps the server-advertised chunk
size to 4 MiB, requires each later response to match the exact requested
interval and original total length, and rejects any representation-identity
change between chunks. A ranged or full bundle larger than 256 MiB is
rejected. Reports are read as a single bounded response, reject declared or
received bodies over 4 MiB, and must contain valid JSON.

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
- sync bundles may also include optional `sth.json` and
  `consistency-proof.json`

Private artifacts stay out of the public `bundle.zip`: `input.json`, `verification.json`,
`included-bitmap.json`, and `seen-bitmap.json`. `verification.json` is available through the
authenticated report endpoint or can be regenerated with:

```bash
verifier-service verify --bundle <zip> --image-id <expected>
```

## Verification Coverage

The CLI does not assert the full UI verification matrix. It enforces this current CLI subset:

- Required step IDs: `counted_as_recorded`, `stark_verification`.
- Required check IDs are derived from the canonical check registry for those
  two steps with third-party STH sources unconfigured:
  - `counted_input_sanity`
  - `counted_unique_indices`
  - `counted_unique_commitments`
  - `counted_tally_consistent`
  - `counted_missing_indices_zero`
  - `counted_expected_vs_tree_size`
  - `counted_election_manifest_consistent`
  - `counted_close_statement_consistent`
  - `counted_my_vote_included`
  - `counted_input_commitment_match`
  - `stark_image_id_match`
  - `stark_receipt_verify`
- The run fails if any required step or check is missing.
- S0 and other non-tamper cases fail if any required check is not `success`.
- Expected-tamper cases S1-S5 may have required checks with non-success statuses.
- Every case fails if a successful stage disagrees with one of its required checks.
- The run fails if `journal.methodVersion` diverges from the current contract.
- The run fails if present public/debug count mirrors for `missingSlots`, `invalidPresentedSlots`,
  `validVotes`, or `excludedSlots` disagree with `journal.*`.

The harness consumes the server-projected verification checks and derives
stage presentation through the shared policy. It does not overlay the
browser's local Cast-as-Intended checks, so `cast_as_intended` remains
`not_run` in this CLI flow and the harness does not claim the UI's fully
verified verdict.

CT inclusion proof behavior:

- A succeeded finalization resource returns CT inclusion data under
  `result.voterEvidence.userVote.proof.merklePath` and `.treeSize` when voter evidence is available.
- The CLI falls back to
  `/api/sessions/:sessionId/votes/:voteId/inclusion-proof` if it still needs finalized proof data.
- `detectTampering` treats the CT inclusion proof as authoritative when `treeSize` is set; CT
  verification errors are treated as "not included".

Verifier-service behavior:

- The CLI shells out to `verifier-service verify` only for real zkVM runs when a bundle is available.
- Dev-mode receipts (`status === 'dev_mode'`) are accepted when running `--zkvm-mode dev`.
- With the CLI-managed `local-proof-production` profile, any server-side
  `dev_mode` result indicates configuration drift and must not be counted as
  production-proof evidence.

## CI Usage

- The private source CI runs the mock CLI flow as part of its centralized core
  checks.
- Generated public snapshots provide `.github/workflows/public-cli-tests.yml`
  for `pnpm test:cli:mock` and `.github/workflows/public-core-checks.yml` for
  the format, lint, type, public Vitest, and static-build gates.

## Troubleshooting

- Session creation fails before voting: confirm the server environment has a non-placeholder
  32+ character `SESSION_CAPABILITY_SECRET`.
- `/api/sessions/:sessionId/finalizations` returns `Invalid ImageID`: capture the expected/actual values and compare them
  against `public/imageId-mapping.json` and the current local host output.
- Bundle or report download returns `401`: confirm the request path uses the intended `:sessionId`
  and carries a valid `X-Session-Capability`; if applicable, also confirm the
  configured operator-gate header pair.
- Bundle download fails: confirm the finalized payload has a safe top-level
  `finalizationId`, then inspect range, response-size, and representation
  identity headers.
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
