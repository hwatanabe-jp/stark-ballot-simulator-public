# Active Roadmap

This page is the current entry point for forward-looking work. Historical phase-by-phase progress records are kept in the private source repository and stripped from generated public snapshots.

## Current Focus

The project is in public-readiness work:

- keep current documentation clear about the public/private repository boundary
- harden monitoring and runbooks for the demo deployment
- keep verification UX, knowledge-panel behavior, and bundle/report
  delivery aligned with current code
- preserve the product invariant that the UI never shows `Verified`
  unless all required checks pass

## Source Of Truth

- Runtime behavior: current code in `src/`, `docker/`, `amplify/`, and
  `terraform/`
- Verification contract: `docs/current/verification/README.md`
- zkVM design contract: `docs/current/guides/6-zkvm_design/final_design.md`
- AWS operations: `docs/current/runbooks/` and
  `docs/current/guides/7-terraform/README.md`
- Historical roadmap and phase notes are kept in the private source repository.

## Archived Phase 10 Plan

The previous phase-based launch-prep plan is retained in private source history. Treat archived planning context as non-evergreen.
