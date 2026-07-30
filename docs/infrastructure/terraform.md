# Terraform Infrastructure Guide

> **Status:** current target-account Terraform ownership and execution guide.
> Last reconciled: 2026-07-29. The retired Amplify/local-workspace workflow is
> deliberately excluded and must not be used as a target deployment path.

Terraform separates application runtime, foundation prerequisites, and
deployment control into distinct roots and states. Routine changes are applied
by AWS-managed CodePipeline/CodeBuild lanes, not by local Terraform `plan` or
`apply`.

Account-specific procedures start at the operator index retained in the private
source repository. This page records only the ownership model and guardrails
that are safe to keep in general project documentation.

## Terraform roots

| Root                          | State identity                             | Owns                                                                                                                                                                          | Does not own                                                                                                 |
| ----------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `infra/terraform/bootstrap/`  | `<account-alias>/<environment>/bootstrap`  | Remote state, KMS, CodeConnections, CodePipeline/CodeBuild, deploy roles, artifact buckets, backend grants, GitHub trigger role                                               | App runtime, ECR workloads, secret values, production authorization                                          |
| `infra/terraform/foundation/` | `<account-alias>/<environment>/foundation` | ECR repositories, ECR signing authority, prover networking, release storage, secret containers, non-secret config containers, DNS/ACM handoff records                         | Lambda/API/DynamoDB/SQS/Step Functions/ECS tasks/CloudFront/static and proof buckets, image builds           |
| `infra/terraform/app/`        | `<account-alias>/<environment>/app`        | Static frontend, CloudFront and operator-gate keys, API Gateway/Hono Lambda, DynamoDB, SQS, Step Functions, ECS task definition, proof/report storage, alarms, runtime wiring | ECR repository creation, image publication, secret values, DNS zones, ACM issuance, production authorization |
| `infra/terraform/legacy/`     | Retired legacy workspace/state             | Read-only retirement inventory                                                                                                                                                | New work, routine plan/apply, target state                                                                   |

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

Shared rules:

- Verify the account alias, deployment environment, state scope, backend key,
  source SHA, and caller role for every execution.
- Keep plan and apply roles separate. Each apply consumes only its reviewed
  saved plan.
- In the develop App lane, the ordinary App approval may be skipped only for a
  normal deployment whose plan is machine-proven empty. Rollback always
  requires approval even when Terraform is empty. Parse failures, unresolved
  plan status, and any resource, output, move, or import change fail closed to
  approval.
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

## Workload resources

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
- the invariant-only SNS topic and optional fixed-path email subscription; and
- non-secret SSM runtime wiring records.

Only the verdict-invariant alarm has an SNS action. Other App-root alarms are
passive evidence for operator diagnosis, and telemetry never changes a
verification verdict.

The App root does not build or promote images. It consumes exact Foundation
publications and a digest-pinned Prover from accepted release authority.

### Foundation root

The Foundation root owns the Prover and Toolchain ECR repositories, ECR managed
signing configuration for the Prover, networking, release-manifest storage,
and runtime secret/configuration containers. It publishes immutable handoff
coordinates for later lanes but does not accept an image digest. Mutable tags,
direct CodeBuild output, local Docker builds, and operator-written manifests
are not App deployment authority.

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
