# RISC Zero Toolchain Image - ARM64

> **Status:** current technical and release-lane guide for the target AWS ARM64
> Toolchain image. Repository procedure updated: 2026-10-11. Live evidence
> last reconciled: 2026-07-24.

The RISC Zero toolchain image prebuilds the large Rust/RISC Zero toolchain used
by Prover image builds. A normal App or Prover execution resolves the current
Foundation checkpoint and requires the selected source's recomputed Foundation
contract hash to match; source equality is neither required nor sufficient. App
may reuse a compatible retained Prover built from another source when the
recorded zkVM contract hash matches exactly. Each Prover candidate preserves the
exact original Toolchain promotion reference (`key`, `versionId`, `sha256`) and digest-pinned base image. Its
Toolchain candidate may have been built from an earlier source SHA. Current
reuse checks the repository/digest and required contracts; repromoting the same
Toolchain digest does not require rebuilding Prover. If the current Toolchain
promotion already selects the intended image, do not run the Toolchain lane.

## Sources of truth

| Concern                           | Source                                                              |
| --------------------------------- | ------------------------------------------------------------------- |
| ARM64 image contents              | `infra/docker/Dockerfile.risc0-toolchain-arm64`                     |
| Target build and scan checks      | `buildspec-risc0-toolchain.yml`                                     |
| Allowed target and lane authority | `packages/deployment-authority/deployment-targets.json`             |
| Release pipeline                  | `infra/terraform/bootstrap/foundation_pipeline_toolchain_release_*` |
| ECR repository                    | `infra/terraform/foundation/ecr.tf`                                 |
| Operator procedure                | Private deployment and operator documentation                       |
| Candidate/promotion ledger        | `packages/deployment-authority/src/release-ledger.js`               |
| Candidate/promotion storage       | Versioned Foundation manifest storage                               |

The amd64 GHCR image built by
`.github/workflows/risc0-toolchain-image-amd64.yml` is for CI. Its Rust label is
independently pinned to 1.97.1. Rust Tests validates that label before using the
image, then installs the application's Rust 1.99.0 for repository tests. This
CI image is not the release authority for the AWS Fargate ARM64 prover.

## Reviewed release pins

The current source build-mode pins describe the next Toolchain build. They do
not establish that an AWS release using these pins has been accepted:

| Component             | Release     | Immutable source commit                    |
| --------------------- | ----------- | ------------------------------------------ |
| Application host Rust | `1.99.0`    | `b940084d7eb6a299eb4bfeb8e34901bc051e7ac4` |
| RISC Zero             | `v3.0.6`    | `1cc70cf05033a79ebc90f07c679cb4bd1cd301b9` |
| RISC Zero guest Rust  | `r0.1.97.0` | `e638c6cfea1eff5fbbb24a27e60538e3760d21b8` |

Use the [Rust stable release authority](https://blog.rust-lang.org/releases/latest/),
the [RISC Zero release](https://github.com/risc0/risc0/releases/tag/v3.0.6),
and the [RISC Zero guest Rust release](https://github.com/risc0/rust/releases/tag/r0.1.97.0)
when reviewing a future update. Do not replace the checked-in pins with a
mutable `latest` reference.

The application host uses Rust 1.99.0. Building upstream RISC Zero host tools
uses a separate Rust 1.97.1 compiler, following the official v3.0.6
[`rust-toolchain.toml`](https://github.com/risc0/risc0/blob/1cc70cf05033a79ebc90f07c679cb4bd1cd301b9/rust-toolchain.toml)
channel `1.97`. The RISC Zero guest compiler remains `r0.1.97.0`.
Both Docker build stages select `RISC0_BUILD_RUST_VERSION=1.97.1`,
check that upstream declares the matching minor channel, install that compiler,
and use it to build rzup; ARM64 also uses it to build cargo-risczero. Application
and guest compilers stay unchanged. ARM64 removes the build-only compiler
before copying tools into the final image. The CI amd64 image retains 1.97.1
as its toolchain compiler; its test job installs application Rust separately. The pinned upstream source is unmodified; there is no FFI patch or
lint suppression. Existing exact-source authority binds this Docker recipe; no
new candidate, metadata, image-label or consumer contract is introduced.

In `build` mode, `buildspec-risc0-toolchain.yml` rejects environment overrides
that differ from these reviewed pins. Before push, it also checks the installed
host and guest `rustc` versions and commits, `cargo-risczero` and `r0vm`
versions, and the corresponding image labels. `existing` deliberately does
not impose current-version pins: historical selection remains available for
admitted candidates identified by one content-addressed ledger key.

The build path uses the Amazon ECR credential helper already supplied by the
managed ARM CodeBuild image. Its temporary Docker configuration admits only
the exact target private registry and `public.ecr.aws`, disables the helper's
token cache, and probes both registries before starting the long image build.
Retained-candidate selection skips this Docker/ECR authentication path.

## When image contents change

- The RISC Zero version or commit changes.
- The RISC Zero Rust toolchain pin changes.
- Packages, build steps, or architecture in
  `Dockerfile.risc0-toolchain-arm64` change.
- The toolchain buildspec, scan, or provenance contract changes.
- The accepted toolchain image itself needs a security fix.

These conditions describe when `build` mode is required. To select a different
already retained candidate, use `existing` mode with its exact
content-addressed ledger key. That mode revalidates the candidate and ECR
digest without rebuilding the image, then conditionally publishes a new version of the fixed promotion record
while preserving original build provenance.

## Current release flow

Build or select the target Toolchain authority in its dedicated release lane.

```text
Source
  -> CandidateApproval / ApproveToolchainCandidateExecution
  -> PrepareToolchainCandidate
     -> render and validate the canonical, hash-bound Toolchain context
     -> build/publish a new candidate or resolve one exact candidate key
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
publishing a new version at `promotions/toolchain/current.json` by first-create
or exact compare-and-swap. The promotion refers to exact immutable candidate
bytes and records the approval, execution and current revalidation.

Normal Prover input observes the current promotion once, or selects an explicitly
pinned S3 VersionId of that fixed key, and binds its complete immutable reference
and candidate to the build. Prover uses immutable candidates and its own versioned
`promotions/prover/current.json`. Its `existing` mode selects one retained candidate
and verifies its original Toolchain provenance plus compatibility with the current
Toolchain repository/digest and source contracts, without rebuilding either image.
Normal App selection resolves exact promotions and candidates from both ledgers.
A missing ECR digest blocks selection; native newest-five retention may remove a
needed image, requiring an explicitly authorized build and fresh promotion.

Do not start this lane until the user explicitly authorizes the intended build
or retained selection. Production requires separate authorization for the exact
target, source, and scope. Follow the private deployment and operator
documentation for the exact dry-run and execution commands. Every selection
must bind a full control source SHA. Toolchain existing-candidate selection binds
its one exact `artifacts/toolchain/candidates/<sha256>.json` ledger key; there
is no operator S3 `VersionId`/body-hash group.

Before execution, independently select the target and review its exact configured
account, pipeline, Source action, region, operator profile, control SHA, mode,
and exact candidate key when applicable. Ordinary starts use
`scripts/aws/deploy-cli.ts`, which selects `stark-dev-operator` for
`stark-dev/develop` or `stark-prod-operator` for `stark-prod/main`.
The develop-only retained-selection helper remains fixed to `stark-dev/develop`
and `stark-dev-operator`; it does not provide production retained selection.
The entrypoints derive target values from deployment authority and reject
account, pipeline, Source-action, region, or profile alternatives. Each passes
the selected commit as both the CodePipeline
Source `COMMIT_ID` and `RequestedSourceSha`, requires an explicit execution
option plus an independently supplied expected account ID, and verifies both
the exact account and reviewed IAM Identity Center operator role before it
starts CodePipeline.

## Approval decisions by mode

`ApproveToolchainCandidateExecution` is required before the shared privileged
candidate project runs in either mode. In `build`, it authorizes the reviewed
ARM64 build, push, scan, and create-only candidate publication. In `existing`,
the same gate authorizes only exact read and validation of the reviewed
candidate key; that path performs no Docker build, ECR mutation, or new scan.
Requiring the gate in both modes prevents the shared project's build-capable
role from running before human approval.

Before approving `ApproveToolchainPromotion`, verify:

- the current control source SHA and selection mode;
- the candidate's exact content-addressed ledger key and original source/build
  evidence, whether newly built or retained;
- the digest-pinned ECR URI;
- the digest-bound scan summary and repository-policy disposition.

The toolchain scan is warn-only. HIGH or CRITICAL findings are accepted and
non-blocking for this PoC under the repository policy; the semantic record
retains the digest-bound `scanStatus` and HIGH/CRITICAL count. No waiver input,
per-finding review, or remediation is required. Toolchain images are neither
signed nor cryptographically verified.

`ApproveToolchainPromotion` is required in both modes. It authorizes the
subsequent `UpdateAcceptedPointer` action to conditionally write the fixed
promotion record for the selected image without changing the candidate.
After that action succeeds, verify:

- the promotion's exact key, S3 VersionId and stored-byte SHA-256, and its
  binding to the reviewed candidate, control source and promotion execution;
- first-create or exact compare-and-swap evidence for that version.

## Required follow-up

Updating the current Toolchain promotion does not change the existing prover or
ECS task.

1. Select Prover authority compatible with the current Toolchain repository/digest
   and source contracts. A same-digest Toolchain repromotion preserves compatibility
   with the candidate's recorded original promotion. Use Prover `existing` for an
   eligible retained candidate; build when required inputs change or its image is absent.
2. Verify and promote the Prover candidate's ImageID/method version, scan, and
   managed-signing readiness.
3. Run the app full lane so its preflight cryptographically verifies the
   selected Prover digest before the accepted record reaches runtime.
4. Validate the real-zkVM flow for the selected target within its authorized
   acceptance scope. Develop uses the operator-gated flow; production validation
   requires separately authorized production scope.

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

## Live status and troubleshooting

Consult the private current-AWS inventory for the latest execution and
versioned promotion evidence, and the private operator script guide for helper
arguments and artifact contracts. Before retrying a failed or stopped
execution, inspect that execution's CodeBuild log and retained candidate
record.

## Unsupported release paths

- The deleted legacy account's CodeBuild/ECR path is retired; use the target
  release.
- Do not use a direct Docker push or local Toolchain generation as image
  authority.
- Do not start CodeBuild directly with `aws codebuild start-build`.
- Do not supply `latest` or another mutable tag to the app.
- Do not transcribe a digest into Terraform or a manifest and call it accepted
  evidence.
- Do not manually reissue candidate or promotion records or select an image by
  digest alone.
- Do not overwrite a current promotion object with an ad hoc S3 write.
