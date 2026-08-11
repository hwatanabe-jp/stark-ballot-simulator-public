# AWS Architecture (Current Repository Target)

This document summarizes the AWS architecture defined by the repository. It
describes the target design, not a claim that every checked-in resource is
currently deployed. Dated account-specific deployment evidence and observed
drift belong in the private operator inventory.

## Runtime Architecture

In its normal active posture, the target runtime has two durable asynchronous
paths: finalization/proving and verification. Both begin at the Hono API, but
each uses its own SQS queue and worker.

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
                 |- POST /api/sessions/:sessionId/finalizations/:finalizationId/verification
                 |    -> SQS verification-work queue (+ DLQ)
                 |    -> Lambda: verification-worker
                 |         |- read session/evidence state from DynamoDB
                 |         |- write terminal verification state to DynamoDB
                 |         `- write public bundle + protected report to private S3
                 |
                 `- POST /api/sessions/:sessionId/finalizations
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
  |- exact verification-invariant contradiction -> invariant SNS notification
  `- damped operational alarms -> EventBridge -> isolated ops-actionable SNS

Owned CodePipeline failure events
  -> EventBridge -> isolated ops-actionable SNS

CloudWatch alarm, ECS stop, pipeline, and accepted-deployment events
  -> EventBridge normalization
  -> retained CloudWatch operations ledger
```

The diagram shows the successful proving sequence. Signature rejection,
capacity exhaustion, ECS failure, timeout, and callback failure follow explicit
fail-closed paths; none may be presented as a successful finalization.

The develop-only recovery posture uses the
`target-aws-async-quiesced` server profile. It keeps the DynamoDB/S3-backed
target available for controlled recovery work while rejecting new public
session creation and disabling both SQS-to-Lambda event-source mappings. It is
not a browser profile, does not describe the normal active posture above, and
does not authorize a production target.

The public lifecycle surface is path-authoritative:

- `POST /api/sessions/:sessionId/finalizations` creates the current
  finalization.
- `GET /api/sessions/:sessionId/finalizations/current` reads it.
- `POST /api/sessions/:sessionId/finalizations/:finalizationId/cancel` cancels
  the matching pending/running finalization.

These routes use only `X-Session-Capability` for session authentication and
return the same discriminated `FinalizationResource`. One `finalizationId`
(`finalization_id` in snake-case repository events) spans the lifecycle,
verification work/observation, and artifact locators. The API-local callback is
`POST /api/internal/sessions/:sessionId/finalizations/:finalizationId/callback`;
it is registered only by the full Hono server and is outside the public route
inventory and CORS surface.

The verification surface preserves that exact path identity:

- `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification`
  returns a strict grouped availability resource; `include=journal` opts into
  the journal group.
- `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification`
  starts server-side receipt verification with a strict empty body.
- `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations`
  accepts telemetry-only `{ castChecks: ... }`.

All three require the matching capability and reject path/finalization
mismatch. Browser-local cast checks and the shared presentation policy derive
display eligibility without changing server proof authority or verdict
semantics.

Queue consumers distinguish strict semantic records with
`recordType: "prover-work"` and `recordType: "verification-work"`. AWS-native
Step Functions execution names, ARNs, and statuses remain orchestration
vocabulary rather than a second repository lifecycle identity.

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
       |    -> daily reference-aware ECR-retention controller
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
       |    -> dedicated full-App transient execution bucket
       |    -> app Terraform state
       |       stark-ballot-simulator/<account-alias>/<environment>/
       |         app/terraform.tfstate
       |    -> accepted App deployment in retained authority storage
       |                         |
       `- App static-fast lane <-'
            -> validate the current accepted App deployment
            -> dedicated static-fast transient execution bucket
            -> frontend diff gate/build, static deploy, lightweight smoke
            -> no Terraform state mutation

Successful Bootstrap / Foundation / App smoke
  -> immutable accepted-Terraform-baseline evidence
       |- Bootstrap and Foundation -> root-specific current pointers
       `- App -> selected through the accepted App execution and attempt

Weekly EventBridge Scheduler
  -> report-only Terraform drift coordinator
       |- Bootstrap drift runner
       |- Foundation drift runner
       `- App drift runner
  -> accepted historical configuration + refresh plan with -lock=false
  -> create-only redacted drift reports
  `- failed schedule delivery -> missed-run SQS DLQ

Separately authorized on-demand starts
  |- rollback-readiness CodeBuild project
  `- DynamoDB recovery-readiness CodeBuild project
  -> create-only readiness evidence
```

Full App and static-fast execution artifacts are isolated in separate private,
versioned, encrypted transient buckets. The retained App bucket remains a
different authority boundary for accepted deployments, deployables, approval
and verifier evidence, and cache objects; neither transient lane gains general
access to the other's storage.

The accepted-baseline, drift, and readiness paths are evidence planes, not
deployment lanes. Drift runners reconstruct the accepted historical source and
can refresh and plan only; they cannot Apply, write Terraform state, move an
accepted pointer, approve a saved plan, or remediate a result. The two readiness
projects are distinct, on-demand, report-only identities and likewise cannot
select or execute a rollback or recovery transition.

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

Report-only drift and readiness executions are intentionally outside this
approval table: starting or reviewing one does not authorize any deployment or
mutation.

The `stark-prod/main` Terraform and pipeline shapes are repository contract
evidence only. There is no authorized live production deployment path.

## Cross-Cutting Boundaries

- **Account boundary:** the management account is limited to Organizations,
  IAM Identity Center, billing, and guardrails. Workloads, state, artifacts,
  pipelines, and runtime resources belong in member accounts.
- **State boundary:** Bootstrap owns the deployment control plane, backend
  grants, accepted-Terraform-baseline authority, and report-only drift/readiness
  resources; Foundation owns prerequisites and immutable handoffs; App owns
  frontend, API, data, asynchronous runtime, proof/report artifacts, and
  runtime observability resources.
- **Admission boundary:** the current develop target is operator-gated.
  CloudFront protects both the static site and `/api/*`, and injects the
  origin-verification header expected by the API. This does not authorize
  normal public admission. During the develop-only quiesced recovery posture,
  even correctly gated requests cannot create new public sessions.
- **API boundary:** the Hono API is the browser/CLI authority for session state,
  mutations, verification runs, and capability-checked bundle/report delivery.
  Direct API Gateway or origin access is diagnostic evidence, not a public
  bypass.
- **Artifact boundary:** the proof/report bucket is private. Public bundles are
  admitted against one default-deny manifest. `input.json`, `verification.json`,
  `included-bitmap.json`, `seen-bitmap.json`, raw bitmap sidecars, vote
  openings, and private locators must not become public bundle members or
  static frontend artifacts.
- **Deployment-storage boundary:** full App and static-fast transient execution
  buckets are isolated from each other and from retained App authority. Their
  temporary pipeline objects are not accepted-deployment records, deployables,
  approvals, verifier evidence, or cache authority.
- **Image boundary:** Foundation owns the Prover signing authority; release
  lanes establish the accepted Toolchain and Prover artifacts; App verifies the
  exact accepted Prover signature before deployment and again before each
  proving run. Foundation's daily reference-aware retention controller protects
  current Toolchain/Prover acceptance, retained App accepted/rollback
  references, the live Prover task definition, and each protected subject's
  referrers. It skips mutation during governed pipeline, candidate-build,
  finalization, or Prover-task activity; it is retention policy, not release or
  deployment authority.
- **Observability boundary:** logs, metrics, alarms, the operations ledger, and
  the isolated invariant and ops-actionable notification routes are diagnostic
  evidence only. Telemetry must never alter the verification verdict or trigger
  automated remediation.
- **Retired surfaces:** Amplify Hosting, Amplify Data/AppSync, and Next.js route
  wrappers are historical and are not target runtime or deployment authority.

## Related Authorities

- [Infrastructure documentation](../infrastructure/README.md)
- [Terraform ownership](../infrastructure/terraform.md)
- [Verification pipeline](../verification/README.md)

The private source repository additionally retains the operator index, release
model, and current live inventory; public snapshots intentionally omit them.
