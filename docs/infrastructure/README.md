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

This diagram summarizes the checked-in architecture for develop and production
targets. Dated deployment evidence and any repository-to-deployment drift remain
in the private current AWS inventory; source changes do not establish live state.

```text
Production: Browser -> Cloudflare proxy -> CloudFront authenticated admission
Develop:    Browser -> CloudFront operator signed-cookie gate

Shared routing in each target:
  CloudFront
     -> private S3 static frontend
     -> API Gateway REST API
        -> Hono public-api Lambda
           -> DynamoDB
           -> SQS prover work
              -> dispatcher Lambda
                 -> Step Functions finalization
                    -> cryptographic image-signature verifier
                    -> AWS Batch job queue and replenishable capacity
                       -> Fargate ARM64 prover container starts
                          -> finalization writer admits and persists running state
                          -> proof execution
                    -> finalization writer terminal callback
           -> SQS verification work
              -> verification-worker Lambda
           -> private proof/report S3 bucket

  EventBridge (every minute)
     -> finalization writer reconciles persisted outcomes
```

Batch owns capacity allocation and replenishment. Container start admission
precedes input reads and proof execution; Step Functions delivers the terminal
callback. Scheduled reconciliation runs independently of API reads and pauses
while the application is quiesced.

Both entrances converge on the same CloudFront static/API routing model.
Production requires the exact public host and a private Cloudflare request
token before cache lookup on every viewer behavior. CloudFront strips the
token before forwarding the authenticated client-IP header. The production
public API uses `TRUSTED_PROXY=cloudflare` and accepts only a valid bare IPv4
or IPv6 address; missing or malformed headers never fall back to another
proxy address. Develop retains API Gateway client-IP attribution.

Deployment control uses local Bootstrap and local drift, plus four managed
pipelines: Foundation, Toolchain, Prover and App. Each target defines twelve
pipeline CodeBuild projects and one asynchronous App status publisher, for
thirteen projects total. Source topology and deployed target observations are separate.

## Selection Rules

- App and static changes use the full App plan and approval, including no-ops.
- Current Foundation consumer requirements and image digest, signature, ImageID
  and method contracts must agree before deployment.
- Image candidate provenance is immutable. Unrelated IaC changes or same-digest
  Toolchain promotion do not require image rebuilds.
- Image `existing` selection revalidates the exact candidate without rebuilding.
  Candidate execution and promotion have separate approvals.
- Both ECR repositories retain the newest five images with native count rules;
  required images can expire. Missing images require authorized rebuild and
  fresh deployment, with no fallback to stale records.
- Future production changes require independent authorization and observation.

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
- Apply Foundation/App through their managed saved-plan roles; Bootstrap uses
  the protected local administrator workflow.
- Keep prover image references digest-pinned and preserve the ImageID/method
  version trust chain.
- Treat pipeline smoke and a voting/proof journey as distinct evidence.
  Develop uses its operator gate; production uses the public entrance with
  server-verified Turnstile.
- Do not treat `RISC0_DEV_MODE=1` as production STARK proof evidence.
