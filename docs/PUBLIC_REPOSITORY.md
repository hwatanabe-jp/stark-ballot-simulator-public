# Public Repository Snapshot

This repository is a generated public portfolio snapshot of STARK Ballot Simulator.

- Public repository: https://github.com/hwatanabe-jp/stark-ballot-simulator-public
- Source commit: `bb9e6753c2ff9717142f887bca24a11364d49475`
- Generated at: `2026-09-13T00:21:17.879Z`
- Copied source files: `1471`

The private repository remains the source of truth. Public-repository changes
should normally be made in the private repository and released again as a new
snapshot.

Use this snapshot to start the public repository from a clean history. Do not
push, mirror, or graft private repository history into the public repository.

## What Is Included

- Vite / React Router application and verification UI source
- TypeScript verification, ballot, session, store, and API logic
- RISC Zero zkVM guest/host source and verifier service source
- Sanitized infrastructure source for Docker and Terraform
- Public documentation, public book sources, and safe local/test scripts
- Public-only GitHub Actions workflows

## Documentation Footprint

The private source repository intentionally keeps broader working notes than the
public portfolio snapshot needs. This export preserves that signal while
publishing only the documentation that is safe and useful for readers.

- Private source files under `docs/` tracked: `246`
- Public source files under `docs/` copied: `58`
- Generated public docs: `1`
- Source files under `docs/` stripped: `188`

Stripped documentation categories:

- Archived history and progress notes: `52` files from `docs/archive/`
- Internal implementation notes: `136` files from `docs/internal/`

## What Is Stripped

- `.agents/`
- `.claude/`
- `AGENTS.md`
- `CLAUDE.md`
- `.env* except .env.local.example and scripts/tests/.env.test.defaults`
- `.github/workflows/* from the private repository`
- `docs/archive/`
- `docs/internal/`
- `examples/hello-service/`
- `infra/framework/`
- `infra/terraform/** except .tf source and explicitly allowlisted public records`
- `packages/deployment-authority/src/framework.{js,test.ts}`
- `scripts/monitoring/`
- `scripts/public/`
- `scripts/security/gitleaks/`
- `scripts/security/lib/framework-template-safety.test.ts`
- `scripts/security/framework-template-safety.ts`
- `scripts/security/lib/framework-template-safety.ts`
- `scripts/security/scan-framework-secrets.sh`
- `scripts/aws/`
- `scripts/skills/`
- `tooling/** except explicitly allowlisted public configuration/runtime files`
- `infra/terraform/legacy/main.tfvars`
- `infra/terraform/legacy/develop.tfvars`
- `input.json`
- `verification.json`
- `included-bitmap.json`
- `seen-bitmap.json`
- `infra/image-signature-verifier/bin/`
- `infra/image-signature-verifier/libexec/`
- `infra/image-signature-verifier/trust/`
- `infra/image-signature-verifier/installation.json`
- `infra/image-signature-verifier/trustpolicy.json`

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
