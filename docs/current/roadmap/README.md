# Active Roadmap

This page is the current entry point for forward-looking work. Historical
progress records remain in the private source archive and are stripped from
generated public snapshots.

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
- Historical roadmap notes: private source archive only

## Archived Launch-Prep Plan

The previous numbered launch-prep plan remains archived in the private source
repository. Treat it as planning context, not an evergreen specification.
