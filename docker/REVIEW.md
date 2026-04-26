# Docker Implementation Review (2026-04-26)

## Overview

Current review of the Docker image and entrypoint used by the async zkVM prover path.
This supersedes the older 2025-10-22 Phase 9.4 review notes.

## Files Reviewed

- `docker/Dockerfile.fargate-prover` (80 lines)
- `docker/entrypoint.sh` (944 lines)
- `docker/.dockerignore` (13 lines)
- `buildspec.yml`
- `buildspec-risc0-toolchain.yml`
- `terraform/ecr.tf`
- `terraform/codebuild.tf`
- `terraform/ecs.tf`
- `terraform/step_functions.tf`
- `terraform/iam.tf`

## Summary

**Overall status**: approved for the current async prover design, with one low-priority
hardening item still open.

The Docker implementation now supports the current SQS -> Step Functions -> ECS Fargate
prover flow:

- digest-pinned RISC Zero toolchain base image via `RISC0_TOOLCHAIN_IMAGE`
- ARM64 Fargate runtime
- S3 input and output orchestration
- input JSON validation before invoking the Rust host
- bounded zkVM execution with `ZKVM_TIMEOUT_SECONDS` (default 900s)
- S3 upload retry logic
- public `bundle.zip` creation
- private bitmap sidecar preservation outside `bundle.zip`

Read-only AWS CLI checks on 2026-04-26 confirmed that the expected ECR repositories,
CodeBuild projects, ECS clusters, lifecycle policies, and Container Insights settings
exist in the configured account/region. Account-specific IDs are intentionally omitted
from this review note.

## Current Architecture

### Image Build Path

The application prover image is built by Terraform-managed CodeBuild projects:

- `stark-ballot-simulator-fargate-prover-develop`
- `stark-ballot-simulator-fargate-prover-main`

`buildspec.yml` resolves the RISC Zero toolchain image from ECR, requires a
digest-pinned `@sha256:<64 lowercase hex chars>` reference, and records the resolved
toolchain image in `image-metadata.json`.

The shared RISC Zero toolchain base image is built by:

- `stark-ballot-simulator-risc0-toolchain-builder`

That project uses `buildspec-risc0-toolchain.yml` and pushes to:

- `stark-ballot-simulator/risc0-toolchain`

### ECR Repositories

Terraform manages the current repository layout:

- `stark-ballot-simulator/zkvm-prover-develop`
- `stark-ballot-simulator/zkvm-prover-main`
- `stark-ballot-simulator/risc0-toolchain`

All three repositories use scan-on-push and AES256 encryption. Lifecycle policy is:

- prover repositories: keep last 10 images
- toolchain repository: keep last 5 images

### Runtime Path

The ECS task definition uses ARM64 Fargate with 16 vCPU / 32 GiB memory. The Step
Functions state machine verifies ECR image signing status before starting ECS:

1. `VerifyImageSignature`
2. `CheckImageSignature`
3. `RunProver`
4. `FinalizeSucceeded` / `FinalizeFailed` / `FinalizeSignatureFailed`

The current network model is public subnets with `AssignPublicIp = ENABLED`. It is not
the older private-subnet-plus-NAT model.

## Dockerfile Review

### Strengths

- Uses a required `RISC0_TOOLCHAIN_IMAGE` build arg instead of embedding private ECR
  URLs in the Dockerfile.
- Builds the Rust host in a dedicated build stage and copies only runtime essentials.
- Uses Amazon Linux 2023 for the ARM64 runtime image.
- Installs the AWS CLI v2 in the runtime image because the entrypoint needs S3 access.
- Keeps `RUST_LOG=info` as an overridable runtime default.

### Open Hardening Item

The runtime container still runs as root. Current ECS task definitions also do not set
a container `user`. Moving to a non-root runtime remains desirable, but it should be
done as a deliberate hardening patch because RISC Zero runtime assets currently live
under `/root/.cargo/bin` and `/root/.risc0`.

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
- consistency validation across public audit artifacts before bundling
- S3 upload retry via `upload_with_retry`

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

- `entrypoint.sh` was listed as 106 lines; it is now 944 lines and contains bundle
  generation and public audit artifact logic.
- Upload retry, input validation, and execution timeout were listed as future
  improvements; they are now implemented.
- The planned GitHub Actions build path is no longer the current standard path.
  Terraform-managed CodeBuild is the source of truth.
- The single `stark-ballot-simulator/zkvm-prover` ECR repository name is stale.
  Prover images are environment-specific: `zkvm-prover-develop` and
  `zkvm-prover-main`.
- The old local Docker run example referenced test data inside the runtime image.
  The runtime image does not include `zkvm/test-data`; mount local fixtures instead.
- The old network note said private subnet + NAT. Current Terraform uses public
  subnets and public IP assignment for ECS tasks.
- Container Insights was listed as follow-up. It is now enabled on the ECS clusters.

## Local Test Pattern

For local image smoke testing, mount the input fixture from the host:

```bash
AWS_ACCOUNT_ID=<account-id> \
  ./scripts/update-risc0-digest.sh --write-env .tmp/risc0-toolchain-image.env
source .tmp/risc0-toolchain-image.env

docker buildx build \
  --platform linux/arm64 \
  --build-arg RISC0_TOOLCHAIN_IMAGE="$RISC0_TOOLCHAIN_IMAGE" \
  -f docker/Dockerfile.fargate-prover \
  -t stark-ballot-simulator/zkvm-prover:local-test \
  --load \
  .

mkdir -p output

docker run --rm \
  -e RISC0_DEV_MODE=1 \
  -e INPUT_PATH=/tmp/input.json \
  -e OUTPUT_DIR=/var/task/output \
  -v "$PWD/zkvm/test-data/test-fixture-valid.json:/tmp/input.json:ro" \
  -v "$PWD/output:/var/task/output" \
  stark-ballot-simulator/zkvm-prover:local-test
```

This smoke test checks local entrypoint execution. It does not produce a production
STARK proof because `RISC0_DEV_MODE=1` creates a fake development receipt.

## Verification

Focused local verification:

```bash
pnpm test:entrypoint-bundle
```

This test checks the public bundle allowlist, private bitmap sidecar handling, public
audit artifact consistency checks, legacy output rejection, method-version rejection,
and timeout error reporting.

## Recommendation

The current Docker and entrypoint implementation matches the active async prover path.
Keep this file updated whenever the entrypoint public bundle contract, Terraform image
build path, or ECS runtime model changes.
