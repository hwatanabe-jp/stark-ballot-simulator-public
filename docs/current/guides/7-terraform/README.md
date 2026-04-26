# Terraform Infrastructure Guide

`develop` / `main` の async prover インフラを Terraform で管理するためのガイドです。

> 公開版の注記:
> 環境固有の ID / ARN / バケット名は `<...>` 形式のプレースホルダで表記しています。

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

STARK Ballot Simulator の AWS 構成は、**Amplify** と **Terraform** の 2 つで分担管理します。

| サービス           | 管理ツール  | 役割                                                                 |
| ------------------ | ----------- | -------------------------------------------------------------------- |
| アプリケーション層 | AWS Amplify | Next.js Hosting、AppSync、DynamoDB、API Gateway、Amplify 管理 Lambda |
| インフラ層         | Terraform   | VPC、ECS、Step Functions、SQS、S3、ECR、CodeBuild、IAM               |

### Amplify が管理するもの

- Amplify Hosting
- Amplify Data (AppSync + DynamoDB)
- Cognito
- API Gateway (HTTP API, `hono-api` integration)
- Lambda Functions (`prover-dispatch-proxy`, `verifier-service-runner`, `finalize-callback-runner`, `hono-api`)

### Terraform が管理するもの

- VPC / Public Subnets / Route Tables / Security Groups
- ECS Cluster / Fargate Task Definition
- Step Functions (`prover-dispatcher`)
- SQS (`prover-work`, `prover-dlq`)
- S3 proof bundle bucket
- ECR repositories
  - 環境別: `stark-ballot-simulator/zkvm-prover-develop`, `...-main`
  - 共通: `stark-ballot-simulator/risc0-toolchain`
- CodeBuild projects
  - 環境別: `stark-ballot-simulator-fargate-prover-develop`, `...-main`
  - 共通: `stark-ballot-simulator-risc0-toolchain-builder`
- IAM Roles / Policies
- CloudWatch Logs
- `check-image-signature` Lambda
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

- Terraform 実行: `aws-vault exec terraform-admin -- ...`
- 手動の AWS CLI 操作: `aws login` または適切な `AWS_PROFILE`

Terraform provider 自体は `terraform/versions.tf` 側で profile を固定していないため、通常は `aws-vault` 経由で実行します。

### Terraform backend

このリポジトリでは、S3 remote backend を使います。state locking は `use_lockfile = true` を有効化します。

```hcl
terraform {
  backend "s3" {}
}
```

実 bucket 名や region は tracked ファイルに置かず、`.env.local` から `terraform/backend.local.hcl` を生成して `terraform init` に渡します。

既存 checkout でこの partial backend への変更を取り込んだ後は、一度だけ local backend config を生成して再初期化してください。

```bash
pnpm terraform:backend
aws-vault exec terraform-admin -- terraform -chdir=terraform init -reconfigure -backend-config=backend.local.hcl
```

`use_lockfile` を使うため、backend 用 principal には state object に加えて `.tflock` に対する `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` が必要です。

## クイックスタート

```bash
# 1. リポジトリルートへ移動
cd <REPO_ROOT>

# 2. backend config を生成して初期化
pnpm terraform:backend
aws-vault exec terraform-admin -- terraform -chdir=terraform init -backend-config=backend.local.hcl
# backend 設定を変更した後は再初期化
# aws-vault exec terraform-admin -- terraform -chdir=terraform init -reconfigure -backend-config=backend.local.hcl

# 3. workspace を選択
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace show
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace select develop
# 存在しない場合のみ
# aws-vault exec terraform-admin -- terraform -chdir=terraform workspace new develop

# 4. .env.local の Terraform 用値を確認し、git 管理外 tfvars を生成
# 必要キーは .env.local.example の "Terraform local tfvars generation" を参照。
pnpm terraform:tfvars:develop

# 5. 標準の local tfvars 生成で要求される値を確認
# - environment = "develop"
# - ecs_image_uri
# - ecr_signing_profile_arn
# - finalize_callback_lambda_arn
# - codestar_connection_arn
# - codebuild_source_location
# - s3_cors_allowed_origins（Terraform 変数としては空配列可。標準ヘルパーでは必須）

# 6. plan / apply
aws-vault exec terraform-admin -- terraform -chdir=terraform plan -var-file="develop.local.tfvars"
aws-vault exec terraform-admin -- terraform -chdir=terraform apply -var-file="develop.local.tfvars"

# 7. outputs を確認
aws-vault exec terraform-admin -- terraform -chdir=terraform output
```

`main` も同様ですが、workspace と `var.environment` の両方を `main` にそろえてください。

## ディレクトリ構成

```text
terraform/
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
├── s3.tf                           # Proof bundle bucket
├── ecr.tf                          # ECR repositories
├── codebuild.tf                    # CodeBuild projects
├── ecs.tf                          # ECS cluster / task definition
├── sqs.tf                          # Prover work queue / DLQ
├── step_functions.tf               # Prover dispatcher state machine
├── iam.tf                          # IAM roles / policies
├── cloudwatch.tf                   # CloudWatch log groups
├── lambda_check_image_signature.tf # ECR signing status checker Lambda
├── cloudtrail.tf                   # CloudTrail (main only)
└── lambda/check-image-signature/   # Lambda source
```

注:

- 実運用値は `.env.local` またはシェル環境に置き、`pnpm terraform:backend` と `pnpm terraform:tfvars:develop` / `pnpm terraform:tfvars:main` で `terraform/*.local.*` を生成します。
- `terraform/*.local.hcl`、`terraform/*.local.tfvars`、`terraform/*.local.json` は git 管理外です。アカウント ID、ARN、実ドメイン、digest-pinned image URI、state bucket 名を tracked ファイルに戻さないでください。

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
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace show

# develop へ切り替え
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace select develop
aws-vault exec terraform-admin -- terraform -chdir=terraform plan -var-file="develop.local.tfvars"

# main へ切り替え
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace select main
aws-vault exec terraform-admin -- terraform -chdir=terraform plan -var-file="main.local.tfvars"
```

`default` workspace のまま `*.local.tfvars` を適用しないでください。

## 主要な入力変数

現在の Terraform と標準の local tfvars 生成で特に重要なのは次の変数です。

| 変数                           | 必須性                               | 用途                                           |
| ------------------------------ | ------------------------------------ | ---------------------------------------------- |
| `environment`                  | 必須                                 | `develop` または `main`                        |
| `ecs_image_uri`                | 必須                                 | digest pin された prover image URI             |
| `ecr_signing_profile_arn`      | 必須                                 | AWS Signer profile ARN                         |
| `finalize_callback_lambda_arn` | 必須                                 | Amplify 管理 `finalize-callback-runner` の ARN |
| `codestar_connection_arn`      | 必須                                 | GitHub 接続用 CodeStar connection ARN          |
| `codebuild_source_location`    | 必須                                 | CodeBuild が clone する GitHub repository URL  |
| `s3_cors_allowed_origins`      | 標準ヘルパーで必須、Terraform は任意 | proof bundle ダウンロード用 CORS               |
| `risc0_toolchain_*`            | 任意                                 | shared toolchain builder の pin 設定           |

### `terraform.tfvars.example`

```hcl
aws_region  = "ap-northeast-1"
aws_profile = "terraform-admin"
environment = "develop"

project_name = "stark-ballot-simulator"
codebuild_source_location = "https://github.com/hwatanabe-jp/<REPO_NAME>.git"

# Digest-pinned image only
ecs_image_uri = "<AWS_ACCOUNT_ID>.dkr.ecr.ap-northeast-1.amazonaws.com/stark-ballot-simulator/zkvm-prover-develop@sha256:..."

# ECR managed signing
ecr_signing_profile_arn = "arn:aws:signer:ap-northeast-1:<AWS_ACCOUNT_ID>:/signing-profiles/<SIGNING_PROFILE_NAME>"

# Amplify-managed Lambda
finalize_callback_lambda_arn = "arn:aws:lambda:ap-northeast-1:<AWS_ACCOUNT_ID>:function:<AMPLIFY_FINALIZE_CALLBACK_FUNCTION>"

# GitHub access for CodeBuild
codestar_connection_arn = "arn:aws:codestar-connections:ap-northeast-1:<AWS_ACCOUNT_ID>:connection/<CONNECTION_ID>"

# Terraform 変数としては任意。空配列なら CORS 設定を作成しない。
# 標準の pnpm terraform:tfvars:<env> ヘルパーでは、ブラウザからの bundle 取得を壊さないよう非空値を要求する。
s3_cors_allowed_origins = ["<AMPLIFY_APP_ORIGIN>"]
```

補足:

- 現在の Terraform 入力として `cognito_identity_pool_id` や `amplify_graphql_api_arn` は要求していません。
- Amplify 由来で Terraform 側に必要なのは、現状は `finalize_callback_lambda_arn` です。
- 実運用では、`.env.local` から生成した `terraform/<env>.local.tfvars` の repo 名、digest、CORS origin を確認してください。

## CodeBuild とコンテナイメージ運用

### 現在の前提

- zkVM prover image は **環境別 ECR repository** に push する
- toolchain image は **shared ECR repository** を使う
- deploy 時は **tag ではなく digest** を `ecs_image_uri` に設定する
- runtime では Step Functions が `check-image-signature` Lambda を通して **ECR signing status** を確認する

### 手動ビルド例

`develop` 用 prover image:

```bash
aws-vault exec terraform-admin -- aws codebuild start-build \
  --project-name stark-ballot-simulator-fargate-prover-develop \
  --environment-variables-override name=IMAGE_TAG,value=v1.1.0,type=PLAINTEXT
```

`main` 用 prover image:

```bash
aws-vault exec terraform-admin -- aws codebuild start-build \
  --project-name stark-ballot-simulator-fargate-prover-main \
  --environment-variables-override name=IMAGE_TAG,value=v1.1.0,type=PLAINTEXT
```

署名ステータス確認:

```bash
aws-vault exec terraform-admin -- aws ecr describe-image-signing-status \
  --repository-name stark-ballot-simulator/zkvm-prover-develop \
  --image-id imageTag=v1.1.0 \
  --query 'signingStatuses[0].status'
```

### デプロイに使う値

1. CodeBuild ログに出力された `image-metadata.json` または ECR から digest を確認する
2. `.env.local` の `TERRAFORM_ECS_IMAGE_URI_<ENV>` または `TERRAFORM_ZKVM_PROVER_DIGEST_<ENV>` を更新する
3. `pnpm terraform:tfvars:<env>` で `terraform/<env>.local.tfvars` を再生成する
4. 対応する workspace / tfvars で `terraform apply` する

`latest` や semver tag のまま `ecs_image_uri` に渡さないでください。

### ARM64 Image ID の確認

zkVM guest を更新したあと、AWS 上で動く ARM64 の Image ID はローカル x86_64 と一致しないことがあります。`public/imageId-mapping.json` の `expectedImageID` を更新する前に、**実際にデプロイ済みの ARM64 task definition を 1 回実行して** `receipt.json` から Image ID を確認してください。

この確認は **Image ID の読取り専用**です。`RISC0_DEV_MODE=1` を使って高速に `image_id` を得ますが、ここで得られる receipt は本番 STARK 証明としては扱いません。

前提:

- 対象環境の CodeBuild が完了し、`ecs_image_uri` 更新後の `terraform apply` まで済んでいる
- AWS CLI / `jq` / `pnpm` / `unzip` が使える
- S3 proof bucket へ一時 object を置ける権限がある

1. 対象アカウントとリージョンを確認する

```bash
aws sts get-caller-identity --output json
aws configure get region
```

2. 現行コードで受理される入力 JSON をローカルで 1 つ生成する

```bash
pnpm tsx -e '
import { writeFileSync } from "node:fs";
import { MockSessionStore } from "./src/lib/store/mockSessionStore";
import { resolveCurrentContractGeneration } from "./src/lib/contract";
import { buildZkVMInputFromSession } from "./src/lib/zkvm/input-builder";
import { serializeZkvmAggregatorInput } from "./src/lib/zkvm/executor";

const main = async () => {
  const store = new MockSessionStore();
  const session = await store.createSession();
  const choices = ["A", "B", "C", "D", "E"];

  for (let i = 0; i < 64; i += 1) {
    await store.addVote(session.sessionId, {
      vote: choices[i % choices.length],
      rand: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      commit: "0x" + "0".repeat(64),
      path: [],
    });
  }

  const fullSession = await store.getSession(session.sessionId);
  if (!fullSession) {
    throw new Error("Session not found");
  }

  const zkvmInput = buildZkVMInputFromSession(fullSession);
  const payload = {
    ...serializeZkvmAggregatorInput(zkvmInput),
    contractGeneration: resolveCurrentContractGeneration(),
    election_config: fullSession.electionConfig,
  };

  writeFileSync("/tmp/arm64-imageid-input.json", JSON.stringify(payload, null, 2));
  process.stdout.write("/tmp/arm64-imageid-input.json\n");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
'
```

3. デプロイ済み Step Functions 定義から、実際の cluster / task definition / network を引く

```bash
AWS_ENV="develop" # or main
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
INPUT_KEY="sessions/imageid-check/${RUN_ID}/input.json"
OUTPUT_PREFIX="sessions/imageid-check/${RUN_ID}/output"

STATE_MACHINE_ARN="$(aws-vault exec terraform-admin -- terraform -chdir=terraform output -raw prover_state_machine_arn)"
STATE_DEF="$(aws-vault exec terraform-admin -- aws stepfunctions describe-state-machine \
  --state-machine-arn "$STATE_MACHINE_ARN" \
  --query definition \
  --output text)"

CLUSTER_ARN="$(jq -r 'fromjson.States.RunProver.Parameters.Cluster' <<<"$STATE_DEF")"
TASK_DEF_ARN="$(jq -r 'fromjson.States.RunProver.Parameters.TaskDefinition' <<<"$STATE_DEF")"
SUBNETS="$(jq -r 'fromjson.States.RunProver.Parameters.NetworkConfiguration.AwsvpcConfiguration.Subnets | join(",")' <<<"$STATE_DEF")"
SECURITY_GROUPS="$(jq -r 'fromjson.States.RunProver.Parameters.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups | join(",")' <<<"$STATE_DEF")"
ASSIGN_PUBLIC_IP="$(jq -r 'fromjson.States.RunProver.Parameters.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp' <<<"$STATE_DEF")"
BUCKET_NAME="$(aws-vault exec terraform-admin -- terraform -chdir=terraform output -raw s3_bucket_name)"
```

4. 一時入力を `sessions/` prefix 配下に upload して one-off task を起動する

注意:

- ECS task role は通常 `sessions/*` にしかアクセスできないため、`tmp/` など別 prefix は使わない
- override するのは `INPUT_S3_*`, `OUTPUT_S3_*`, `RISC0_DEV_MODE=1` だけに留める

```bash
aws s3 cp /tmp/arm64-imageid-input.json "s3://${BUCKET_NAME}/${INPUT_KEY}"

OVERRIDES="$(jq -nc \
  --arg bucket "$BUCKET_NAME" \
  --arg inputKey "$INPUT_KEY" \
  --arg outputPrefix "$OUTPUT_PREFIX" \
  '{
    containerOverrides: [
      {
        name: "prover",
        environment: [
          { name: "INPUT_S3_BUCKET", value: $bucket },
          { name: "INPUT_S3_KEY", value: $inputKey },
          { name: "OUTPUT_S3_BUCKET", value: $bucket },
          { name: "OUTPUT_S3_PREFIX", value: $outputPrefix },
          { name: "RISC0_DEV_MODE", value: "1" }
        ]
      }
    ]
  }'
)"

TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER_ARN" \
  --launch-type FARGATE \
  --task-definition "$TASK_DEF_ARN" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUPS}],assignPublicIp=${ASSIGN_PUBLIC_IP}}" \
  --overrides "$OVERRIDES" \
  --query 'tasks[0].taskArn' \
  --output text)"

aws ecs wait tasks-stopped --cluster "$CLUSTER_ARN" --tasks "$TASK_ARN"
```

5. `bundle.zip` と CloudWatch ログの両方で Image ID を確認する

```bash
TASK_ID="${TASK_ARN##*/}"

aws logs get-log-events \
  --log-group-name "/aws/ecs/stark-ballot-simulator-prover-${AWS_ENV}" \
  --log-stream-name "prover/prover/${TASK_ID}" \
  --query "events[?contains(message, 'Guest Program ImageID')].message" \
  --output text

aws s3 cp "s3://${BUCKET_NAME}/${OUTPUT_PREFIX}/bundle.zip" /tmp/arm64-imageid-bundle.zip
unzip -p /tmp/arm64-imageid-bundle.zip receipt.json | jq -r '.image_id // .imageId'
```

6. 更新先をそろえる

- `public/imageId-mapping.json` の `mappings[current].expectedImageID`
- `src/lib/verification/expected-image-id.ts` の fallback 定数
- `EXPECTED_IMAGE_ID` を使っている Amplify / CI / 手元シェルの override

補足:

- `expectedImageID_x86_64` は、x86_64 build の実測値があるときだけ更新します
- Amplify に `EXPECTED_IMAGE_ID` が残っている場合、runtime では mapping より **env override が優先**されます
- 既存の async finalization がすでに新 task definition で成功しているなら、その task のログや `bundle.zip` を使って同じ確認ができます

## Amplify との連携

Terraform outputs は、Amplify で管理している次の環境変数と対応します。

| Terraform output           | Amplify env var            |
| -------------------------- | -------------------------- |
| `prover_state_machine_arn` | `PROVER_STATE_MACHINE_ARN` |
| `prover_work_queue_arn`    | `PROVER_WORK_QUEUE_ARN`    |
| `prover_work_queue_url`    | `PROVER_WORK_QUEUE_URL`    |
| `s3_bucket_name`           | `S3_PROOF_BUCKET`          |

### 現在の方針

- このリポジトリの Terraform / CLI ワークフローから **Amplify の環境変数を更新しません**
- CLI や補助スクリプトは、必要に応じて Amplify の環境変数を**参照**しますが、**変更**はしません
- 運用上、Amplify の環境変数は **app-level を基底**に管理します
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

- `appLevel` が Amplify app-level の基底値です
- `branchOverride` は branch-level で上書きしている項目です
- `effective` が、その branch で実際に効く値です

## デプロイ手順

### develop

```bash
cd <REPO_ROOT>
pnpm terraform:backend
pnpm terraform:tfvars:develop

aws-vault exec terraform-admin -- terraform -chdir=terraform init -backend-config=backend.local.hcl
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace select develop
# 初回のみ:
# aws-vault exec terraform-admin -- terraform -chdir=terraform workspace new develop

aws-vault exec terraform-admin -- terraform -chdir=terraform plan -var-file="develop.local.tfvars"
aws-vault exec terraform-admin -- terraform -chdir=terraform apply -var-file="develop.local.tfvars"
```

apply 後の確認:

```bash
cd <REPO_ROOT>/terraform

STATE_MACHINE_ARN=$(aws-vault exec terraform-admin -- terraform output -raw prover_state_machine_arn)
QUEUE_URL=$(aws-vault exec terraform-admin -- terraform output -raw prover_work_queue_url)
BUCKET_NAME=$(aws-vault exec terraform-admin -- terraform output -raw s3_bucket_name)

aws-vault exec terraform-admin -- aws stepfunctions describe-state-machine \
  --state-machine-arn "$STATE_MACHINE_ARN" \
  --query 'name'

aws-vault exec terraform-admin -- aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn RedrivePolicy

aws-vault exec terraform-admin -- aws s3api head-bucket \
  --bucket "$BUCKET_NAME"
```

必要に応じて、前節の確認例で Amplify の app-level / branch override / 実効値も照合してください。

### main

```bash
cd <REPO_ROOT>
pnpm terraform:backend
pnpm terraform:tfvars:main

aws-vault exec terraform-admin -- terraform -chdir=terraform init -backend-config=backend.local.hcl
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace select main
# 初回のみ:
# aws-vault exec terraform-admin -- terraform -chdir=terraform workspace new main

aws-vault exec terraform-admin -- terraform -chdir=terraform plan -var-file="main.local.tfvars"
aws-vault exec terraform-admin -- terraform -chdir=terraform apply -var-file="main.local.tfvars"
```

apply 後の確認:

```bash
cd <REPO_ROOT>/terraform

STATE_MACHINE_ARN=$(aws-vault exec terraform-admin -- terraform output -raw prover_state_machine_arn)
QUEUE_URL=$(aws-vault exec terraform-admin -- terraform output -raw prover_work_queue_url)
BUCKET_NAME=$(aws-vault exec terraform-admin -- terraform output -raw s3_bucket_name)

aws-vault exec terraform-admin -- aws stepfunctions describe-state-machine \
  --state-machine-arn "$STATE_MACHINE_ARN" \
  --query 'name'

aws-vault exec terraform-admin -- aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn RedrivePolicy

aws-vault exec terraform-admin -- aws s3api head-bucket \
  --bucket "$BUCKET_NAME"
```

必要に応じて、前節の確認例で Amplify の app-level / branch override / 実効値も照合してください。

補足:

- `pnpm test:cli:real-dev` / `pnpm test:cli:real-prod:s0` はアプリケーション回帰確認には有用ですが、`STARK_BALLOT_CLI_BASE_URL` を明示しない限りローカルで `next build` / `next start` を起動するため、Terraform で構築した AWS リソースの疎通確認にはなりません。
- Terraform apply 後の一次確認は、まず Terraform outputs と AWS API で存在確認し、その後に必要に応じて Amplify 側で管理している実効 env 値と照合してから E2E を実施してください。

### 更新デプロイ

```bash
cd <REPO_ROOT>
pnpm terraform:backend
pnpm terraform:tfvars:main
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace select main
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace show # main であることを確認
aws-vault exec terraform-admin -- terraform -chdir=terraform plan -var-file="main.local.tfvars"
aws-vault exec terraform-admin -- terraform -chdir=terraform apply -var-file="main.local.tfvars"
```

### リソース削除

```bash
cd <REPO_ROOT>
pnpm terraform:backend
pnpm terraform:tfvars:develop
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace select develop
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace show # develop であることを確認
aws-vault exec terraform-admin -- terraform -chdir=terraform destroy -var-file="develop.local.tfvars"
```

## トラブルシューティング

### Q: state が競合する / 想定外の差分が出る

まず workspace を確認してください。

```bash
aws-vault exec terraform-admin -- terraform -chdir=terraform workspace show
```

`var.environment` と workspace が食い違っていると、誤った state に対して plan/apply してしまいます。

### Q: `terraform plan` が必須変数不足で失敗する

標準の `pnpm terraform:tfvars:<env>` 経由では、主に次の値が必要です。

- `ecs_image_uri`
- `ecr_signing_profile_arn`
- `finalize_callback_lambda_arn`
- `codestar_connection_arn`
- `codebuild_source_location`
- `s3_cors_allowed_origins`

Terraform 変数としての `s3_cors_allowed_origins` は default `[]` で、空なら S3 CORS 設定を作成しません。標準ヘルパーは proof bundle download のブラウザ導線を誤って無効化しないため、非空の CORS origin を要求します。

古い手順にあった `cognito_identity_pool_id` や `amplify_graphql_api_arn` は、現行 Terraform の必須入力ではありません。

### Q: ECS タスクが起動しない

以下を確認してください。

```bash
aws-vault exec terraform-admin -- aws ecr describe-images \
  --repository-name stark-ballot-simulator/zkvm-prover-develop

aws-vault exec terraform-admin -- aws logs tail \
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

`check-image-signature` Lambda は `ecr:DescribeImageSigningStatus` を使って、対象 digest の signing status を確認します。

```bash
aws-vault exec terraform-admin -- aws ecr describe-image-signing-status \
  --repository-name stark-ballot-simulator/zkvm-prover-main \
  --image-id imageTag=v1.1.0 \
  --query 'signingStatuses[0].status'
```

`COMPLETE` になる前に `terraform apply` しても、実行時検証で弾かれます。

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
