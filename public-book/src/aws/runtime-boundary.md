<a id="aws-runtime-boundary"></a>

# AWS runtime 境界

このページは、AWS 章で前提にする公開仕様上の runtime 境界を定義します。
ここでいう runtime は、ブラウザから投票、集計、検証を実行するための target 構成です。
扱わない範囲は末尾の [このページで扱わないもの](#このページで扱わないもの) にまとめます。

## Semantic runtime profiles

server は `RUNTIME_PROFILE`、browser build は `VITE_RUNTIME_PROFILE` で実行意図を
一度だけ選びます。server resolver は adapter construction より前に profile を解決し、
store、proof evidence、finalization、artifact backend、rate limit、Turnstile posture
の混在を拒否します。

| Profile                     | Store  | Proof evidence | Finalization | Artifact | 主な用途                                      |
| --------------------------- | ------ | -------------- | ------------ | -------- | --------------------------------------------- |
| `local-demo`                | memory | mock           | sync         | local    | Vite browser mock API と高速 UI 開発          |
| `static-mock-e2e`           | file   | mock           | sync         | local    | production-build static Hono / Playwright E2E |
| `local-proof-development`   | memory | development    | sync         | local    | Rust host 接続を使う fake receipt smoke       |
| `local-proof-production`    | memory | production     | sync         | local    | local production STARK proof                  |
| `target-aws-async`          | Dynamo | production     | async        | S3       | Lambda/SQS/Step Functions/ECS target runtime  |
| `target-aws-async-quiesced` | Dynamo | production     | async        | S3       | develop recovery 時の public admission 封鎖   |

target profile は production proof、DynamoDB、S3、async orchestration、Dynamo
rate limit、bypass 不可を一体として選びます。quiesced profile は develop recovery
専用で browser public projection には公開しません。secret 値と外部 resource identifier
は profile 名に埋め込まず、target runtime の参照入力として別に検証します。

## 公開仕様として扱う境界

### Frontend

ブラウザアプリケーションは Vite / React Router で生成された静的 frontend です。
ビルド成果物は CloudFront から配信され、origin は private S3 bucket です。
S3 frontend origin は直接公開せず、CloudFront が静的 asset と browser route fallback の入口になります。

ブラウザからの API 呼び出しは、通常 same-origin の `/api/*` として CloudFront に送られます。
CloudFront は静的 asset を S3 origin へ、`/api/*` を API Gateway origin へ routing します。
これにより、frontend と API の公開入口は同じ origin 上に投影されます。

Develop target では、静的 frontend と API の両方を含む CloudFront behavior を operator / tester 向けの signed-cookie gate で保護します。
署名用の秘密鍵は KMS 内で管理し、対応する公開鍵だけを CloudFront trusted key group に登録します。
この gate は環境全体への入口を制限するもので、session-scoped な capability token の代わりにはなりません。

### API

API Gateway は `/api/*` を受け取り、Lambda 上の Hono runtime adapter に渡します。
実際の wire-level API surface は `packages/api-contract/src/routes/inventory.ts` が正準です。
`apps/api/src/server/api/routes/definitions.ts` はその contract を runtime mode 別に投影し、Hono は
contract で定義された route と handler を AWS runtime に接続します。

Target runtime では、CloudFront が API origin への転送時に origin-verification header を付与し、Hono はその値が欠落または不一致のリクエストを拒否します。
したがって、API Gateway の直接 URL は通常の browser / CLI contract ではなく、認可された CloudFront origin path が外側の admission boundary です。

その内側で、session-scoped な現行 route は path の `sessionId` と `X-Session-Capability` を照合します（対象 route と header の契約は [API リファレンス > セッション capability](../api/endpoints.md#セッション-capability)）。

### Data store

DynamoDB は session、vote、finalization state、verification run state、rate-limit state、prover semaphore state などの runtime state を保持します。
ブラウザが DynamoDB に直接アクセスする経路はありません。
API Lambda と worker Lambda が、それぞれの IAM role に基づく最小権限で DynamoDB を読み書きします。

### Async prover

長時間かかる STARK 証明生成は、非同期 runtime に分離されます。
非同期モードの `POST /api/sessions/:sessionId/finalizations` は work item を SQS に登録します。
Step Functions は署名確認や concurrency semaphore などの gate を通過した場合だけ ECS Fargate task を起動し、zkVM host が証明と公開監査用 artifact を生成します。
生成結果は finalization-writer Lambda が finalization record に反映し、ブラウザは
`GET /api/sessions/:sessionId/finalizations/current` を capability 付きでポーリングします。
パイプラインの詳細は [非同期プローバー](async-prover.md) を参照してください。

### Verification worker

Target runtime の `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification` は、
path と session capability、current succeeded finalization、finalization-scoped な bundle locator、
expected Image ID を確認したうえで verification work を durable queue に登録します。
`verification-worker` Lambda は private S3 bucket から `bundle.zip` を取得して
`verifier-service` で STARK レシートを検証します。検証結果は
`sessionId` と `finalizationId` で scope された verification result record に、S3 の
bundle/report locator は分離された AWS delivery metadata に保存されます。
ブラウザは通常の API flow から検証状態を取得し、worker や S3 に直接アクセスしません（検証内容は [検証サービス](../zkvm/verifier-service.md) を参照）。

### Proof artifacts

Proof artifact storage は private S3 bucket です。
保護対象 artifact を public `bundle.zip` に含めない分類と除外リストは、[公開境界](../verification/public-boundary.md) に従います。
`bundle.zip` と report（`verification.json`）の通常配信は capability 保護 API 経由で、raw S3 URL や presigned URL は通常の browser / CLI contract ではありません（取得経路とアクセスポリシーは [公開境界 > bundle と report の取得経路](../verification/public-boundary.md#bundle-と-report-の取得経路)）。

## このページで扱わないもの

この runtime boundary は公開仕様としての責務分担に限定します。
次の情報は扱いません。

- AWS account ID、具体的な ARN、bucket 名、secret 名
- secret / config handoff の手順や証跡
- post-merge Plan 02 / Plan 03 の完了条件や blocking status
- production DNS cutover の進捗
- CodePipeline / CodeBuild の詳細な承認証跡
- legacy AWS account deletion の状態

## 関連する章

- [現行構成とサービス一覧](design-and-services.md)：AWS service ごとの責務
- [トポロジー](topology.md)：CloudFront、API Gateway、Lambda、DynamoDB、S3、SQS、Step Functions、ECS の通信経路
- [非同期プローバー](async-prover.md)：SQS / Step Functions / ECS Fargate による証明生成
- [可観測性設計](observability.md)：runtime を横断する構造化ログ、検出、相関、通知境界
- [バンドル構造](../verification/bundle-structure.md)：`bundle.zip` と private artifact の境界

<!-- source: packages/runtime-config/src/env/runtimeProfile.ts, packages/api-contract/src/routes/inventory.ts, apps/api/src/server/api/handlers/verificationRun.ts, apps/api/src/server/api/handlers/verificationBundles.ts, infra/lambdas/verification-worker/handler.ts, public-book/src/aws/async-prover.md, public-book/src/verification/bundle-structure.md -->
