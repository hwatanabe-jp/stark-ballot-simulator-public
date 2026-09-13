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

This diagram summarizes the architecture of the accepted develop and production
deployments. Dated live status and any repository-to-deployment drift remain
in the private current AWS inventory; the diagram supplies no new live checks.

```text
Production: Browser -> Cloudflare proxy -> CloudFront authenticated admission
Develop:    Browser -> CloudFront operator signed-cookie gate

Shared routing in each target:
  CloudFront
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

Both entrances converge on the same CloudFront static/API routing model.
Production requires the exact public host and a private Cloudflare request
token before cache lookup on every viewer behavior. CloudFront strips the
token before forwarding the authenticated client-IP header. The production
public API uses `TRUSTED_PROXY=cloudflare` and accepts only a valid bare IPv4
or IPv6 address; missing or malformed headers never fall back to another
proxy address. Develop retains API Gateway client-IP attribution.

Deployment control is separated into bootstrap and foundation saved-plan
lanes, toolchain and prover release lanes, an app saved-plan lane, and a
develop-only static fast lane for allowlisted presentation changes. The
retired Amplify, Next.js, and AppSync surfaces are not part of the current
target runtime.

## Selection Rules

- Static presentation-only changes may use the develop static fast lane;
  production uses the full App saved-plan lane.
- Normal App and Prover lanes resolve one current Foundation acceptance and
  require the selected source's complete Foundation contract hash to match.
  Run Foundation first only when that contract changes; source equality is
  neither required nor sufficient.
- App may reuse a Prover from another source when its zkVM contract matches
  the App source, its candidate's Foundation closure/hash matches the selected
  Foundation, its promotion binds the exact current Foundation acceptance,
  and its immutable Toolchain link is valid.
- Run the Prover lane when its contents, ImageID/method, Toolchain, zkVM
  contract, or Foundation binding changes. An incompatible candidate requires
  a new build even when proof code is unchanged; a compatible retained
  candidate may use `existing` mode for a fresh promotion. Follow the
  [deployment selection rules](./terraform.md#selecting-a-deployment-story)
  before proceeding to App.
- Run the Toolchain lane only when its contents or accepted selection changes.
  `build` creates a new image and content-addressed candidate; `existing`
  validates one exact retained candidate key without rebuilding it. Both
  publish a content-addressed release and conditionally move the key-only
  accepted pointer. A Toolchain change is followed by the Prover and App lanes.
- ImageID mapping changes are never static-only.
- Secret and CloudFront-key rotation requires a dedicated compatibility
  analysis.
- Production operates through five lanes and accepted authority, with no
  static-fast lane. New executions remain separately authorized; initial
  construction is an exceptional path before the owning acceptance exists.

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
- Treat pipeline smoke and a voting/proof journey as distinct evidence.
  Develop uses its operator gate; production uses the public entrance with
  server-verified Turnstile.
- Do not treat `RISC0_DEV_MODE=1` as production STARK proof evidence.
