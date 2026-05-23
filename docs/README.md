# Documentation

This directory is split by document freshness:

- `docs/current/` contains documents that are intended to describe the
  current implementation, current operating procedures, or current design
  contracts.
- Historical plans, old specs, completed phase notes, and proposal material are kept in the private source repository and stripped from generated public snapshots.

When code and documentation disagree, current code wins. For runtime
behavior, check `src/`, `docker/`, `amplify/`, `terraform/`, and the
nearest README for the area you are changing.

## Current Entry Points

- `docs/current/verification/README.md` - verification pipeline and bundle contract
- `docs/current/formal/README.md` - Lean model scope and generated vector outputs
- `docs/current/tests/cli.md` - CLI flow and verification test guide
- `docs/current/runbooks/aws-hybrid.md` - AWS hybrid operations
- `docs/current/guides/7-terraform/README.md` - Terraform-managed infrastructure
- `docs/current/guides/6-zkvm_design/final_design.md` - zkVM design contract
- `docs/current/roadmap/README.md` - active roadmap entry

Operational or account-specific material is kept in the private source repository and stripped from generated public snapshots.
