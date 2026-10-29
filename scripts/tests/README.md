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
| Script regression coverage        | Local Vitest                                           | Low                                     | `pnpm vitest run scripts/tests`                               |

Use the lightest row that proves the change. Development-mode receipts are not production STARK proofs,
and the live develop acceptance and production-proof rows are intentionally outside the default local or
CI gate.

## Retained test value

- TDD is a design workflow, not a reason to retain every test written during Red/Green. During Refactor, remove or consolidate scaffolding tests unless they continue to protect an enduring requirement.
- A retained test must provide durable regression signal for a named product, domain, cryptographic, security, privacy, validation, fail-closed, public-contract, accessibility, persistence, integration, or operational invariant.
- Tests that merely mirror implementation details, restate compiler or framework behavior, duplicate stronger coverage, freeze incidental styling, or exist only to increase coverage count have negative value and should be removed.
- Large test deletions are acceptable when the remaining invariant coverage is explicitly reviewed and the applicable gates pass.

## Completion Gates by Change Area

Focused runs during development do not replace the complete TypeScript gates
(`pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test:run`) or the
Rust format/clippy/test gates for both workspaces. Before reporting completion,
apply the following matrix as well; an intentional TDD red phase is the exception.
Documentation-only work checks references, commands, formatting, and affected
contracts; the explicit public-book and formal-document gates still apply.

`pnpm type-check:cached` is optional local feedback backed by pnpm's experimental
pipeline cache. It caches the root `type-system:verify` task with the whole
repository as its input set. A cached local success does not replace the direct
completion checks above. Private CI and the broad local `pnpm ci:verify` gate run
`pnpm type-system:verify` directly, including `type-check`, checked JavaScript,
and workspace derivation checks. Both also run the private source checkout's
Fallow dead-code and dependency gate. See the
[tooling guide](../README.md#testing) for cache inputs and bypass commands.

| Change                                                                                          | Additional verification                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Web routes/components, styling, copy                                                            | `pnpm type-check`, `pnpm test:run`, relevant route/component tests                                                                              |
| Interactive UI used by Playwright                                                               | `pnpm test:e2e:mock --grep @smoke --reporter=list`; `pnpm test:e2e:axe` for accessibility-sensitive changes                                     |
| API routes, request validation, response schemas                                                | Targeted route tests and one flow smoke (`pnpm test:cli:mock` or mock E2E), plus `pnpm test:run`                                                |
| `packages/verification/src/**`, `packages/merkle/src/**`, `packages/domain/src/lib/bulletin/**` | `pnpm test:run`; proof-semantics changes also need mock CLI and ideally real-dev                                                                |
| Guest/public input, proof inputs, bundle/journal format, ImageID                                | `pnpm build:zkvm`, `pnpm test:run`, `pnpm test:cli:real-dev`, and **`pnpm test:cli:real-prod:s0` before completion**                            |
| `verifier-service/`                                                                             | `pnpm build:verifier-service`, verifier format/clippy/test; `pnpm test:stark-tamper` when verification behavior changes                         |
| `tests/e2e/`                                                                                    | `pnpm test:e2e:mock`                                                                                                                            |
| Terraform/Docker                                                                                | Applicable contracts, build/config syntax validation, `pnpm terraform:policy:check` for Bootstrap IAM changes, smallest realistic affected flow |
| `formal/`, `docs/formal/`, vector consumers                                                     | `pnpm formal:verify`; affected TS/Rust consumer tests for implementation-contract changes                                                       |
| `public-book/`, `scripts/docs/`                                                                 | `pnpm docs:book:build`; update `public-book/src/introduction.md` final-updated date for public content changes                                  |
| Public export/safety boundary                                                                   | `pnpm public-safety:scan`, targeted export/security tests; when practical export into a disposable directory                                    |
| Broad or risky changes                                                                          | `pnpm ci:verify`                                                                                                                                |

## Test Placement

- Put Vitest tests beside the implementation or contract they verify, using
  `*.test.ts` or `*.test.tsx`. Tests spanning a feature stay in that feature's
  directory; repository policy tests stay with their owning tooling area.
- Put local shared test helpers and fixtures in `test-support/` under their
  owner. Production TypeScript projects exclude tests and these support
  directories; test projects include them. Cross-workspace test utilities
  remain in `packages/test-support/`.
- Keep generated snapshots in the adjacent `__snapshots__/` directory.
- Put browser component examples beside their components as `*.stories.tsx`.
  `apps/web/tsconfig.storybook.json` owns those files and `.storybook/` configuration;
  production TypeScript and the application import graph exclude them. Shared
  fixtures follow the same `test-support/` ownership rules. Storybook does not
  replace Vitest or Playwright. See the [component review guide](../../docs/ui/design-spec-transparent-trust.md#component-review-with-storybook).
- Keep Playwright browser tests under `tests/e2e/` as `*.spec.ts`, with the
  existing page objects and helpers. Keep `*.type-test.ts` files in their
  owning area for TypeScript checking, outside Vitest execution.

Placement does not select a runtime profile or authorize an expensive run.
Real zkVM E2E, production proofs, benchmarks, and live acceptance retain their
explicit commands and prerequisites. The tooling tests compare current files with actual compiler and runner
discovery. They reject missing or duplicate ownership without retaining a file
list or requiring updates when tests are added, removed, or moved.

## Focused Vitest Runs

### Prerequisites and selection

Run commands from the repository root with dependencies installed from the
root package-manager declaration. Full private-repository `pnpm test:run`
also requires the pinned Rust toolchain with Cargo: repository checks compare
cache paths with `cargo metadata --offline --no-deps`. Compiler ownership checks
invoke the installed TypeScript CLI, first admitting configuration with
`--noEmit --listFilesOnly` and then reading `--showConfig`; they do not replace
the compiler diagnostics checked by `pnpm type-system:verify`. These metadata
checks generate no proof. Focused selections need the tools used by their
selected tests.

```bash
pnpm test:run --project @stark-ballot/verification
pnpm test:watch --project @stark-ballot/web
pnpm test:run packages/merkle/src --testNamePattern inclusion
pnpm test:changed
pnpm test:changed origin/develop
pnpm exec vitest related --run packages/validation/src/schema.ts
pnpm test:profile --project @stark-ballot/verification
pnpm exec vitest doctor --project @stark-ballot/merkle
pnpm exec vitest --clearCache
```

`test:changed` and `related` select tests through the import graph. Tests that
read fixtures, configuration, or source text through the filesystem may need
an explicit file/project selection; these shortcuts do not replace
`pnpm test:run` or the complete root gates. Package-local test commands pass
the root configuration explicitly, as Vitest 5 no longer searches parent
directories for it. `pnpm test:public` selects apps, packages, and the public
safety tests in a single Vitest invocation.

### Runtime isolation and performance

The default suite uses one named project per workspace plus repository tooling
and infrastructure projects. Vitest 5 shares the root Vite server across these
inline projects and persists transformed modules with `fsModuleCache`, reducing
repeated transformation within and between runs. Test files remain isolated;
only the web project starts jsdom and loads browser setup. Mock call history is
cleared before each test by Vitest's default `clearMocks` behavior.

Apps and libraries use the measured faster `threads` pool. Repository scripts,
infrastructure, and tooling use `forks`: their subprocess and filesystem-heavy
checks became slower with every project in threads. Both pools share one
CPU-aware worker budget. No machine-specific worker count is hardcoded;
`--maxWorkers` can bound a local run on a busy machine. Passing `--pool` overrides
the project choices, so omit it when measuring the configured suite.

`test:profile` prints import costs together with Vitest's phase breakdown.
`vitest doctor` measures alternative pools and worker counts by running the
selected tests several times; use a focused project when investigating a
slow area. Review its isolation and environment tradeoffs before changing
the configuration. The file-system transform cache lives in `node_modules`;
clear it when changing a transform plugin that reads undeclared external
inputs. Reporter output uses the ignored `.vitest/` directory.

Measure candidate configurations sequentially with the same test selection,
worker count, isolation, and cache conditions. Compare several repetitions and
check the full suite before adopting a change that helps one project. Vitest's
phase percentages sum worker time rather than dividing the wall-clock duration.
For expensive read-only fixtures, share setup within the owning suite and clean
it up after that suite. Tests that mutate inputs still need fresh fixtures;
determinism checks must retain independent executions.

Keep expensive isolated module imports in bounded setup hooks so they do not
consume the assertion timeout. Subprocesses need their own deadlines: a Vitest
timer cannot interrupt a synchronous child-process call. Test deadline policy
with a controlled clock and retain separate real-process lifecycle coverage;
do not assume startup finishes within a few hundred milliseconds. Real-process
tests budget startup and shutdown separately. Functional tests assert cache
behavior directly; timing comparisons belong in `pnpm test:bench`.

File-backed tests allocate a unique disposable directory for each test file and
execution, including when project names and worker IDs coincide across runs.
Within Vitest, `FILE_MOCK_STORE_DIR` selects the parent directory; setup creates
and later removes only its own child directory. The caller-owned parent and
other runs' stores are preserved. This does not change the application runtime's
meaning of `FILE_MOCK_STORE_DIR`.

The [Vitest 5 migration guide](https://vitest.dev/guide/migration/) and
[performance guide](https://vitest.dev/guide/improving-performance) describe
the inherited configuration, cache, and profiling behavior.

### Declaration patches

Dependency typing is kept compatible with strict compiler checks through three
exact pnpm patches:

- `patches/vitest@5.0.5.patch` admits the `undefined` benchmark
  provider and VM memory-limit values returned by configuration resolution.
- `patches/@testing-library__jest-dom@7.0.1.patch` augments Vitest's
  `Matchers<R, T>` interface while preserving synchronous/asynchronous return
  types.
- `patches/@storybook__react@10.6.3.patch` places two existing upstream
  `@ts-expect-error` comments immediately before their intended declarations.

These declaration-only patches leave runtime behavior unchanged and preserve
Node-only types, `exactOptionalPropertyTypes`, and `skipLibCheck: false`.
Remove each exact patch when its upstream declarations support those contracts.

## Local and CI Coverage

In the private source checkout, local `pnpm ci:verify` runs `pnpm test:e2e` once
for the union of the Axe and mock selections, sharing one frontend build and
test-server lifecycle. The private CI jobs retain their separate required names
and evidence. The generated public UI workflow also combines the selections;
the exported local `ci:verify` command still runs Axe and mock separately.

CI coverage depends on the checkout being tested:

| Checkout                  | Configured test coverage                                                                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private source            | `core-checks.yml` prepares pinned Rust, runs `pnpm test:run` once, and runs `pnpm test:entrypoint-bundle`. Separate jobs run CLI mock, Playwright Axe, and Playwright mock. Validation jobs honor `CI_PAUSED`; CLI/UI jobs also skip draft pull requests. |
| Generated public snapshot | Public core CI runs `pnpm test:public`; a separate public CLI workflow runs `pnpm test:cli:mock`. Public UI CI combines mock and Axe coverage in one `pnpm test:e2e` invocation; the local `test:e2e:mock` and `test:e2e:axe` selectors remain available. |

Private core CI runs lint, typecheck, test, build, and both Playwright jobs
independently. Only CLI mock waits for the build artifact. The required aggregate
admits exactly the declared job set with every result successful; paused CI,
draft pull requests, missing jobs, and skipped or failed results block success.

Private workflow contract tests inspect private workflow definitions and are
excluded from public export. A public subset pass does not establish private
repository-check coverage. Workflow definitions describe configured gates;
skipped jobs and inspected workflow source are not successful test executions.

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
local development. Build the Rust host and verifier-service for the evidence mode you intend to run:

Both modes write the same binary paths. Choose only the build pair for your intended run.

For `pnpm test:cli:real-dev` (fake development receipts):

```bash
pnpm build:zkvm:dev-mode
pnpm build:verifier-service:dev-mode
```

For `pnpm test:cli:real-prod:s0` or `pnpm test:cli:real-prod:all` (production STARK receipts):

```bash
pnpm build:zkvm
pnpm build:verifier-service
```

When the harness starts its own production Vite static frontend plus Hono API server, it fills a
test-only local `SESSION_CAPABILITY_SECRET` from `scripts/tests/.env.test.defaults` if neither the shell
nor `.env.local` already provides one. When reusing a long-lived server, set
`STARK_BALLOT_CLI_BASE_URL` explicitly before running the harness.

Before build or server setup, the CLI captures bounded execution conditions in memory.
At run completion or a caught setup/run failure, it saves those conditions in
`.tmp/cli-bundles/run-<timestamp>/report.json` and the selected text/Markdown report.
These include Git commit, dirty state, a SHA-256 of the tracked diff, and path/hash
pairs for eligible untracked source files within manifest-owned workspaces.
Excluded or unreadable source files and Git/tool lookup failures are explicit
incomplete/unknown evidence; raw diffs, secret files, environment dumps, and process
stderr are not retained. This is a scoped source observation, not a complete tree digest.

The same record identifies local Node/pnpm, OS/architecture, profile, scenarios,
expected ImageID, requested/effective finalize timeout, configured Rayon threads
(actual worker count remains unmeasured), and available real-mode binary hashes
and tool versions. An external server's host is explicitly unobserved. Setup or
run failure still saves the initial conditions and identifies selected scenarios
that were not run. Evidence collection failures do not replace the test outcome.

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

`setup-cli-test.sh` starts the browser demo through `pnpm dev` inside a tmux session named `vite`:

```bash
bash scripts/tests/setup-cli-test.sh --mock
```

The file is not executable in the current repository, so invoke it with `bash`. It requires `tmux` and
`nc`. The root `dev` command fixes the browser profile to `local-demo`; Vite serves the UI with its
browser mock API and does not start a Hono API server. The helper's `--real` and `--image-id`
options therefore do not establish a real-proof or external CLI server.

For browserless voting, use the CLI-managed `test:cli:mock` or `test:cli:real-*` commands above.
To reuse a long-lived API server, prepare a matching static frontend build and runtime profile,
start Hono with `pnpm start`, and set `STARK_BALLOT_CLI_BASE_URL` to that server's origin.
See the [CLI runbook](../../docs/guides/cli.md) for the external-server setup.

`teardown-cli-test.sh` stops the `vite` tmux session and removes `.zkvm-temp/` plus generated
`*-output.json` and `*-receipt.json` files:

```bash
./scripts/tests/teardown-cli-test.sh
```

## Live Develop Acceptance

`scripts/tests/develop-gated-smoke.ts` is the operator-gated develop acceptance runner. It must use the
gated CloudFront hostname and probe the direct API origin for fail-closed rejection. Its positive owner
flow uses HTTP against deployed develop to produce and verify production-mode STARK evidence;
it invokes no local compiler, prover, container build, or receipt-verifier process. Both deployed targets require production
proofs, but this runner validates develop. Develop uses its signed-cookie gate;
production uses authenticated Cloudflare ingress, strict Cloudflare client-IP
admission, and server-side Turnstile. Target configuration, release lanes, and
artifact-retention policy are separately owned. A develop acceptance run does
not establish production acceptance.

The default acceptance matrix is `S0,S1,S2`: normal, one exclusion class, and one claimed-tally class.
Set `STARK_BALLOT_GATED_SMOKE_SCENARIOS=S0,S1,S2,S3,S4,S5` to exercise the full scenario set. A
configured matrix fails closed unless it includes `S0`, at least one of `S1`/`S3`/`S5`, and at least one
of `S2`/`S4`.

For every scenario, the runner:

- resolves the independent expected ImageID from the current `default` entry in
  `public/imageId-mapping.json` and compares the API ImageID projections with it; the mapping is exact-admitted by
  the validation owner before any field is read
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
- exact-admits the protected report with the verification owner before validating its execution-bound response
  metadata, status, expected and receipt ImageIDs, production-mode marker, and empty error result
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
STARK_BALLOT_DIRECT_API_ORIGIN=https://<api-id>.execute-api.<region>.amazonaws.com/live \
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
pnpm exec vitest run scripts/tests/develop-gated-smoke.test.ts --reporter=dot
```

### Parallel remote acceptance and prover-capacity evidence

The maintained runner submits every selected scenario on equal terms. For the
capacity acceptance test, use the default three scenarios `S0,S1,S2` with the
Batch replenishable resource configured for two concurrent provers. No scenario is designated
as the one that must wait. Successful HTTP results alone do not establish
capacity evidence; the native Batch observations below are also required.

[`runParallelOwnerFlows()`](develop-gated-smoke.ts) creates an independent
`CLITestHelpers` instance, session and vote for each scenario. It waits for all
preparations, then starts all finalizations together. It reuses the existing
finalization client and `completeFinalizedVerificationAcceptance()` for ImageID,
receipt/report, local cast and scenario checks. S0 must be fully verified; S1
must detect exclusion; S2 must detect claimed-tally tampering while retaining a
valid proof. This HTTP acceptance is not a canonical CLI or local real-production
verifier run.

1. Prepare all three sessions and their votes, then submit S0, S1 and S2
   concurrently. Let Batch determine admission order and which
   job waits; do not hold back S2 or impose a client-side concurrency limit.
2. Retain each exact session/finalization binding and the bounded HTTP status
   observations. HTTP `pending` can include other preparation stages, so it
   does not prove Batch capacity contention by itself.
3. Once all scenarios complete, observe their exact Batch job IDs and terminal
   Step Functions status under the explicitly selected target administrator
   profile/account/region. Read `batch describe-jobs` with a projection limited to
   `jobId`, `jobName`, `jobQueue`, `jobDefinition`, `status`, `createdAt`,
   `startedAt`, `stoppedAt`, `retryStrategy.attempts`, and
   `consumableResourceProperties.consumableResourceList`. Require three distinct
   single-attempt `SUCCEEDED` jobs, their names bound to the selected finalization
   IDs, and the expected target queue and reviewed job-definition revision.
   Verify each job requires one unit of the exact shared resource, and observe
   that resource as `REPLENISHABLE`, total quantity 2. Do not retain raw job
   descriptions, container environments, input payloads, or free-form reasons.
4. Compare the half-open `[startedAt, stoppedAt)` intervals. Require observed
   concurrency exactly two among these jobs, never three. At least one job must
   have been submitted before the overlap ended and started only after one of
   those jobs stopped. Record this as observed waiting, not proof of its sole
   cause. These timestamps cover RUNNING work, not STARTING or global occupancy;
   the shared Batch resource supplies the configured bound. Missing or ambiguous
   job bindings, retry attempts, timestamps, resource requirements or terminal
   evidence fail acceptance.

The former `readProverCapacityEvidence()` helper and semaphore-history validator
are retired. A `RunProver` Step Functions task now includes Batch queue wait;
counting those state intervals would incorrectly count queued jobs as workers.
The Lean model and source contract tests cover the abstract bound and configured
submission path; they do not replace this separately authorized live evidence.

Both preparation and execution use `Promise.allSettled`: an early rejection
cannot hide other started work or allow success for a subset. Failure does not
authorize stopping remote executions. The runner defaults to a 30-minute
per-finalization deadline, including queue wait. The private live acceptance
wrapper retains an overall 55-minute deadline and a 60-minute cookie lifetime.
Do not silently extend deadlines or renew credentials. Missing capacity evidence
is a failed acceptance criterion, never an implicit pass or skip. The HTTP
command alone reports that native capacity evidence and Gateway access-log
correlation remain necessary; it does not claim they passed.

Use `--no-include-execution-data` and an explicit history projection limited to
event IDs, previous-event IDs, timestamps, event/state names and error codes. Omit input, output, task parameters and error `cause`; those may
contain private data even when execution data is disabled. Keep cookies,
capabilities and vote openings in memory only. Persist only bounded private
observations, scenario/session/finalization bindings and the existing acceptance
result fields under a `0700` directory, using `0600` files and no-overwrite
creation. Retain source/checkpoint checks and Gateway access-log correlation
independently of capacity evidence. This method adds no API fields, queue-position
estimate or separate authority record.

## Release And Container Contracts

### Prover candidate posture

The prover release buildspec runs `scripts/tests/fargate-prover-container-smoke.sh <image-uri>`
immediately after building the candidate and before ImageID extraction or publication. The smoke starts
the actual image with a read-only root filesystem, all capabilities dropped, an init process, and no
network. It checks UID/GID `10001:10001`, `/opt/risc0` assets including an executable `r0vm --version`,
the exact `PROVER_ARTIFACT_TOOL_BIN=/opt/zkvm/bin/prover-artifacts` setting and executable,
the no-new-privileges startup setting,
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
pnpm exec vitest run scripts/tests/fargate-prover-container-smoke.test.ts --reporter=dot
```

### Prover entrypoint contract

`entrypoint-bundle.test.sh` exercises the public bundle/archive contract, bounded host wrapper, and
shutdown behavior and Batch start admission exposed by `infra/docker/entrypoint.sh`. It builds and uses the Rust
`prover-artifacts` binary with `RISC0_SKIP_BUILD=1`, while stubbing proof-host execution and AWS calls.
The harness skips guest compilation and generates no production proof; its results are artifact and
orchestration contract evidence:

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
remain alongside the uploaded outputs. The Rust artifact tool validates cross-artifact consistency;
negative cases include a changed close-statement timestamp and duplicate vote indices, with the latter
fixture generated through `pnpm tsx`.

The harness also exercises TERM/INT forwarding, exact 143/130 interruption exits, the
`infrastructure_interruption` failure marker and summary, bounded kill-after behavior for an
uncooperative host, durable-publication handling, and the rule that an immediate host exit 137 remains a
`prover_execution` failure.

The package script wraps `bash scripts/tests/entrypoint-bundle.test.sh`, so local runs and CI use the same
entrypoint. It requires the pinned Rust toolchain with Cargo, installed Node/pnpm dependencies,
`jq`, `python3`, GNU Coreutils `timeout`, and `unzip`. The harness rejects other
`timeout` implementations before running; interruption forwarding must match the
Amazon Linux prover image. On Ubuntu runners that ship `gnutimeout`, Core Checks
selects it as `/usr/local/bin/timeout`, which is also on the entrypoint's fixed PATH.

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

### Bitmap golden-vector generator

`generate-bitmap-golden-vectors.ts` regenerates the exact-current TypeScript-to-Rust bitmap root
and proof fixture:

```bash
pnpm tsx scripts/tests/generate-bitmap-golden-vectors.ts
```

It writes `zkvm/contract-core/testdata/bitmap-ts-golden-vectors.json` from the deterministic seeds in
`bitmap-golden-vectors.ts`. The freshness test exact-admits the complete envelope before comparing
it with the producer, and Rust rejects unknown envelope, case, proof, and audit-node keys.

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

Tests live beside the maintained harnesses, fixture generators, and smoke
wrappers. For example, `batch-processor.test.ts` covers `batch-processor.ts`,
and `lib/cli-run-evidence.test.ts` covers the evidence collector in `lib/`.

Run them directly or with the full one-shot Vitest suite:

```bash
pnpm vitest run scripts/tests
pnpm test:run
```

### Node STH public-runtime smoke

`sth-public-runtime-node-smoke.ts` checks that Node-side runtime configuration resolves public STH
sources and the minimum-match threshold under `tsx` without relying on Vite `import.meta.env`:

```bash
pnpm tsx scripts/tests/sth-public-runtime-node-smoke.ts
```

Its adjacent Vitest wrapper is included in `pnpm test:run` and can be run independently:

```bash
pnpm exec vitest run scripts/tests/sth-public-runtime-node-smoke.test.ts --reporter=dot
```
