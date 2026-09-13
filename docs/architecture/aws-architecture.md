# AWS Architecture (Current Repository Target)

This document summarizes the current AWS architecture for the registered
`stark-dev/develop` and `stark-prod/main` targets, with production operating
from its accepted deployment baseline. It describes repository-owned boundaries;
dated account-specific deployment observations and validation evidence belong
in the private operator inventory. An accepted deployment does not authorize a
subsequent production execution without its required approvals.

## Runtime Architecture

In its normal active posture, the target runtime has two durable asynchronous
paths: finalization/proving and verification. Both begin at the Hono API, but
each uses its own SQS queue and worker.

### Ingress and Request Admission

Main browser traffic enters through Cloudflare before reaching CloudFront.
Every production CloudFront cache behavior runs viewer-request admission before
cache lookup. Admission requires the expected public Host, one valid
Cloudflare origin token, and one bounded client-IP header; missing or duplicate
headers fail closed. The token is checked against its reviewed SHA-256 digest
and removed before forwarding to an origin. Only the digest is retained in the
repository and Terraform state; the raw token belongs to Cloudflare's request
header configuration.

For API requests, CloudFront forwards the admitted `CF-Connecting-IP` on main.
Terraform waits for the guarded CloudFront distribution to finish deploying
before updating target Lambdas to trust Cloudflare. The public API then accepts
only a valid IP address from that header in `TRUSTED_PROXY=cloudflare` mode;
missing or malformed values never fall back to other proxy headers or the peer
address. Develop retains `TRUSTED_PROXY=api-gateway` and its operator/tester
signed-cookie gate for static and API access, independently of Cloudflare.

Both targets separately require the `X-Stark-Ballot-Origin-Verify` header
injected by CloudFront on API origin requests. Main session creation also
requires server-side Turnstile validation with action `session` and an allowed
hostname. Cloudflare ingress admission, API origin verification, and Turnstile
are separate checks.

The develop-only recovery posture uses the
`target-aws-async-quiesced` server profile. It keeps the DynamoDB/S3-backed
target available for controlled recovery work while rejecting new public
session creation even for correctly gated requests and disabling both
SQS-to-Lambda event-source mappings. It is not a browser profile and does not
authorize a production target.

### Runtime Flow and API Identity

```text
Users / browsers
  |- main -> Cloudflare -> CloudFront token, Host, and client-IP admission
  `- develop -> CloudFront operator/tester signed-cookie gate

Target CloudFront distribution
       |- static assets -> private S3 frontend through OAC
       `- /api and /api/*
            + X-Stark-Ballot-Origin-Verify
            -> API Gateway HTTP API
            -> Lambda: Hono public API
                 |- main session creation -> server-side Turnstile validation
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
directly, or read runtime secrets. Each target selects its own registered lanes,
state, artifacts, and retained authority. Retained records must match that
selected target; a record cannot select another account or environment.

| Target              | Deployment lanes                                           | CodeBuild projects | Static frontend publication |
| ------------------- | ---------------------------------------------------------- | ------------------ | --------------------------- |
| `stark-dev/develop` | Bootstrap, Foundation, Toolchain, Prover, App, static-fast | 27                 | Full App or static-fast     |
| `stark-prod/main`   | Bootstrap, Foundation, Toolchain, Prover, App              | 24                 | Full App                    |

Each count includes three report-only Terraform drift runners. All projects
select checked-in buildspecs. Pipeline notifications and the operations ledger
follow the target's registered pipeline set.

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
       |
       |- Toolchain release lane
       |    -> build/publish or select one content-addressed candidate
       |    -> publish a content-addressed release
       |    -> first-create or CAS the key-only accepted pointer
       |                         |
       |- Prover release lane <--'
       |    -> resolve one accepted or pinned Toolchain release key
       |    -> build and sign against the exact digest-pinned Toolchain image,
       |       or revalidate an existing candidate without image mutation
       |    -> publish a content-addressed release for the digest-pinned Prover
       |    -> first-create or CAS the key-only accepted pointer
       |
       |- App full lane (normal, accepted inputs)
       |    <---- Foundation acceptance + image releases
       |    -> ResolveRelease selects Foundation, Toolchain, and Prover authority
       |    -> cryptographic verifier preflight
       |    -> TerraformPlan runs folded source gates, prepares execution and
       |       current-App authority, and creates the saved plan
       |    -> ManualApproval (proven-empty skip only for normal develop)
       |    -> apply, static deploy, smoke
       |    -> current-status publication from the accepted App history
       |    -> app Terraform state
       |       stark-ballot-simulator/<account-alias>/<environment>/
       |         app/terraform.tfstate
       |
       `- App static-fast lane (develop only)
            -> validate the current App acceptance projection
            -> frontend diff gate/build, static deploy, lightweight smoke
            -> no Terraform state mutation

Successful Bootstrap / Foundation / App smoke
  -> isolated publication of content-addressed accepted reconstruction authority
       |- Bootstrap and Foundation -> root-specific current pointers
       `- App -> one bounded-history current pointer

Explicit on-demand drift request
  -> bounded starter with both request guards
       `- exactly one selected root runner
            |- Bootstrap drift runner
            |- Foundation drift runner
            `- App drift runner
  -> accepted historical configuration + refresh plan with -lock=false
  `- create-only redacted drift report
```

The full App sequence above shows normal deployment with accepted inputs:
`ResolveRelease` selects current Foundation, Toolchain, and Prover authority
once, and TerraformPlan
separately selects current App authority. Rollback instead selects one reachable
retained App acceptance other than the current head and uses its Foundation,
image, verifier, and deployable authority without resolving current Foundation
or image-release pointers.

Each target's full App execution artifacts use a private, versioned, encrypted
transient bucket. Develop's static-fast lane has its own isolated transient
bucket. The retained App bucket remains a different authority boundary for
App acceptances, deployables, approval
and verifier evidence, and cache objects. Develop's two execution lanes cannot
access each other's transient storage.

Frontend publishers use one target-specific conditional S3 lease; in develop,
full App and static-fast share it. Each publisher verifies its exact ownership
before every frontend-object mutation and around invalidation and evidence publication,
then releases it conditionally. A competing publisher can take over only after
an exact CodeBuild observation proves the holder's build complete with an
admitted terminal status; elapsed time does not authorize takeover.

Frontend content identity binds sorted regular-file paths, byte lengths, and
SHA-256 digests. Publication uploads every selected file with its exact checksum
before deleting stale frontend keys. Rollback's deployable authority remains
the selected acceptance's exact retained archive SHA-256 and S3 VersionId.

Drift runners reconstruct the accepted historical source and can refresh and
plan only; they cannot Apply, write Terraform state, move an accepted pointer,
approve a saved plan, or remediate a result. Runs are explicitly requested per
root through the guarded starter shown above, with no recurring drift schedule.
Rollback and recovery have no report-only readiness project or report
prerequisite: each real operation uses its separately authorized current lane
or bounded recovery procedure, with a fresh plan and approval for every mutation.

The managed lanes enforce these approval boundaries:

| Lane                              | Develop                                                                                                           | Main                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Bootstrap / Foundation saved plan | Human approval of the reviewed saved plan, including semantic no-ops                                              | Same                                                                            |
| Toolchain / Prover release        | Candidate-execution approval in both build and retained-candidate modes, then separate promotion approval         | Same                                                                            |
| App full, normal deployment       | Mandatory verifier-preflight approval; full-plan `ManualApproval` may be skipped only for a proven semantic no-op | Mandatory verifier-preflight and full-plan approvals, including semantic no-ops |
| App full, rollback                | Retained verifier authority is revalidated without preflight mutation; full-plan approval is always required      | Same                                                                            |
| App static-fast                   | No Terraform plan/apply or human approval                                                                         | Absent                                                                          |

Report-only drift executions are intentionally outside this approval table:
starting or reviewing one does not authorize any deployment or mutation.

### Exceptional Initialization

Accepted deployments use the routine authority selection described above.
Initialization requires explicit inputs and separate approvals; absence or a
failed read never selects it implicitly. The following paths describe first
construction when separately authorized, rather than outstanding production
rollout work.

Bootstrap first construction uses explicit initialization inputs. Its bounded
initializer applies separately approved backend and control-plane seed plans, then hands an exact versioned manifest to the managed
`BootstrapInputMode=initial` execution. The managed saved plan still requires
review, approval, Apply, and successful Smoke before first acceptance publication.
Ordinary Bootstrap executions select accepted authority.

Foundation then uses its ordinary saved-plan lane. First main review admits
uncreated state only from a complete create-only plan and version inventories
proving no prior state or acceptance pointer; Terraform lock history is checked
separately. Apply rechecks that absence before backend initialization, and owning
Smoke must succeed before the first Foundation acceptance is published.

After Foundation and image authority exist, App initialization uses two explicit
executions of the existing full pipeline. `AppInputMode=verifier-prerequisite`
creates the closed verifier dependency scope through its own saved-plan approval
and skips the following App stages. `AppInputMode=initial` then observes the real
verifier version and aliases, runs normal verifier reconciliation and preflight,
and proceeds through the full saved-plan, approval, deployment, and smoke path.
Successful initial smoke publishes the first App acceptance and generation-one
history pointer by conditional first creation. Ordinary `AppInputMode=accepted`
never infers initialization from missing authority or a failed read; later
publications use the observed pointer for compare-and-swap.

## Cross-Cutting Boundaries

- **Account boundary:** the management account is limited to Organizations,
  IAM Identity Center, billing, and guardrails. Workloads, state, artifacts,
  pipelines, and runtime resources belong in member accounts.
- **State boundary:** Bootstrap owns the deployment control plane, backend
  grants, accepted reconstruction authority, and report-only drift resources;
  Foundation owns prerequisites and its acceptance; App owns
  frontend, API, data, asynchronous runtime, proof/report artifacts, and
  runtime observability resources.
- **Admission boundary:** the target-specific ingress, origin, and session
  checks in [Ingress and Request Admission](#ingress-and-request-admission)
  apply independently of session capabilities and proof verification.
- **API boundary:** the Hono API is the browser/CLI authority for session state,
  mutations, verification runs, and capability-checked bundle/report delivery.
  Direct API Gateway or origin access is diagnostic evidence, not a public
  bypass.
- **Artifact boundary:** the proof/report bucket is private. Public bundles are
  admitted against one default-deny manifest. `input.json`, `verification.json`,
  `included-bitmap.json`, `seen-bitmap.json`, raw bitmap sidecars, vote
  openings, and private locators must not become public bundle members or
  static frontend artifacts.
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

## Related Authorities

- [Infrastructure documentation](../infrastructure/README.md)
- [Terraform ownership](../infrastructure/terraform.md)
- [Verification pipeline](../verification/README.md)

The private source repository additionally retains the operator index, release
model, and current live inventory; public snapshots intentionally omit them.
