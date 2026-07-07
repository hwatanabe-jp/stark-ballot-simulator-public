# RISC Zero Toolchain Base Image - ARM64 Linux

## 目次

1. [概要](#概要)
2. [背景と目的](#背景と目的)
3. [初回セットアップ](#初回セットアップ)
4. [ビルド手順](#ビルド手順)
5. [ダイジェスト固定](#ダイジェスト固定)
6. [更新運用](#更新運用)
7. [トラブルシューティング](#トラブルシューティング)

---

## 概要

**ファイル**: `infra/docker/Dockerfile.risc0-toolchain-arm64`
**目的**: RISC Zero zkVM ツールチェーンを事前ビルドし、CI/CD の高速化とコスト削減を実現
**対象アーキテクチャ**: `linux/arm64` (aarch64)
**ビルド時間**:

- **CodeBuild ARM_CONTAINER (ARM64 native)**: 初回 100-120 分（ツールチェーンビルド）、以降のアプリケーションビルドは 5-10 分
- **ローカル (x86_64 + QEMU emulation)**: ⚠️ **非推奨**（12時間以上でも未完了、10-20x 遅い）
- **推奨**: すべてのベースイメージビルドは CodeBuild を使用

> **Plan 02/03 guardrail:** This guide preserves technical background for
> building and digest-pinning the RISC Zero ARM64 toolchain image. It is not
> the current `stark-dev/develop/app` Plan 02 release-candidate authority and
> is not Plan 03 handoff evidence. Direct local Docker builds, direct ad hoc
> `aws codebuild start-build` invocations, legacy Terraform/CodeBuild
> resources, mutable tags, and operator-authored manifest assertions are not
> accepted Plan 02/03 handoff evidence. CodeBuild evidence is accepted for
> Plan 03 only when produced by the required separate target-account develop
> toolchain/prover release artifact pipelines with retained build, scan,
> signing, provenance, promotion/channel records, and a selected prover
> release/app deployment record. Any different authority would
> require a future formally approved superseding decision. For the current
> target-develop handoff contract, use
> [`develop-target-image-authority.md`](../../internal/guides/3-deployment/develop-target-image-authority.md)
> and the post-merge Plan 02/03 documents.

### バージョン情報（2026-03-21 時点）

- **RISC Zero**: v3.0.5 (commit: `8eb06ab020a92dc5b63ba6dd0836d432aba6d890`)
- **RISC Zero Rust toolchain**: `r0.1.91.1` (`risc0/rust` リポジトリのタグ, upstream release asset は `1.91.1`)
- **Rust**: 1.91.1
- **`risc0-zkp`**: 3.0.4（upstream の `v3.0.5` workspace 定義に追従）
- **`rzup`**: 0.5.1（`risc0/risc0` `v3.0.5` タグ上の crate version）
- **Base OS**: Debian bookworm-slim
- **Build strategy**: Multi-stage (build + final stages for size optimization)

### 管理境界

このドキュメント内の Terraform / CodeBuild resource references は、retained legacy/shared build path の背景情報です。
Plan 02/03 の target develop image authority では、foundation-owned ECR repository と承認済み AWS-controlled
release-candidate path が優先されます。Terraform 管理リソースの作成・変更は
`docs/current/guides/7-terraform/README.md` と current post-merge handoff contract を優先してください。

- ECR repository: `infra/terraform/legacy/ecr.tf` の `aws_ecr_repository.risc0_toolchain`
- CodeBuild project: `infra/terraform/legacy/codebuild.tf` の `aws_codebuild_project.risc0_toolchain`
- version pin: `infra/terraform/legacy/variables.tf` の `risc0_version` / `risc0_commit` / `risc0_rust_version` / `risc0_rust_toolchain_tag`
- application image build: `buildspec.yml` が ECR 上の toolchain tag から digest-pinned image URI を解決して `infra/docker/Dockerfile.fargate-prover` に渡す

---

## 背景と目的

### 問題

RISC Zero の公式インストーラー `rzup` は ARM64 Linux (aarch64-unknown-linux-gnu) のプリビルドバイナリを提供していない。そのため、CodeBuild ARM_CONTAINER 環境で毎回 100-120 分のツールチェーンビルドが必要となり：

- CI/CD ビルドが 100-120 分かかる（タイムアウトリスク）
- コスト増加（BUILD_GENERAL1_MEDIUM での長時間実行）
- 開発イテレーションが遅い

### 解決策

**ベースイメージ戦略**: ツールチェーンを一度だけビルドし、ECR にプッシュ。以降のアプリケーションビルドはこのベースイメージを使用。

- **通常の CI/CD ビルド**: 5-10 分（高速イテレーション）
- **ツールチェーン更新**: 年 1-2 回のみ（RISC Zero リリース時）

### イメージサイズ最適化

**Multi-stage build による最適化**（2025-10-24 実装）:

- **Build stage**: RISC Zero toolchain + 全ビルド依存関係（git, cmake, ninja, build-essential など）
- **Final stage**: ランタイム成果物のみコピー（cargo/rustc/r0vm バイナリ、toolchains、stdlib）
- **除外されるもの**: git 履歴、cargo cache、build artifacts、一時ファイル

**サイズの目安**（参考）:

- 単一ステージは 10 GB を超えることがある（toolchain + build deps を含むため）
- Multi-stage で大幅に削減できるが、サイズはツールチェーン版本や依存関係に依存するため、実ビルドで確認する

**⚠️ 注意: `linker \`cc\` not found`**:

Multi-stage の Final stage にランタイム依存関係のみを含め、ビルドツール（gcc）を除外すると発生する。cargo は Rust コードのリンク時に C リンカーを必要とするため、Final stage に最小限のビルドツールを追加する。

- `gcc`: C コンパイラ/リンカー（cargo がリンク時に必要）
- `libc6-dev`: C 標準ライブラリヘッダー

**rzup build rust の削減可否調査結果**（2025-10-24）:

- **結論**: 削減不可
- **理由**:
  1. RISC Zero 公式ドキュメント ([Manual Installation for arm64 Linux](https://dev.risczero.com/api/zkvm/install)) で ARM64 Linux はプリビルド済みツールチェーン未提供
  2. `zkvm/methods/build.rs` が `risc0_build::embed_methods()` を呼び出し、`riscv32im-risc0-zkvm-elf` ターゲットでゲストコード再コンパイル
  3. `~/.risc0/toolchains/` の Rust toolchain が必須（過去ログで toolchain 'risc0' 未インストールエラーを確認済み）
  4. 「rzup で Rust toolchain を build → cargo-risczero/r0vm を install」フローは ARM64 CodeBuild でホストバイナリ生成に最低限必要

したがって、**`rzup build rust` を省略する選択肢はない**と判断します。

---

## 初回セットアップ

### Retained legacy/shared path: Terraform で管理リソースを作成

RISC Zero toolchain の legacy/shared ECR repository と CodeBuild project は Terraform で管理します。手動で `aws ecr create-repository`
や `aws codebuild create-project` を実行する前に、対象 workspace と tfvars を確認してください。
この path は current Plan 02/03 handoff authority ではありません。

Do not use the removed `pnpm terraform:tfvars:*` package scripts or direct
legacy Terraform `plan/apply` examples as current operator guidance. For
post-merge `stark-dev/develop`, create toolchain release evidence through the
separate toolchain release artifact pipeline and accepted channel pointer
required by
[`develop-target-image-authority.md`](../../internal/guides/3-deployment/develop-target-image-authority.md).
Legacy/shared Terraform changes require a separately authorized guarded
Terraform operation outside the Plan 03 acceptance path.

関連 Terraform 入力:

- `risc0_toolchain_codebuild_name`: 既定 `stark-ballot-simulator-risc0-toolchain-builder`
- `risc0_toolchain_source_version`: shared toolchain builder が clone する Git ref。既定は `refs/heads/main`
- `risc0_version`: 既定 `3.0.5`
- `risc0_commit`: `risc0/risc0` release tag の pinned commit
- `risc0_rust_version`: host Rust version
- `risc0_rust_toolchain_tag`: ARM64 guest toolchain build に使う `risc0/rust` tag
- `risc0_toolchain_image_retention_count`: shared ECR repository の image retention count

作成される主なリソース:

- ECR: `stark-ballot-simulator/risc0-toolchain`
- CodeBuild: `stark-ballot-simulator-risc0-toolchain-builder`
- IAM role/policy: `stark-ballot-simulator-codebuild-risc0-toolchain`
- CloudWatch Logs: toolchain builder 用 log group

### 参考: 手動 ECR 確認

```bash
export AWS_ACCOUNT_ID="<aws-account-id>"
export AWS_REGION="<region>"
export ECR_REPO="stark-ballot-simulator/risc0-toolchain"
export ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr describe-repositories \
  --repository-name "$ECR_REPO" \
  --region "$AWS_REGION"
```

ECR repository や lifecycle policy を手動作成・手動変更した場合は、Terraform state と差分が出ないか `terraform plan` で確認してください。

### ECR ログイン

```bash
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"
```

---

## ビルド手順

### Option A: ローカルビルド（retained legacy/diagnostic only）

This local build/push example is retained only for legacy investigation or
isolated diagnostics. It tags and pushes `latest`, which is not compatible with
the Plan 02/03 target-develop authority model. Do not run this as current
release guidance, and do not cite its output as handoff evidence. Current
target-develop toolchain images must come from the separate target-account
toolchain release artifact pipeline, accepted channel pointer, and retained
artifact record required by
[`develop-target-image-authority.md`](../../internal/guides/3-deployment/develop-target-image-authority.md).

**前提条件**:

- Docker Desktop with ARM64 support（Mac M1/M2 または WSL2 with ARM64 emulation）
- 100-120 分の待機時間
- 8 GB 以上のメモリ

**⚠️ 重要**: WSL2 で QEMU を使用した ARM64 ビルドは非常に遅い（90-120 分）ため、M1/M2 Mac などの ARM64 ネイティブ環境、または CodeBuild を推奨。

```bash
cd <repo-root>

# ARM64 イメージをビルド
IMAGE_TAG="3.0.5-arm64"
IMAGE_URI="${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"
docker build --platform linux/arm64 \
  -t "$IMAGE_URI" \
  -f infra/docker/Dockerfile.risc0-toolchain-arm64 \
  .

# ビルド完了後、タグ付け
docker tag \
  "$IMAGE_URI" \
  "${ECR_REGISTRY}/${ECR_REPO}:latest"

# ECR にプッシュ
docker push "$IMAGE_URI"
docker push "${ECR_REGISTRY}/${ECR_REPO}:latest"

# スモークテスト（ビルド後必須）
docker run --rm "$IMAGE_URI" cargo risczero --help
docker run --rm "$IMAGE_URI" r0vm --version
docker run --rm "$IMAGE_URI" rustc --version
```

### Option B: CodeBuild でビルド（legacy/shared path）

**前提条件**:

- Terraform で作成済みの CodeBuild project
- タイムアウト: **120 分**
- コンピュートタイプ: BUILD_GENERAL1_LARGE（7 GB メモリ、4 vCPU）
- `buildspec-risc0-toolchain.yml` が参照する Git ref に、対象 Dockerfile と buildspec の変更が push 済みであること

#### B-1. 現行 buildspec の役割

標準 buildspec は repository root の `buildspec-risc0-toolchain.yml` です。doc 内のコピーではなく、実ファイルを source of truth としてください。

現行 buildspec は次を行います。

- `IMAGE_REPO_NAME` を CodeBuild env から必ず受け取る（未指定なら fail
  closed）。`RISC0_VERSION` / `RUST_VERSION` / `RUST_TOOLCHAIN_TAG` / `RISC0_COMMIT`
  は CodeBuild env から受け取り、不足時は既定値を使う
- `SOURCE_REPOSITORY` を `CODEBUILD_SOURCE_REPO_URL` から渡し、Docker image label に private repository URL を固定しない
- `infra/docker/Dockerfile.risc0-toolchain-arm64` に build args を渡して ARM64 toolchain image を build
- `rustc --version` / `cargo risczero --version` / `r0vm --version` / `rzup --version` を image 内で smoke test
- `latest` tag も push する（legacy/shared behavior only; not target-develop
  Plan 02/03 authority）
- ECR image scan の HIGH/CRITICAL finding を確認する
  - toolchain base image では finding があっても build は fail しない
  - production 利用前に `docs/current/runbooks/security.md` の運用で確認する
- `/tmp/image-info.json` に `imageTag` / `imageDigest` / `imageUri` / version metadata に加えて
  `sourceSha` / `requestedSourceSha` / `buildId` / `timestamp` を出力する
  （CodeBuild artifact としては `base-directory: /tmp` の `image-info.json`）
- `REQUESTED_SOURCE_SHA` は任意。明示した場合は resolved source と不一致なら
  pre_build で fail-closed、未設定なら resolved branch head をビルドして
  `sourceShaMode: "branch-head"` として記録する。通常は
  `development_toolchain_release` レーン（`ApproveToolchainBuild` 承認で
  ビルド発火）経由で実行する

#### B-2. Terraform 設定の確認

Do not use legacy Terraform plan output as current Plan 02/03 acceptance
evidence. For target-develop release candidates, verify the corresponding
source version, CodeBuild project configuration, and version pins through the
retained outputs of the toolchain release artifact pipeline and accepted
channel pointer.

確認ポイント:

- `risc0_toolchain_codebuild_name` が意図した project name であること
- `risc0_toolchain_source_version` が build したい Git ref を指していること
- `risc0_version` / `risc0_commit` / `risc0_rust_version` / `risc0_rust_toolchain_tag` が Dockerfile と一致していること
- `codebuild_source_location` が concrete な GitHub repository URL であること

#### B-3. ビルド実行

Direct `aws codebuild start-build` is not current Plan 02/03 handoff guidance.
For target-develop, the toolchain image must be built or pipeline-selected by
the target-account toolchain release artifact pipeline, and the successful
candidate/promotion execution IDs plus retained outputs are the evidence.

Do not use environment-variable override `start-build` commands as current
target-develop release guidance. Version pins for a Plan 02/03 release
candidate must be captured by the release artifact pipeline inputs, accepted
channel pointer, and retained outputs.

#### B-4. ビルド完了後の確認

The tag lookup below is only a local diagnostic for resolving the pushed
toolchain digest. It is not release acceptance evidence; accepted toolchain or
prover evidence must be bound to immutable digests and retained artifact
records.

```bash
export AWS_ACCOUNT_ID="<aws-account-id>"
export AWS_REGION="ap-northeast-1"
export ECR_REPO="stark-ballot-simulator/risc0-toolchain"
export ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

IMAGE_TAG="3.0.5-arm64"
IMAGE_URI="${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

aws ecr describe-images \
  --repository-name "$ECR_REPO" \
  --image-ids imageTag="$IMAGE_TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text

docker run --rm "$IMAGE_URI" cargo risczero --help
docker run --rm "$IMAGE_URI" r0vm --version
docker run --rm "$IMAGE_URI" rzup --version
docker run --rm "$IMAGE_URI" rustc --version
```

---

## ダイジェスト固定

### Retained legacy: application image build tag resolution

This section describes the retained legacy/shared `buildspec.yml` behavior. It
is not the target-develop Plan 02/03 authority. Current target-develop prover
builds must resolve the toolchain from an accepted or pinned immutable
toolchain artifact record before the prover release artifact pipeline starts.
The app deployment pipeline must select a prover release record generated from
that pipeline output; it must not resolve a toolchain tag as deployment
authority.

`infra/docker/Dockerfile.fargate-prover` は private ECR URI を既定値として持たず、`ARG RISC0_TOOLCHAIN_IMAGE` を必須 build arg として受け取ります。
CodeBuild の application image build (`buildspec.yml`) は、ECR 上の toolchain tag から digest を解決し、`<registry>/<repo>@sha256:<digest>` の形にして Docker build に渡します。

標準の解決順:

1. `RISC0_TOOLCHAIN_IMAGE` が CodeBuild env に明示されていれば、それを使う
2. 未指定なら必須の `RISC0_TOOLCHAIN_REPO_NAME` と `RISC0_TOOLCHAIN_IMAGE_TAG` を使って
   ECR から digest を取得する（repository name 未指定は fail closed）
3. `RISC0_TOOLCHAIN_IMAGE_TAG` 未指定時は `${RISC0_VERSION:-3.0.5}-arm64` を使う
4. 解決後の `RISC0_TOOLCHAIN_IMAGE` が `@sha256:<64 lowercase hex chars>` でなければ build を fail する
5. `image-metadata.json` に `risc0ToolchainImage` と `risc0ToolchainTag` を記録する

このため、通常の application image build では `infra/docker/Dockerfile.fargate-prover` を編集して digest を更新しません。

### 手動でダイジェストを取得する

This manual lookup is a diagnostic path only. Do not use tag-derived output as
Plan 02/03 acceptance evidence unless the digest is independently recorded in
the release artifact authority.

```bash
# ECR からダイジェストを取得
DIGEST=$(aws ecr describe-images \
  --repository-name "$ECR_REPO" \
  --image-ids imageTag=3.0.5-arm64 \
  --query 'imageDetails[0].imageDigest' \
  --output text)

echo "Image digest: $DIGEST"
# 出力例: sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

### Dockerfile での固定

`infra/docker/Dockerfile.fargate-prover` では **`ARG RISC0_TOOLCHAIN_IMAGE` をビルド時に渡し**、`FROM ${RISC0_TOOLCHAIN_IMAGE}` で参照します。公開リポジトリに private ECR URI を固定しないため、build arg は実行環境側で明示してください。

```dockerfile
ARG RISC0_TOOLCHAIN_IMAGE
FROM ${RISC0_TOOLCHAIN_IMAGE} AS build
```

```bash
docker build \
  --build-arg RISC0_TOOLCHAIN_IMAGE=<ecr-registry>/stark-ballot-simulator/risc0-toolchain@sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890 \
  -f infra/docker/Dockerfile.fargate-prover .
```

### ローカル build arg 生成スクリプト

`scripts/update-risc0-digest.sh` は ECR から toolchain image digest を解決します。公開可能な Dockerfile に private ECR URI を書き戻さないため、必要な場合だけ git 管理外の env ファイルへ `RISC0_TOOLCHAIN_IMAGE=...` を出力します。

実行:

```bash
chmod +x scripts/update-risc0-digest.sh
export AWS_ACCOUNT_ID=000000000000
./scripts/update-risc0-digest.sh --write-env .tmp/risc0-toolchain-image.env
source .tmp/risc0-toolchain-image.env
docker build --build-arg RISC0_TOOLCHAIN_IMAGE="$RISC0_TOOLCHAIN_IMAGE" -f infra/docker/Dockerfile.fargate-prover .
```

---

## 更新運用

### 更新が必要なケース

1. **RISC Zero 新バージョンリリース時**（年 1-2 回）
   - v3.0.5 → v3.1.0 など
   - リリースノートを確認: https://github.com/risc0/risc0/releases

2. **Debian セキュリティパッチ適用時**（四半期推奨）
   - Debian bookworm-slim の更新
   - 重大な脆弱性（CVE）対応時

3. **Rust バージョン更新時**（必要に応じて）
   - RISC Zero の推奨 Rust バージョン変更時のみ

### 更新手順

#### 1. Dockerfile と Terraform pin の更新

`infra/docker/Dockerfile.risc0-toolchain-arm64` の build args を更新します。

```dockerfile
ARG RUST_VERSION=1.91.1
ARG RISC0_VERSION=3.1.0
ARG RISC0_GIT_TAG=v3.1.0
ARG RISC0_COMMIT=<new-commit-hash>
ARG RUST_TOOLCHAIN_TAG=<new-toolchain-tag>
```

併せて、Terraform の shared toolchain builder pin も更新します。

```hcl
risc0_version            = "3.1.0"
risc0_commit             = "<new-commit-hash>"
risc0_rust_version       = "<rust-version>"
risc0_rust_toolchain_tag = "<new-toolchain-tag>"
```

対象:

- `infra/terraform/legacy/variables.tf` の既定値
- `infra/terraform/legacy/terraform.tfvars.example` の sanitized example
- 必要に応じて `.env.local` から生成する `infra/terraform/legacy/<env>.local.tfvars`

> **Note**: `RUST_TOOLCHAIN_TAG` は `risc0/rust` リポジトリの `r0.x.xx.x` タグを参照します。新しいリリースで Rust ツールチェーンが更新された場合は、このタグも必ず更新してください。

> **Tip**: `cargo-risczero` パッケージに `r0vm` バイナリが同梱されます。Dockerfile では `cargo install --path risc0/cargo-risczero --locked` のみを実行し、`r0vm` を個別に `cargo install` しないでください（重複インストールでビルドが失敗します）。動作確認は `cargo risczero --version` と `r0vm --version` を実行します。

#### 2. Terraform plan と CodeBuild source の確認

toolchain builder は shared resource で、既定では `risc0_toolchain_source_version = "refs/heads/main"` を参照します。Dockerfile や buildspec の変更を使って build するには、その Git ref に変更が push 済みである必要があります。

Do not use the removed `pnpm terraform:tfvars:*` package scripts or direct
legacy Terraform `plan/apply` commands for current target-develop release
candidate work. The target-develop update path is the separate
toolchain/prover release artifact pipelines, promotion/channel records, and
immutable handoff described in
[`develop-target-image-authority.md`](../../internal/guides/3-deployment/develop-target-image-authority.md).

#### 3. 新バージョンのビルド

Do not directly start the legacy/shared toolchain builder for current Plan
02/03 evidence. Run the target-account toolchain release artifact pipeline and
retain its successful candidate/promotion execution IDs, accepted channel
pointer, and outputs.

ローカル ARM64 環境で legacy/diagnostic 検証をする場合だけ、次のように直接
build/push できます。この path は target-develop Plan 02/03 handoff
authority ではありません。

```bash
IMAGE_TAG="3.1.0-arm64"
IMAGE_URI="${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"
docker build --platform linux/arm64 \
  --build-arg RUST_VERSION=<rust-version> \
  --build-arg RISC0_VERSION=3.1.0 \
  --build-arg RISC0_GIT_TAG=v3.1.0 \
  --build-arg RISC0_COMMIT=<new-commit-hash> \
  --build-arg RUST_TOOLCHAIN_TAG=<new-toolchain-tag> \
  -t "$IMAGE_URI" \
  -f infra/docker/Dockerfile.risc0-toolchain-arm64 \
  .

docker push "$IMAGE_URI"
```

#### 4. ダイジェスト固定スクリプト実行

```bash
# 新バージョンの digest-pinned build arg をローカル env に出力
AWS_ACCOUNT_ID="$YOUR_AWS_ACCOUNT_ID" \
RISC0_VERSION=3.1.0 \
./scripts/update-risc0-digest.sh --write-env .tmp/risc0-toolchain-image.env
```

application image の CodeBuild では `buildspec.yml` が同等の digest 解決を自動実行します。ローカルで `infra/docker/Dockerfile.fargate-prover` を build する場合だけ、この env file を `source` してください。

#### 5. スモークテスト（ビルド後必須）

**目的**: Multi-stage build で必要なランタイム依存関係（libssl3 など）が正しくコピーされたか確認

```bash
# ベースイメージ内でコマンドが動作するか確認
IMAGE_TAG="3.1.0-arm64"  # 新バージョンタグに置き換え
FULL_IMAGE="${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

# Test 1: cargo-risczero
docker run --rm $FULL_IMAGE cargo risczero --help
# 期待される出力: Usage: cargo risczero <COMMAND>

# Test 2: r0vm
docker run --rm $FULL_IMAGE r0vm --version
# 期待される出力: r0vm x.x.x

# Test 3: rzup
docker run --rm $FULL_IMAGE rzup --version
# 期待される出力: rzup x.x.x

# Test 4: rustc (RISC Zero toolchain)
docker run --rm $FULL_IMAGE rustc --version
# 期待される出力: rustc 1.91.1 (...)
```

**エラー時の対処**:

- `error while loading shared libraries: libssl.so.3: cannot open shared object file`
  → Final stage の `apt-get install` に `libssl3` を追加
- `cargo: command not found`
  → `COPY --from=build /root/.cargo/bin` が正しく実行されているか確認
- `toolchain 'risc0' not found`
  → `COPY --from=build /root/.risc0` が正しく実行されているか確認

#### 6. 検証ビルド（アプリケーション）

```bash
# アプリケーションイメージをビルド（新しいベースイメージを使用）
source .tmp/risc0-toolchain-image.env
docker build \
  --build-arg RISC0_TOOLCHAIN_IMAGE="$RISC0_TOOLCHAIN_IMAGE" \
  -t test-app \
  -f infra/docker/Dockerfile.fargate-prover .

# zkVM host バイナリの動作確認
docker run --rm test-app /opt/zkvm/bin/host --version
```

For target-develop, do not start the prover builder directly. The prover image
must be built by the target-account prover release artifact pipeline so the
digest, scan/signing evidence, ImageID evidence, accepted prover pointer,
selected prover release/app deployment record, and generated bridge inputs come
from retained pipeline outputs.

#### 7. コミットとデプロイ

```bash
git add infra/docker/Dockerfile.risc0-toolchain-arm64 infra/terraform/legacy/variables.tf infra/terraform/legacy/terraform.tfvars.example
git commit -m "chore(docker): update RISC Zero toolchain to v3.1.0"
git push origin <branch-used-by-risc0_toolchain_source_version>
```

---

## トラブルシューティング

### Error 1: ビルドが 60 分でタイムアウト

**症状**:

```
[Container] YYYY/MM/DD HH:MM:SS Phase complete: BUILD State: FAILED
[Container] Phase context status code: CLIENT_ERROR Message: Build timed out
```

**原因**: `rzup build rust` が時間内に完了しない

**解決策**:

1. `infra/terraform/legacy/codebuild.tf` の toolchain builder が `build_timeout = 120` になっていることを確認
2. `compute_type = "BUILD_GENERAL1_LARGE"`（7 GB / 4 vCPU）になっていることを確認
3. 手動変更ではなく Terraform で差分を反映

For target-develop, confirm CodeBuild timeout and compute settings through the
retained release artifact pipeline definition and outputs, not by citing a
legacy Terraform plan as acceptance evidence.

### Error 2: Docker layer キャッシュが効かない

**症状**: 毎回 `cargo install` が最初から実行される

**原因**: BuildKit キャッシュマウントが無効

**解決策**: Dockerfile で `--mount=type=cache` を使用（既に設定済み）

確認:

```bash
# Dockerfile 内の RUN --mount=type=cache 行を確認
grep "mount=type=cache" infra/docker/Dockerfile.risc0-toolchain-arm64
```

### Error 3: ECR プッシュ時に "denied" エラー

**症状**:

```
denied: User: arn:aws:sts::<aws-account-id>:assumed-role/<codebuild-role>/... is not authorized
```

**原因**: Terraform-managed CodeBuild role に ECR push/pull 権限が反映されていない、または手動変更で drift している

**解決策**: `infra/terraform/legacy/iam.tf` の `aws_iam_role_policy.codebuild_risc0_toolchain` を確認し、Terraform で反映する

For target-develop, confirm ECR push/pull permissions through the
release artifact pipeline IAM definition and retained execution evidence, not
by citing a legacy Terraform plan as acceptance evidence.

### Error 4: "Unsupported architecture: linux/aarch64"

**症状**: `rzup install rust` が失敗する

**原因**: 公式インストーラーを使用している（このドキュメントの手順では回避済み）

**解決策**: 手動インストールフロー（`cargo install --path rzup`）を使用（既に実装済み）

### Error 5: イメージサイズが大きすぎる（10 GB 超）

**症状**: ECR プッシュが遅い、Fargate 起動が遅い、ストレージコストが高い

**原因**:

1. 単一ステージビルドで不要なレイヤーが残っている（git 履歴、cargo cache など）
2. 別の RUN で削除しても、元のレイヤーにファイルが残る（Docker のレイヤー構造の仕組み）

**解決策** (2025-10-24 実装):

1. ✅ **Multi-stage build を採用**: ビルドステージと最終ステージを分離
   - Build stage: 全ビルド依存関係を含む
   - Final stage: ランタイム成果物のみコピー
2. ✅ **同一 RUN 内でクリーンアップ**: ファイル生成と削除を同じ RUN ステップで実行
   - `git clone ... && rm -rf .git`
   - `rzup build rust && rm -rf /root/.risc0/tmp`
3. ✅ **Cache mount の活用**: `/root/.cargo/registry` と `/root/.cargo/git` は --mount=type=cache でマウント（レイヤーに残らない）

確認:

```bash
# イメージサイズ確認
aws ecr describe-images \
  --repository-name "$ECR_REPO" \
  --query 'imageDetails[0].imageSizeInBytes' \
  --output text | awk '{printf "%.2f GB\n", $1/1024/1024/1024}'

# 期待値: 6-8 GB (Multi-stage 実装後)
# 従来値: 10-11 GB (単一ステージ)
```

**Note**: RISC Zero toolchain 本体（rustc + LLVM）が 6-8 GB を占めるため、これ以上の劇的な削減には rzup build 自体を省略する必要があります（検討課題）。

---

## 参考資料

- [RISC Zero Installation - Manual Installation](https://dev.risczero.com/api/zkvm/install)
- [RISC Zero GitHub - Issue #1286: ARM64 Linux support](https://github.com/risc0/risc0/issues/1286)
- [AWS CodeBuild - ARM Container](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html)
- [Docker BuildKit Cache Mounts](https://docs.docker.com/build/guide/mounts/)
