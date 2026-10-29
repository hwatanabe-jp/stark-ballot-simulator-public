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
session creation even for correctly gated requests and disabling the two
SQS-to-Lambda event-source mappings, the Batch prover job queue, and the
scheduled finalization sweep.
It is not a browser profile and does not authorize a production target.

### Runtime Flow and API Identity

```text
Users / browsers
  |- main -> Cloudflare -> CloudFront token, Host, and client-IP admission
  `- develop -> CloudFront operator/tester signed-cookie gate

Target CloudFront distribution
       |- static assets -> private S3 frontend through OAC
       `- /api and /api/*
            + X-Stark-Ballot-Origin-Verify
            -> API Gateway Regional REST API (live stage)
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
                           1. Lambda signature-verifier published version
                              verifies the accepted, digest-pinned Prover
                           2. submit Batch job requiring 1 of 2 shared slots
                           3. Batch launches an on-demand Fargate container
                           4. container asks finalization-writer to admit RUNNING
                           5. admitted Prover reads/writes private S3 objects
                           6. Batch releases the slot after attempt termination
                           7. finalization-writer persists terminal state

One-minute EventBridge schedule
  -> Lambda: finalization-writer
  -> reconcile finalization outcomes in DynamoDB independently of API reads

Runtime logs and metrics
  -> CloudWatch Logs, metric filters, alarms, and dashboard
  |- exact verification-invariant contradiction -> invariant SNS notification
  `- damped operational alarms -> EventBridge -> isolated ops-actionable SNS

Owned CodePipeline failure events
  -> EventBridge -> isolated ops-actionable SNS

CloudWatch alarm, Batch job completion, pipeline, and accepted-deployment events
  -> EventBridge input transformation
  -> Lambda: semaphore-janitor (retained name; operations-ledger normalizer)
       validates reduced records, derives timestamps, and writes the ledger
  -> retained CloudWatch operations ledger
```

The diagram shows the successful proving sequence. Signature rejection,
queue deadline, Batch failure, timeout, and callback failure follow explicit
fail-closed paths; none may be presented as a successful finalization.
Step Functions invokes the signature verifier through its immutable,
version-qualified Lambda ARN.

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

Bootstrap is a local administrator saved-plan operation. Source defines four
QUEUED managed pipelines with one concurrent build per project:

| Pipeline   | Projects | Mutation sequence                                                                        |
| ---------- | -------- | ---------------------------------------------------------------------------------------- |
| Foundation | 3        | Plan → approval → Apply → Smoke/checkpoint                                               |
| App        | 4        | Plan/release resolution → approval → Apply → frontend → Smoke/checkpoint                 |
| Toolchain  | 2        | Candidate approval → build/validate → promotion approval → promotion                     |
| Prover     | 3        | PrepareImage → candidate approval → build/validate/sign → promotion approval → promotion |

App also owns one independent Status project, giving each target thirteen
active CodeBuild projects. After successful App execution, EventBridge and
Step Functions schedule that project against the exact accepted source.
Status delivery can lag or fail independently of deployment acceptance.

Each target owns separate state, roles and records. GitHub Actions may
start/observe permitted pipelines without reading state or secrets. The exact
project ARN constrains CodeBuild trust; runtime admission binds the native
build, action, pipeline execution and source. The detached Status project
instead admits the successful App execution and current checkpoint. Only
candidate builds are privileged.

```text
Local administrator -> Bootstrap saved plan -> explicit approval -> Apply
  -> no-change Smoke -> Bootstrap checkpoint

Exact source -> four managed pipelines
  Foundation -> plan package -> approval -> Apply/Smoke -> checkpoint
  Toolchain -> candidate -> approved versioned promotion
  Prover <- Foundation + exact Toolchain promotion
    -> candidate -> approved versioned promotion
  App <- Foundation + image authority
    -> signature check + plan package -> approval
    -> Apply -> frontend -> Smoke/checkpoint

Successful App execution -> EventBridge -> Step Functions
  -> exact-source Status project -> public status projection

Local drift -> one root-specific read role
  -> checkpoint recipe/source/tools/artifacts -> refresh plan -lock=false
  -> redacted no-drift / drift-detected / check-failed result
```

Plan packages are immutable exact S3 references. Successful Smoke writes one
versioned checkpoint per root. A CAS mutation owner and create-only action starts
reject stale execution and retries across Apply, frontend and publication.
Partial deployment never advances successful authority. Status conditionally
publishes a public DTO derived from the current checkpoint; it does not claim
mutation ownership or authorize deployment. Old records remain frozen audit history.

Image candidates remain immutable; promotion contains their exact reference and
approval/revalidation. Current dependency checks remain separate from original
build provenance. Compatible images can be reused across unrelated IaC changes.
Native ECR count policies may delete required digests; recovery requires rebuild,
promotion and a fresh App plan and approval.

Local drift reconstructs the successful checkpoint using exact source, tools,
provider lock and artifacts. Its child receives only root-specific read
credentials. State, owner and active-execution checks before/after reject
concurrent-change conclusions. Drift cannot write state, lock or authority.

### Exceptional Initialization

First publication is explicit and binds absence expectations into the reviewed
plan. Failed reads never imply absence. A new target first creates backend
storage through the bounded local initializer, then follows the full local
Bootstrap flow. Existing targets retain their backend and successful checkpoints
through recurring operations; initialization is not a repair path. Each new
production operation requires its own authorization and observed acceptance.

## Cross-Cutting Boundaries

- **Account boundary:** the management account is limited to Organizations,
  IAM Identity Center, billing, and guardrails. Workloads, state, artifacts,
  pipelines, and runtime resources belong in member accounts.
- **State boundary:** Bootstrap owns the deployment control plane, backend
  grants, protected checkpoint storage, and root-specific local drift roles;
  Foundation owns prerequisites and its acceptance, including the shared
  account/region API Gateway logging role and account setting; App owns
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
  proving run. Both repositories use native retention of the newest five images, including
  tagged and currently used images. Repositories remain destroy-protected;
  a retained record does not guarantee that its digest still exists.
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
