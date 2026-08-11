# RISC Zero Toolchain Image - ARM64

> **Status:** current technical and release-lane guide for the target AWS ARM64
> Toolchain image. Repository procedure updated: 2026-08-09. Live evidence
> last reconciled: 2026-07-24.

The RISC Zero toolchain image prebuilds the large Rust/RISC Zero toolchain used
by Prover image builds. A normal full App deployment uses one control source
SHA for its same-source Foundation and App lanes, but it may reuse a compatible
retained Prover built from another source when the recorded zkVM contract hash
matches exactly. Each Prover record exact-links one immutable Toolchain
artifact, which may itself have been built from an earlier source SHA. If the
accepted Toolchain pointer already names the intended artifact, do not run the
Toolchain lane.

## Sources of truth

| Concern                           | Source                                                              |
| --------------------------------- | ------------------------------------------------------------------- |
| ARM64 image contents              | `infra/docker/Dockerfile.risc0-toolchain-arm64`                     |
| Target build and scan checks      | `buildspec-risc0-toolchain.yml`                                     |
| Allowed target and lane authority | `packages/deployment-authority/deployment-targets.json`             |
| Release pipeline                  | `infra/terraform/bootstrap/foundation_pipeline_toolchain_release_*` |
| ECR repository                    | `infra/terraform/foundation/ecr.tf`                                 |
| Operator procedure                | Private deployment and operator documentation                       |
| Release record and pointer        | Versioned foundation manifest storage                               |

The amd64 GHCR image built by
`.github/workflows/risc0-toolchain-image-amd64.yml` is for CI. It is not the
release authority for the AWS Fargate ARM64 prover.

## Reviewed release pins

The current build-mode pins were checked against the official release
authorities on 2026-07-26:

| Component            | Release     | Immutable source commit                    |
| -------------------- | ----------- | ------------------------------------------ |
| Host Rust            | `1.97.1`    | `8bab26f4f68e0e26f0bb7960be334d5b520ea452` |
| RISC Zero            | `v3.0.6`    | `1cc70cf05033a79ebc90f07c679cb4bd1cd301b9` |
| RISC Zero guest Rust | `r0.1.97.0` | `e638c6cfea1eff5fbbb24a27e60538e3760d21b8` |

Use the [Rust stable release authority](https://blog.rust-lang.org/releases/latest/),
the [RISC Zero release](https://github.com/risc0/risc0/releases/tag/v3.0.6),
and the [RISC Zero guest Rust release](https://github.com/risc0/rust/releases/tag/r0.1.97.0)
when reviewing a future update. Do not replace the checked-in pins with a
mutable `latest` reference.

In `build` mode, `buildspec-risc0-toolchain.yml` rejects environment overrides
that differ from these reviewed pins. Before push, it also checks the installed
host and guest `rustc` versions and commits, `cargo-risczero` and `r0vm`
versions, and the corresponding image labels. `existing` deliberately does
not impose current-version pins: historical selection remains available for
current semantic records identified by exact immutable coordinates.

The build path uses the Amazon ECR credential helper already supplied by the
managed ARM CodeBuild image. Its temporary Docker configuration admits only
the exact target private registry and `public.ecr.aws`, disables the helper's
token cache, and probes both registries before starting the long image build.
Retained-artifact selection skips this Docker/ECR authentication path.

## When image contents change

- The RISC Zero version or commit changes.
- The RISC Zero Rust toolchain pin changes.
- Packages, build steps, or architecture in
  `Dockerfile.risc0-toolchain-arm64` change.
- The toolchain buildspec, scan, or provenance contract changes.
- The accepted toolchain image itself needs a security fix.

These conditions describe when `build` mode is required. To select a different
already retained semantic artifact, use `existing` mode with its exact key, S3
`VersionId`, and canonical body SHA-256. That mode revalidates the record and
ECR digest without rebuilding the image, then publishes a current semantic
record that preserves the original build provenance. Direct publication,
manual record reissue, digest-only selection, and mutable tags remain
unsupported.

## Current release flow

Build or select the target Toolchain authority in its dedicated release lane,
never through a direct Docker push, direct CodeBuild start, or legacy Terraform
path.

```text
Source
  -> CandidateApproval / ApproveToolchainCandidateExecution
  -> PrepareToolchainCandidate
     -> render and validate the canonical, hash-bound Toolchain context
     -> build a new candidate or resolve one exact retained artifact
  -> PromotionApproval / ApproveToolchainPromotion
  -> UpdateAcceptedPointer
     (revalidate the same context for the pointer role and project)
```

`packages/deployment-authority/deployment-targets.json` is the reviewed source
for the allowed target, Toolchain lane, exact generated names, and lane policy.
The candidate renders those values with the requested control, selected
application, and framework source all bound to the exact Toolchain control SHA.
It retains the canonical context and its SHA-256 beside `image-info.json`.
Context loading verifies the full target-configuration hash, lane, account,
region, resolved source, and exact CodeBuild role and project. Pointer promotion
loads that same retained context against its own exact role and project before
publishing authority.

Do not start this lane until the user explicitly authorizes the intended build
or retained selection. Follow the private deployment and operator
documentation for the exact dry-run and execution commands. Every selection
must bind a full control source SHA. Retained-artifact selection must also bind
the exact artifact key, S3 `VersionId`, and body SHA-256.

Before execution, review the exact configured account, pipeline, Source action,
region, fixed `stark-dev-operator` profile, control SHA, mode, and exact retained
coordinates when applicable. The private starter derives the target values
from deployment authority and rejects account, pipeline, Source-action, region,
or profile alternatives. It passes the selected commit as both the CodePipeline
Source `COMMIT_ID` and `RequestedSourceSha`, requires an explicit execution
option plus an independently supplied expected account ID, and verifies both
the exact account and reviewed IAM Identity Center operator role before it
starts CodePipeline.

## Approval decisions by mode

`ApproveToolchainCandidateExecution` is required before the shared privileged
candidate project runs in either mode. In `build`, it authorizes the reviewed
ARM64 build, push, scan, and immutable record write. In `existing`, the same
gate authorizes only exact read and validation of the reviewed retained
coordinates; that path performs no Docker build, ECR mutation, or new scan.
After the separate promotion approval, it writes a current semantic record for
the selected image without changing the selected immutable record. Requiring
the gate in both modes prevents the shared project's build-capable role from
running before human approval.
`ApproveToolchainPromotion` separately authorizes promoting the prepared
candidate into the accepted channel and is also required in both modes.

Before promotion, verify:

- the current control source SHA and selection mode;
- the new candidate source/build evidence, or the retained artifact's original
  source and exact key, VersionId, and body SHA-256;
- the digest-pinned ECR URI;
- the digest-bound scan summary and repository-policy disposition;
- immutable artifact-record key, VersionId, and body checksum; and
- accepted-pointer first-create or compare-and-swap evidence.

The toolchain scan is warn-only. HIGH or CRITICAL findings are accepted and
non-blocking for this PoC under the repository policy; the semantic record
retains the digest-bound `scanStatus` and HIGH/CRITICAL count. No waiver input,
per-finding review, or remediation is required. Toolchain images are neither
signed nor cryptographically verified.

## Required follow-up

Updating the accepted toolchain pointer does not change the existing prover or
ECS task.

1. Run a new prover release that selects the accepted toolchain.
2. Verify and promote the prover candidate's ImageID/method version, scan, and
   managed-signing readiness.
3. Run the app full lane so its preflight cryptographically verifies the
   selected Prover digest before the accepted record reaches runtime.
4. Validate the real-zkVM and gated develop flows.

Do not treat toolchain promotion alone as a completed application deployment.

## Local validation

Before starting an AWS build, run repository checks for any Dockerfile or pin
change. Before retained selection, run the release-lane contract tests. A
complete ARM64 Toolchain build under x86_64/QEMU is not a routine local gate.

```bash
pnpm test:run
pnpm public-safety:scan
```

Run the affected Dockerfile/buildspec contract tests and format checks as well.
A local image or mutable tag is never release evidence.

## Live status and troubleshooting

The dedicated Toolchain lane supports both build and exact retained-artifact
selection. Consult the private current-AWS inventory for the latest execution
and accepted-pointer evidence. Before retrying a failed or stopped execution,
inspect that execution's CodeBuild log and retained artifact instead of
repeatedly changing inputs.

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
