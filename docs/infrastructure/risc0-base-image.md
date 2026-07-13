# RISC Zero Toolchain Image - ARM64

> **Status:** current technical and release-lane guide for the target AWS ARM64
> toolchain image. Last reconciled: 2026-07-11.

The RISC Zero toolchain image prebuilds the large Rust/RISC Zero toolchain used
by prover image builds. Ordinary application, API, frontend, and prover-source
changes do not require rebuilding it.

## Sources of truth

| Concern                                | Source                                                              |
| -------------------------------------- | ------------------------------------------------------------------- |
| ARM64 image contents                   | `infra/docker/Dockerfile.risc0-toolchain-arm64`                     |
| Target build, scan, and signing checks | `buildspec-risc0-toolchain.yml`                                     |
| Release pipeline                       | `infra/terraform/bootstrap/foundation_pipeline_toolchain_release_*` |
| ECR repository and signing authority   | `infra/terraform/foundation/ecr.tf`, `ecr_signing.tf`               |
| Operator helper                        | `scripts/aws/start-develop-toolchain-release-pipeline.ts`           |
| Release record and pointer             | Versioned foundation manifest storage                               |

The amd64 GHCR image built by
`.github/workflows/risc0-toolchain-image-amd64.yml` is for CI. It is not the
release authority for the AWS Fargate ARM64 prover.

## When a rebuild is required

- The RISC Zero version or commit changes.
- The RISC Zero Rust toolchain pin changes.
- Packages, build steps, or architecture in
  `Dockerfile.risc0-toolchain-arm64` change.
- The toolchain buildspec, scan, signing, or provenance contract changes.
- The accepted toolchain image itself needs a security fix.

A rebuild is not required for:

- frontend, API, package, or app Terraform changes;
- guest, host, or prover Dockerfile changes that retain the same toolchain pin;
- a verifier-service-only change; or
- regeneration of a prover release or app deployment record.

## Current release flow

Build the target toolchain image in its dedicated release lane, never through a
direct Docker push, direct CodeBuild start, or legacy Terraform path.

```text
Source
  -> ApproveToolchainBuild
  -> BuildToolchainCandidate
  -> ApproveToolchainPromotion
  -> PublishPromotionEvidence
  -> UpdateAcceptedPointer
```

Start with a dry run pinned to the exact source SHA.

```bash
pnpm aws:toolchain-release-pipeline:develop -- \
  --source-sha <40-character-develop-commit>
```

Review the selected pipeline, region, profile, source mode, and SHA before
starting it.

```bash
pnpm aws:toolchain-release-pipeline:develop -- \
  --source-sha <40-character-develop-commit> \
  --execute
```

Omitting `--source-sha` makes the pipeline resolve the branch head when it
starts. Prefer an explicit SHA for a reproducible release.

## Two separate approval decisions

`ApproveToolchainBuild` authorizes the expensive ARM64 build.
`ApproveToolchainPromotion` separately authorizes promoting its result into the
accepted channel.

Before promotion, verify:

- source SHA and build-evidence consistency;
- the digest-pinned ECR URI;
- the scan summary and HIGH/CRITICAL findings;
- digest-level signing status `COMPLETE`;
- immutable artifact-record key, VersionId, and body checksum; and
- accepted-pointer first-create or compare-and-swap evidence.

The toolchain scan is warn-only. When HIGH or CRITICAL findings are accepted,
pass a reviewed waiver evidence ID in both the dry-run review and execution.

```bash
pnpm aws:toolchain-release-pipeline:develop -- \
  --source-sha <40-character-develop-commit> \
  --scan-waiver <reviewed-evidence-id> \
  --execute
```

Never place a secret, raw report body, or full account ID in the waiver ID.

## Required follow-up

Updating the accepted toolchain pointer does not change the existing prover or
ECS task.

1. Run a new prover release that selects the accepted toolchain.
2. Verify and promote the prover candidate's ImageID/method version, scan, and
   signing evidence.
3. Run the app full lane so the accepted prover record reaches the app
   deployment record and runtime.
4. Validate the real-zkVM and gated develop flows.

Do not treat toolchain promotion alone as a completed application deployment.

## Local validation

Before starting the AWS build, run repository checks for any Dockerfile or pin
change. A complete ARM64 toolchain build under x86_64/QEMU is not a routine
local gate.

```bash
pnpm test:run
pnpm public-safety:scan
```

Run the affected Dockerfile/buildspec contract tests and format checks as well.
A local image or mutable tag is never release evidence.

## Live status and troubleshooting

As of 2026-07-11, the dedicated toolchain lane exists in AWS and its build and
promotion stages have been exercised, but it has no successful end-to-end
execution. Before retrying, inspect the first failed/stopped execution's
CodeBuild log and retained artifact instead of repeatedly changing inputs.

See the private current-AWS inventory for live status and the private operator
script guide for helper arguments and artifact contracts.

## Forbidden legacy paths

- Do not use `infra/terraform/legacy/` CodeBuild/ECR resources for a target
  release.
- Do not accept a local `docker buildx ... --push` as image authority.
- Do not start CodeBuild directly with `aws codebuild start-build`.
- Do not supply `latest` or another mutable tag to the app.
- Do not transcribe a digest into Terraform or a manifest and call it accepted
  evidence.
- Do not overwrite an accepted-pointer object with an ad hoc S3 write.
