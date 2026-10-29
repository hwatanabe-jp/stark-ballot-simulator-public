# Active Roadmap

This page summarizes forward-looking work. Current code and tests define
implemented behavior. The public [zkVM decision records](./zkvm/decisions/README.md)
and [formal phase plans](../formal/docs/README.md) retain selected design history;
private operational history stays outside the public documentation set.

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
- Reconcile deployed development and production sources with selected repository
  changes using the existing deployment and approval boundaries; neither is at
  latest HEAD as of the September 14, 2026 owner update. Legacy account deletion
  is complete and is not a platform prerequisite.
- Build the on-demand Backstage portfolio with anonymous access to reviewed
  public content, authenticated owner operations, and a static S3/CloudFront
  explanation at the same hostname while the runtime is stopped.

## Source of Truth

- Runtime behavior: `apps/`, `packages/`, `infra/docker/`, and
  `infra/terraform/`
- Verification contract: [verification pipeline](./verification/README.md)
- zkVM design and evidence: [zkVM documentation](./zkvm/README.md)
- AWS architecture: [architecture overview](./architecture/aws-architecture.md)
- Runtime diagnosis: [runbooks](./runbooks/README.md)

Roadmap items are priorities, not completion claims. A change is complete only
when its implementation and proportionate verification evidence agree.
