# Docker Implementation Review (updated 2026-07-24)

## Overview

This retained review records the Docker image and entrypoint assessment at the
date in the title, including the cutover assumptions used then. It supersedes
the older 2025-10-22 Phase 9.4 review notes. For current execution and release
contracts, read the [zkVM workspace guide](../../zkvm/README.md) and
[infrastructure guide](../../docs/infrastructure/README.md).

## Plan 02/03 Migration Guardrail

This file supplies implementation background for the historical Plan 02/03
migration. Target-account release-candidate authority, acceptance evidence,
prerequisites, and handoff decisions belong to the private operator
documentation; this review grants none of those authorities.

Legacy/shared CodeBuild and ECR references below may be used only as
background or local smoke context. They do not prove accepted target images,
scan decisions, signing status, immutable release-manifest provenance, or
Plan 03 readiness.

## Files Reviewed

- `infra/docker/Dockerfile.fargate-prover`
- `infra/docker/entrypoint.sh`
- `infra/docker/prover-failure-marker-contract.json`
- `zkvm/contract-core/src/current-zkvm-semantic-contract.json`
- root `.dockerignore` for the repository-root Docker build context
- `buildspec.yml`
- `buildspec-risc0-toolchain.yml`
- `infra/terraform/legacy/ecr.tf`
- `infra/terraform/legacy/codebuild.tf`
- `infra/terraform/legacy/ecs.tf`
- `infra/terraform/app/step_functions.tf`
- `infra/terraform/app/target_lambda_iam.tf`

## Summary

**Overall status**: approved for the current async prover design. The former
root-runtime hardening item is repository-resolved and pending the ordered
prover release plus app saved-plan apply; it is not yet live evidence.

The cryptographic verifier and unversioned failure-marker behavior described
below are the repository-defined hard-cutover target. Live AWS continues to use
the old status-only gate and old failure-marker contract until the coordinated
bootstrap, Foundation, image-promotion, and App cutover sequence succeeds.

The Docker implementation now supports the current SQS -> Step Functions -> ECS Fargate
prover flow:

- digest-pinned RISC Zero toolchain base image via `RISC0_TOOLCHAIN_IMAGE`
- ARM64 Fargate runtime
- S3 input and output orchestration
- input JSON validation before invoking the Rust host
- bounded zkVM execution with `ZKVM_TIMEOUT_SECONDS` (default 900s)
- a checked `prover-artifacts` Rust binary for exact public-audit projection,
  canonical hashes, duplicate-index rejection, and cross-artifact admission
- S3 upload retry logic
- public `bundle.zip` creation
- private bitmap sidecar preservation outside `bundle.zip`
- read-only inclusion of the Rust-owned exact-current zkVM semantic descriptor
  under `/opt/zkvm/share/current-zkvm-semantic-contract.json`
- Rust-owned public-input filename/schema/version projection; the entrypoint
  has no independent public-input contract literals

Read-only AWS CLI checks on 2026-04-26 confirmed that the then-expected
legacy/shared ECR repositories, CodeBuild projects, ECS clusters, lifecycle
policies, and Container Insights settings existed in the configured
account/region. Account-specific IDs are intentionally omitted from this review
note. These checks predate the current post-merge Plan 02/03 handoff model and
are not current release-candidate evidence.

## Runtime Architecture And Legacy Image Background

### Legacy/Shared Image Build Path

The retained legacy/shared application prover image path used Terraform-managed
CodeBuild projects:

- `stark-ballot-simulator-fargate-prover-develop`
- `stark-ballot-simulator-fargate-prover-main`

`buildspec.yml` resolves the RISC Zero toolchain image from ECR, requires a
digest-pinned `@sha256:<64 lowercase hex chars>` reference, extracts the ARM64
guest ImageID from the built prover image, and records the resolved toolchain
image, prover digest, methodVersion, and ImageID in `image-metadata.json`.
Those mechanics remain useful implementation context, but the current
target-develop release candidate must come from the dedicated target-account
release-candidate authority maintained in private operator documentation.

The retained shared RISC Zero toolchain base image path used:

- `stark-ballot-simulator-risc0-toolchain-builder`

That project uses `buildspec-risc0-toolchain.yml` and pushes to:

- `stark-ballot-simulator/risc0-toolchain`

### Legacy/Shared ECR Repositories

The legacy/shared repository layout was:

- `stark-ballot-simulator/zkvm-prover-develop`
- `stark-ballot-simulator/zkvm-prover-main`
- `stark-ballot-simulator/risc0-toolchain`

These repository names are retained as background references only. They are not
the Plan 02 target-account release-candidate repositories and must not be cited
as Plan 03 image evidence. Their lifecycle policy was:

- prover repositories: keep last 10 images
- toolchain repository: keep last 5 images

### Runtime Path

The repository target ECS task definition uses ARM64 Fargate with 16 vCPU /
32 GiB memory. After the hard cutover and before starting ECS, the Step
Functions state machine invokes the qualified
`image-signature-verifier` runtime alias for the exact digest-pinned prover
image. `CheckImageSignature` advances only when the verifier returns both
`result: "VERIFIED"` and `mode: "cryptographic"`; every other response and
invocation failure follows the fail-closed `CallbackSignatureFailed` path.
After the prover slot is acquired and its start is admitted, `RunProver`
invokes the ECS task.

The current network model is public subnets with `AssignPublicIp = ENABLED`. It is not
the older private-subnet-plus-NAT model.

## Dockerfile Review

### Strengths

- Uses a required `RISC0_TOOLCHAIN_IMAGE` build arg instead of embedding private ECR
  URLs in the Dockerfile.
- Builds the Rust host and bounded artifact tool in a dedicated build stage and
  copies only runtime essentials.
- Uses Cargo `--quiet` for the production host/guest build so successful
  dependency progress does not dominate candidate logs; warnings and errors
  remain visible.
- Uses Amazon Linux 2023 for the ARM64 runtime image.
- Installs the AWS CLI v2 in the runtime image because the entrypoint needs S3 access.
- Keeps `RUST_LOG=info` as an overridable runtime default.

### Runtime Hardening Status

The repository runtime now moves immutable RISC Zero assets to `/opt/risc0`,
uses fixed UID/GID `10001:10001`, declares only `/tmp` and
`/var/task/output` as writable volumes, and repeats the identity in the ECS
task definition. The task uses a read-only root filesystem, drops all Linux
capabilities, enables init, and allows 120 seconds for stop handling. The
release build runs the actual ARM64 image under this posture and rejects writes
outside the declared volumes before publishing image evidence.

The entrypoint forwards `TERM` and `INT` through its bounded host wrapper and
records `infrastructure_interruption` unless durable publication already
completed. These are repository and release-gate contracts until the new image
is promoted and the app task definition is applied.

## Entrypoint Review

### Current Capabilities

- `set -euo pipefail` and narrow `IFS`
- local file or S3 input through `INPUT_PATH` or `INPUT_S3_BUCKET` / `INPUT_S3_KEY`
- `jq`-based top-level input validation
- explicit host timeout via `run_host_with_timeout`
- output staging for `*-output.json`, `*-receipt.json`, `*-journal.json`,
  `*-bitmap.json`, and `*-seen-bitmap.json`
- public audit artifact generation:
  - `public-input.json`
  - `election-manifest.json`
  - `close-statement.json`
  - `journal.json`
  - `receipt.json`
- exact Rust admission and consistency validation across public audit artifacts
  before bundling; embedded shell Python does not own conversion or hashing
- S3 upload retry via `upload_with_retry`

### Failure Marker Contract

The canonical private failure-marker descriptor is
`infra/docker/prover-failure-marker-contract.json`. The repository target
entrypoint writes `failure-marker.json` with exactly one `category` key and
rejects categories outside this closed allowlist:

- `configuration`
- `input`
- `prover_execution`
- `infrastructure_interruption`
- `artifact`
- `upload`
- `timeout`
- `unknown`

The prover candidate smoke exercises this exact writer contract. The candidate
record retains the descriptor's SHA-256 and
`failureMarkerSmokeStatus: "PASS"`, and promotion rejects a mismatched checksum
or non-passing smoke result. The writer becomes live only when the newly built
and promoted prover is selected by the same App hard cutover that installs the
strict unversioned parser; the pre-cutover runtime keeps its old writer/parser
pair.

### Bundle Boundary

Async `bundle.zip` contains only public audit artifacts:

- `public-input.json`
- `election-manifest.json`
- `close-statement.json`
- `receipt.json`
- `journal.json`

Private artifacts must stay outside public `bundle.zip`:

- `input.json`
- `verification.json`
- `included-bitmap.json`
- `seen-bitmap.json`

`included-bitmap.json` and `seen-bitmap.json` are preserved as sibling output objects
for authenticated restore/report paths, not as public bundle members.

## Drift Resolved From The Previous Review

The previous review drifted in several places:

- `entrypoint.sh` was listed with a brittle line count. This review no longer
  treats line counts as an implementation contract; the entrypoint orchestrates
  bundle generation while `zkvm/host/src/artifacts.rs` owns typed projection
  and canonical hashing.
- Upload retry, input validation, and execution timeout were listed as future
  improvements; they are now implemented.
- The planned GitHub Actions build path is no longer the retained
  legacy/shared Docker image path. Terraform-managed CodeBuild remains
  historical implementation context for that path, but current target-develop
  release-candidate authority requires the dedicated target-account
  release-candidate CodePipeline and immutable handoff described in the
  post-merge Plan 02/03 documents.
- The single `stark-ballot-simulator/zkvm-prover` ECR repository name is stale.
  Legacy/shared prover image examples are environment-specific:
  `zkvm-prover-develop` and `zkvm-prover-main`.
- The old local Docker run example referenced test data inside the runtime image.
  The runtime image does not include `zkvm/test-data`; mount local fixtures instead.
- The old network note said private subnet + NAT. Current Terraform uses public
  subnets and public IP assignment for ECS tasks.
- Container Insights was listed as follow-up. It is now enabled on the ECS clusters.

## Local Test Pattern

For local entrypoint validation only, mount the input fixture from the host:

```bash
AWS_ACCOUNT_ID=<account-id> \
  ./scripts/update-risc0-digest.sh --write-env .tmp/risc0-toolchain-image.env
source .tmp/risc0-toolchain-image.env

docker buildx build \
  --platform linux/arm64 \
  --build-arg RISC0_TOOLCHAIN_IMAGE="$RISC0_TOOLCHAIN_IMAGE" \
  -f infra/docker/Dockerfile.fargate-prover \
  -t stark-ballot-simulator/zkvm-prover:local-test \
  --load \
  .

scripts/tests/fargate-prover-container-smoke.sh \
  stark-ballot-simulator/zkvm-prover:local-test

docker run --rm \
  --read-only \
  --cap-drop ALL \
  --init \
  --network none \
  -e RISC0_DEV_MODE=1 \
  -e INPUT_PATH=/input/test-fixture-valid.json \
  -e OUTPUT_DIR=/var/task/output \
  --mount type=bind,src="$PWD/zkvm/test-data",dst=/input,readonly \
  stark-ballot-simulator/zkvm-prover:local-test
```

This smoke test checks local entrypoint execution only. It is not deployment
evidence, signing evidence, scan evidence, release-manifest evidence, or
Plan 03 acceptance evidence. It does not produce a production STARK proof
because `RISC0_DEV_MODE=1` creates a fake development receipt.

## Verification

Focused local verification:

```bash
pnpm test:entrypoint-bundle
```

This test checks the public bundle allowlist, private bitmap sidecar handling,
the checked Rust public-audit projection and consistency checks, duplicate-index
rejection, legacy output rejection, method-version rejection, and timeout error
reporting.

## Recommendation

The Dockerfile and entrypoint implementations match the repository-defined
target async prover runtime path, while the legacy/shared image-build notes
above remain background only. Keep this file updated whenever the entrypoint
public bundle or failure-marker contract, target image authority, or ECS
runtime model changes.
