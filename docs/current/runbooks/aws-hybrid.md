# AWS Target Environment Runbook

> **Status guardrail:** This runbook describes current target-design and
> post-Plan-03 operations for the AWS hybrid path. It is not Plan 02
> release-candidate handoff evidence and does not authorize Plan 03. For current
> go/no-go authority, use
> [`post-merge/02`](../aws-account-migration/post-merge/02-develop-app-prerequisite-definitions-plan.md)
> and
> [`post-merge/03`](../aws-account-migration/post-merge/03-develop-app-execution-and-validation-plan.md).

## スコープ

この Runbook は、target AWS account の `stark-dev/develop/app` と後続の
production path を対象にした運用手順です。

- 対象: Terraform-managed static frontend, CloudFront, Hono API, DynamoDB, S3
  proof artifacts, SQS, Step Functions, Lambda, ECS/Fargate
- 前提: 通常運用は AWS-native saved-plan pipeline と Terraform-managed target
  runtime を起点に行う
- 非対象: legacy AWS account cleanup, production DNS cutover, localhost,
  local CLI-only reproduction
- 原則: AWS 障害の一次切り分けは target environment、CloudFront/API origin、
  AWS Console、AWS CLI、retained deployment evidence で行う

補足:

- ブラウザは通常 CloudFront same-origin の `/api/*` を叩きます。分離 origin
  を使う local/test path では `VITE_API_BASE_URL` が browser-public authority
  です。
- API カスタムドメイン運用中は、frontend URL と API origin が異なることが
  あります。疎通確認や `curl` は実効 API origin を優先してください。

## 1. 初動確認

1. 影響環境を特定する
   - `develop` / `main` のどちらで発生しているか
   - 発生時刻
   - 症状
   - `sessionId` と、取得できる場合は `executionId`
2. app pipeline の最新 accepted deployment evidence と source SHA を確認する
3. target runtime config と apply outputs を確認する
   - 特に `VITE_API_BASE_URL`, `PROVER_STATE_MACHINE_ARN`,
     `PROVER_WORK_QUEUE_URL`, `VERIFICATION_WORK_QUEUE_URL`,
     `VERIFICATION_WORKER_FUNCTION_NAME`, `S3_PROOF_BUCKET`,
     `S3_PROOF_PREFIX`, `PROVER_SEMAPHORE_TABLE_NAME`,
     `PROVER_SEMAPHORE_LOCK_NAME`, `PROVER_SEMAPHORE_STALE_SECONDS`, `USE_S3`
4. 関連ロググループを target environment に絞って discovery する

```bash
TARGET_PREFIX="stark-ballot-simulator-stark-dev-develop"
# For production after cutover, use:
# TARGET_PREFIX="stark-ballot-simulator-stark-prod-main"

# Hono API / target Lambda logs.
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/${TARGET_PREFIX}-" \
  --query 'logGroups[].logGroupName' \
  --output json

# Terraform-managed async prover logs.
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/ecs/${TARGET_PREFIX}-prover" \
  --query 'logGroups[].logGroupName' \
  --output json

aws logs describe-log-groups \
  --log-group-name-prefix "/aws/vendedlogs/states/${TARGET_PREFIX}-finalization" \
  --query 'logGroups[].logGroupName' \
  --output json

aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/${TARGET_PREFIX}-image-signature-gate" \
  --query 'logGroups[].logGroupName' \
  --output json

# API Gateway access logs for the target API path.
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/apigateway/${TARGET_PREFIX}-api/access" \
  --query 'logGroups[].logGroupName' \
  --output json
```

CloudWatch Logs Insights では該当 log group の API errors、finalize
errors、verifier errors を時間範囲で絞り込んで確認してください。

## 2. S3 bundle / authenticated download 障害

### 典型症状

- Verify 画面やダウンロード導線で 403 が返る
- 認証付き bundle / report endpoint が S3 artifact を取得できない
- ログに S3 download / GetObject 系のエラーが出る

### 対応手順

1. `public-api` のログを最初に確認する
   - S3 artifact の取得は
     `/api/verification/bundles/:sessionId/:executionId` と
     `/api/verification/bundles/:sessionId/:executionId/report` 側で実行される
   - `/api/verify` は `s3BundleUrl` を公開レスポンスに返さず、
     `verificationExecutionId` を返して認証付き download endpoint へ誘導する
   - `public-api` のログが出ていない場合は、API Gateway access log も確認する
2. target runtime env を確認する
   - `S3_PROOF_BUCKET`
   - `S3_PROOF_PREFIX`
   - `USE_S3`
   - `TARGET_AWS_RUNTIME`
3. Hono API Lambda 実行ロールに proof artifact bucket への
   object-level `s3:GetObject` / `s3:GetObjectVersion` があることを確認する
4. bundle 自体が存在しない、または初回アップロードが失敗している場合は、
   Step Functions と ECS prover のログを先に確認する
   - 初回の `bundle.zip` 生成と S3 upload は ECS prover task の責務
   - `s3:PutObject` や task failure は
     `/aws/ecs/<target-prefix>-prover` を見る
5. bundle は存在するのに session state が更新されない場合は、
   finalize callback Lambda のログを確認する
6. `/api/verification/run` 実行後の `verification.json` 再生成や再 upload が
   怪しい場合は verification worker Lambda のログを確認する
7. 必要に応じて、対象 object の存在を確認する
   - key は通常 `<S3_PROOF_PREFIX><sessionId>/<executionId>/bundle.zip`

### 運用メモ

- 手動 `presign` は通常運用の標準手順にしない。browser / CLI には認証付き
  download endpoint を使わせる
- 標準復旧経路は UI の bundle / report ダウンロード再試行、または認証付き
  download endpoint の再実行
- `S3_SIGNED_URL_TTL_SECONDS` / `S3_BUNDLE_SIGNED_URL_TTL_SECONDS` は
  現行の bundle/report 配信制御ではない。残存する場合は履歴互換入力の
  fail-closed validation 対象であり、復旧手順や browser / CLI download
  経路として扱わない

## 3. 非同期 finalization 障害

### 典型症状

- Finalization が `pending` / `running` のまま進まない
- Verify 画面で `FAILED`、または callback が `TIMED_OUT` を受けた場合の
  `TIMEOUT`
- Step Functions が `SUCCEEDED` なのに UI が進行中のまま

### 対応手順

1. Step Functions 実行の `status` と `cause` を確認する
2. Step Functions のログを確認する
   - log group は通常 `/aws/vendedlogs/states/<target-prefix>-finalization`
   - target Terraform の callback 終端は `CallbackSucceeded` /
     `CallbackTimedOut` / `CallbackSignatureFailed` / `CallbackFailed`
   - callback delivery 自体が失敗した場合は `CallbackDeliveryFailed`
3. `public-api` のログを確認する
   - `/api/finalize` での SQS publish 失敗
   - `PROVER_WORK_QUEUE_URL` の未設定や `sqs:SendMessage` 権限不足
4. prover dispatch Lambda のログを確認する
   - SQS 受信後の payload parse / dispatch precondition / input upload 失敗
   - session が存在しない、または stored finalization state が message の
     `executionId` に対する `pending` ではないため message が drop されたケース
   - Step Functions 起動失敗
   - `ExecutionAlreadyExists` 後の再 read で outcome が記録済みなら
     already-processed として drop される
   - `ExecutionAlreadyExists` 後も session が同じ `executionId` の `pending`
     のままなら、`DescribeExecution` を確認する。execution が `RUNNING` なら
     already-dispatched duplicate として drop し、closed / not-found なら
     lost-outcome execution として retry / DLQ evidence を残す
   - malformed message は fail-closed に throw し、retry / DLQ 対象になる。
     verified-stale work だけが削除される
5. Step Functions が `VerifyImageSignature` / `CheckImageSignature` で止まる場合は、
   `image-signature-gate` Lambda のログと ECR signing status を確認する
6. Step Functions が semaphore 導入後の `AcquireProverSlot`（およびその
   wait/retry ループ）で止まっている場合は、semaphore item の
   `currentLockCount`、`limit`、owner marker、古い owner の有無を確認する
7. Step Functions が `RunProver` まで進んでいる場合は、ECS prover のログを確認する
   - Fargate capacity / ECS API transient retry 中も user-visible state は
     `running` のまま
   - operators may see multiple `RunTask` attempts in the Step Functions
     execution history before success or final failure
8. backlog が疑われる場合は、対象 queue の深さと古いメッセージ滞留を確認する。
   semaphore 導入後の SQS depth は dispatch backlog であり、prover slot 待ちの
   execution 数そのものではない
9. Step Functions が `SUCCEEDED` なのに UI が更新されない場合は、finalize
   callback Lambda のログと session 更新成否を確認する
10. オペレータが中断する場合は `/api/finalize/cancel` を使う
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

- `BASE_URL` には、CloudFront domain、API カスタムドメイン、または explicit
  `VITE_API_BASE_URL` origin を使います。

### Passive observability baseline

Plan 03 時点の alarm は passive です。SNS / auto-remediation は設定せず、発火時は
operator が evidence を確認して redrive / drop / 再実行を判断します。

| Alarm                                      | Signal                                                                  | Operator response                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prover_work_dlq_depth`                    | prover dispatch DLQ の visible message が 0 を超えた                    | message payload、dispatcher log、Step Functions execution 有無、session state を保存し、下の redrive-or-drop 判断へ進む                                                         |
| `verification_work_dlq_depth`              | verification worker DLQ の visible message が 0 を超えた                | verification worker log、対象 session/execution、bundle/report object の有無を保存し、再投入で重複副作用がないか確認する                                                        |
| `target_sfn_executions_failed`             | target finalization state machine の `ExecutionsFailed` が 0 を超えた   | execution history と callback state を確認する。意図的な `CallbackDeliveryFailed` terminal もここに出るため、session state reconciliation と callback Lambda log を必ず確認する |
| `target_sfn_executions_timed_out`          | target finalization state machine の `ExecutionsTimedOut` が 0 を超えた | `RunProver` timeout、callback timeout、ECS task status、proof artifact の有無を確認する                                                                                         |
| `target_lambda_errors_proof_dispatcher`    | proof dispatcher Lambda `Errors` が 0 を超えた                          | SQS record、payload parse、pre-dispatch gate、`StartExecution` / `DescribeExecution` error を確認する                                                                           |
| `target_lambda_errors_finalization_writer` | finalization writer Lambda `Errors` が 0 を超えた                       | callback payload、DynamoDB/KMS permissions、sticky terminal guard の返却 state、artifact metadata を確認する                                                                    |
| `target_lambda_errors_semaphore_janitor`   | semaphore janitor Lambda `Errors` が 0 を超えた                         | EventBridge terminal-status event、scheduled sweep log、DynamoDB conditional failure 以外の error、`DescribeExecution` error を確認する                                         |
| `fargate_on_demand_vcpu_usage`             | AWS/Usage Fargate On-Demand vCPU usage が threshold を超えた            | threshold は `40`、想定 quota は `48`。Service Quotas、active ECS tasks、Step Functions `RunTask` retry、semaphore slot limit を確認する                                        |

Semaphore lock count、janitor activity、slot wait は custom metric ではなく、CLI
checks と `semaphore-janitor` logs で確認します。これは passive demo model の
意図的な境界です。

### DLQ redrive-or-drop 判断

DLQ message はすぐ redrive しないで、まず evidence を保存します。

1. message の `sessionId` / `executionId` / S3 keys を記録する
2. session state を読む
   - session が missing、または stored finalization state が message の
     `executionId` に対する `pending` ではない場合は stale work として drop 候補
   - すでに `FINALIZATION_DISPATCH_TIMEOUT` で `failed` になった session は、
     message を redrive しても dispatcher が non-pending work として drop する。
     この DLQ message は evidence であり、user recovery path は新しい session
     からの再実行
   - same executionId の `pending` の場合は Step Functions execution の有無を確認する
3. Step Functions execution を確認する
   - `RUNNING` なら duplicate delivery の可能性が高く、redrive しない
   - not found か closed without recorded outcome なら、status handler が
     fail-closed に persist するまで待つか、evidence を添えて再実行方針を決める
4. malformed message は redrive しても同じ fail-closed path に戻るため、payload と
   parser error を保存して drop する

Redrive は、message が正当で、session がまだ同じ executionId の `pending` で、
execution が存在せず、dispatch deadline 内で再送に意味がある場合だけ検討します。
Deadline 後に sticky failed state へ進んだ attempt は redrive で復活しません。

### 状態遷移メモ

- `pending` または `running` 中の cancel は durable です。Terminal states
  (`succeeded` / `failed` / `timeout`) は executionId ごとに sticky なので、
  late dispatcher delivery や racing callback は terminal state を別の
  terminal / running state に戻しません。
- 既存 attempt がある間の duplicate `POST /api/finalize` は、既存 attempt を
  一貫して記述する 202 response を返します。二つ目の `input.json` upload、
  SQS publish、proof run は発生しません。
- Dispatcher は session missing または stored finalization state が message の
  `executionId` に対する `pending` ではない message を drop します。この場合、
  SQS message は削除され、retry / DLQ には進みません。
- `RunProver` の capacity / ECS API transient retry は Step Functions execution
  history に現れます。`running` は `MarkProverStarted` が semaphore slot 取得後に
  記録するため、slot 取得後の capacity / ECS API transient retry 中は
  user-visible state が `running` のままです。
- semaphore wait 中の cancel は session state を terminal `failed` にします。
  待機中の Step Functions execution が後で slot を取得しても、
  `MarkProverStarted` は store guard によって `running` へ進めず、
  `ReleaseSuperseded` 経由で slot を解放して proof を実行せずに終了します。
- Status polling は stuck `pending` を reconcile します。`pending` が 60 秒より
  若い間は Step Functions describe を行いません。60 秒を超えた場合は
  `PROVER_STATE_MACHINE_ARN` と `executionId` から deterministic execution ARN を
  構築して確認します。
- Execution が存在せず、age が `FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS`
  （未設定時 900 秒）を超えた場合は、store guard 経由で
  `FINALIZATION_DISPATCH_TIMEOUT` の `failed` state を persist します。
- Execution が closed (`SUCCEEDED` / `FAILED` / `TIMED_OUT` / `ABORTED`) なのに
  stored state がまだ `pending` の場合は、recorded result authority がないため、
  `SUCCEEDED` でも `FINALIZATION_OUTCOME_UNRECORDED` として fail closed に
  persist します。
- `running` についても Step Functions が terminal なら display-only projection
  ではなく store guard 経由で terminal state を persist します。Callback が race に
  勝っていれば sticky guard の返却 state が response に使われます。

### 注意

- `StopExecution` の直接実行は標準手順にしない
- 直接停止すると、Step Functions は止まっても session state が整合しない可能性がある
- semaphore 導入後は、直接停止によって owner marker が残る可能性もあるため、
  EventBridge/scheduled janitor の cleanup evidence を確認する
- 再実行が必要な場合は、対象環境の `/aggregate` 導線からやり直す

### Semaphore 運用チェック

通常の operator cancel は `/api/finalize/cancel` を使います。`StopExecution`
は session state と semaphore owner marker を分離させるため標準手順にしません。

Semaphore item は 1 行です。`LockName`、`currentLockCount`、`limit` 以外の
top-level attributes は Step Functions execution name（通常は `executionId`）を
名前に持つ owner marker です。値は slot 取得時刻の ISO timestamp です。

```bash
TARGET_PREFIX="stark-ballot-simulator-stark-dev-develop"
PROVER_SEMAPHORE_TABLE_NAME="${TARGET_PREFIX}-prover-semaphore"

aws dynamodb get-item \
  --table-name "${PROVER_SEMAPHORE_TABLE_NAME}" \
  --key '{"LockName":{"S":"prover-fargate"}}' \
  --consistent-read
```

確認ポイント:

- `currentLockCount` が `limit` を超えていないこと。ただし stored `limit` は
  seed item 作成時の inventory であり、現在の enforced authority は
  `var.prover_max_concurrent_provers`
- owner marker 数と `currentLockCount` が整合していること
- owner marker の timestamp が古すぎないこと
- owner marker に対応する Step Functions execution がまだ active か、terminal
  event / scheduled sweep の janitor cleanup 対象か

Semaphore row 自体が削除されている場合、Step Functions は
`CheckProverSlotHeld` から `CallbackCapacityWaitFailed` へ fail closed します。
復旧は item shape `{ LockName: "prover-fargate", currentLockCount: 0, limit:
var.prover_max_concurrent_provers }` で seed item を再作成し、通常の finalize
path から再実行します。

Capacity wait 中の execution は Step Functions history で
`AcquireProverSlot` retry / `CheckProverSlotHeld` 付近に留まります。SQS depth は
dispatcher に到達していない work の backlog だけを示し、semaphore 待ちの
execution 数や UI queue position ではありません。

Leaked owner が疑われる場合は、次の evidence を 1 つの調査記録に残します:

- SQS queue depth、oldest message age、DLQ message count
- Step Functions execution ARN、status、history の最後の state、失敗 cause
- ECS task ARN、last status、stopped reason、container exit code、ECS log excerpt
- semaphore item の `currentLockCount`、`limit`、owner marker と timestamp
- `semaphore-janitor` Lambda の EventBridge terminal-status invocation と
  30-minute scheduled sweep のログ
- session の finalization state と stuck `pending` / `running` の有無

`ConditionalCheckFailedException` による release 失敗は、すでに解放済みの
owner として許容されることがあります。DynamoDB のその他の error、古い owner
が残り続けるケース、または session が terminal なのに owner marker が残る
ケースは evidence を残して retry / janitor / manual recovery の判断対象にします。

## 4. IAM / 設定ドリフト

### 優先して確認すること

1. target app pipeline の source SHA と accepted deployment evidence
2. Terraform apply outputs と runtime env
3. CloudFront/API Gateway access log と Hono API / prover dispatch / finalize
   callback / verification worker のログ
4. async finalization 経路なら Step Functions、`image-signature-gate` Lambda、
   ECS prover のログ

### 管理境界

- Terraform 管理:
  - CloudFront, S3 static frontend, API Gateway, Lambda, DynamoDB, SQS,
    Step Functions, ECS/Fargate, proof artifact S3, ECR, CloudWatch Logs,
    IAM roles and policies
  - 反映漏れや設定差分の復旧は AWS-native saved-plan pipeline の retained
    evidence と Terraform state identity を確認してから実行する
- Legacy AWS account references:
  - historical, retention-only, or future cutover context として扱う
  - target runtime の復旧 authority にはしない

### 症状別メモ

- `AccessDenied: s3:GetObject`
  - bundle / report download 経路ならまず Hono API Lambda の S3 権限を見る
  - callback での bundle 復元なら finalize callback Lambda、verify report
    再取得なら verification worker Lambda も確認する
- `AccessDenied: s3:PutObject`
  - 初回 `bundle.zip` upload なら ECS prover task role を疑う
  - `/api/verification/run` 後の再 upload なら `USE_S3=true` の実効値、
    verification worker Lambda の権限、同 Lambda のログを見る
- ECR signing status が `COMPLETE` ではない
  - prover image URI が digest pinned され、対象 digest の ECR signing status
    が `COMPLETE` であることを確認する
- `HybridCliAccessPolicyArn`
  - 外部 CLI や運用ロールが S3 を直接読む場合の補助ポリシー
  - hosted UI / API 障害の一次確認先ではない

## 5. 参照先

- Target Terraform roots: `infra/terraform/app/README.md`, `infra/terraform/foundation/README.md`, and `infra/terraform/bootstrap/README.md`
- Retained legacy Terraform reference: `docs/current/guides/7-terraform/README.md`
- CloudWatch Logs Insights: target log groups for API, finalize, verifier, and access logs
