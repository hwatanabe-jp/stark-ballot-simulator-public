# Terraform Infrastructure Guide

> **Status:** current target-account Terraform ownership and execution guide.
> Last reconciled against repository implementation: 2026-09-11. The retired
> Amplify/local-workspace workflow is deliberately excluded and must not be used
> as a target deployment path.

Terraform separates application runtime, foundation prerequisites, and
deployment control into distinct roots and states. Routine changes are applied
by AWS-managed CodePipeline/CodeBuild lanes, not by local Terraform `plan` or
`apply`.

Account-specific procedures start at the operator index retained in the private
source repository. This page records only the ownership model and guardrails
that are safe to keep in general project documentation.

`packages/deployment-authority/deployment-targets.json` is the single reviewed
cross-runtime authority for allowed targets and their exact lane, state,
backend, policy, and generated-name values. The three active Terraform roots
decode that file directly and fail closed unless their inputs match the selected
target. The `@stark-ballot/deployment-authority` package owns the matching
context, immutable-reference, publication, saved-plan, and acceptance
admission rules. The caller selects the target before reading authority, and
all retained inputs must match that target; consumers must not reconstruct
names or allow evidence to select a different account.

The registered targets are `stark-dev/develop` with six lanes and
`stark-prod/main` with five. Both have Bootstrap, Foundation, Toolchain, Prover,
and App lanes; static-fast is develop-only. Ordinary development and production
operations consume accepted authority through these lanes. Exceptional first
construction is described separately below. Repository checks and target
registration do not replace retained approvals, smoke, or acceptance evidence;
dated live observations remain in the private inventory.

## Terraform roots

| Root                          | State identity                             | Owns                                                                                                                                                                                                                                                 | Does not own                                                                                                 |
| ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `infra/terraform/bootstrap/`  | `<account-alias>/<environment>/bootstrap`  | Remote state and durable Terraform authority storage/KMS, CodeConnections, CodePipeline/CodeBuild and report-only projects, deploy roles, retained and execution artifact buckets, backend grants, CodeBuild log groups, and the GitHub trigger role | App runtime, ECR workloads, secret values, production authorization                                          |
| `infra/terraform/foundation/` | `<account-alias>/<environment>/foundation` | ECR repositories and managed Prover signing, reference-aware ECR retention, prover networking, release storage, secret containers, non-secret config containers, and DNS/ACM handoff records                                                         | Lambda/API/DynamoDB/SQS/Step Functions/ECS tasks/CloudFront/static and proof buckets, image builds           |
| `infra/terraform/app/`        | `<account-alias>/<environment>/app`        | Static frontend, CloudFront and operator-gate keys, API Gateway/Hono Lambda, DynamoDB, SQS, Step Functions, ECS task definition, proof/report storage, alarms and notification routing, the operations ledger, and runtime wiring                    | ECR repository creation, image publication, secret values, DNS zones, ACM issuance, production authorization |
| `infra/terraform/legacy/`     | Retired legacy workspace/state             | Read-only retirement inventory                                                                                                                                                                                                                       | New work, routine plan/apply, target state                                                                   |

Root-specific details live in the per-root operator `README.md` files, which
remain in private operator documentation:

- `infra/terraform/bootstrap/README.md`
- `infra/terraform/foundation/README.md`
- `infra/terraform/app/README.md`

Bootstrap is the only composition root that consumes the bounded shared
`infra/framework/terraform/modules/codebuild-log-groups` module. Its four
explicit calls own Bootstrap, Foundation, App, and report-only CodeBuild log
groups. Declarative `moved` blocks preserve the existing Bootstrap,
Foundation, and App log-group identities; this module is not a new Terraform
root or deployment lane.

## State identity and backend

Target state keys include the project, account, environment, and scope rather
than using a bare `terraform.tfstate` key.

| Example root | State identity                 | Backend key                                                             |
| ------------ | ------------------------------ | ----------------------------------------------------------------------- |
| bootstrap    | `stark-dev/develop/bootstrap`  | `stark-ballot-simulator/stark-dev/develop/bootstrap/terraform.tfstate`  |
| foundation   | `stark-dev/develop/foundation` | `stark-ballot-simulator/stark-dev/develop/foundation/terraform.tfstate` |
| app          | `stark-dev/develop/app`        | `stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate`        |

Tracked roots use partial backend configuration so concrete account settings
do not enter source control. The bootstrap root manages S3 versioning, KMS
encryption, public-access blocking, bucket policy, and the S3 lockfile. Treat
the state body as secret-bearing private data; never copy it into documentation,
chat, CI summaries, or public exports.

State storage is distinct from both execution evidence and durable accepted
authority. All three roots exactly require Terraform 1.15.8 and AWS provider
6.58.0. A managed Plan retains its resolved `.terraform.lock.hcl`,
Terraform/provider identity, CodeBuild runtime evidence, saved plan, and saved
plan checksum. Apply copies that exact lock and consumes the reviewed saved
plan without replanning. Root lock files remain untracked; changing a provider
constraint or resolution requires a fresh managed Plan.

## Selecting a deployment story

Terraform root ownership does not by itself describe the full release
sequence. Normal App and Prover lanes resolve the current Foundation acceptance
once, recompute the selected source's complete Foundation contract, and require
exact closure/hash equality. Run Foundation first only on a mismatch; source
equality is neither required nor sufficient. App also requires the Prover
candidate's Foundation closure/hash to match that selection and the release's
promotion binding to identify the exact current Foundation acceptance. Its zkVM
contract must match the App source, and its immutable Toolchain link must remain
valid. Different source SHAs are allowed when these contracts agree.

If a Foundation change invalidates the candidate's binding, build and promote a
new Prover before continuing to App, even if the proof code is unchanged. A
still-compatible retained candidate may instead use the reviewed `existing`
release path to bind promotion to the current Foundation acceptance. Do not run
an image lane merely to align source SHAs. Mutable tags, direct CodeBuild output,
local Docker builds, and operator-written manifests are not App deployment authority.

| Change story                         | Required sequence                                                    | Image behavior                                                                        | Acceptance boundary                                       |
| ------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| App/API/shared code or App Terraform | Foundation / Prover as required by binding checks -> App full        | Reuse compatible authority; rebuild Prover if its Foundation or zkVM contract changes | App plan, smoke, and target browser flow                  |
| Foundation Terraform                 | Foundation saved-plan; then Prover / App when needed for the release | Foundation builds no image; revalidate dependent Prover authority                     | Foundation smoke, then each affected lane                 |
| Bootstrap Terraform                  | Bootstrap saved-plan                                                 | No image build                                                                        | Revalidate every affected lane                            |
| Prover, guest, or Prover image input | Prover release -> App full saved-plan                                | Build, scan, and managed-sign the Prover                                              | Prover promotion, App preflight, target browser flow      |
| Retained Prover candidate selection  | Prover `existing` -> App full saved-plan                             | Revalidate exact retained bytes; no image mutation                                    | Prover promotion, App preflight, target browser flow      |
| Toolchain image input or selection   | Toolchain release -> Prover release -> App full lane                 | Build or select Toolchain, then build and managed-sign the dependent Prover           | Each promotion plus App preflight                         |
| Static presentation-only change      | Develop static-fast; main App full                                   | Reuse compatible accepted image authority                                             | Develop static gate / SmokeLite; main full review / smoke |
| `infra/terraform/legacy/**`          | No routine lane                                                      | None                                                                                  | Explicit retirement work only                             |

Full App is available for both registered targets and remains an explicit
reviewed operator start. Static-fast is started by its
bounded GitHub workflow for admitted presentation-only changes. Both
CodePipeline Source actions keep native change detection disabled, so neither
lane acquires an independent branch-following trigger.

The target browser flow uses the operator-gated hostname on develop and the
public hostname with server-side Turnstile on main. Pipeline smoke and a
state-creating browser journey are distinct acceptance evidence. Concrete start
commands, approvals, and post-deploy checks remain in the private operator guide.

## Lane shapes and shared controls

Bootstrap and Foundation are conventional saved-plan lanes with validation
folded into Plan:

```text
Source -> saved plan and validation -> approval -> exact-plan apply -> smoke
```

Toolchain and Prover have deliberately different trust boundaries:

```text
Toolchain:
Source -> candidate approval -> build or exact retained selection
       -> digest-bound scan/validation -> promotion approval -> accepted pointer

Prover:
Source -> resolve Foundation acceptance/contract and Toolchain
       -> candidate-action approval -> build/scan/sign or exact retained selection
       -> promotion approval -> accepted pointer
```

Toolchain images are not signed or cryptographically verified. Their
digest-bound scan result and immutable provenance are retained, and promotion
selects that authority for a later Prover build. The Prover image is managed
signed, but the Prover release lane does not perform the cryptographic
verification that authorizes App use. Only the App lane's packaged verifier
cryptographically verifies the exact selected Prover digest.

Both image lanes publish content-addressed candidates and releases and select
one release through a key-only accepted pointer. Prover `existing` accepts one
candidate key and live-revalidates its Toolchain binding, governed ECR digest,
zero HIGH/CRITICAL findings, and managed-signing readiness without a build,
push, scan start, signing request, rewrite, or ECR mutation. Neither image
family has a local record generator or operator key/VersionId/body-hash group.

The full App lane includes that verification before the ordinary App saved
plan:

```text
Source
  -> ResolveRelease
  -> verifier preflight plan/approval/apply/cryptographic verification
  -> TerraformPlan with folded source gates and execution-authority materialization
  -> App saved plan -> ManualApproval (eligible develop no-op may skip)
  -> exact-plan apply
  -> static deploy -> smoke -> retained acceptance evidence -> current status
```

### Source and runtime controls

The complete deployment-control inventory has 27 CodeBuild projects for
develop and 24 for main, which omits the three static-fast projects. All select
exact checked-in buildspecs from their pinned CodePipeline or configured GitHub
source. No Terraform-rendered project buildspec remains.
Bootstrap, Foundation, and App Validate work is folded into the owning Plan;
the Plan, Apply, and Smoke actions select checked-in buildspecs and bounded
source-path entrypoints from the exact Source revision. No project admits an embedded command body, local fallback,
predecessor Bootstrap path, or aggregate asset manifest.

- Verify the account alias, deployment environment, state scope, backend key,
  source SHA, and caller role for every execution.
- Keep plan and apply roles separate. Each apply consumes only its reviewed
  saved plan and retained provider lock without replanning.
- Each Plan records the configured CodeBuild image, compute/environment type,
  privilege mode, project identity, build identity, and observed managed image.
  Both managed-image identifiers are independently admitted as AWS-managed
  diagnostic evidence and need not equal; missing or malformed evidence fails
  before planning.
- GitHub Actions may start or observe an allowed AWS pipeline; they must not
  read Terraform state or runtime secrets.
- Local App or Foundation `plan` and `apply` are not acceptance evidence.
  Local `terraform fmt` and root-approved backend-disabled validation are
  repository preflight only.
- Never bypass `scripts/terraform/terraform-guarded.sh` inside a managed lane.
- Production initialization and subsequent deployments require their owning
  saved-plan approvals; repository checks do not grant live execution authority.

### Saved-plan review and approval

Terraform 1.15.8 reports a successful complete semantic no-op as
`applyable: false`. Bootstrap/Foundation no-ops and App rollback no-ops remain
reviewable. Only a develop normal App no-op with unchanged accepted release
authority can become `EMPTY_PLAN_SKIP`; main always requires manual approval.
Verifier preflight plans, including the production verifier prerequisite,
are incomplete and applyable within their bounded target scopes.
Non-applyable plans with resource/read or root-output changes, applyable
semantic no-ops, failed or errored checks, deferred changes, action or
deferred-action invocations, moves, and imports fail closed. Provider-reported
drift is displayed separately and does not redefine the `applyable` bit.

The redacted review must show every changed resource address and every drift
address, within separate 1,000-address bounds. Exceeding either bound rejects
review rather than hiding changes. Changed output names must also be complete
within their 100-name bound. Report-only drift uses a separate 100-address
display limit with an explicit omitted count.

Sensitivity summaries disclose attribute names, never values. Terraform may
omit a sensitive after-value only when validated `after_unknown` metadata
explicitly marks it unknown; review then reports both classifications.
Before-side sensitivity still requires a materialized value. Missing,
false-only, or malformed unknown metadata cannot justify a missing value.

Before backend initialization, reviewable Apply admits the carried saved-plan
correspondence, exact succeeded approval action, and exact-version create-only
expanded approval evidence as one agreement. Its checksum-bound approval-action
projection carries that agreement into acceptance. Eligible develop App
`EMPTY_PLAN_SKIP` instead verifies the correspondence, disposition, and exact
absence of its main approval action; it does not synthesize approval.

### Bootstrap accepted-input execution

Bootstrap's three saved-plan CodeBuild projects and their actions carry no
customer environment variables. In ordinary `BootstrapInputMode=accepted`,
Plan resolves the selected current Bootstrap acceptance and reconstructs its
full canonical nonsecret inputs while changing
only the requested control source. Its exact authority read is the only one of
the three with KMS decrypt through the Terraform-authority bucket. Smoke
reconstructs the same inputs from `tfplan.json`, requires byte equality with
the carried input file, and admits the state-key alias against the saved key ID
before its zero-drift plan and successor acceptance publication.

## App modes

The full App lane supports `normal` and `rollback` deployment modes and also
carries the DynamoDB recovery phase. Neither rollback nor recovery has a
separate readiness project or report prerequisite. Repository tests and the
existence of retained authority do not prove that a live exercise ran.

### Normal

A normal deployment uses the current source as both control and deployable
source. `ResolveRelease` selects the current Foundation acceptance and
Toolchain/Prover release chain once before signature preflight or Terraform
work, using the contract checks described under
[deployment selection](#selecting-a-deployment-story). The
canonical resolution is carried through signature preflight and TerraformPlan;
the mandatory preflight approval binds it. TerraformPlan installs the frozen
workspace dependencies and the Rust toolchain selected by `rust-toolchain.toml`,
installing `rustup` if needed and verifying the selected `rustc` version before
its folded `format:check`, `lint`, `type-system:verify`, `public-safety:scan`, and
`test:run` gates. A failed gate cannot produce a reviewable plan.

TerraformPlan materializes execution authority and deployment identity, then
uses `AppInputMode=accepted` to resolve the current App pointer and acceptance
once for recovery and eligible develop empty-plan correspondence. It prepares
immutable Lambda artifacts and creates the App saved plan. The
[production initialization](#production-initialization) section owns exceptional
first-state admission. After Apply, the shared
[static publication](#static-frontend-publication) path builds and retains the
frontend archive before publishing it.

### Rollback

A rollback uses the current pipeline source as its control source but selects a
retained App acceptance by its exact content-addressed key from the bounded
current history. The starter accepts no record body, VersionId, checksum, or
selected-source coordinate; the lane resolves and revalidates the acceptance's
historical approval, release authority, verifier authority, and embedded
Foundation/image facts
before reusing its Lambda and static artifacts. It does not resolve current
Foundation or image pointers, emit or read a current-Foundation resolution, or
fetch predecessor Toolchain record bodies.
Rollback requires a fresh saved plan, human approval, Apply, and smoke; it never
uses the normal empty-plan approval skip. A subsequent normal roll-forward is
a separately reviewed execution.

### DynamoDB recovery

The App saved-plan lane represents the served table pair through four explicit
phases:

- `primary_active` serves the Terraform-owned primary tables and has no
  recovery manifest;
- `primary_quiesced` still serves the primary tables while disabling public
  session creation and Prover/Verifier event-source consumption;
- `replacement_quiesced` selects the validated replacement pair while keeping
  those admission and event-source paths disabled; and
- `replacement_active` serves the validated replacement pair with normal
  admission and event-source behavior restored.

Every phase other than `primary_active` is bound to immutable recovery-manifest
coordinates. The plan records the validated selection, apply consumes it
unchanged, and smoke checks the live table pair, admission state, Lambda
configuration, and event-source mappings against the phase. Terraform switches
the served pair; it does not copy or reconcile data. Restore, each adjacent
activation or switch-back phase, and cleanup are separately authorized
operations.

## Accepted authority

Each root publishes durable acceptance only after its owning smoke succeeds.
The records bind target context, complete backend authority, nonsecret inputs
and secret references, provider lock/runtime evidence, reviewed plan checksum,
approval disposition, and specialized smoke. They contain no Terraform state, saved-plan
binary, raw plan JSON, decrypted values, or generated sensitive values. These
records support reconstruction and inspection; they do not replace state or
authorize a later saved plan.

All roots' predecessor baseline objects remain delete-protected inactive
history with no active writer or reader. Incompatible authority fails admission;
there is no old-shape, old-hash fallback, dual reader, or fixed Foundation
handoff.

### Bootstrap and Foundation

Bootstrap and Foundation each publish one content-addressed acceptance to the
separate Bootstrap-owned Terraform authority bucket. Their root pointers select
one immutable `{ key, versionId, sha256 }` reference. Foundation acceptance also
binds its complete contract, networking, and Prover image/signing authority;
Foundation does not accept an image digest.

The refresh-capable owning Smoke role proves its identity and assumes a
dedicated acceptance-publisher role before any authority write. The publisher
has exact object/KMS grants and no bucket listing; refresh retains its
provider-required reads. Pointer publication attempts first-create before any
read, and only a precondition conflict permits exact observation and
compare-and-swap.

### App

After smoke succeeds, the isolated publisher creates one content-addressed App
acceptance in the distinct Bootstrap-owned retained App artifact bucket. It
binds approval or the eligible develop normal empty-plan skip, verifier
preflight, App plan/apply, release authority, recovery selection, retained
deployables, and reconstruction inputs. The bounded-history current pointer
uses the selected target's exact
`accepted-deployments/<account-alias>/<environment>/app/current.json` key.
Readers and publishers require the caller-selected target throughout the
acceptance and its linked release authority. Recurring publication uses the
observed pointer's compare-and-swap coordinates; exceptional first publication
follows the [initialization rules](#production-initialization). A conflicting pointer fails closed.
The retired `index.json` has no authority.

## Production initialization

This exceptional first-construction sequence is separate from the accepted
production workflow. Bootstrap and App use explicit administrator-started initialization modes;
Foundation uses its ordinary saved-plan lane with a bounded first-state check.
Missing acceptance or a read failure never chooses an initialization path.

### Bootstrap initial execution and recovery

Bootstrap first creates only its backend and control-plane seed through separately approved
limited saved plans. Its managed `BootstrapInputMode=initial` execution then
binds an immutable initialization manifest, exact source and seed state, and a
complete empty version inventory for the current-pointer key. Normal managed
Plan, approval, Apply, and Smoke produce the first Bootstrap acceptance;
subsequent executions use `accepted` inputs.

A partial managed initial Bootstrap Apply has a separately authorized recovery
path. It requires the original immutable manifest, seed state, approved plan
and approval evidence, a complete failed-execution history without retries,
and matching partial state. It cannot recover an accepted deployment or chain
recovery executions. Tainted/deposed state, changed seed identity, unrelated
resources, or unapproved input changes fail admission. Recovery performs no
state edits: it publishes a new transient manifest and starts a fresh managed
execution, requiring a new saved plan, approval, Apply, and owning Smoke.
Diagnosis and any separately authorized state-only repair remain private
operator procedures; the failed plan and approval are never reused for Apply.

### Foundation first-state admission

First main Foundation review admits uncreated state only for a complete,
applyable create-only managed-resource plan with no prior managed resources or
drift. Refreshed data sources and already evaluated nonsecret outputs may
appear in `prior_state`. Each output must exactly match the complete planned
value/type/sensitivity metadata, with an output change creating that known value
from null and no unknown or sensitive before/after value. Retained, updated,
missing, or mismatched outputs reject initialization.

The reviewer verifies enabled bucket versioning and complete inventories proving that neither the exact state key nor current-acceptance
pointer has ever been published. State inventories group the `.tflock` suffix
history separately using `delimiter=.`; the exact state key must have no version
or delete marker, and the ungrouped pointer inventory must be empty. Approval
binds null state coordinates, and Apply repeats the checks before backend
initialization. No new initialization flag or local state seed is required.

### App initial execution and retries

After Foundation and image authority exist, the full App pipeline uses two
separate `DeploymentMode=normal` executions. `AppInputMode=verifier-prerequisite`
creates only the eight-resource verifier dependency scope through its own
incomplete, applyable saved plan and approval; later App stages are skipped.
`AppInputMode=initial` then observes the real verifier version and aliases,
performs the ordinary incomplete, applyable verifier preflight with its own
approval, and continues through the full App saved-plan approval, Apply, and
Smoke. These executions use separate source-derived verifier configurations
against the same App backend without removing resources from source or state.

An App `initial` retry may follow a changed source/Prover selection or a
successful verifier preflight whose full App plan later failed. It admits the
retained source-addressed package and immutable runtime independently of the
new candidate. Untouched prerequisites require null reconciliation input/output;
applied preflight requires matching canonical, hash-bound input/output and the
exact candidate and retained runtime aliases. Retained outputs must correspond
to an admitted package/version branch and never select runtime authority.
Partial or unrelated state and detached authority reject the retry.

Initial preflight uses the shared output renderer in explicit initial mode,
retaining observed IAM authority and deriving candidate output from the reviewed
inputs and targeted alias. Plan carries that output configuration to isolated
Apply so that excluded mutable Lambda/IAM resources cannot leave stale
output values. The phase creates no App identity or target-runtime output, and the
ordinary post-Apply live checks remain mandatory.

Never-published state checks for App verifier prerequisites use the same
separation of exact state history from lock history. Initialization rejects
read failures, truncated inventories, prior versions or delete markers on keys
required to be absent, and mismatched source, state, or target authority. A
successful full App initial smoke permits conditional first acceptance:
generation 1, one history key, and `previous: null`. A conflicting pointer fails
closed; Smoke and its isolated publisher gain no listing authority. Subsequent
production executions use accepted inputs and observed-pointer CAS. Repository
and simulated integration evidence does not replace actual approvals, smoke,
or acceptance results.

## Report-only drift

Bootstrap owns three root-specific report-only drift runners. An explicit
on-demand operation assumes the bounded starter, whose exact selected-runner
allow remains inside both request guards, and starts only one runner. There is
no coordinator, recurring drift schedule, missed-run queue, fan-out path,
rendered coordinator template, or coordinator output.

Each runner admits its installed controller source and independently validates
the configured and running CodeBuild image identifiers as AWS-managed images;
they need not equal. It resolves its own current acceptance, materializes that
root's accepted historical source in a private workspace, and admits the
corresponding context, backend, inputs, and provider lock/runtime. It then runs
refresh-enabled `terraform plan -lock=false -detailed-exitcode`.

The retained report contains a bounded redacted result of `no-drift`,
`drift-detected`, or `check-failed`, together with the admitted build-image pair.
Failures before runtime admission carry `buildRuntime: null`. Temporary state
views, plans, and full plan JSON are removed on exit.

Repository admission tests and owning Bootstrap smoke prove the accepted-
authority reader and bounded-start architecture. They do not turn any runner
result into deployment authority.

The drift plane has no Apply, state/lock write, accepted-pointer write,
promotion, or remediation path. A drift result never becomes saved-plan input;
remediation returns to the owning managed saved-plan lane.

## Workload resources

### Bootstrap-owned App storage

Each target has a private, versioned, KMS-encrypted full App execution bucket
and a distinct retained App bucket for accepted authority, immutable deployables,
approval and verifier evidence, and CodeBuild cache objects. Develop also has a
separate static-fast execution bucket; main has no static-fast storage. Each
lane can access only its execution bucket plus exact retained objects required
by its work. Legacy CodePipeline transients in the retained bucket are not
copied and have no compatibility reader; their existing lifecycle expires them.

### Static frontend publication

Each target's full App publisher uses its exact conditional S3 lease for the
frontend bucket. Develop's static-fast publisher shares that same lease.
A conflicting lease can be replaced only
after an exact CodeBuild observation proves its holder has completed with an
admitted terminal status; timestamps do not establish expiry. Both publishers
recheck ownership before each frontend mutation and around invalidation and
evidence publication, then release the lease conditionally.

The frontend tree identity binds sorted regular-file paths, exact byte lengths,
and SHA-256 content digests with unambiguous framing. Publication uploads every
selected file with its exact checksum before deleting stale keys; file size or
S3 sync metadata cannot establish byte identity. Normal deployment builds and
retains the archive during static deployment. Rollback retrieves the selected
acceptance's archive by exact VersionId and SHA-256, preserving that retained
archive as its deployable authority.

### App root

The App root manages:

- the private static frontend bucket, CloudFront OAC/distribution, policies,
  and develop-only operator-gate KMS keys and trusted key group;
- the API Gateway HTTP API and Hono `public-api` Lambda;
- DynamoDB/KMS resources for sessions, votes, rate limits, the Prover
  semaphore, and validated primary/replacement recovery selection;
- proof dispatcher, finalization writer, verification worker, cryptographic
  image-signature verifier, and semaphore-janitor Lambdas;
- Prover and verification SQS queues and DLQs;
- Step Functions semaphore orchestration and the ECS/Fargate Prover task
  definition;
- the private proof/report bucket, versioning, lifecycle, and retention
  controls;
- CloudWatch log groups, alarms, closed-field metric filters, the compact
  dashboard, and the normalized operations ledger;
- separate verification-invariant and operations-actionable SNS topics with
  optional fixed-path email subscriptions; and
- non-secret SSM runtime wiring records.

The verdict-invariant alarm is the only alarm with a direct SNS action. Five
dedicated damped alarms keep direct actions disabled, but EventBridge routes
their exact `ALARM` transitions to the separate operations-actionable topic;
owned-pipeline `FAILED` events use that same route. Remaining alarms are passive
diagnostic evidence. Neither notification class performs remediation or
changes a verification verdict.

The App root consumes accepted image authority; image builds and promotion
belong to the separate release lanes.

### Foundation root

The Foundation root owns the Prover and Toolchain ECR repositories, ECR managed
signing configuration for the Prover, networking, release-manifest storage,
runtime secret/configuration containers, and reference-aware image retention.

Native ECR lifecycle expiry remains disabled. Each scheduled retention
controller is bound to one registered target's account, region, exact schedule,
repositories, and retained authority. Both targets use a reviewed subject count
of 10, and missing initial App authority permits no deletion. The controller
protects current Toolchain/Prover acceptance, retained App accepted
and rollback references, the live Prover task definition, and each protected
subject's referrers. Relevant pipeline, candidate-build, finalization, or
Prover-task activity suppresses deletion. Otherwise the controller requires two
identical snapshots, lets protected references override the reviewed target
count, deletes referrers before subjects, and verifies the result. Ordinary
Foundation Apply remains delete-denied; only the bounded controller role can
delete from the two repositories.

The controller's only trigger is the fixed `cron(0 18 * * ? *)` UTC schedule.
Rollout never manually invokes it, and a release transition must establish a
no-fire interval while a newly built Prover candidate is not yet protected by
accepted authority.

## Secret and configuration boundary

- Terraform may own a Secrets Manager container and its reference name, but not
  the runtime secret value.
- The app plan reads `EXPECTED_ORIGIN_VERIFY_HEADER` for the CloudFront origin
  configuration, so sensitive material can enter Terraform state. Protect state
  access like secret access.
- The develop operator gate is controlled by a tracked keyset manifest. Its
  signing keys are asymmetric KMS keys, and only their public keys are published
  to CloudFront. Private signing material must never enter Terraform state,
  repository files, pipeline artifacts, or smoke evidence; Terraform
  plan/apply, deployment smoke, and target runtime roles have no `kms:Sign`
  permission.
- Lambda entrypoints preload runtime references on cold start. Updating a
  Secrets Manager or SSM value does not switch every warm environment at once.
- Session capability, vote encryption, origin verification, Turnstile, and
  CloudFront signed-cookie keys have different rotation requirements. Current
  unsupported cases are documented in the private AWS change guide under
  "Runtime secret/configuration rotation."

## Local checks

Run format and related contract tests before starting an AWS lane.

```bash
terraform -chdir=infra/terraform/bootstrap fmt -check
terraform -chdir=infra/terraform/foundation fmt -check
terraform -chdir=infra/terraform/app fmt -check

pnpm test:run
```

The authoritative plan/apply evidence comes from the selected AWS lane. This
guide intentionally provides no routine flow for creating local private tfvars
and applying them from a workstation.

## Read-only inspection

```bash
aws sts get-caller-identity \
  --profile stark-dev-operator \
  --region ap-northeast-1 \
  --output json \
  --no-cli-pager

aws codepipeline list-pipelines \
  --profile stark-dev-operator \
  --region ap-northeast-1 \
  --output json \
  --no-cli-pager
```

Record live observations in the private current-AWS inventory without
committing full account IDs, ARNs, secret values, or private object bodies.

## Legacy boundary

The retired Amplify/Next.js/AppSync, IAM-user + aws-vault, local Terraform
workspace, and direct CodeBuild/ECR mutation guides have been deleted. The
continued presence of `infra/terraform/legacy/` is not a reason to preserve
those change procedures. Inspect or retire legacy resources only as an
explicitly scoped task separate from target deployment.
