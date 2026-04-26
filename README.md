# STARK Ballot Simulator

STARK Ballot Simulator is a full-stack security and cryptography portfolio project built around an
end-to-end verifiable voting demo.

This README is the main entry point for reviewers. It summarizes what the project demonstrates, how to
run the local mock flow, and where to find the detailed public specifications.

- Live demo: <https://stark-ballot-sim.hwatanabe.dev/>
- Public specs: <https://specs.stark-ballot-sim.hwatanabe.dev/>
- Security policy: [`SECURITY.md`](./SECURITY.md)
- Public snapshot notes: generated as `docs/PUBLIC_REPOSITORY.md` during public export

## What This Is

`STARK Ballot Simulator` is an educational demo that walks through casting a vote, finalizing a tally,
displaying results, and independently checking the evidence needed to verify the outcome.

The goal is not to provide production election infrastructure. The goal is to integrate several security
and cryptography concepts into one inspectable application:

- a Next.js / React user experience
- TypeScript API, session, verification, and artifact-handling logic
- Rust / RISC Zero zkVM proof and receipt-verification components
- vote commitments, receipts, and CT-style append-only bulletin board evidence
- tamper scenarios for demonstrating verification failures
- a sanitized public repository snapshot with CI, documentation, and security boundaries

Detailed architecture notes, protocol explanations, verification model details, and AWS deployment notes
are collected in the Public Specs.

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

## Recommended Review Path

For a short review pass:

1. Try the live demo and complete the vote-to-verification flow.
2. Read the Public Specs overview and verification model.
3. Run the local mock flow from this README.
4. Review [`SECURITY.md`](./SECURITY.md) for live-demo testing limits.
5. Inspect `src/`, `zkvm/`, `verifier-service/`, and `tests/` as needed.

The core product invariant is simple: the UI must never show "Verified" unless all required
cryptographic and consistency checks pass.

## Verification and Bundles

Verification covers cast-as-intended receipts, recorded-as-cast bulletin-board evidence,
counted-as-recorded tally inputs, and server-side STARK receipt verification.

Public bundles include evidence such as `public-input.json`, `election-manifest.json`,
`close-statement.json`, `receipt.json`, and `journal.json`. Private artifacts such as `input.json`,
`verification.json`, `included-bitmap.json`, and `seen-bitmap.json` must not be included in public
bundles.

## Local Quick Start

The fastest local path uses mock storage and mock zkVM behavior. It does not require AWS resources or
external services.

### Prerequisites

- Node.js 24
- pnpm 10.x through Corepack
- Rust and RISC Zero tooling only if you want to run real zkVM flows

### Install

```bash
corepack enable
pnpm install --frozen-lockfile
```

Create a local environment file before first boot:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local` and replace `SESSION_CAPABILITY_SECRET` with a fresh random value of at least 32
characters. Do not reuse the placeholder from `.env.local.example`.

### Run the Browser Mock Flow

```bash
pnpm dev
```

Then open:

```text
http://localhost:3000
```

`pnpm dev` enables these local-only defaults:

- `NEXT_PUBLIC_USE_MOCK_API=true`
- `USE_MOCK_STORE=true`
- `USE_MOCK_ZKVM=true`
- local Turnstile bypass
- `RUNTIME_DEPLOYMENT_ENV=develop`
- `DISABLE_STRICT_CSP=1`

These settings are for local development only and must not be reused for production or public hosting.

## Local Checks

### Public Test Subset

This is the showcase-safe Vitest subset used by the public repository profile.

```bash
pnpm test:public
```

### CLI Mock Voting Flow

This runs session creation, voting, finalization, and verification without opening a browser.

```bash
pnpm test:cli:mock
```

### Next.js-Only Build

Use this when you want to check the UI/API build without building the Rust zkVM and verifier-service
components.

```bash
pnpm build:ci
```

### Mock E2E Smoke

This runs the Playwright mock flow through the production-mode test server.

```bash
pnpm exec playwright install --with-deps
pnpm test:e2e:mock --grep @smoke --reporter=list
```

## Optional: Real zkVM Checks

Real zkVM flows require the pinned Rust toolchain and RISC Zero tooling.

```bash
rustup toolchain install 1.91.1
rustup component add rustfmt clippy --toolchain 1.91.1
cargo install --locked cargo-risczero --version 3.0.5
cargo risczero install
```

Build the Rust components:

```bash
pnpm build:zkvm
pnpm build:verifier-service
```

Run the real zkVM development receipt flow:

```bash
pnpm test:cli:real-dev
```

Run a production STARK proof for the normal scenario:

```bash
pnpm test:cli:real-prod:s0
```

Notes:

- `test:cli:real-dev` uses `RISC0_DEV_MODE=1`; these receipts are not production STARK proofs.
- `test:cli:real-prod:s0` generates a real STARK receipt and can take significantly longer than mock mode.
- For most review purposes, start with `pnpm dev`, `pnpm test:public`, and `pnpm test:cli:mock`.

## Repository Layout

```text
.
|- src/                 Next.js app, API routes, UI components, and shared TypeScript logic
|- zkvm/                RISC Zero zkVM guest/host workspace
|- verifier-service/    Rust receipt verification service
|- tests/               Playwright E2E tests
|- scripts/             Test, build, docs, security, and utility scripts
|- public-book/         mdBook source for the Public Specs
|- docs/                Current documentation and supporting notes
|- amplify/             Sanitized Amplify Gen2 backend source
|- terraform/           Sanitized async prover infrastructure source
|- docker/              Prover container files
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
- monitoring scripts and queries
- private verification artifacts
- internal notes not intended for publication

The public export process generates `docs/PUBLIC_REPOSITORY.md`, `.public-repository`, and
`.public-export-manifest.json` in the public snapshot so reviewers can inspect what was copied and what
was stripped.

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
- Current docs entry point: [`docs/current/README.md`](./docs/current/README.md)
- Verification pipeline and bundle contract: [`docs/current/verification/README.md`](./docs/current/verification/README.md)
- CLI test guide: [`docs/current/tests/cli.md`](./docs/current/tests/cli.md)
- zkVM build details: [`zkvm/README.md`](./zkvm/README.md)
- Verifier-service details: [`verifier-service/README.md`](./verifier-service/README.md)
- Security policy: [`SECURITY.md`](./SECURITY.md)
- Third-party notices: [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

Third-party license information is summarized in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
