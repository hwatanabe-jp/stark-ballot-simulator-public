# Terraform Infrastructure Guide

> Source contract: local Bootstrap, four managed pipelines, and local drift.
> Target rollout observations remain in the private deployment inventory.

Terraform has three independent roots and states. Bootstrap owns the state and
control plane, Foundation owns networking, ECR/signing and configuration
containers, and App owns runtime, frontend, data and monitoring.
`packages/deployment-authority/deployment-targets.json` selects the exact target,
account, region, backend and names before any retained record is read.
`@stark-ballot/deployment-authority` owns pure admission; AWS, filesystem and
process adapters remain outside it.

## Terraform roots

| Root                          | Execution                                                     | Ownership                                                                                                          |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `infra/terraform/bootstrap/`  | Local administrator, reviewed saved plan                      | State/KMS, CodeConnections, four pipelines, thirteen projects, IAM, retained and execution storage, preserved logs |
| `infra/terraform/foundation/` | Managed Plan → approval → Apply → Smoke                       | Networking, ECR/signing, image retention, release storage, secret/config containers, regional API Gateway logging  |
| `infra/terraform/app/`        | Managed Plan → approval → Apply → frontend → Smoke/checkpoint | Static/API runtime, queues, proofs, data and monitoring                                                            |

The Bootstrap log module preserves historical log identities. Retired Bootstrap
and drift logs remain audit storage; they do not imply executable projects.

## State identity and backend

Each backend key is
`stark-ballot-simulator/<account-alias>/<environment>/<root>/terraform.tfstate`.
Partial backend configuration, S3 versioning, KMS encryption, public-access
blocking and S3 lockfiles protect the root-specific state. State and raw plans
can contain sensitive values and remain private.

Roots pin Terraform 1.17.0 and AWS provider 6.70.0. Each plan package binds the
resolved provider lock, official Terraform archive checksum/platform, exact
source, backend, nonsecret inputs and immutable artifact references. Root lock
files are untracked; changing a pin requires a fresh plan.

## Selecting a deployment story

| Change                     | Required sequence                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Bootstrap control plane    | Local fresh plan, explicit target/source/digest approval, Apply, no-change Smoke, checkpoint                           |
| Foundation infrastructure  | Foundation plan, approval, Apply, Smoke, checkpoint                                                                    |
| App or static frontend     | App plan with compatible Foundation/images, approval, Apply, frontend, Smoke/checkpoint; asynchronous status afterward |
| Toolchain or Prover inputs | Candidate approval, build or exact existing candidate validation, promotion approval, fresh App deployment when needed |
| Missing retained image     | Authorized rebuild and promotion, then fresh App plan and approval                                                     |

Image build-time Foundation hashes and original Toolchain references are
immutable provenance. Current consumer requirements and live digest/signature/
ImageID/method checks determine compatibility. Unrelated IaC changes and
same-digest Toolchain re-promotion do not require Prover rebuilds.

## Lane shapes and shared controls

There are four QUEUED pipelines with twelve CodeBuild actions per target:
Foundation 3, App 4, Toolchain 2 and Prover 3. App also owns an independently
scheduled Status project, making thirteen projects in total. Each project permits
one concurrent build. Only the two image candidate builds are privileged. Prover PrepareImage
resolves Foundation, signing and Toolchain before candidate execution. App Plan
resolves its release inside the Plan action. No Bootstrap pipeline, remote drift
runner, standalone signing resolver or App release resolver remains.

Trust names the exact CodeBuild project ARN. Pipeline runtime admission binds caller,
project, build, source, owning pipeline execution and current native action.
The Status project instead admits its native build, exact source, successful App
execution and current checkpoint; it has no in-progress pipeline action.
Direct StartBuild and source overrides alone do not establish authority. GitHub
Actions can start/observe allowed pipelines without state or secret access.

### Saved-plan review and approval

Plan publishes one create-only, versioned plan package under
`deployment/<target>/<root>/plan-packages/<execution>.json`. It binds saved
binary/JSON plan bytes, target, source, backend, runtime, provider lock, inputs,
artifacts and the observed checkpoint/mutation owner. Managed approval uses a
compact native summary bound to the package digest and exact action.
Apply verifies caller, native successful approval and exact package bytes before
backend initialization. It never replans. Complete semantic no-ops also require
approval; incomplete plans, failed checks, moves/imports and hidden changes fail
closed. Sensitive values are never printed by review.

### Local Bootstrap

The administrator materializes exact source in an owner-only workspace and uses
fixed tools. Approval binds target/source/package digest in a protected record.
Apply rejects changed bytes or symlink substitutions. Failure or workspace loss
requires a fresh plan and approval. First construction explicitly creates only
backend storage before the ordinary full local flow; missing records never
silently choose initialization.

## Checkpoints and concurrency

After successful Smoke, each root updates one versioned
`deployment/<target>/<root>/checkpoint.json`. Its current S3 version records the
successful package reference and root outputs. Bootstrap/Foundation use the
Terraform authority bucket; App uses its separate retained bucket. Old records
remain frozen audit history with no normal reader or conversion.

Apply claims `mutation-owner.json` by create-only first publication or exact
compare-and-swap. Every deployment mutation action checks the owner and records a create-only
action start. Smoke checks the owner again before publishing. A failed action,
partial deployment or stale execution cannot advance the checkpoint. Native
QUEUED execution and project concurrency do not replace these checks. First
publication is an explicit plan/start choice, never inferred from a 403, timeout
or missing current read.

## App execution and status

Every App deployment, including frontend-only changes and no-ops, uses the full
plan and approval. Signature verification precedes the saved plan. Apply owns
the immutable verifier version; Step Functions invokes its exact qualified ARN.
Smoke confirms that version before checkpoint publication and completes the App
pipeline. A Bootstrap-owned EventBridge rule then starts the status-delivery
Step Functions workflow, which schedules the dedicated Status project using the
successful execution's exact source. The publisher rechecks acceptance and
conditionally writes the derived status without claiming a mutation owner.
Status delivery can lag or fail independently; its scheduler failure alarm and
delivery-failure queue retain diagnostic evidence. An accepted checkpoint does
not prove status delivery. The public status DTO grants no deployment authority.

### Rollback and DynamoDB recovery

Corrective source follows a fresh App plan and approval. Historical replay and
old-shape record readers are absent. Stopped DynamoDB restoration uses distinct
sessions/votes tables, validates data/settings and changes explicit source
configuration. PITR and original tables remain protected. Develop quiescing
blocks new sessions and consumers; operators must separately drain existing
writers. Restoration, resume and cleanup retain their own authorization.

## Existing targets and exceptional initialization

Develop and production use the recurring operations above. Their completed
cutovers and subsequent deployments retain their dated observations in the
private deployment inventory. Drain active work before changing control topology
and preserve state/backend storage and retained history.

Initialization applies only to a genuinely new target. Explicit first record
publication is a separate admitted choice; missing or invalid records on an
existing target do not authorize initialization. New records come from fresh
execution, never conversion of old authority.

## Local drift

The local parent assumes only the selected root's read role; the child receives
only that role's credentials. It reconstructs the successful checkpoint's
source, fixed tools, provider lock, inputs and exact artifacts, then executes
`terraform plan -lock=false -detailed-exitcode`. It observes native execution,
state and mutation owner before and after; concurrent change makes the result
inconclusive. Exit 0 means no drift, 2 means drift and 1 means failure. Reports
are bounded and redacted. No runner may Apply, write state/locks/authority,
promote images or repair a result.

## Workload resources

### Bootstrap-owned App storage

Each target has a private, versioned, KMS-encrypted full App execution bucket
and a distinct retained App bucket for checkpoint authority, immutable deployables,
approval and verifier evidence, and CodeBuild cache objects. Each
lane can access only its execution bucket plus exact retained objects required
by its work. Legacy CodePipeline transients in the retained bucket are not
copied and have no compatibility reader; their existing lifecycle expires them.

### Static frontend publication

The App lane is the sole frontend publisher. Its QUEUED deployment stage owns
Apply, static publication and Smoke/checkpoint in order. A per-root mutation
owner and create-only action records reject stale or retried publishers. Drain
active executions before changing this topology;
never stop an active publisher so another execution can overtake it. Failed
publication produces no new checkpoint and may leave partial files.

The frontend tree identity binds sorted regular-file paths, exact byte lengths,
and SHA-256 content digests with unambiguous framing. Publication uploads every
selected file with its exact checksum before deleting stale keys; file size or
S3 sync metadata cannot establish byte identity. Prepare builds and retains the
archive, manifest and configuration before sealing their exact S3 VersionIds and
SHA-256 hashes into the plan package. Static deployment materializes those
approved bytes. Historical replay is retired; recovery deploys corrected current source.

### App root

The App root manages:

- the private static frontend bucket, CloudFront OAC/distribution, policies,
  and develop-only operator-gate KMS keys and trusted key group;
- the API Gateway REST API, stage/access-log configuration and Hono `public-api` Lambda;
- four active DynamoDB tables for sessions, votes, rate-limit events and
  rate-limit counters, their KMS resources, and validated primary/replacement
  recovery selection;
- proof dispatcher, finalization writer, verification worker, cryptographic
  image-signature verifier, and the operations-ledger normalizer Lambda under
  its retained `semaphore-janitor` identity; the normalizer does not manage
  Prover capacity;
- the minute-based EventBridge finalization sweep targeting the finalization
  writer, with bounded retries and a delivery-failure alarm; the sweep pauses
  during develop quiescence;
- Prover-dispatch and verification SQS queues and DLQs;
- a Batch Fargate compute environment and separate Batch job queue, plus the
  `aws_cloudformation_stack.prover_job` stack containing exactly the Batch job
  definition and replenishable consumable resource for Prover capacity;
- Step Functions orchestration that verifies the image signature and submits
  the selected job definition to the Batch queue using `batch:submitJob.sync`;
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

Foundation owns the account/region API Gateway logging singleton and its bounded
CloudWatch writer role. App owns the REST API's access-log group and stage
settings. Foundation Plan and Apply reject a pre-existing different singleton
owner before changing it.

Foundation owns the two ECR repositories and their native lifecycle policies.
Each uses one `tagStatus=any`, `imageCountMoreThan=5`, `expire` rule. Tagged,
untagged and currently used images can expire; no active-image exception or
custom cleaner exists. Repositories remain destroy-protected. Foundation Apply
has lifecycle-policy management on exactly those repositories and no general
image-delete authority. Missing images require rebuild, validation, promotion
and a fresh approved App deployment; records do not guarantee availability.

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

Foundation and App use their selected managed lanes. Bootstrap uses the protected local saved-plan workflow; local drift only reads deployed configuration.

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
legacy AWS account has been deleted, and its Terraform root and dedicated
tfvars/IAM generators have been removed. Git history retains the old source;
current deployment uses only the three reviewed target roots.
