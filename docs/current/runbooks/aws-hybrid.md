# AWS Hybrid Environment Runbook

## スコープ

この Runbook は、GitHub 連携済みの Amplify branch deploy（`develop` / `main`）と、その背後にある AWS 環境を対象にした運用手順です。

- 対象: Amplify Hosting + Amplify Data + Terraform 管理リソース
- 前提: Amplify アプリはすでに稼働中で、通常運用は branch deploy を起点に行う
- 非対象: Amplify sandbox、`localhost`、ローカル CLI を使った共同検証
- 原則: AWS 障害の一次切り分けは、対象 branch のデプロイ URLと AWS コンソール / AWS CLI で行う

補足:

- ブラウザが実際に叩く API origin は、`NEXT_PUBLIC_API_BASE_URL` が設定されていればその値を優先し、未設定時のみ branch deploy URL 配下の `/api/*` を使います
- API カスタムドメイン運用中は、branch URL と API origin が異なることがあります。疎通確認や `curl` は **実効 API origin** を優先してください

Amplify の app-level / branch override の確認方法は `docs/current/guides/7-terraform/README.md` の「Amplify との連携」を参照してください。

## 1. 初動確認

1. 影響環境を特定する
   - `develop` / `main` のどちらで発生しているか
   - 発生時刻
   - 症状
   - `sessionId` と、取得できる場合は `executionId`
2. Amplify Console で対象 branch の最新 deploy が成功しているか確認する
3. branch の実効環境変数を確認する
   - 特に `NEXT_PUBLIC_API_BASE_URL`、`PROVER_STATE_MACHINE_ARN`、`PROVER_WORK_QUEUE_ARN`、`PROVER_WORK_QUEUE_URL`、`S3_PROOF_BUCKET`、`S3_PROOF_PREFIX`、`USE_S3`
4. 関連ロググループを current app / branch に絞って discovery する

```bash
APP_ID="<AMPLIFY_APP_ID>"
BRANCH_NAME="develop" # or main
AWS_ENV="$BRANCH_NAME"

# Amplify-managed Lambda logs for the current app / branch only.
# appId で絞らない broad query は、削除していない旧 Amplify app のログまで拾うことがある。
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda" \
  --output json \
  | jq -r --arg app "$APP_ID" --arg branch "$BRANCH_NAME" '
      ($branch
        | if . == "main" then ["main", "ma"]
          elif . == "develop" then ["develop", "de"]
          else [.]
          end) as $branchTokens
      | .logGroups[].logGroupName as $name
      | $name
      | select(contains($app))
      | select(any($branchTokens[]; $name | contains(.)))
      | select(test("hono|proverdispatchproxy|verifierservicerunner|finalizecallbackrunner"))
    '

# Terraform-managed async prover logs for the selected environment.
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/ecs/stark-ballot-simulator-prover-${AWS_ENV}" \
  --query 'logGroups[].logGroupName' \
  --output json

aws logs describe-log-groups \
  --log-group-name-prefix "/aws/stepfunctions/stark-ballot-simulator-prover-${AWS_ENV}" \
  --query 'logGroups[].logGroupName' \
  --output json

aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/stark-ballot-simulator-check-image-signature-${AWS_ENV}" \
  --query 'logGroups[].logGroupName' \
  --output json

# API Gateway access logs for the current API path.
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/apigateway/stark-ballot-simulator-hono-api-${AWS_ENV}" \
  --query 'logGroups[].logGroupName' \
  --output json
```

CloudWatch Logs Insights のクエリ集と週次監視手順は private operations notes 側で管理します。public snapshot では、この Runbook のロググループ discovery 例を一次切り分けの入口にしてください。

## 2. S3 bundle / authenticated download 障害

### 典型症状

- Verify 画面やダウンロード導線で 403 が返る
- 認証付き bundle / report endpoint が S3 artifact を取得できない
- ログに S3 download / GetObject 系のエラーが出る

### 対応手順

1. `hono-api` のログを最初に確認する
   - S3 artifact の取得は `/api/verification/bundles/:sessionId/:executionId` と `/api/verification/bundles/:sessionId/:executionId/report` 側で実行される
   - `/api/verify` は `s3BundleUrl` を公開レスポンスに返さず、`verificationExecutionId` を返して認証付き download endpoint へ誘導する
   - `hono-api` のログが出ていない場合は、API Gateway access log も確認する
2. 対象 branch の実効 env を確認する
   - `S3_PROOF_BUCKET`
   - `S3_PROOF_PREFIX`
   - `USE_S3`
     - hosted Lambda では Lambda runtime 判定でも S3 upload / authenticated download 経路が有効になる
     - ローカルや非 Lambda runtime で S3 経路を再現する場合は `USE_S3=true` が必要
3. `hono-api` の Lambda 実行ロールに、proof bundle bucket への `s3:GetObject` / `s3:GetObjectVersion` / `s3:ListBucket` があることを確認する
4. bundle 自体が存在しない、または初回アップロードが失敗している場合は、Step Functions と ECS prover のログを先に確認する
   - 初回の `bundle.zip` 生成と S3 upload は ECS prover task の責務
   - `s3:PutObject` や task failure は `/aws/ecs/stark-ballot-simulator-prover-<env>` を見る
5. bundle は存在するのに session state が更新されない場合は、`finalize-callback-runner` のログを確認する
   - callback は既存 bundle を読み出して session を確定する
6. `/api/verification/run` 実行後の `verification.json` 再生成や再 upload が怪しい場合だけ、`verifier-service-runner` のログを確認する
7. 必要に応じて、対象 object の存在を確認する
   - key は通常 `<S3_PROOF_PREFIX><sessionId>/<executionId>/bundle.zip`

### 運用メモ

- 手動 `presign` は通常運用の標準手順にしない。browser / CLI には認証付き download endpoint を使わせる
- 標準復旧経路は UI の bundle / report ダウンロード再試行、または認証付き download endpoint の再実行
- TTL の基準値
  - `S3_SIGNED_URL_TTL_SECONDS`: default 3600
  - `S3_BUNDLE_SIGNED_URL_TTL_SECONDS`: default 300, max 900

## 3. 非同期 finalization 障害

### 典型症状

- Finalization が `pending` / `running` のまま進まない
- Verify 画面で `FAILED`、または callback が `TIMED_OUT` を受けた場合の `TIMEOUT`
- Step Functions が `SUCCEEDED` なのに UI が進行中のまま

### 対応手順

1. Step Functions 実行の `status` と `cause` を確認する
2. Step Functions のログを確認する
   - log group は通常 `/aws/stepfunctions/stark-ballot-simulator-prover-<env>`
   - 現行 Terraform の終端は `FinalizeSucceeded` / `FinalizeFailed` / `FinalizeSignatureFailed`。callback Lambda は `TIMED_OUT` も受理するが、標準の State Machine からは通常送出されない
3. `hono-api` のログを確認する
   - `/api/finalize` での SQS publish 失敗
   - `PROVER_WORK_QUEUE_URL` の未設定や `sqs:SendMessage` 権限不足
4. `prover-dispatch-proxy` のログを確認する
   - SQS 受信後の payload parse / dispatch precondition / input upload 失敗
   - Step Functions 起動失敗
   - AppSync への running state 更新失敗
5. Step Functions が `VerifyImageSignature` / `CheckImageSignature` で止まる場合は、`check-image-signature` Lambda のログと ECR signing status を確認する
   - log group は通常 `/aws/lambda/stark-ballot-simulator-check-image-signature-<env>`
   - 署名ステータスが `COMPLETE` でない場合、ECS task は起動されず `FinalizeSignatureFailed` に進む
6. Step Functions が `RunProver` まで進んでいる場合は、ECS prover のログを確認する
   - zkVM 実行失敗
   - `bundle.zip` upload 失敗
   - log group は通常 `/aws/ecs/stark-ballot-simulator-prover-<env>`
7. backlog が疑われる場合は、対象 queue の深さと古いメッセージ滞留を確認する
   - 併せて `PROVER_LAMBDA_CONCURRENCY` の実効値を確認する
8. Step Functions が `SUCCEEDED` なのに UI が更新されない場合は、`finalize-callback-runner` のログと session 更新成否を確認する
9. オペレータが中断する場合は `/api/finalize/cancel` を使う
   - `X-Session-ID`
   - `X-Session-Capability`
   - body: `executionId`

```bash
BASE_URL="https://<EFFECTIVE_API_ORIGIN>"

curl -X POST "${BASE_URL%/}/api/finalize/cancel" \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: <sessionId>" \
  -H "X-Session-Capability: <capabilityToken>" \
  -d '{"executionId":"<executionId>","reason":"Cancelled by operator"}'
```

- `BASE_URL` には、`NEXT_PUBLIC_API_BASE_URL` または API カスタムドメインが設定されていればその origin を使います
- API base を分離していない環境では、従来どおり Amplify branch URL を使います

### 注意

- `StopExecution` の直接実行は標準手順にしない
- 直接停止すると、Step Functions は止まっても session state が整合しない可能性がある
- 再実行が必要な場合は、対象 branch の `/aggregate` 導線からやり直す

## 4. IAM / 設定ドリフト

### 優先して確認すること

1. 対象 branch の deploy 成否
2. app-level / branch override の実効 env
3. current app / branch の API Gateway access log と `hono-api` / `prover-dispatch-proxy` / `finalize-callback-runner` / `verifier-service-runner` のログ
4. async finalization 経路なら `/aws/stepfunctions/stark-ballot-simulator-prover-<env>`、`/aws/lambda/stark-ballot-simulator-check-image-signature-<env>`、`/aws/ecs/stark-ballot-simulator-prover-<env>` のログ

### まず管理境界を切り分ける

- Amplify 管理:
  - branch/app env、API Gateway（`hono-api` integration 含む）、AppSync、`hono-api` / `prover-dispatch-proxy` / `verifier-service-runner` / `finalize-callback-runner` の Lambda とそのロール
  - 反映漏れや設定差分の復旧は Amplify backend 再デプロイを第一候補にする
- Terraform 管理:
  - VPC、ECS、Step Functions、SQS、S3、ECR、CloudWatch Logs、ECS task role / Step Functions role など
  - 反映漏れや設定差分の復旧は Terraform で行う。`terraform workspace show` で対象環境を確認してから、guarded flow（`pnpm terraform:plan:<env>` / `pnpm terraform:apply:<env>`、または `scripts/terraform/terraform-guarded.sh`）で実行する

### 症状別メモ

- `AccessDeniedException: appsync:GraphQL`
  - hosted backend 側の認可反映を疑う
  - `amplify/data/resource.ts` の `allow.resource(...)` が現行デプロイへ反映されているか確認する
- `AccessDenied: s3:GetObject`
  - bundle / report download 経路ならまず `hono-api` の S3 権限を見る
  - callback での bundle 復元なら `finalize-callback-runner`、verify report 再取得なら `verifier-service-runner` も確認する
- `AccessDenied: s3:PutObject`
  - 初回 `bundle.zip` upload なら ECS prover task role を疑う
  - `/api/verification/run` 後の再 upload なら `USE_S3=true` の実効値、`verifier-service-runner` の権限、同 Lambda のログを見る
  - ECS prover task role は Terraform 管理、`verifier-service-runner` は Amplify 管理
- ECR signing status が `COMPLETE` ではない
  - `ecs_image_uri` が digest pin され、対象 digest の ECR signing status が `COMPLETE` であることを確認する
  - `check-image-signature` Lambda は Terraform 管理、`FinalizeSignatureFailed` 後の session state 更新は Amplify 管理 `finalize-callback-runner` を確認する
- `HybridCliAccessPolicyArn`
  - 外部 CLI や運用ロールが S3 を直接読む場合の補助ポリシー
  - hosted UI / API 障害の一次確認先ではない
  - Amplify branch deploy の通常運用では必須前提にしない

設定差分や認可反映漏れが疑われる場合は、まず対象リソースが Amplify 管理か Terraform 管理かを確定します。Amplify 管理の差分なら対象 branch の Amplify backend を再デプロイし、Terraform 管理の差分なら `terraform workspace show` で環境を確認したうえで、`pnpm terraform:plan:<env>` / `pnpm terraform:apply:<env>` または `scripts/terraform/terraform-guarded.sh <env> ...` で反映状態を揃えます。

## 5. 参照先

- Terraform / Amplify env 連携: `docs/current/guides/7-terraform/README.md`
- CloudWatch Logs Insights query catalogs and weekly monitoring runbooks are private operations notes stripped from the generated public snapshot.
