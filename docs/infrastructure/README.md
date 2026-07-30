# Infrastructure and Cloud Security

This area describes the current target AWS architecture, Terraform ownership,
release-lane boundaries, and public cloud-security guidance. Account-specific
commands, live status, approvals, and change procedures remain in private
operator documentation; this page does not authorize an AWS change.

## Guide Catalog

| Guide                                                           | Scope                                                            | Use it when                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| [Terraform infrastructure](./terraform.md)                      | Bootstrap, foundation, and app ownership and execution model     | IaC or runtime ownership matters               |
| [RISC Zero ARM64 toolchain image](./risc0-base-image.md)        | Toolchain rebuild and promotion lane                             | The toolchain image changes                    |
| [AWS Security Hub](./aws-security-hub.md)                       | Low-cost Security Hub and AWS Config monitoring                  | Reviewing cloud security signals               |
| [AWS architecture](../architecture/aws-architecture.md)         | Public target runtime and deployment-control architecture        | Reviewing the system design                    |
| [AWS runtime operations](../runbooks/aws-runtime-operations.md) | Read-only-first diagnosis and recovery boundary                  | A deployed flow is unavailable or inconsistent |
| [Security runbook](../runbooks/security.md)                     | CSP, Turnstile, rate limits, image security, and incident checks | Reviewing application or edge security         |

Migration history explains how the system arrived here; it is not deployment
authority.

## Current Target Model

This diagram summarizes the repository target. Dated live status and any
repository-to-deployment drift remain in the private current AWS inventory.

```text
Browser
  -> CloudFront
     -> private S3 static frontend
     -> API Gateway HTTP API
        -> Hono public-api Lambda
           -> DynamoDB
           -> SQS prover work
              -> dispatcher Lambda
                 -> Step Functions finalization
                    -> cryptographic image-signature verifier
                    -> acquire DynamoDB prover semaphore slot
                    -> finalization writer persists running state
                    -> ECS/Fargate ARM64 prover
                    -> release semaphore slot and persist terminal state
           -> SQS verification work
              -> verification-worker Lambda
           -> private proof/report S3 bucket
```

Deployment control is separated into bootstrap and foundation saved-plan
lanes, toolchain and prover release lanes, an app saved-plan lane, and a
develop-only static fast lane for allowlisted presentation changes. The
retired Amplify, Next.js, and AppSync surfaces are not part of the current
target runtime.

## Selection Rules

- Static presentation-only changes may use the develop static fast lane.
- Every new source SHA used by a normal full App deployment first requires the
  same-SHA Foundation lane, then the App lane.
- The App lane may reuse an accepted Prover from another source only when its
  immutable release record has a `zkvmContractHash` exactly matching the hash
  recomputed from the App source. The Prover record must exact-link its
  selected immutable Toolchain artifact, whose source SHA may also differ.
- Run the Prover lane only when the Prover image contents, ImageID or method
  version, selected Toolchain, or zkVM interface hash changes. Prover and guest
  changes therefore require a Prover release followed by the App lane.
- Run the Toolchain lane only when its contents or accepted selection changes.
  `build` creates a new image; `existing` validates one exact retained
  artifact without rebuilding it, then promotes a current semantic record that
  preserves the original build provenance. A Toolchain change is followed by
  the Prover and App lanes.
- ImageID mapping changes are never static-only.
- Secret and CloudFront-key rotation requires a dedicated compatibility
  analysis.
- `stark-prod/main` has no authorized live deployment path yet.

## Security Routing

| Concern                               | Public authority                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Web and admission controls            | [Security runbook](../runbooks/security.md)                                                                             |
| STARK and zkVM verification           | [Verification pipeline](../verification/README.md) and [proof structure](../zkvm/stark-proof-structure.md)              |
| Terraform, IAM, S3, and ECR ownership | [Terraform infrastructure](./terraform.md)                                                                              |
| AWS Security Hub and Config           | [AWS Security Hub](./aws-security-hub.md)                                                                               |
| Public snapshot safety                | `docs/PUBLIC_REPOSITORY.md` in generated snapshots and [`scripts/security/README.md`](../../scripts/security/README.md) |

Secret values, concrete account identifiers, signed credentials, private
artifact bodies, and live inventory must not appear in public documentation.

## Shared Safeguards

- Verify the intended profile, account, role, region, source revision, state
  scope, and backend key before starting an authorized lane.
- Apply Terraform only through the AWS-managed saved-plan role for the target
  root.
- Keep prover image references digest-pinned and preserve the ImageID/method
  version trust chain.
- Treat pipeline smoke and the gated browser/CLI flow as distinct evidence.
- Do not treat `RISC0_DEV_MODE=1` as production STARK proof evidence.
