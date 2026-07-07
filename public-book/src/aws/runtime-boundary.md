# AWS runtime boundary

このページは、AWS 章で前提にする公開仕様上の runtime 境界を定義します。
ここでいう runtime は、ブラウザから投票、集計、検証を実行するための target 構成です。
アカウント移行の進捗、秘密値の受け渡し、個別デプロイ承認の証跡は扱いません。

## 公開仕様として扱う境界

### Frontend

ブラウザアプリケーションは Vite / React Router で生成された静的 frontend です。
ビルド成果物は CloudFront から配信され、origin は private S3 bucket です。
S3 frontend origin は直接公開せず、CloudFront が静的 asset と browser route fallback の入口になります。

ブラウザからの API 呼び出しは、通常 same-origin の `/api/*` として CloudFront に送られます。
CloudFront は静的 asset を S3 origin へ、`/api/*` を API Gateway origin へ routing します。
これにより、frontend と API の公開入口は同じ origin 上に投影されます。

### API

API Gateway は `/api/*` を受け取り、Lambda 上の Hono runtime adapter に渡します。
実際の API surface は `apps/api/src/server/api/routes/definitions.ts` の route inventory を中心に定義されます。
Hono はその route inventory を AWS runtime に接続します。

Session-scoped な操作は capability token で保護されます。
`POST /api/vote`、`POST /api/finalize`、`GET /api/verify`、`POST /api/verification/run` などの header-scoped route は、`X-Session-ID` と `X-Session-Capability` の検証を通過した場合だけ処理されます。
`GET /api/sessions/:sessionId/status` や bundle/report delivery などの path-scoped route は、path 上の `sessionId` と `X-Session-Capability` を照合します。

### Data store

DynamoDB は session、vote、finalization state、verification run state、rate-limit state、prover semaphore state などの runtime state を保持します。
ブラウザが DynamoDB に直接アクセスする経路はありません。
API Lambda と worker Lambda が、それぞれの IAM role に基づく最小権限で DynamoDB を読み書きします。

### Async prover

長時間かかる STARK 証明生成は、非同期 runtime に分離されます。
`POST /api/finalize` が非同期モードで受理されると、API は work item を SQS に送り、dispatcher Lambda が Step Functions execution を開始します。
Step Functions は署名確認と concurrency semaphore などの gate を通過したうえで ECS Fargate task を起動し、zkVM host が証明と公開監査用 artifact を生成します。

ECS Fargate task は一回限りの証明生成 job として実行されます。
生成結果は finalization-writer Lambda によって session state に反映されます。
ブラウザは status endpoint を capability 付きでポーリングして進捗を確認します。

### Verification worker

Target runtime の `POST /api/verification/run` は、session capability、finalization state、bundle locator、Image ID を確認したうえで verification work を durable queue に登録します。
verification-worker Lambda は private S3 bucket から `bundle.zip` を取得し、`verifier-service` で STARK receipt を検証します。
検証結果は session state と、必要に応じて protected report artifact として保存されます。
ブラウザは通常の API flow から検証状態を取得し、worker や S3 に直接アクセスしません。

### Proof artifacts

Proof artifact storage は private S3 bucket です。
`input.json`、`verification.json`、`included-bitmap.json`、`seen-bitmap.json` などの private artifact は public `bundle.zip` に含めません。

ここでの `public` / 「公開可能」は「秘密を含まず第三者検証に使える」という分類であり、無認証公開を意味しません（詳細は [公開境界](../verification/public-boundary.md)）。
`bundle.zip` や report の通常配信は、capability-protected API が session、execution ID、artifact locator を検証したうえで S3 から読み出し、API response として返す経路です。
Raw S3 URL や presigned URL は通常の browser / CLI contract ではありません。

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
- [バンドル構造](../verification/bundle-structure.md)：`bundle.zip` と private artifact の境界

<!-- source: public-book/src/aws/topology.md, public-book/src/aws/async-prover.md, public-book/src/verification/bundle-structure.md -->
