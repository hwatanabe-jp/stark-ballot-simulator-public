# Terraform Infrastructure Guide

Legacy/root `develop` / `main` async prover Terraform notes plus target-runtime handoff references.

> 公開版の注記:
> 環境固有の ID / ARN / バケット名は `<...>` 形式のプレースホルダで表記しています。

> **Migration warning:** This guide describes the retained legacy hybrid
> Amplify/Terraform workflow and `develop` / `main` Terraform workspace model.
> It is not target-account migration guidance and does not describe the
> `infra/terraform/app` target runtime. For the proposed greenfield target-state
> direction, use
> [`docs/current/aws-account-migration/04-terraform-state-and-account-migration-plan.md`](../../aws-account-migration/04-terraform-state-and-account-migration-plan.md)
> and
> [`docs/current/aws-account-migration/08-ci-cd-and-deployment-flow-plan.md`](../../aws-account-migration/08-ci-cd-and-deployment-flow-plan.md).
> For the Terraform-managed target API and async runtime, use
> [`docs/current/aws-account-migration/implementation-plans/05-terraform-managed-api-and-async-runtime-plan.md`](../../aws-account-migration/implementation-plans/05-terraform-managed-api-and-async-runtime-plan.md)
> and [`infra/terraform/app/README.md`](../../../../infra/terraform/app/README.md).
> The legacy commands shown below are not migration authorization; any
> legacy-account mutation during migration still requires explicit approval.

## 目次

- [概要](#概要)
- [前提条件](#前提条件)
- [クイックスタート](#クイックスタート)
- [ディレクトリ構成](#ディレクトリ構成)
- [State と環境分離](#state-と環境分離)
- [主要な入力変数](#主要な入力変数)
- [CodeBuild とコンテナイメージ運用](#codebuild-とコンテナイメージ運用)
- [Amplify との連携](#amplify-との連携)
- [デプロイ手順](#デプロイ手順)
- [トラブルシューティング](#トラブルシューティング)

## 概要

この retained legacy/root Terraform workflow では、STARK Ballot Simulator の AWS 構成は **Amplify** と
**Terraform** の 2 つで分担管理していました。Target `infra/terraform/app` runtime は Terraform が
public API、finalization writer、proof dispatcher、verification worker、SQS、Step Functions、private artifact bucket を管理し、Amplify-managed finalize callback ARN を要求しません。

| サービス           | 管理ツール  | 役割                                                                                 |
| ------------------ | ----------- | ------------------------------------------------------------------------------------ |
| アプリケーション層 | AWS Amplify | Retired legacy: Next.js Hosting、AppSync、DynamoDB、API Gateway、Amplify 管理 Lambda |
| インフラ層         | Terraform   | VPC、ECS、Step Functions、SQS、S3、ECR、CodeBuild、IAM                               |

### Retired legacy Amplify-owned inventory

- Amplify Hosting
- Amplify Data (AppSync + DynamoDB)
- Cognito
- API Gateway (HTTP API, `public-api` integration)
- Lambda Functions (`verification-worker`, `finalization-writer`, `public-api`, and the legacy Amplify proof-dispatcher proxy)

### Terraform が管理するもの

- VPC / Public Subnets / Route Tables / Security Groups
- ECS Cluster / Fargate Task Definition
- Step Functions (`proof-dispatcher`)
- SQS (`prover-work`, `prover-dlq`)
- S3 proof bundle bucket
- S3 prover image metadata bucket
- ECR repositories
  - 環境別: `stark-ballot-simulator/zkvm-prover-develop`, `...-main`
  - 共通: `stark-ballot-simulator/risc0-toolchain`
- CodeBuild projects
  - 環境別: `stark-ballot-simulator-fargate-prover-develop`, `...-main`
  - 共通: `stark-ballot-simulator-risc0-toolchain-builder`
- IAM Roles / Policies
- CloudWatch Logs
- SSM parameter for the retained legacy/current prover image metadata candidate
- `image-signature-gate` Lambda
- CloudTrail (`main` のみ)

### 設計の特徴

- パブリックサブネット構成で NAT Gateway を使わない
- 2 AZ 構成
- Step Functions が Fargate タスクをオンデマンド起動する
- `ecs_image_uri` は必ず digest pin (`...@sha256:...`)
- **Terraform workspace で state を分離**し、**`var.environment` でリソース名と環境差分を制御**する

## 前提条件

### 必須ツール

```bash
# Terraform
terraform version  # >= 1.10.0

# AWS CLI
aws --version

# jq
jq --version

# 推奨: aws-vault
aws-vault --version
```

### 認証の使い分け

- Retained legacy/root Terraform inspection: `aws-vault exec terraform-admin -- ...`
  commands below are legacy-environment guidance and are not target-account
  mutation authority.
- Target-account AWS inspection or operation: choose the explicit IAM Identity
  Center profile, account, and region first, for example
  `--profile stark-dev-admin --region ap-northeast-1`. Do not rely on implicit
  default AWS credentials for account-targeted work.
- Direct CodeBuild / ECR / SSM / CloudWatch Logs commands in this file are
  retained legacy or diagnostic examples. They are not Plan 02 release-candidate
  handoff evidence, not Plan 03 app-execution evidence, and not a substitute for
  the separate target-account toolchain/prover release artifact pipelines,
  promotion/channel records, selected prover release/app deployment record, and
  immutable handoff required by the post-merge plans.

For the retained legacy/root Terraform path, the Terraform provider does not
set an explicit profile and uses the temporary credentials supplied by
`aws-vault exec terraform-admin -- ...`. Legacy plan / apply / destroy commands
must go through `scripts/terraform/terraform-guarded.sh` and confirm AWS
caller, account ID, workspace, and tfvars `environment` before execution.
`infra/terraform/legacy/principal_guard.tf` remains as an auxiliary fail-fast
guard, but for special operations such as `-target`, treat the wrapper check as
the source of truth. These legacy checks do not authorize target-account
Plan 02/03 acceptance.

### Terraform backend

このリポジトリでは、S3 remote backend を使います。state locking は `use_lockfile = true` を有効化します。

```hcl
terraform {
  backend "s3" {}
}
```

実 bucket 名や region は tracked ファイルに置かず、`.env.local` から `infra/terraform/legacy/backend.local.hcl` を生成して `terraform init` に渡します。

既存 checkout でこの partial backend への変更を取り込んだ後は、一度だけ local backend config を生成して再初期化してください。

```bash
pnpm terraform:backend
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy init -reconfigure -backend-config=backend.local.hcl
```

`use_lockfile` を使うため、backend 用 principal には state object に加えて `.tflock` に対する `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` が必要です。

## クイックスタート

```bash
# 1. リポジトリルートへ移動
cd <REPO_ROOT>

# 2. backend config を生成して初期化
pnpm terraform:backend
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy init -backend-config=backend.local.hcl
# backend 設定を変更した後は再初期化
# aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy init -reconfigure -backend-config=backend.local.hcl

# 3. workspace を選択
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace show
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace select develop
# 存在しない場合のみ
# aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace new develop

# 4. .env.local の Terraform 用値を確認し、git 管理外 tfvars を生成
# 必要キーは .env.local.example の "Terraform local tfvars generation" を参照。
./scripts/terraform/render-local-tfvars.sh develop

# 5. Terraform-managed Lambda artifacts を生成
pnpm terraform:build-lambdas

# 6. legacy/root local tfvars 生成で要求される値を確認
# - environment = "develop"
# - aws_account_id
# - ecs_image_uri
# - ecr_signing_profile_arn
# - finalization_writer_lambda_arn
# - codestar_connection_arn
# - codebuild_source_location
# - s3_cors_allowed_origins（Terraform 変数としては空配列可。標準ヘルパーでは必須）

# 7. plan / apply
aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh develop plan -var-file=develop.local.tfvars
# Legacy workspace apply is not exposed as a package script during Phase 04.
# Use the direct guarded script only after explicit approval:
# aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh develop apply -var-file=develop.local.tfvars

# 8. outputs を確認
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy output
```

`main` も同様ですが、workspace と `var.environment` の両方を `main` にそろえてください。

## ディレクトリ構成

```text
infra/terraform/legacy/
├── backend.tf                      # S3 backend (lockfile)
├── versions.tf                     # Terraform / provider versions
├── main.tf                         # 共通 locals / environment settings
├── variables.tf                    # 入力変数
├── outputs.tf                      # Amplify 連携に使う outputs
├── terraform.tfvars.example        # 公開向けの sanitized tfvars 例
├── backend.local.hcl               # backend 実運用値（git 管理外、render-backend-config.sh で生成）
├── *.local.tfvars                  # 実運用値（git 管理外、render-local-tfvars.sh で生成）
├── *.local.json                    # IAM 初期設定用 JSON（git 管理外、render-admin-iam-docs.sh で生成）
├── vpc.tf                          # VPC / Subnets / IGW / routes
├── security_groups.tf              # Security Groups
├── s3.tf                           # Proof bundle bucket / prover image metadata storage
├── ecr.tf                          # ECR repositories
├── codebuild.tf                    # CodeBuild projects
├── ecs.tf                          # ECS cluster / task definition
├── sqs.tf                          # Prover work queue / DLQ
├── step_functions.tf               # Prover dispatcher state machine
├── iam.tf                          # IAM roles / policies
├── cloudwatch.tf                   # CloudWatch log groups
├── ssm.tf                          # Current prover image metadata pointer
├── principal_guard.tf              # Terraform execution principal guard
├── lambda_check_image_signature.tf # ECR signing status checker Lambda
├── cloudtrail.tf                   # CloudTrail (main only)
└── lambda/image-signature-gate/   # Lambda source
```

注:

- 実運用値は `.env.local` またはシェル環境に置き、`pnpm terraform:backend` と direct `scripts/terraform/render-local-tfvars.sh` 実行で `infra/terraform/legacy/*.local.*` を生成します。
- `image-signature-gate` Lambda は `pnpm terraform:build-lambdas` で `infra/terraform/legacy/.tmp/image-signature-gate/` に bundle してから Terraform が zip 化します。
- `infra/terraform/legacy/*.local.hcl`、`infra/terraform/legacy/*.local.tfvars`、`infra/terraform/legacy/*.local.json` は git 管理外です。アカウント ID、ARN、実ドメイン、digest-pinned image URI、state bucket 名を tracked ファイルに戻さないでください。

## State と環境分離

### 方針

- **state の分離**: Terraform workspace
- **環境差分の制御**: `var.environment`

両者は必ず一致させて運用します。

| 項目                      | develop                           | main                           |
| ------------------------- | --------------------------------- | ------------------------------ |
| Terraform workspace       | `develop`                         | `main`                         |
| `var.environment`         | `develop`                         | `main`                         |
| Proof bundle bucket       | `<PROJECT>-proof-bundles-develop` | `<PROJECT>-proof-bundles-main` |
| zkVM prover ECR repo      | `.../zkvm-prover-develop`         | `.../zkvm-prover-main`         |
| S3 lifecycle              | 7 日                              | 30 日                          |
| CloudWatch Logs retention | 7 日                              | 14 日                          |
| CloudTrail                | 無効                              | 有効                           |

### なぜ workspace も使うのか

backend の `key` は `terraform.tfstate` 固定ですが、S3 backend は named workspace ごとに state を分離します。  
そのため、`develop` と `main` を同じ backend bucket で安全に運用できます。lockfile も各 workspace の state path 配下に作られます。

### 運用ルール

```bash
# まず現在の workspace を確認
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace show

# develop へ切り替え
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace select develop
aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh develop plan -var-file=develop.local.tfvars

# main へ切り替え
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace select main
aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh main plan -var-file=main.local.tfvars
```

`default` workspace のまま `*.local.tfvars` を適用しないでください。

## 主要な入力変数

この legacy/root Terraform と標準の local tfvars 生成で特に重要なのは次の変数です。Target
`infra/terraform/app` の immutable Lambda artifact inputs や direct callback runtime には
[`infra/terraform/app/README.md`](../../../../infra/terraform/app/README.md) を使ってください。

| 変数                             | 必須性                                           | 用途                                              |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| `aws_account_id`                 | 必須                                             | provider の account guard                         |
| `environment`                    | 必須                                             | `develop` または `main`                           |
| `ecs_image_uri`                  | 必須                                             | digest pin された prover image URI                |
| `ecr_signing_profile_arn`        | 必須                                             | AWS Signer profile ARN                            |
| `finalization_writer_lambda_arn` | legacy/root では必須                             | Amplify 管理 `finalization-writer` の ARN         |
| `codestar_connection_arn`        | 必須                                             | GitHub 接続用 CodeStar connection ARN             |
| `codebuild_source_location`      | 必須                                             | CodeBuild が clone する GitHub repository URL     |
| `s3_cors_allowed_origins`        | legacy/root 標準ヘルパーで必須、Terraform は任意 | legacy direct-S3 proof bundle ダウンロード用 CORS |
| `risc0_toolchain_*`              | 任意                                             | shared toolchain builder の pin 設定              |

### `terraform.tfvars.example`

```hcl
aws_region     = "ap-northeast-1"
aws_account_id = "000000000000"
environment    = "develop"

project_name = "stark-ballot-simulator"
codebuild_source_location = "https://github.com/hwatanabe-jp/<REPO_NAME>.git"

# Digest-pinned image only
ecs_image_uri = "<AWS_ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot-simulator/zkvm-prover-develop@sha256:..."

# ECR managed signing
ecr_signing_profile_arn = "arn:aws:signer:ap-northeast-1:<AWS_ACCOUNT_ID>:/signing-profiles/<SIGNING_PROFILE_NAME>"

# Legacy/root Amplify-managed Lambda. Target infra/terraform/app does not use this input.
finalization_writer_lambda_arn = "arn:aws:lambda:ap-northeast-1:<AWS_ACCOUNT_ID>:function:<AMPLIFY_FINALIZE_CALLBACK_FUNCTION>"

# GitHub access for CodeBuild
codestar_connection_arn = "arn:aws:codestar-connections:ap-northeast-1:<AWS_ACCOUNT_ID>:connection/<CONNECTION_ID>"

# Terraform 変数としては任意。空配列なら CORS 設定を作成しない。
# Phase 04 では package script ではなく scripts/terraform/render-local-tfvars.sh <env> を直接使う。
# その renderer はブラウザからの bundle 取得を壊さないよう非空値を要求する。
s3_cors_allowed_origins = ["<AMPLIFY_APP_ORIGIN>"]
```

補足:

- 現在の Terraform 入力として `cognito_identity_pool_id` や `amplify_graphql_api_arn` は要求していません。
- legacy/root Terraform で Amplify 由来として必要なのは、現状は `finalization_writer_lambda_arn` です。Target `infra/terraform/app` は Terraform-managed direct callback Lambda を使います。
- 実運用では、`.env.local` から生成した `infra/terraform/legacy/<env>.local.tfvars` の repo 名、digest、CORS origin を確認してください。

## CodeBuild とコンテナイメージ運用

### Retained legacy / diagnostic premise

The bullets in this section describe retained legacy/root Terraform and
diagnostic lookup behavior. They are not Plan 02/03 release-candidate
authority. For the target develop handoff, use the successor authority model in
[`../../internal/guides/3-deployment/develop-target-image-authority.md`](../../internal/guides/3-deployment/develop-target-image-authority.md):
separate toolchain/prover artifact records, accepted channel pointers, selected
prover release/app deployment records, generated app inputs, and any generated
release-manifest bridge required by current helpers.

- zkVM prover image は **環境別 ECR repository** に push する
  legacy/diagnostic path
- toolchain image は **shared ECR repository** を使う legacy/diagnostic path
- deploy 時は **tag ではなく digest** を `ecs_image_uri` に設定する retained
  legacy/root Terraform path
- runtime では Step Functions が `image-signature-gate` Lambda を通して **ECR signing status** を確認する

### 手動ビルド例（retained legacy / diagnostic only）

The following direct `aws codebuild start-build` examples describe the retained
legacy/shared build path. They are not current Plan 02/03 release-candidate
authority, do not produce accepted handoff evidence, and must not be used as a
substitute for the required separate target-account toolchain/prover release
artifact pipelines, promotion/channel records, selected prover release/app
deployment record, and retained outputs.

`develop` 用 prover image:

```bash
aws codebuild start-build \
  --project-name stark-ballot-simulator-fargate-prover-develop \
  --environment-variables-override name=IMAGE_TAG,value=v1.1.0,type=PLAINTEXT
```

`main` 用 prover image:

```bash
aws codebuild start-build \
  --project-name stark-ballot-simulator-fargate-prover-main \
  --environment-variables-override name=IMAGE_TAG,value=v1.1.0,type=PLAINTEXT
```

署名ステータス確認:

```bash
TRUSTED_SIGNING_PROFILE_VERSION_ARN="arn:aws:signer:ap-northeast-1:<AWS_ACCOUNT_ID>:/signing-profiles/<SIGNING_PROFILE_NAME>/<PROFILE_VERSION>"

aws ecr describe-image-signing-status \
  --repository-name stark-ballot-simulator/zkvm-prover-develop \
  --image-id imageDigest=sha256:<64-hex> \
  --query "length(signingStatuses[?signingProfileVersionArn=='${TRUSTED_SIGNING_PROFILE_VERSION_ARN}' && status=='COMPLETE'])" \
  --output text
```

The command must return `1`. Tag-based signing checks or
`signingStatuses[0]` checks are not acceptance evidence.

### デプロイに使う値（retained legacy only）

This digest-promotion flow is retained legacy/root Terraform guidance. Direct
local `terraform apply`, operator-selected image digests, and local tfvars
promotion are not Plan 02/03 acceptance evidence for the target account.

1. CodeBuild ログに出力された `image-metadata.json` または ECR から digest を確認する
2. `.env.local` の `TERRAFORM_ECS_IMAGE_URI_<ENV>` または `TERRAFORM_ZKVM_PROVER_DIGEST_<ENV>` を更新する
3. `./scripts/terraform/render-local-tfvars.sh <env>` で `infra/terraform/legacy/<env>.local.tfvars` を再生成する
4. 対応する workspace / tfvars で `terraform apply` する

`latest` や semver tag のまま `ecs_image_uri` に渡さないでください。

### ARM64 Image ID の確認（retained legacy / diagnostic only）

zkVM guest を更新したあと、AWS 上で動く ARM64 の Image ID はローカル
x86_64 と一致しないことがあります。この retained legacy/shared path
では、prover image の CodeBuild が build 済み ARM64 container から
`host --print-image-id --json` を実行し、ImageID を candidate metadata
として保存していました。Target develop Plan 02/03 では、この SSM
`current` lookup、`latest.json`、または手動 mapping 反映は authority
ではありません。ImageID/method-version facts must come from the selected
prover release metadata and app deployment record; `public/imageId-mapping.json`
is compatibility/public-ledger evidence.

Diagnostic lookup point:

```bash
aws ssm get-parameter \
  --name /stark-ballot-simulator/develop/prover/metadata/current \
  --query 'Parameter.Value' \
  --output text | jq .
```

S3 metadata bucket には次のキーが保存されます。

```text
prover-images/<env>/latest.json
prover-images/<env>/by-digest/sha256-<digest>.json
prover-images/<env>/by-git-sha/<sha>.json
```

`image-metadata.json` と SSM の current JSON には、ECR digest、
digest-pinned image URI、Git SHA、RISC Zero toolchain image、
`methodVersion`、ARM64 `risc0ImageId`、S3 metadata URI が含まれます。
This is a diagnostic current pointer for the retained legacy/shared path, not
an accepted channel pointer and not selected prover release authority.

Retained legacy compatibility update targets, not Plan 02/03 authority:

- `public/imageId-mapping.json` の `mappings[current].expectedImageID`
- `packages/verification/src/verification/expected-image-id.ts` の fallback 定数
- `EXPECTED_IMAGE_ID` を使っている Amplify / CI / 手元シェルの override

補足:

- `expectedImageID_x86_64` は、x86_64 build の実測値があるときだけ更新します
- Amplify に `EXPECTED_IMAGE_ID` が残っている場合、runtime では mapping より **env override が優先**されます
- CodeBuild metadata は昇格前の candidate です。Retained legacy/root
  Terraform では ECR signing status と必要な real/prod proof smoke を確認してから
  mapping / Terraform 値へ反映します。Target develop Plan 02/03 では、
  selected prover release/app deployment record が deployed ImageID facts を供給し、
  mapping は compatibility/public-ledger evidence として照合します。

## Amplify との連携

Retained legacy Terraform outputs mapped to the following Amplify-managed environment variables.

| Terraform output           | Amplify env var            |
| -------------------------- | -------------------------- |
| `prover_state_machine_arn` | `PROVER_STATE_MACHINE_ARN` |
| `prover_work_queue_arn`    | `PROVER_WORK_QUEUE_ARN`    |
| `prover_work_queue_url`    | `PROVER_WORK_QUEUE_URL`    |
| `s3_bucket_name`           | `S3_PROOF_BUCKET`          |

Terraform は CodeBuild が使う prover image metadata bucket と current metadata JSON の SSM parameter name も output します。これらは運用確認用の lookup point であり、retired Amplify runtime env var ではありません。

### Retained legacy policy

- このリポジトリの Terraform / CLI ワークフローから **Amplify の環境変数を更新しません**
- CLI や補助スクリプトは、必要に応じて Amplify の環境変数を**参照**しますが、**変更**はしません
- Retained legacy 運用上、Amplify の環境変数は **app-level を基底**に管理していました
- `develop` / `main` で値が異なる項目だけを **branch-level override** で上書きします
- app-level に存在しないキーを特定 branch 専用の値として扱う前提にはしません。差分が必要なキーも、まず app-level に定義してから branch override を設定します

### 確認例

```bash
APP_ID="<AMPLIFY_APP_ID>"
BRANCH_NAME="develop"

APP_VARS=$(aws amplify get-app \
  --app-id "$APP_ID" \
  --query 'app.environmentVariables.{PROVER_STATE_MACHINE_ARN:PROVER_STATE_MACHINE_ARN,PROVER_WORK_QUEUE_ARN:PROVER_WORK_QUEUE_ARN,PROVER_WORK_QUEUE_URL:PROVER_WORK_QUEUE_URL,S3_PROOF_BUCKET:S3_PROOF_BUCKET}' \
  --output json)

BRANCH_VARS=$(aws amplify get-branch \
  --app-id "$APP_ID" \
  --branch-name "$BRANCH_NAME" \
  --query 'branch.environmentVariables.{PROVER_STATE_MACHINE_ARN:PROVER_STATE_MACHINE_ARN,PROVER_WORK_QUEUE_ARN:PROVER_WORK_QUEUE_ARN,PROVER_WORK_QUEUE_URL:PROVER_WORK_QUEUE_URL,S3_PROOF_BUCKET:S3_PROOF_BUCKET}' \
  --output json)

jq -n \
  --argjson app "$APP_VARS" \
  --argjson branch "$BRANCH_VARS" \
  '{appLevel: $app, branchOverride: $branch, effective: ($app + $branch)}'
```

`main` を確認する場合は `BRANCH_NAME="main"` に切り替えてください。

補足:

- `appLevel` が retired legacy Amplify app-level の基底値です
- `branchOverride` は branch-level で上書きしている項目です
- `effective` が、その branch で実際に効く値です

## デプロイ手順

### develop

```bash
cd <REPO_ROOT>
pnpm terraform:backend
./scripts/terraform/render-local-tfvars.sh develop
pnpm terraform:build-lambdas

aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy init -backend-config=backend.local.hcl
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace select develop
# 初回のみ:
# aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace new develop

aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh develop plan -var-file=develop.local.tfvars
# Legacy workspace apply is not exposed as a package script during Phase 04.
# Use the direct guarded script only after explicit approval:
# aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh develop apply -var-file=develop.local.tfvars
```

apply 後の確認:

```bash
cd <REPO_ROOT>

STATE_MACHINE_ARN=$(aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy output -raw prover_state_machine_arn)
QUEUE_URL=$(aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy output -raw prover_work_queue_url)
BUCKET_NAME=$(aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy output -raw s3_bucket_name)

aws stepfunctions describe-state-machine \
  --state-machine-arn "$STATE_MACHINE_ARN" \
  --query 'name'

aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn RedrivePolicy

aws s3api head-bucket \
  --bucket "$BUCKET_NAME"
```

必要に応じて、前節の確認例で Amplify の app-level / branch override / 実効値も照合してください。

### main

```bash
cd <REPO_ROOT>
pnpm terraform:backend
./scripts/terraform/render-local-tfvars.sh main
pnpm terraform:build-lambdas

aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy init -backend-config=backend.local.hcl
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace select main
# 初回のみ:
# aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace new main

aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh main plan -var-file=main.local.tfvars
# Legacy workspace apply is not exposed as a package script during Phase 04.
# Use the direct guarded script only after explicit approval:
# aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh main apply -var-file=main.local.tfvars
```

apply 後の確認:

```bash
cd <REPO_ROOT>

STATE_MACHINE_ARN=$(aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy output -raw prover_state_machine_arn)
QUEUE_URL=$(aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy output -raw prover_work_queue_url)
BUCKET_NAME=$(aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy output -raw s3_bucket_name)

aws stepfunctions describe-state-machine \
  --state-machine-arn "$STATE_MACHINE_ARN" \
  --query 'name'

aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn RedrivePolicy

aws s3api head-bucket \
  --bucket "$BUCKET_NAME"
```

必要に応じて、前節の確認例で Amplify の app-level / branch override / 実効値も照合してください。

補足:

- `pnpm test:cli:real-dev` / `pnpm test:cli:real-prod:s0` はアプリケーション回帰確認には有用ですが、`STARK_BALLOT_CLI_BASE_URL` を明示しない限りローカルで Vite static frontend と local Hono server を起動するため、Terraform で構築した AWS リソースの疎通確認にはなりません。
- Terraform apply 後の一次確認は、まず Terraform outputs と AWS API で存在確認し、その後に必要に応じて Amplify 側で管理している実効 env 値と照合してから E2E を実施してください。

### 更新デプロイ

```bash
cd <REPO_ROOT>
pnpm terraform:backend
./scripts/terraform/render-local-tfvars.sh main
pnpm terraform:build-lambdas
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace select main
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace show # main であることを確認
aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh main plan -var-file=main.local.tfvars
# Legacy workspace apply is not exposed as a package script during Phase 04.
# Use the direct guarded script only after explicit approval:
# aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh main apply -var-file=main.local.tfvars
```

### リソース削除

```bash
cd <REPO_ROOT>
pnpm terraform:backend
./scripts/terraform/render-local-tfvars.sh develop
pnpm terraform:build-lambdas
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace select develop
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace show # develop であることを確認
aws-vault exec terraform-admin -- ./scripts/terraform/terraform-guarded.sh develop destroy -var-file=develop.local.tfvars
```

## トラブルシューティング

### Q: state が競合する / 想定外の差分が出る

まず workspace を確認してください。

```bash
aws-vault exec terraform-admin -- terraform -chdir=infra/terraform/legacy workspace show
```

`var.environment` と workspace が食い違っていると、誤った state に対して plan/apply してしまいます。

### Q: `terraform plan` が必須変数不足で失敗する

Phase 04/legacy root では app/prover workspace の tfvars 生成 package script は公開していません。直接
`./scripts/terraform/render-local-tfvars.sh <env>` を実行する場合、主に次の値が必要です。

- `ecs_image_uri`
- `aws_account_id`
- `ecr_signing_profile_arn`
- `finalization_writer_lambda_arn`
- `codestar_connection_arn`
- `codebuild_source_location`
- `s3_cors_allowed_origins`

Terraform 変数としての `s3_cors_allowed_origins` は default `[]` で、空なら S3 CORS 設定を作成しません。legacy/root 標準ヘルパーは proof bundle download のブラウザ導線を誤って無効化しないため、非空の CORS origin を要求します。Target `infra/terraform/app` の bundle/report delivery は public bucket CORS ではなく capability-checked Hono API endpoint 経由です。

古い手順にあった `cognito_identity_pool_id` や `amplify_graphql_api_arn` は、現行 Terraform の必須入力ではありません。

### Q: ECS タスクが起動しない

以下を確認してください。

```bash
aws ecr describe-images \
  --repository-name stark-ballot-simulator/zkvm-prover-develop

aws logs tail \
  /aws/ecs/stark-ballot-simulator-prover-develop --follow
```

確認ポイント:

- 対応する環境の ECR repository にイメージがあるか
- `ecs_image_uri` が digest pin されているか
- Security Group の egress で HTTPS が許可されているか
- ECS task execution role / task role に必要権限があるか

### Q: Step Functions が ECS タスクを起動できない

Step Functions role に少なくとも次の権限が必要です。

- `ecs:RunTask`
- `ecs:DescribeTasks`
- `ecs:StopTask`
- `iam:PassRole`
- `lambda:InvokeFunction`
- EventBridge managed rule 用の `events:PutRule`, `events:PutTargets`, `events:DescribeRule`, `events:DeleteRule`, `events:RemoveTargets`

### Q: 署名検証で止まる

`image-signature-gate` Lambda は `ecr:DescribeImageSigningStatus` を使って、対象 digest の signing status を確認します。

```bash
TRUSTED_SIGNING_PROFILE_VERSION_ARN="arn:aws:signer:ap-northeast-1:<AWS_ACCOUNT_ID>:/signing-profiles/<SIGNING_PROFILE_NAME>/<PROFILE_VERSION>"

aws ecr describe-image-signing-status \
  --repository-name stark-ballot-simulator/zkvm-prover-main \
  --image-id imageDigest=sha256:<64-hex> \
  --query "length(signingStatuses[?signingProfileVersionArn=='${TRUSTED_SIGNING_PROFILE_VERSION_ARN}' && status=='COMPLETE'])" \
  --output text
```

The command must return `1`; otherwise the digest is not signed by the trusted
profile for acceptance purposes.

Retained legacy/root Terraform では、`COMPLETE` になる前に
`terraform apply` しても、実行時検証で弾かれます。この確認は Plan 02/03
acceptance evidence ではありません。

### Q: Amplify の env vars と Terraform outputs が食い違う

このガイドの Terraform / CLI 手順は Amplify の環境変数を更新しません。  
差異を確認するときは、次の 3 層を分けて見てください。

- `terraform output`: Terraform が作成した AWS リソースの値
- `aws amplify get-app`: app-level の基底値
- `aws amplify get-branch`: branch-level の override 値

実効値は、**app-level + branch override** です。  
`develop` / `main` で差分が必要なキーは、まず app-level に定義した上で branch override を設定してください。

### Q: Step Functions 作成時に `Log Group ARN must be provided with '*' qualifier` エラー

`logging_configuration.log_destination` が `"${aws_cloudwatch_log_group.sfn_prover.arn}:*"` になっているか確認してください。

### Q: Step Functions 作成時に `not authorized to create managed-rule` エラー

Step Functions role に EventBridge 権限が不足しています。`events:PutRule`, `events:PutTargets`, `events:DescribeRule`, `events:DeleteRule`, `events:RemoveTargets` を確認してください。

## 参考資料

- [Terraform AWS Provider Documentation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
- [AWS ECS Fargate Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/intro.html)
- [AWS Step Functions Best Practices](https://docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html)
- Amplify-owned resources are documented separately in the internal infrastructure notes.
