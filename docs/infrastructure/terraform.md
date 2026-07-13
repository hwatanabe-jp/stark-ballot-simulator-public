# Terraform Infrastructure Guide

> **Status:** current target-account Terraform ownership and execution guide.
> Last reconciled: 2026-07-13. The retired Amplify/local-workspace workflow is
> deliberately excluded and must not be used as a target deployment path.

Terraform separates application runtime, foundation prerequisites, and
deployment control into distinct roots and states. Routine changes are applied
by AWS-managed CodePipeline/CodeBuild lanes, not by local Terraform `plan` or
`apply`.

Account-specific procedures start at the operator index retained in the private
source repository. This page records only the ownership model and guardrails
that are safe to keep in general project documentation.

## Terraform roots

| Root                          | State identity                       | Owns                                                                                                                                                                          | Does not own                                                                                                 |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `infra/terraform/bootstrap/`  | `<account>/<environment>/bootstrap`  | Remote state, KMS, CodeConnections, CodePipeline/CodeBuild, deploy roles, artifact buckets, backend grants, GitHub trigger role                                               | App runtime, ECR workloads, secret values, production authorization                                          |
| `infra/terraform/foundation/` | `<account>/<environment>/foundation` | ECR repositories, ECR signing authority, prover networking, release storage, secret containers, non-secret config containers, DNS/ACM handoff records                         | Lambda/API/DynamoDB/SQS/Step Functions/ECS tasks/CloudFront/static and proof buckets, image builds           |
| `infra/terraform/app/`        | `<account>/<environment>/app`        | Static frontend, CloudFront and operator-gate keys, API Gateway/Hono Lambda, DynamoDB, SQS, Step Functions, ECS task definition, proof/report storage, alarms, runtime wiring | ECR repository creation, image publication, secret values, DNS zones, ACM issuance, production authorization |
| `infra/terraform/legacy/`     | Retired legacy workspace/state       | Read-only retirement inventory                                                                                                                                                | New work, routine plan/apply, target state                                                                   |

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

## Execution model

```text
GitHub source
  -> AWS CodePipeline
  -> CodeBuild validation and saved Terraform plan
  -> conditional scoped manual approval
  -> CodeBuild applies the exact reviewed plan
  -> post-apply smoke and retained evidence
```

Shared rules:

- Verify the account alias, deployment environment, state scope, backend key,
  and caller role for every execution.
- Keep plan and apply roles separate. Apply consumes only the reviewed saved
  plan.
- In the develop app lane, manual approval may be skipped only for a normal
  deployment whose saved plan is machine-proven empty. Rollback always requires
  approval even when Terraform is empty, and protected production remains
  unconditionally approval-gated. Parse failures, unresolved plan status, and
  any resource, output, move, or import change fail closed to approval.
- GitHub Actions may start or observe an allowed AWS pipeline; it must not read
  Terraform state or runtime secrets.
- Local app/foundation `plan` or `apply` is not acceptance evidence.
- Local `terraform fmt` and any root-approved backend-disabled validation are
  repository preflight, not substitutes for AWS deployment.
- Never bypass `scripts/terraform/terraform-guarded.sh` inside a managed lane.

## Selecting a lane

| Terraform change                | Lane                  | Image build                                                                       | Follow-up                                         |
| ------------------------------- | --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `infra/terraform/app/**`        | App full saved-plan   | No ECR image; normal rebuilds Lambda/frontend, rollback reuses retained artifacts | Gated integration smoke                           |
| `infra/terraform/foundation/**` | Foundation saved-plan | None                                                                              | Image or app lane when changed outputs require it |
| `infra/terraform/bootstrap/**`  | Bootstrap saved-plan  | None                                                                              | Live validation of every affected lane            |
| `infra/terraform/legacy/**`     | No routine lane       | None                                                                              | Retirement work only                              |

Concrete start commands, approvals, build decisions, and post-deploy checks are
retained in the private operator guide.

The full app lane supports `normal` and `rollback` deployment modes. Normal
deployment resolves the currently accepted release authority and produces
immutable application artifacts for the selected source. Rollback requires the
exact key, version, and checksum of a previously accepted app deployment
record, revalidates its historical approval and release authority, and reuses
the retained Lambda and static artifacts. The current pipeline source remains
the control source; the accepted record supplies the deployable source.

The same saved-plan lane carries the DynamoDB recovery state through four
explicit phases:

- `primary_active` serves the Terraform-owned primary tables and has no
  recovery manifest;
- `primary_quiesced` still serves the primary tables while disabling public
  session creation and prover/verifier event-source consumption;
- `replacement_quiesced` selects the validated replacement pair while keeping
  those admission and event-source paths disabled; and
- `replacement_active` serves the validated replacement pair with normal
  admission and event-source behavior restored.

Every phase other than `primary_active` is bound to immutable
recovery-manifest coordinates. The plan records the validated selection, apply
must consume that reviewed selection unchanged, and post-apply smoke checks the
live table pair, admission state, Lambda configuration, and event-source
mappings against the phase. Terraform switches the served pair; it does not
copy or reconcile data between tables.

## App resources

The target app root manages:

- the private static frontend bucket, CloudFront OAC/distribution, and policies;
- the API Gateway HTTP API and Hono `public-api` Lambda;
- DynamoDB/KMS resources for sessions, votes, rate limits, and the prover
  semaphore, including the validated primary/replacement recovery selection;
- the develop-only operator gate's versioned asymmetric KMS signing keys,
  aliases, derived CloudFront public keys, and stable trusted key group;
- proof dispatcher, finalization writer, verification worker, image-signature
  gate, and semaphore-janitor Lambdas;
- prover and verification SQS queues and DLQs;
- Step Functions semaphore orchestration and the ECS/Fargate prover task
  definition;
- the private proof/report bucket, versioning, and lifecycle;
- passive CloudWatch alarms and log groups; and
- non-secret SSM runtime wiring records.

For a normal deployment, the app pipeline produces immutable static and Lambda
artifacts and supplies them to the saved plan. Rollback instead supplies the
exact retained artifacts from the selected accepted deployment. The app root
does not build the prover image; it consumes a digest-pinned URI from accepted
release authority.

After smoke succeeds, the app lane publishes immutable evidence under the
pipeline execution and a distinct acceptance attempt. That evidence binds the
manual approval or allowed empty-plan skip, saved-plan and apply evidence,
release authority, recovery selection, and retained deployable coordinates.
Immutable objects are create-only; mutable accepted indexes use conditional
first-create or compare-and-swap updates.

## Foundation resources and image boundary

The foundation root owns the prover/toolchain ECR repositories, Signer
configuration, networking, release-manifest storage, and runtime secret/config
containers. Dedicated toolchain and prover release lanes own each image build,
scan, signing check, and promotion.

A successful foundation apply does not accept an image digest. Mutable tags,
direct CodeBuild output, local Docker builds, and operator-written manifests are
not app deployment authority.

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
  --profile stark-dev-admin \
  --output json \
  --no-cli-pager

aws codepipeline list-pipelines \
  --profile stark-dev-admin \
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
