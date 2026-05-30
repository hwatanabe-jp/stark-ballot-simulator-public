# Public Repository Snapshot

This repository is a generated public portfolio snapshot of STARK Ballot Simulator.

- Public repository: https://github.com/hwatanabe-jp/stark-ballot-simulator-public
- Source commit: `e0af278cdab03cd0cf811b3ebffe2f880add6207`
- Generated at: `2026-05-30T13:50:52.953Z`
- Copied source files: `907`

The private repository remains the source of truth. Public-repository changes
should normally be made in the private repository and released again as a new
snapshot.

Use this snapshot to start the public repository from a clean history. Do not
push, mirror, or graft private repository history into the public repository.

## What Is Included

- Next.js application and verification UI source
- TypeScript verification, ballot, session, store, and API logic
- RISC Zero zkVM guest/host source and verifier service source
- Sanitized infrastructure source for Amplify, Docker, and Terraform
- Public documentation, public book sources, and safe local/test scripts
- Public-only GitHub Actions workflows

## Documentation Footprint

The private source repository intentionally keeps broader working notes than the
public portfolio snapshot needs. This export preserves that signal while
publishing only the documentation that is safe and useful for readers.

- Private source docs tracked: `128`
- Public source docs copied: `62`
- Generated public docs: `1`
- Source docs stripped: `66`

Stripped documentation categories:

- Archived history and progress notes: `49` files from `docs/archive/`
- Internal implementation notes: `13` files from `docs/current/internal/`
- Monitoring and operations notes: `4` files from `docs/current/monitoring/`

## What Is Stripped

- `.env* except .env.local.example and scripts/tests/.env.test.defaults`
- `.github/workflows/* from the private repository`
- `docs/archive/`
- `docs/current/internal/`
- `docs/current/monitoring/`
- `docs/current/guides/3-deployment/public-repository-release.md`
- `scripts/aws/`
- `scripts/monitoring/`
- `scripts/public/`
- `terraform/main.tfvars`
- `terraform/develop.tfvars`
- `input.json`
- `verification.json`
- `included-bitmap.json`
- `seen-bitmap.json`

The public tree intentionally does not include the private release generator,
private GitHub Actions workflows, AWS credential setup workflows, monitoring
jobs, concrete Terraform tfvars, or private verification artifacts.

## CI Profile

The public repository runs showcase-safe checks only. The generated workflow
files keep the CI categories visible while removing private operations. They do
not assume AWS credentials, publish container packages, mutate Terraform-managed
infrastructure, or create another public-repository snapshot.

The generated weekly monitor is a public-safe showcase issue poster. It
summarizes public CI health and public-safety scan results without accessing
AWS credentials, Terraform state, private artifacts, private monitoring
queries, or credentialed runbooks.
