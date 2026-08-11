# Terraform Infrastructure Guide

> **Status:** current target-account Terraform ownership and execution guide.
> Last reconciled: 2026-08-09. The retired Amplify/local-workspace workflow is
> deliberately excluded and must not be used as a target deployment path.

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
admission rules; consumers must not reconstruct names or add a fallback target.

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

Successful smoke publishes a secret-safe accepted Terraform baseline to the
separate Bootstrap-owned Terraform authority bucket. A baseline binds the
target context, complete backend authority, nonsecret inputs and secret
references, provider lock/runtime evidence, reviewed plan checksum, acceptance,
and specialized smoke. It never retains Terraform state, a saved-plan binary,
raw plan JSON, decrypted values, or generated sensitive values.

## Selecting a deployment story

Terraform root ownership does not by itself describe the full release
sequence. In particular, every new source SHA used by a normal full App
execution must first complete the Foundation lane at the same control SHA. The
App lane may reuse an accepted Prover from a different source only when its
recorded zkVM contract hash matches the hash recomputed from the App source.
That Prover exact-links one immutable Toolchain artifact, which may also come
from a different source SHA. Do not run an image lane merely to align source
SHAs.

| Change story                         | Required sequence                                    | Image behavior                                                              | Acceptance boundary                         |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| App/API/shared code or App Terraform | Foundation saved-plan -> App full saved-plan         | Reuse a contract-compatible accepted Prover; rebuild no ECR image           | App plan, smoke, and gated flow             |
| Foundation Terraform                 | Foundation saved-plan                                | No image build                                                              | Foundation smoke and publication evidence   |
| Bootstrap Terraform                  | Bootstrap saved-plan                                 | No image build                                                              | Revalidate every affected lane              |
| Prover, guest, or Prover image input | Prover release -> App full saved-plan                | Build, scan, and managed-sign the Prover                                    | Prover promotion, App preflight, gated flow |
| Toolchain image input or selection   | Toolchain release -> Prover release -> App full lane | Build or select Toolchain, then build and managed-sign the dependent Prover | Each promotion plus App preflight           |
| Static presentation-only change      | Develop static-fast lane                             | Reuse the current accepted App and image authority                          | Static gate and lightweight smoke           |
| `infra/terraform/legacy/**`          | No routine lane                                      | None                                                                        | Explicit retirement work only               |

Run Toolchain only when its contents or accepted selection must change. Run
Prover only when its image contents, ImageID or method version, selected
Toolchain, or zkVM contract changes. Concrete start commands, approval
procedures, and post-deploy checks remain in the private operator guide.

## Lane shapes and shared controls

Bootstrap and Foundation are conventional saved-plan lanes:

```text
Source -> validate -> saved plan -> approval -> exact-plan apply -> smoke
```

Foundation smoke also publishes the immutable networking and image-signing
authority coordinates consumed by later lanes. A successful Foundation apply
does not accept an image digest.

Toolchain and Prover have deliberately different trust boundaries:

```text
Toolchain:
Source -> candidate approval -> build or exact retained selection
       -> digest-bound scan/validation -> promotion approval -> accepted pointer

Prover:
Source -> resolve Foundation signing authority and Toolchain
       -> build approval -> build/scan/managed signing
       -> promotion approval -> accepted pointer
```

Toolchain images are not signed or cryptographically verified. Their
digest-bound scan result and immutable provenance are retained, and promotion
selects that authority for a later Prover build. The Prover image is managed
signed, but the Prover release lane does not perform the cryptographic
verification that authorizes App use. Only the App lane's packaged verifier
cryptographically verifies the exact selected Prover digest.

The full App lane includes that verification before the ordinary App saved
plan:

```text
Source
  -> conditional verifier state-refresh plan/approval/apply
  -> verifier preflight plan/approval/apply/cryptographic verification
  -> App deployment record and validation
  -> App saved plan -> conditional approval -> exact-plan apply
  -> static deploy -> smoke -> retained acceptance evidence
```

The four self-hosted Bootstrap Validate, Plan, Apply, and Smoke projects run
checked-in buildspec templates from the exact pinned Source revision and verify
`infra/terraform/bootstrap/bootstrap-buildspec-assets.sha256`. That manifest
binds all four templates and their bounded entrypoints. Extracted Foundation,
App, and report-only buildspecs instead carry a Terraform `filesha256` for one
bounded entrypoint and verify it before dispatch; neither model admits an
embedded command-body or local fallback.

Bootstrap is the only composition root that consumes the bounded shared
`infra/framework/terraform/modules/codebuild-log-groups` module. Its four
explicit calls own Bootstrap, Foundation, App, and report-only CodeBuild log
groups. Declarative `moved` blocks preserve the existing Bootstrap,
Foundation, and App log-group identities; this module is not a new Terraform
root or deployment lane.

Shared rules:

- Verify the account alias, deployment environment, state scope, backend key,
  source SHA, and caller role for every execution.
- Keep plan and apply roles separate. Each apply consumes only its reviewed
  saved plan and retained provider lock without replanning.
- Each Plan records the configured CodeBuild image, compute/environment type,
  privilege mode, project identity, build identity, and observed managed image.
  A missing field or configured/observed mismatch fails before planning.
- Terraform 1.15.8 reports a successful complete semantic no-op as
  `applyable: false`. Bootstrap/Foundation no-ops and App rollback no-ops remain
  reviewable; only a normal App no-op becomes the mechanical
  `EMPTY_PLAN_SKIP`. Verifier preflight remains incomplete and applyable.
  Non-applyable plans with resource/read or root-output changes, applyable
  semantic no-ops, failed or errored checks, deferred changes, action or
  deferred-action invocations, moves, and imports fail closed. Provider-reported
  drift is displayed separately and does not redefine the `applyable` bit.
- GitHub Actions may start or observe an allowed AWS pipeline; they must not
  read Terraform state or runtime secrets.
- Local App or Foundation `plan` and `apply` are not acceptance evidence.
  Local `terraform fmt` and root-approved backend-disabled validation are
  repository preflight only.
- Never bypass `scripts/terraform/terraform-guarded.sh` inside a managed lane.
- Protected production remains unconditionally approval-gated, and
  `stark-prod/main` has no authorized live deployment path.

## App modes and retained authority

The full App lane supports `normal` and `rollback` deployment modes and also
carries the DynamoDB recovery phase.

### Normal

A normal deployment uses the current source as both control and deployable
source. It consumes exact same-source Foundation publications, resolves a
contract-compatible accepted Prover and its linked Toolchain, builds immutable
static and Lambda artifacts, and cryptographically verifies the selected
Prover before the App saved plan.

### Rollback

A rollback uses the current pipeline source as its control source but selects a
previously accepted App deployment by exact object key, version, and body
checksum. The lane revalidates that record's historical approval, release
authority, verifier authority, and retained artifact coordinates before
reusing its Lambda and static artifacts. Rollback never uses the normal
empty-plan approval skip.

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
the served pair; it does not copy or reconcile data.

### Accepted App evidence

After smoke succeeds, the lane publishes create-only evidence under both the
pipeline execution and a distinct acceptance attempt. It binds approval or the
allowed normal empty-plan skip, verifier preflight, App plan/apply, release
authority, recovery selection, and retained deployable coordinates. Mutable
accepted pointers use conditional first-create or compare-and-swap updates.
App authority is selected only by
`accepted-deployments/stark-dev/develop/app/current.json`, never the retired
`index.json`.

Before that existing App pointer advances, smoke also publishes the attempt's
immutable accepted Terraform baseline. App does not have a second mutable
baseline pointer: its current accepted pipeline execution and acceptance
attempt deterministically select the matching baseline.

## Accepted baselines and report-only controls

Successful Bootstrap, Foundation, and App smoke each publish one durable
`accepted-terraform-baseline` with immutable `{ key, versionId, sha256 }`
references. Bootstrap and Foundation select their current baselines through
root-specific `current-terraform-baseline` pointers using conditional
first-create or compare-and-swap. App selection follows the accepted execution
and attempt described above. These records are reconstruction authority for
inspection; they do not replace state and do not authorize a later saved plan.

Bootstrap owns a weekly AWS-managed coordinator and three root-specific
report-only drift runners. The coordinator selects each exact accepted
baseline, and each runner materializes that accepted historical source in a
private workspace, admits its context, backend, inputs, provider lock/runtime,
and controller source, then runs refresh-enabled
`terraform plan -lock=false -detailed-exitcode`. Only a bounded redacted result
of `no-drift`, `drift-detected`, or `check-failed` is retained. Temporary state
views, plans, and full plan JSON are removed on exit.

The drift plane has no Apply, state/lock write, accepted-pointer write,
promotion, or remediation path. A drift result never becomes saved-plan input;
remediation returns to the owning managed saved-plan lane.

Two distinct source-pinned CodeBuild projects provide on-demand rollback and
DynamoDB recovery readiness reports. They have no scheduler or alarm trigger
and may exact-read current authority and publish only create-once encrypted
readiness evidence. They cannot apply Terraform, mutate state or pointers,
restore or switch tables, redrive work, stop tasks, inject faults, or authorize
an exercise. Both projects are installed for the current target but remain
uninvoked, so the repository and project definitions are not readiness or live
exercise evidence.

## Workload resources

### Bootstrap-owned App storage

The full App and static-fast CodePipeline lanes use separate private,
versioned, KMS-encrypted transient execution buckets. The existing retained App
bucket is a third, distinct bucket that owns accepted authority, immutable
deployables, approval and verifier evidence, and CodeBuild cache objects. Each
lane can access only its execution bucket plus exact retained objects required
by its work. Legacy CodePipeline transients in the retained bucket are not
copied and have no compatibility reader; their existing lifecycle expires them.

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

The App root does not build or promote images. It consumes exact Foundation
publications and a digest-pinned Prover from accepted release authority.

### Foundation root

The Foundation root owns the Prover and Toolchain ECR repositories, ECR managed
signing configuration for the Prover, networking, release-manifest storage,
runtime secret/configuration containers, and reference-aware image retention.
It publishes immutable handoff coordinates for later lanes but does not accept
an image digest. Mutable tags, direct CodeBuild output, local Docker builds, and
operator-written manifests are not App deployment authority.

Native ECR lifecycle expiry remains disabled. The scheduled retention
controller protects current Toolchain/Prover acceptance, retained App accepted
and rollback references, the live Prover task definition, and each protected
subject's referrers. Relevant pipeline, candidate-build, finalization, or
Prover-task activity suppresses deletion. Otherwise the controller requires two
identical snapshots, lets protected references override the reviewed target
count, deletes referrers before subjects, and verifies the result. Ordinary
Foundation Apply remains delete-denied; only the bounded controller role can
delete from the two repositories.

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
