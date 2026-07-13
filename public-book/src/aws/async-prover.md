# 非同期プローバー

このページは、AWS runtime で STARK 証明生成を HTTP リクエストから分離する非同期プローバー経路を説明します。
対象は `FINALIZE_ASYNC_MODE=true` の経路です。

STARK 証明生成はブラウザ操作や API Gateway / Lambda の短い応答時間より長くかかります。
そのため、`POST /api/finalize` は作業を受理してすぐ返し、証明生成は SQS、Step Functions、ECS Fargate に委ねます。
ブラウザは capability token 付きの status API をポーリングし、完了後に capability 保護 API から bundle/report を取得します。

ここでいう `public` の分類は [公開境界](../verification/public-boundary.md) の定義に従います。

## 全体像

```mermaid
flowchart TB
  API["POST /api/finalize<br/>capability protected"] --> S3IN["Private S3<br/>input.json"]
  API --> SQS["SQS<br/>prover work queue"]
  SQS --> DISPATCH["proof-dispatcher Lambda"]
  DISPATCH --> SFN["Step Functions<br/>finalization state machine"]
  SFN --> SIG["image-signature-gate Lambda"]
  SIG --> CHECK{"署名 status<br/>COMPLETE?"}
  CHECK -->|Yes| SEM["DynamoDB<br/>prover semaphore"]
  JANITOR["semaphore-janitor Lambda<br/>compensating cleanup"] -.-> SEM
  SEM --> STARTED["finalization-writer Lambda<br/>running admitted"]
  STARTED --> ECS["ECS Fargate task<br/>zkVM host"]
  CHECK -->|No| CALLBACK_FAIL["finalization-writer Lambda<br/>failed"]
  ECS --> S3OUT["Private S3<br/>bundle.zip + sibling artifacts"]
  ECS --> CALLBACK_OK["finalization-writer Lambda<br/>succeeded / timeout / failed"]
  CALLBACK_OK --> DDB["DynamoDB<br/>session finalization state"]
  CALLBACK_FAIL --> DDB
  DDB --> STATUS["GET /api/sessions/:sessionId/status<br/>capability protected"]
  S3OUT --> DOWNLOAD["GET /api/verification/bundles/...<br/>GET /report<br/>capability protected"]
```

主要な責務は次のとおりです。

| コンポーネント             | 責務                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| API handler                | セッション capability、Turnstile、rate limit、finalize 前提条件を検証し、`input.json` を private S3 に保存して非同期 work item を作る |
| SQS work queue             | finalize 要求を durable な dispatch 単位として保持し、dispatcher の再試行と DLQ 移動を担う                                            |
| proof-dispatcher Lambda    | work item、artifact key、session の `pending` state を検証し、Step Functions execution を開始する                                     |
| Step Functions             | image signature gate、prover semaphore、ECS Fargate `runTask.sync`、成功、失敗、timeout の callback を順序づける                      |
| prover semaphore           | DynamoDB の単一 lock item で `RunProver` への同時進入数を制限し、capacity 待ちを Step Functions 内に閉じ込める                        |
| semaphore-janitor Lambda   | terminal execution event と定期 sweep を使い、通常の release 経路で残った semaphore owner を補償的に解放する                          |
| ECS Fargate task           | zkVM host を実行し、公開可能 artifact と private sibling artifact を private S3 に保存する                                            |
| finalization-writer Lambda | callback payload と S3 bundle key を検証し、DynamoDB の session finalization state を更新する                                         |
| bundle/report API          | session capability と execution scope を検証し、S3 または local artifact を API response として返す                                   |

## Finalize 受付

`POST /api/finalize` は session-scoped な操作であり、`X-Session-ID` と `X-Session-Capability` の検証を通過した場合だけ処理されます。

非同期モードでは、API handler は同期的に証明を作らず、次の処理を行います。

1. セッションが finalize 可能な状態か検証する。
2. zkVM 入力を構築し、finalization state を `pending` として保存する。
3. target AWS runtime では `sessions/{sessionId}/{executionId}/input.json` に zkVM 入力を保存する。
4. SQS work queue に、正準 S3 key を含む prover work message を送る。
5. `202 Accepted` と status URL を返す。

返却後のクライアントのポーリングと status の判定境界は [Client polling と判定境界](#client-polling-と判定境界) を参照してください。

## Dispatch 処理

`proof-dispatcher` Lambda は SQS message を 1 件ずつ処理します。
SQS は長時間の証明生成を直接抱えるのではなく、Step Functions execution を開始するための durable dispatch queue です。

dispatcher は次を検証します。

- message shape、session ID、execution ID、contract generation
- `input.json`、output prefix、`bundle.zip` の S3 key が session / execution scope の正準 layout に一致すること
- AWS runtime に必要な環境設定が存在すること

検証後、dispatcher は Step Functions を `StartExecution` で開始します。
dispatcher は `input.json` を保存せず、`StartExecution` 成功だけで finalization state を `running` にもしません。
`running` は Step Functions が prover semaphore slot を取得し、`MarkProverStarted` が admitted された後に記録されます。

session が存在しない、または message の `executionId` に対する `pending` state ではない場合、dispatcher は stale work として drop します。
message shape や artifact key の不整合、または一時的な AWS 呼び出し失敗は SQS retry / DLQ の対象です。

### DynamoDB recovery phase と quiesce

Terraform の DynamoDB recovery transition で `primary_quiesced` または `replacement_quiesced` が選ばれると、新規の public session admission と prover / verification work queue の SQS event-source mapping が無効になります。
この間、未消費の prover work は SQS に残り、finalization state は `pending` のままになることがあります。

`primary_active` では primary table pair、`replacement_active` では manifest が選択した replacement table pair を target Lambda が使い、active phase で event-source consumption を再開します。
これは repository に定義された切替契約の説明であり、live restore、切替、switch-back の完了証跡を主張するものではありません。

## Step Functions

Step Functions state machine は、証明生成の順序と callback を管理します。

```mermaid
stateDiagram-v2
  [*] --> VerifyImageSignature
  VerifyImageSignature --> CheckImageSignature
  VerifyImageSignature --> CallbackFailed: Lambda error
  CheckImageSignature --> AcquireProverSlot: COMPLETE
  CheckImageSignature --> CallbackSignatureFailed: other status
  AcquireProverSlot --> MarkProverStarted: slot acquired
  AcquireProverSlot --> CallbackCapacityWaitFailed: capacity wait exhausted
  MarkProverStarted --> RunProver: admitted
  MarkProverStarted --> ProverStartSuperseded: stale/cancelled
  RunProver --> ReleaseAfterSuccess: success
  RunProver --> ReleaseAfterTimeout: timeout
  RunProver --> ReleaseAfterFailure: task error
  ReleaseAfterSuccess --> CallbackSucceeded
  ReleaseAfterTimeout --> CallbackTimedOut
  ReleaseAfterFailure --> CallbackFailed
  CallbackSucceeded --> [*]
  CallbackTimedOut --> [*]
  CallbackSignatureFailed --> [*]
  CallbackFailed --> [*]
  CallbackCapacityWaitFailed --> [*]
  ProverStartSuperseded --> [*]
```

`VerifyImageSignature` は `image-signature-gate` Lambda を呼び出し、ECS で実行する prover image の署名状態を確認します。
署名状態が `COMPLETE` の場合だけ semaphore 取得に進みます。
イメージ署名の考え方は [イメージ署名](image-signing.md) を参照してください。

`AcquireProverSlot` は DynamoDB-backed semaphore で `RunProver` への同時進入数を制限します。
capacity 競合は Step Functions 内で待機 / retry され、この間の user-visible finalization state は `pending` のままです。
slot 取得後、`MarkProverStarted` が `finalization-writer` Lambda を呼び、store guard を通過した場合だけ `running` と `startedAt` を記録します。
この guard により、cancel 済みまたは superseded された execution は `RunProver` に進まず slot を解放して終了します。

`RunProver` は ECS Fargate task を `ecs:runTask.sync` で起動します。
Step Functions は task の完了を待ち、slot を解放したうえで成功、timeout、その他の失敗を `finalization-writer` Lambda に callback します。

通常の slot 解放は state machine 内の `ReleaseAfterSuccess` / `ReleaseAfterTimeout` / `ReleaseAfterFailure` が担います。
`semaphore-janitor` Lambda はその補償経路です。
Step Functions の terminal status event で owner 解放を試み、さらに 30 分ごとの sweep で prover task timeout に 15 分を加えた期間より古い owner を確認します。
sweep は Step Functions execution がまだ `RUNNING` なら owner を保持し、terminal または存在しない execution だけを条件付き更新で解放します。

## ECS Fargate task

ECS Fargate task は一回限りの証明生成 job です。
ブラウザや外部利用者に直接公開される endpoint ではありません。

task には Step Functions から次のような session 固有の入力が渡されます。

| 環境変数                                | 説明                                     |
| --------------------------------------- | ---------------------------------------- |
| `INPUT_S3_BUCKET` / `INPUT_S3_KEY`      | API handler が保存した zkVM 入力の場所   |
| `OUTPUT_S3_BUCKET` / `OUTPUT_S3_PREFIX` | bundle と sibling artifact の保存先      |
| `EXPECTED_IMAGE_ID`                     | 実行する guest image と照合する Image ID |

コンテナの entrypoint は次の順序で処理します。

1. private S3 から `input.json` を取得する。
2. 入力 JSON の必須フィールドを検証する。
3. zkVM host binary を実行する。
4. host output から `journal.json` を構築する。
5. `public-input.json`、`election-manifest.json`、`close-statement.json` を構築する。
6. `journal.json` と公開監査アーティファクト の method version、input commitment、選挙情報が一致することを検証する。
7. `receipt.json`、`journal.json`、`public-input.json`、`election-manifest.json`、`close-statement.json` だけを含む `bundle.zip` を作る。
8. `bundle.zip` と sibling artifacts を private S3 にアップロードする。

`RISC0_DEV_MODE` が有効な receipt は production STARK proof ではなく、production 証明を扱う runtime では成功証明として説明しません。

## Artifact 境界

非同期プローバーの S3 bucket は private proof artifact storage です。
ブラウザは S3 に直接アクセスしません。

`bundle.zip` に含まれる非同期 bundle の公開可能 artifact は次です。

| ファイル                 | 内容                                 |
| ------------------------ | ------------------------------------ |
| `receipt.json`           | zkVM host の receipt wrapper         |
| `journal.json`           | zkVM guest の公開出力                |
| `public-input.json`      | 秘密入力を含まない検証用レコード     |
| `election-manifest.json` | 選挙設定の公開監査用スナップショット |
| `close-statement.json`   | 集計締切時点のログ境界               |

次の artifact は private artifact であり、public `bundle.zip` member ではありません。

| ファイル               | 扱い                                               |
| ---------------------- | -------------------------------------------------- |
| `input.json`           | zkVM witness を含むため private S3 にだけ保存する  |
| `included-bitmap.json` | counted bitmap。`bundle.zip` 外の sibling object   |
| `seen-bitmap.json`     | presented bitmap。`bundle.zip` 外の sibling object |
| `verification.json`    | 検証サービスの protected report artifact           |

`verification.json` は finalize callback 時点で常に存在する artifact ではありません。
後続の verification run が report を生成し、その report key が session の許可された execution scope として保存されている場合に、`/api/verification/bundles/:sessionId/:executionId/report` から capability 保護 API 経由で取得できます。

詳細な bundle allowlist と同期 / 非同期差分は [バンドル構造](../verification/bundle-structure.md) を参照してください。

## Callback と session state

`finalization-writer` Lambda は Step Functions から受け取った callback を session state に反映します。

成功 callback では、writer は S3 上の `bundle.zip` key が `sessions/{sessionId}/{executionId}/bundle.zip` の正準 layout と一致することを確認します。
その後、bundle から receipt、journal、公開監査アーティファクト を復元し、利用可能な sibling bitmap artifact と合わせて finalization result を保存します。

失敗 callback では、署名検証失敗、ECS task 失敗、timeout などの理由を finalization state に保存します。
callback delivery 自体が失敗した場合は Step Functions の bounded retry / failure state に従います。

## Client polling と判定境界

クライアントは `GET /api/sessions/:sessionId/status` を capability 付きで呼び出して進捗を確認します。

```mermaid
stateDiagram-v2
  [*] --> pending: POST /api/finalize accepted
  pending --> running: semaphore slot acquired / MarkProverStarted admitted
  pending --> failed: signature rejection / capacity wait or start failure
  running --> succeeded: callback persisted result
  running --> failed: callback persisted error
  running --> timeout: timeout callback persisted
  succeeded --> [*]
  failed --> [*]
  timeout --> [*]
```

| ステータス  | 説明                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `pending`   | finalize request は受理済みで、SQS dispatch、Step Functions setup、または semaphore capacity wait を待っている |
| `running`   | semaphore slot 取得後に prover 開始が admitted され、ECS task または task-start retry が進行中                 |
| `succeeded` | bundle が復元され、finalization result が session に保存された                                                 |
| `failed`    | 署名検証失敗、prover task 失敗、artifact 復元失敗などで fail-closed に保存された                               |
| `timeout`   | ECS task timeout が callback として保存された                                                                  |

status response は finalization の進捗を示すものです。
検証 UI の最終的な「Verified」判定は、bundle、receipt、journal、公開監査アーティファクト、必要な検証チェックを別途評価して決まります。

## Bundle / report delivery

通常の browser / CLI 経路では、bundle と report は capability 保護 API から取得します（endpoint の一覧は [公開境界 > bundle と report の取得経路](../verification/public-boundary.md#bundle-と-report-の取得経路)）。

どちらの endpoint も session capability を検証します。
さらに、`executionId` は session に保存された現在の `verificationExecutionId` と一致する必要があります。
S3 key が正準 layout と一致しない場合や、許可された execution scope に属さない場合、API は fail-closed に扱います。

`bundle.zip` が大きい場合、bundle endpoint は range response で配信できます。
raw S3 URL や presigned URL は通常の browser / CLI contract ではありません。

## 関連する章

- [AWS runtime boundary](runtime-boundary.md)：AWS 章全体の runtime 境界
- [バンドル構造](../verification/bundle-structure.md)：`bundle.zip` と private artifact の境界
- [イメージ署名](image-signing.md)：Step Functions 内の署名確認
- [Image ID](../zkvm/image-id.md)：prover image と guest Image ID の対応

<!-- source: apps/api/src/server/api/handlers/finalize.ts, apps/api/src/server/api/handlers/sessionStatus.ts, apps/api/src/server/api/handlers/verificationBundles.ts, packages/application/src/finalize/usecases/finalize-async.ts, infra/docker/entrypoint.sh, infra/lambdas/proof-dispatcher, infra/lambdas/finalization-writer, infra/lambdas/semaphore-janitor, infra/terraform/app -->
