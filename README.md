# STARK Ballot Simulator

STARK Ballot Simulator is a full-stack security and cryptography portfolio project with a
formal-methods layer, built around an end-to-end verifiable voting demo.

This root README is the reviewer entry point. It explains what the project demonstrates, how to run the
local mock flow, and where to find the detailed public specifications. Protocol details, AWS diagrams,
verification semantics, and implementation notes live in the Public Specs and the purpose-oriented `docs/` tree.

- Live demo: <https://stark-ballot-sim.hwatanabe.dev/>
- Public specs: <https://specs.stark-ballot-sim.hwatanabe.dev/>
- Public repository: <https://github.com/hwatanabe-jp/stark-ballot-simulator-public>
- Developer-portal catalog: [`catalog-info.yaml`](./catalog-info.yaml)
- Generated OpenAPI reference: [`openapi/stark-ballot-api.openapi.json`](./openapi/stark-ballot-api.openapi.json)
- Guest-safe TechDocs source: [`techdocs/docs/index.md`](./techdocs/docs/index.md)
- Security policy: [`SECURITY.md`](./SECURITY.md)
- License: [`Apache-2.0`](./LICENSE)
- Public snapshot notes: generated as `docs/PUBLIC_REPOSITORY.md` during public export

## What This Is

`STARK Ballot Simulator` is an educational demo that walks through casting a vote, finalizing a tally,
displaying results, and independently checking the evidence needed to verify the outcome.

The goal is not to provide production election infrastructure. The goal is to integrate several security
and cryptography concepts into one inspectable application:

- a Vite / React Router user experience for vote, tally, result, and verification flows
- TypeScript API, session, verification, and artifact-handling logic
- Hono-compatible route handlers for the API Gateway bridge path
- Rust / RISC Zero zkVM proof generation and receipt verification
- vote commitments, receipts, and CT-style append-only bulletin-board evidence
- tamper scenarios for demonstrating verification failures
- Lean 4 models and generated vectors for selected fail-closed and encoding invariants
- a sanitized public repository snapshot with CI, documentation, and security boundaries

Detailed architecture notes, protocol explanations, verification-model details, formal-methods scope, and
AWS deployment notes are collected in the Public Specs.

## Development Style

This project was built with AI-assisted development.

Coding agents helped accelerate implementation, test additions, refactoring, and documentation work. I
owned the requirements, architecture decisions, security boundaries, test strategy, release review, and
public/private repository boundary.

## Non-Goals

This is a portfolio/demo proof of concept, not a production voting system.

By design, it does not claim:

- full ballot secrecy against the operator in every demo path
- production election hardening
- operational readiness for real ballots or public-sector elections
- full formal verification of the complete application, AWS runtime, or React UI

## Recommended Review Path

For a short review pass:

1. Try the live demo and complete the vote-to-verification flow.
2. Read the Public Specs overview and verification model.
3. Run the local mock flow from this README.
4. Review [`SECURITY.md`](./SECURITY.md) for live-demo testing limits.
5. Inspect `apps/`, `packages/`, `infra/`, `zkvm/`, `verifier-service/`, `formal/`, and `tests/` as needed.

The core product invariant is simple: the UI must never show "Verified" unless all required
cryptographic and consistency checks pass.

Three design choices make useful starting points for a code review:

- [Verified requires complete evidence](./public-book/src/verification/gating-logic.md): a valid STARK
  receipt alone cannot establish that every required ballot and consistency check passed.
- [Public bundles exclude private evidence](./public-book/src/verification/public-boundary.md): the
  archive boundary takes precedence over reproducing every UI check from the ZIP alone.
- [Asynchronous finalization has guarded transitions](./public-book/src/aws/async-prover.md): stale or
  cancelled work must be rejected before starting a prover task.

## Verification and Bundles

Verification covers cast-as-intended receipts, recorded-as-cast bulletin-board evidence,
counted-as-recorded tally inputs, and server-side STARK receipt verification.

Public bundles include evidence such as `public-input.json`, `election-manifest.json`,
`close-statement.json`, `receipt.json`, and `journal.json`. Private artifacts such as `input.json`,
`verification.json`, `included-bitmap.json`, and `seen-bitmap.json` must not be included in public
bundles.

The verification flow is intentionally fail-closed. Missing required evidence, inconsistent CT proofs,
excluded slots, ImageID mismatches, unallowed dev-mode receipts, or failed STARK receipt verification must
block a successful overall result. Dev-mode receipts are accepted only in explicit non-production/dev
verification paths and must not be counted as production STARK proofs.

## Architecture at a Glance

- **Frontend / app shell:** Vite, React 19, React Router, TypeScript, Tailwind CSS
- **API surface:** Hono route handlers backed by a framework-neutral route definition inventory
- **Validation:** local schema validators and explicit response-shape tests
- **Proof stack:** RISC Zero zkVM guest/host plus a standalone Rust `verifier-service`
- **Image supply chain:** a dedicated verifier checks the selected digest-pinned prover image at app preflight and before runtime launch
- **Session persistence:** lifecycle-owned identity, voting, finalization, verification-observation, and adapter-metadata records rather than one optional-field session aggregate
- **Formal scope:** Lean 4 models for selected summary, count, bitmap, input-commitment, and guest-model contracts
- **AWS path:** Terraform-managed static frontend, Hono/API, DynamoDB store, and async prover infrastructure
- **Public docs:** normative mdBook chapters in `public-book/` plus a thin,
  guest-safe TechDocs overview in `techdocs/`

## Local Quick Start

The fastest local path uses mock storage and mock zkVM behavior. It does not require AWS resources or
external services.

### Prerequisites

- Node.js 24.15 or later within the Node 24 release line (the supported range is bounded by
  `engines.node`; `.nvmrc` selects the current Node 24 release for version managers)
- Corepack, which resolves the exact pnpm release and integrity hash from the root `packageManager`
- Rust 1.97.1 only if you want Rust builds or real zkVM flows
- RISC Zero tooling only if you want real zkVM flows
- Lean / `elan` only if you want to run the formal verification gate
- `mdbook` / `mdbook-mermaid` only if you want to build the Public Specs

### Install

If you use nvm, select the checked-in Node major first:

```bash
nvm use
```

Then activate the root package-manager authority and install:

```bash
corepack enable
corepack install
pnpm install --frozen-lockfile
```

The browser-only mock flow does not need a server capability secret. Copy the local environment template
for the remaining local defaults:

```bash
cp .env.local.example .env.local
```

`SESSION_CAPABILITY_SECRET` is intentionally commented out in the template. Leave it unset for `pnpm dev`.
If you run the same-origin local Hono API with `pnpm start`, uncomment it and replace the placeholder with
a fresh random value of at least 32 characters.

### Run the Browser Mock Flow

```bash
pnpm dev
```

Then open:

```text
http://localhost:3000
```

`pnpm dev` starts the Vite frontend shell with the browser projection of the
`local-demo` runtime profile:

- `VITE_RUNTIME_PROFILE=local-demo`
- browser mock API
- Turnstile bypass eligibility for this local-only profile

The `.env.local` copied from `.env.local.example` aligns the server-side
selector:

- `RUNTIME_PROFILE=local-demo`
- `VITE_RUNTIME_PROFILE=local-demo`

One immutable server profile selects storage, proof evidence, finalization,
artifact delivery, rate limiting, runtime adapters, and admission posture
before adapters are created. The supported local profiles are:

| Profile                   | Store  | Proof evidence               | Browser API | Intended use                 |
| ------------------------- | ------ | ---------------------------- | ----------- | ---------------------------- |
| `local-demo`              | memory | mock; no STARK proof         | mock        | `pnpm dev`                   |
| `static-mock-e2e`         | file   | mock; no STARK proof         | same-origin | Playwright and mock CLI      |
| `local-proof-development` | memory | fake development receipt     | same-origin | TypeScript/Rust contract run |
| `local-proof-production`  | memory | production RISC Zero receipt | same-origin | local real-proof evidence    |

Target runtime definitions use `target-aws-async` for production-proof,
DynamoDB/S3/queue-backed execution. A develop-only
`target-aws-async-quiesced` server profile rejects new public sessions during
recovery, and Terraform pauses both prover and verification queue consumers.
Existing session access remains available. The quiesced profile is not a browser
profile.
Target definitions and deployment remain separately reviewed and authorized.

These profiles are not interchangeable evidence labels: mock and development
receipts do not prove production STARK correctness. `pnpm build:ci` selects
the target-safe browser profile before building and scanning `dist/`.

## Local Checks

Use the narrowest check that proves the change. For reviewer smoke tests, start with `pnpm dev`,
`pnpm test:public`, and `pnpm test:cli:mock`.

| Purpose                   | Command                                            |
| ------------------------- | -------------------------------------------------- |
| Public-safe Vitest subset | `pnpm test:public`                                 |
| Full Vitest suite         | `pnpm test:run`                                    |
| CLI mock voting flow      | `pnpm test:cli:mock`                               |
| Static frontend build     | `pnpm build:ci`                                    |
| Component previews        | `pnpm storybook`                                   |
| Static component previews | `pnpm storybook:build`                             |
| Mock E2E smoke            | `pnpm test:e2e:mock --grep @smoke --reporter=list` |
| Accessibility smoke       | `pnpm test:e2e:axe`                                |
| Public safety scan        | `pnpm public-safety:scan`                          |
| OpenAPI freshness         | `pnpm api-contract:openapi:check`                  |
| Catalog and TechDocs      | `pnpm catalog:check`                               |
| Public Specs build        | `pnpm docs:book:build`                             |
| Lean formal/vector gate   | `pnpm formal:verify`                               |
| Type-system verification  | `pnpm type-system:verify`                          |
| Broad TypeScript/UI gate  | `pnpm ci:verify`                                   |

Notes:

- `pnpm build:ci` checks the Vite static frontend, browser import boundary, and generated `dist/` artifact scan. It is the reusable/deployable artifact path and rejects browser mock API or Turnstile bypass flags.
- Storybook opens at `http://localhost:6006`; its build writes to `.tmp/storybook-static`, separately from `dist/`. See the [component review guide](./docs/ui/design-spec-transparent-trust.md#component-review-with-storybook) for story placement and test ownership.
- Mock Playwright uses a production-mode Vite static frontend plus local Hono API test server, not the same runtime path as `pnpm dev`.
- `pnpm formal:verify` requires the pinned Lean toolchain under `formal/`.

The workspace uses pnpm 12, TypeScript 7, Oxlint, Oxfmt, and Vitest 5. pnpm schedules source-based
workspace checks without waiting for dependency packages' checks, with bounded
concurrency to control compiler memory and avoid overlapping Vitest pools.
Preview a task graph with `pnpm --recursive run --dry-run type-check`.

For fast local feedback, use `pnpm test:changed` or a workspace's `test` task.
`pnpm test:profile --project @stark-ballot/verification` reports import costs.
Vitest projects share one Vite server and reuse disk-cached transforms while
keeping test files isolated. The complete repository gate remains
`pnpm test:run`; selection and cache details are in the
[test harness guide](./scripts/tests/README.md).

Vitest tests live beside the code or contract they verify as `*.test.ts` or
`*.test.tsx`; local shared helpers and fixtures live in `test-support/`.
Browser E2E tests remain under `tests/e2e/` as `*.spec.ts`, and
`*.type-test.ts` files are checked by TypeScript. See the
[test placement convention](./scripts/tests/README.md#test-placement) for
support-file boundaries and explicit test gates. Tooling tests compare current
source files with compiler and runner discovery; no saved test-file list needs
updating when tests are added, removed, or moved.

Review dependency updates with `pnpm dependencies:outdated` and peer compatibility
with `pnpm dependencies:peers`. When updating Actions, run
`pnpm dependencies:actions:update` to refresh workflow and local composite-action
SHA pins through pnpm. Registry package updates still respect the workspace's
24-hour release-age and supply-chain policies.

## Optional: Real zkVM Checks

Real zkVM flows require the pinned Rust toolchain and RISC Zero tooling.

```bash
rustup toolchain install 1.97.1
rustup component add rustfmt clippy --toolchain 1.97.1
cargo install --locked --git https://github.com/risc0/risc0 --tag v3.0.6 rzup
rzup install rust 1.97.0
rzup install r0vm 3.0.6
rzup install cargo-risczero 3.0.6
```

Build the development-evidence Rust components before the real-host
development flow:

```bash
pnpm build:zkvm:dev-mode
pnpm build:verifier-service:dev-mode
pnpm test:cli:real-dev
```

Build the production-feature components before generating a real STARK proof:

```bash
pnpm build:zkvm
pnpm build:verifier-service
pnpm test:cli:real-prod:s0
```

Run each Rust workspace's local quality gates through the semantic root
proxies:

```bash
pnpm rust:verifier:format
pnpm rust:verifier:clippy
pnpm rust:verifier:test
pnpm rust:zkvm:format
pnpm rust:zkvm:clippy
pnpm rust:zkvm:test
```

Notes:

- `test:cli:real-dev` selects `local-proof-development`; the adapter invokes
  the real Rust host in development-evidence mode, but its fake receipts are
  not production STARK proofs.
- `test:cli:real-prod:s0` generates a real STARK receipt and can take significantly longer than mock mode.
- Proof-input, journal, bundle, verifier, or ImageID changes should be validated beyond mock mode before they are treated as complete.

## Optional: Formal Model Checks

The Lean workspace is under [`formal/`](./formal/) and pins its toolchain in
[`formal/lean-toolchain`](./formal/lean-toolchain). It models selected invariants and generates vectors
consumed by TypeScript and Rust tests; it does not claim to prove the whole voting system.

```bash
pnpm formal:verify
```

For scope and claim boundaries, see [`docs/formal/README.md`](./docs/formal/README.md).

## Repository Layout

```text
.
|- apps/web/            Vite/React browser app, routes, components, and presentation state
|- apps/api/            Hono/API Gateway route binding and HTTP adapters
|- packages/            TypeScript API contract, domain, verification, zkVM contract, and test support packages
|- zkvm/                RISC Zero zkVM guest/host workspace
|- verifier-service/    Rust receipt verification service
|- formal/              Lean 4 formal model and generated vectors/reports
|- tests/               Playwright E2E tests
|- scripts/             Test, build, docs, security, formal, Terraform, and utility scripts
|- public-book/         mdBook source for the Public Specs
|- docs/                Current documentation and supporting notes
|- infra/terraform/     Terraform-managed infrastructure source
|- infra/docker/         Prover container files
|- infra/image-signature-verifier/  Prover image-signature verifier source and pinned assets
|- infra/lambdas/        Lambda handlers and runtime adapters
`- public/              Static assets and public mappings
```

## Public Repository Boundary

The public repository is generated as a sanitized portfolio snapshot. The private repository remains the
source of truth for private operations and release generation.

The public snapshot intentionally excludes private or sensitive artifacts such as:

- private `.env` files
- concrete Terraform tfvars
- private GitHub Actions workflows
- AWS credential setup workflows
- private monitoring scripts, query catalogs, and operational monitoring notes
- private verification artifacts
- internal notes not intended for publication
- agent memory files and local automation scaffolding

The public export process generates `docs/PUBLIC_REPOSITORY.md`, `.public-repository`,
`.public-export-manifest.json`, and public-safe workflow files in the public snapshot so reviewers can
inspect what was copied and what was stripped.

## Security and Testing Boundaries

Do not submit secrets, credentials, private keys, personal data, or sensitive ballots to the live demo,
issues, logs, or public artifacts.

Do not run automated vulnerability scans, load tests, fuzzers, credential stuffing, destructive tests, or
infrastructure enumeration against the public domains without prior authorization. Local testing against
your own clone is welcome.

For vulnerability reporting and supported testing scope, see [`SECURITY.md`](./SECURITY.md).

## Documentation

- Public specs: <https://specs.stark-ballot-sim.hwatanabe.dev/>
- Local mdBook source: [`public-book/`](./public-book/)
- Current docs entry point: [`docs/README.md`](./docs/README.md)
- Verification pipeline and bundle contract: [`docs/verification/README.md`](./docs/verification/README.md)
- Formal model scope: [`docs/formal/README.md`](./docs/formal/README.md)
- CLI test guide: [`docs/guides/cli.md`](./docs/guides/cli.md)
- zkVM build details: [`zkvm/README.md`](./zkvm/README.md)
- Verifier-service details: [`verifier-service/README.md`](./verifier-service/README.md)
- Security policy: [`SECURITY.md`](./SECURITY.md)
- Third-party notices: [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

Third-party license information is summarized in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
