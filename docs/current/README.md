# Current Documentation

These documents are intended to describe the current project state. They are
still subordinate to the implementation: if a doc and code disagree, verify
the behavior in code first.

## Read First

- `verification/README.md` - verification pipeline, hard-failure semantics, and bundle boundaries
- `formal/README.md` - Lean model scope and generated vector outputs
- `tests/cli.md` - CLI command matrix, reports, bundles, and real-zkVM notes
- `runbooks/aws-hybrid.md` - AWS hybrid operational flow
- `guides/7-terraform/README.md` - Terraform-managed infrastructure
- `guides/6-zkvm_design/final_design.md` - zkVM design contract
- `zkvm-contract/index.md` - zkVM contract plans, including planned hardening work
- `roadmap/README.md` - active roadmap entry

## Areas

- `guides/` and `references/` - setup, development, architecture, deployment, security, and reference material
- `repository-baseline/` - ownership, dependency, path, and runtime boundary maps
- `verification/`, `formal/`, and `zkvm-contract/` - verification semantics, Lean artifacts, vectors, and zkVM contract notes
- `hono/` - retained API runtime notes
- `ui-redesign/` - current UI vocabulary and design contracts
- `runbooks/` - public operational procedures; private monitoring query catalogs are stripped from generated public snapshots
- `tests/` - test and CLI runbooks
- `licenses/` - generated dependency license and metadata artifacts
- `roadmap/` - active roadmap entry

Historical context is kept in the private source repository and stripped from generated public snapshots.
