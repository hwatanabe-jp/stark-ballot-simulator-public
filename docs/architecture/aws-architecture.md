# AWS Architecture (Current Repository Target)

This document summarizes the AWS architecture defined by the repository. It
describes the target design, not a claim that every checked-in resource is
currently deployed. Dated account-specific deployment evidence and observed
drift belong in the private operator inventory.

## Runtime Architecture

The target runtime has two durable asynchronous paths: finalization/proving and
verification. Both begin at the Hono API, but each uses its own SQS queue and
worker.

```text
Users / browsers
  -> CloudFront
       |- conditional develop operator/tester signed-cookie gate
       |- static assets -> private S3 frontend through OAC
       `- /api and /api/*
            + X-Stark-Ballot-Origin-Verify
            -> API Gateway HTTP API
            -> Lambda: Hono public API
                 |- session, vote, and rate-limit operations
                 |    <-> DynamoDB application-state tables
                 |
                 |- capability-checked bundle/report delivery
                 |    <- private S3 proof/report artifacts
                 |
                 |- POST /api/verification/run
                 |    -> SQS verification-work queue (+ DLQ)
                 |    -> Lambda: verification-worker
                 |         |- read session/evidence state from DynamoDB
                 |         |- write terminal verification state to DynamoDB
                 |         `- write public bundle + protected report to private S3
                 |
                 `- POST /api/finalize
                      -> SQS prover-work queue (+ DLQ)
                      -> Lambda: proof-dispatcher
                      -> Step Functions finalization
                           1. Lambda signature-verifier runtime alias
                              verifies the accepted, digest-pinned Prover
                           2. acquire slot in DynamoDB prover-semaphore table
                           3. finalization-writer persists RUNNING to DynamoDB
                           4. ECS Fargate Prover reads/writes private S3 objects
                           5. release the DynamoDB semaphore slot
                           6. finalization-writer persists terminal state

Step Functions terminal events + 30-minute schedule
  -> EventBridge
  -> Lambda: semaphore-janitor
  -> release terminal or stale owners in the DynamoDB semaphore table

Runtime logs and metrics
  -> CloudWatch Logs, metric filters, alarms, and dashboard
  -> invariant-only SNS notification

CloudWatch alarm, ECS stop, pipeline, and accepted-deployment events
  -> EventBridge normalization
  -> retained CloudWatch operations ledger
```

The diagram shows the successful proving sequence. Signature rejection,
capacity exhaustion, ECS failure, timeout, and callback failure follow explicit
fail-closed paths; none may be presented as a successful finalization.

## Deployment Control Plane

Bootstrap owns the AWS-native deployment control plane. GitHub Actions may
start and observe selected pipelines through a branch-scoped OIDC trigger role,
but it does not apply Terraform, read Terraform state, mutate runtime resources
directly, or read runtime secrets.

```text
GitHub repository (CI evidence + branch-pinned trigger)
  -> AssumeRoleWithWebIdentity
  -> narrow GitHub trigger role (start/observe selected pipelines only)
  -> Bootstrap-managed AWS CodePipeline lane families
       |
       |- Bootstrap saved-plan lane
       |    -> bootstrap Terraform state
       |       stark-ballot-simulator/<account-alias>/<environment>/
       |         bootstrap/terraform.tfstate
       |    -> control plane, backend grants, and pipeline artifacts
       |
       |- Foundation saved-plan lane
       |    -> foundation Terraform state
       |       stark-ballot-simulator/<account-alias>/<environment>/
       |         foundation/terraform.tfstate
       |    -> ECR, Prover signing authority, release storage, networking,
       |       secret/config containers, and DNS/ACM prerequisites
       |    -> immutable Foundation handoff
       |
       |- Toolchain release lane
       |    -> build or select an exact retained Toolchain artifact
       |    -> publish accepted Toolchain release authority
       |                         |
       |- Prover release lane <--'
       |    -> build against the exact Toolchain
       |    -> sign and promote a digest-pinned Prover artifact
       |                         |
       |- App full lane <--------+---- immutable Foundation handoff
       |    -> verifier state refresh when required
       |    -> cryptographic verifier preflight
       |    -> app saved plan/apply, static deploy, and post-apply smoke
       |    -> app Terraform state
       |       stark-ballot-simulator/<account-alias>/<environment>/
       |         app/terraform.tfstate
       |    -> accepted App deployment
       |                         |
       `- App static-fast lane <-'
            -> validate the current accepted App deployment
            -> frontend diff gate/build, static deploy, lightweight smoke
            -> no Terraform state mutation
```

The current develop approval boundaries are:

| Lane                        | Develop approval behavior                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap saved plan        | Human approval of the reviewed saved plan                                                                                       |
| Foundation saved plan       | Human approval of the reviewed saved plan                                                                                       |
| Toolchain release           | Candidate-execution approval in both build and retained-artifact modes, followed by separate promotion approval                 |
| Prover release              | Candidate-build approval, followed by separate promotion approval                                                               |
| App full, normal deployment | Verifier state-refresh approval only when reconciliation is needed; verifier-preflight approval; main approval if plan nonempty |
| App full, rollback          | Retained verifier authority is revalidated without preflight mutation; the main saved plan always requires approval             |
| App static fast             | No Terraform plan/apply and no human approval                                                                                   |

The `stark-prod/main` Terraform and pipeline shapes are repository contract
evidence only. There is no authorized live production deployment path.

## Cross-Cutting Boundaries

- **Account boundary:** the management account is limited to Organizations,
  IAM Identity Center, billing, and guardrails. Workloads, state, artifacts,
  pipelines, and runtime resources belong in member accounts.
- **State boundary:** Bootstrap owns the control plane and backend grants;
  Foundation owns prerequisites and immutable handoffs; App owns frontend,
  API, data, asynchronous runtime, artifact, and observability resources.
- **Admission boundary:** the current develop target is operator-gated.
  CloudFront protects both the static site and `/api/*`, and injects the
  origin-verification header expected by the API. This does not authorize
  normal public admission.
- **API boundary:** the Hono API is the browser/CLI authority for session state,
  mutations, verification runs, and capability-checked bundle/report delivery.
  Direct API Gateway or origin access is diagnostic evidence, not a public
  bypass.
- **Artifact boundary:** the proof/report bucket is private. Public bundles are
  allowlisted evidence only. `input.json`, `verification.json`,
  `included-bitmap.json`, `seen-bitmap.json`, raw bitmap sidecars, vote
  openings, and private locators must not become public bundle members or
  static frontend artifacts.
- **Image boundary:** Foundation owns the Prover signing authority; release
  lanes establish the accepted Toolchain and Prover artifacts; App verifies the
  exact accepted Prover signature before deployment and again before each
  proving run.
- **Observability boundary:** logs, metrics, alarms, the operations ledger, and
  notifications are diagnostic evidence only. Telemetry must never alter the
  verification verdict.
- **Retired surfaces:** Amplify Hosting, Amplify Data/AppSync, and Next.js route
  wrappers are historical and are not target runtime or deployment authority.

## Related Authorities

- [Infrastructure documentation](../infrastructure/README.md)
- [Terraform ownership](../infrastructure/terraform.md)
- [Verification pipeline](../verification/README.md)

The private source repository additionally retains the operator index, release
model, and current live inventory; public snapshots intentionally omit them.
