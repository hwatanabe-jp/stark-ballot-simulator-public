# Active Roadmap

This page is the current entry point for forward-looking work. Historical
phase-by-phase progress records live in `docs/archive/progress/`.

## Current Focus

The project is in public-readiness work:

- keep current documentation clear about what is public-facing and what
  belongs under `docs/current/internal/`
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
- Historical roadmap and phase notes: `docs/archive/progress/`

## Archived Phase 10 Plan

The previous phase-based launch-prep plan is archived at
`docs/archive/progress/phase10-launch-prep.md`. Treat it as planning
context, not an evergreen specification.
