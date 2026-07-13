# Active Roadmap

This page summarizes forward-looking work. Current code and tests remain the
source of truth; completed plans and historical progress notes are retained
outside the public documentation set.

## Current Focus

- Preserve the invariant that the UI never shows `Verified` unless every
  required cryptographic and consistency check passes.
- Keep verification UX, knowledge-panel behavior, and authenticated
  bundle/report delivery aligned with the implementation.
- Maintain reproducible ImageID, method-version, journal, bitmap, and input
  commitment evidence across TypeScript and Rust boundaries.
- Improve reviewer-facing architecture, formal-evidence, and operational
  documentation without expanding the PoC into a production voting claim.
- Continue read-only-first monitoring and runbook hardening for the deployed
  develop environment.
- Treat production bootstrap, public admission, DNS cutover, and retirement of
  legacy infrastructure as separately authorized follow-up work.

## Source of Truth

- Runtime behavior: `apps/`, `packages/`, `infra/docker/`, and
  `infra/terraform/`
- Verification contract: [verification pipeline](./verification/README.md)
- zkVM design and evidence: [zkVM documentation](./zkvm/README.md)
- AWS architecture: [architecture overview](./architecture/aws-architecture.md)
- Runtime diagnosis: [runbooks](./runbooks/README.md)

Roadmap items are priorities, not completion claims. A change is complete only
when its implementation and proportionate verification evidence agree.
