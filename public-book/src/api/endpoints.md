# エンドポイント一覧

この文書は、外部クライアント向け API のレスポンス形状と要件を現行実装ベースで記載します。
session-scoped API と capability 保護 API も含むため、無認証公開 API ではありません。

## 対象外の retired route と内部向け route

`GET /api/debug/enable`、`GET /api/botdata/:id`、`POST /api/finalize/callback`、`GET /api/zkvm-input-hash?includeData=<truthy>` は通常のブラウザと CLI の契約ではありません。
この文書では active API として扱わず、詳細な request/response contract も定義しません。
各 route の位置づけは [Retired route と internal surface の扱い](#retired-route-と-internal-surface-の扱い) を参照してください。

## API runtime 構成

API ハンドラはフレームワーク非依存の共通実装で、ローカル static Hono server と AWS Lambda runtime から利用されます。

| ランタイム         | 用途                | 主な入口                              |
| ------------------ | ------------------- | ------------------------------------- |
| Static Hono server | ローカルと test API | `scripts/dev/static-hono-server.ts`   |
| Hono on Lambda     | AWS Lambda API      | `infra/lambdas/public-api/handler.ts` |

## Active browser と CLI API 一覧

この一覧は通常のブラウザと CLI flow から使う active API です。
ここでいう `public` は「秘密を含まず第三者検証に使える」という機密性の分類であり、無認証公開を意味しません（定義は [公開境界](../verification/public-boundary.md)）。
session-scoped API と bundle/report API は capability 保護が必須です。
「セッションヘッダー」列の「両方必須」は `X-Session-ID` と `X-Session-Capability` の両方、「capability のみ」は `X-Session-Capability` だけを要求します。

| メソッド | パス                                                                                                                | 主用途                             | セッションヘッダー |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------ |
| `POST`   | [`/api/session`](#post-apisession)                                                                                  | セッション作成                     | 不要               |
| `POST`   | [`/api/vote`](#post-apivote)                                                                                        | 投票送信                           | 両方必須           |
| `GET`    | [`/api/progress`](#get-apiprogress)                                                                                 | ボット投票進捗                     | 両方必須           |
| `POST`   | [`/api/finalize`](#post-apifinalize)                                                                                | 集計/証明生成                      | 両方必須           |
| `POST`   | [`/api/finalize/cancel`](#post-apifinalizecancel)                                                                   | 非同期集計キャンセル               | 両方必須           |
| `GET`    | [`/api/sessions/:sessionId/status`](#get-apisessionssessionidstatus)                                                | 非同期集計ステータス               | capability のみ    |
| `GET`    | [`/api/verify`](#get-apiverify)                                                                                     | 検証ペイロード取得                 | 両方必須           |
| `POST`   | [`/api/verification/run`](#post-apiverificationrun)                                                                 | STARK 検証実行                     | 両方必須           |
| `GET`    | [`/api/verification/bundles/:sessionId/:executionId`](#get-apiverificationbundlessessionidexecutionid)              | バンドル ZIP 取得                  | capability のみ    |
| `GET`    | [`/api/verification/bundles/:sessionId/:executionId/report`](#get-apiverificationbundlessessionidexecutionidreport) | 検証レポート取得                   | capability のみ    |
| `GET`    | [`/api/bulletin/:voteId/proof`](#get-apibulletinvoteidproof)                                                        | 最小包含証明                       | 両方必須           |
| `GET`    | [`/api/bitmap-proof`](#get-apibitmap-proof)                                                                         | ビットマップ証明材料               | 両方必須           |
| `GET`    | [`/api/sth`](#get-apisth)                                                                                           | STH スナップショット               | 両方必須           |
| `GET`    | [`/api/zkvm-input-hash`](#get-apizkvm-input-hash)                                                                   | zkVM input commitment（hash-only） | capability のみ    |

## Active owner-scoped inspection と tooling API

以下は active route ですが、通常のブラウザと CLI の主導線ではなく、owner-scoped inspection や検証 tooling 用の surface です。
private inspection route や debug 系 route とは分離して扱います。

| メソッド | パス                                                                   | 主用途                                    | セッションヘッダー |
| -------- | ---------------------------------------------------------------------- | ----------------------------------------- | ------------------ |
| `GET`    | [`/api/bulletin`](#get-apibulletin)                                    | retained owner-scoped bulletin inspection | 両方必須           |
| `GET`    | [`/api/bulletin/consistency-proof`](#get-apibulletinconsistency-proof) | RFC6962 整合性証明 tooling                | 両方必須           |

## 共通の実装上の注意

### ミドルウェア構成

ミドルウェアは「全リクエスト共通の固定チェーン」ではなく、エンドポイント実装ごとに必要な検証を呼び出す方式です。
セッションヘッダーの要否は上記一覧テーブルを参照してください。

| 区分                                     | 代表エンドポイント                                                                                                  | Turnstile                                             | レート制限       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------- |
| セッション作成                           | `POST /api/session`                                                                                                 | production では server-side abuse protection を有効化 | セッション作成用 |
| 投票                                     | `POST /api/vote`                                                                                                    | あり                                                  | 投票用           |
| 集計                                     | `POST /api/finalize`                                                                                                | あり                                                  | zkVM 用          |
| 非同期集計キャンセル                     | `POST /api/finalize/cancel`                                                                                         | なし                                                  | キャンセル専用   |
| 検証実行                                 | `POST /api/verification/run`                                                                                        | なし                                                  | zkVM 用          |
| 読み取り（セッションスコープ）           | `GET /api/progress`, `GET /api/bulletin*`, `GET /api/bitmap-proof`, `GET /api/sth`, `GET /api/verify`               | なし                                                  | なし             |
| 読み取り（path/query で session を指す） | `GET /api/sessions/:sessionId/status`, `GET /api/verification/bundles/...`, `GET /api/zkvm-input-hash`（hash-only） | なし                                                  | なし             |

### 共通セッションエラー（ヘッダースコープ）

`X-Session-ID` と `X-Session-Capability` をヘッダーで受け取る session-scoped エンドポイントは、session/capability 失敗時に以下の共通エラーを返します。
各エンドポイントの「主なエラー」欄ではこれらを省略し、固有エラーのみ記載します。

- `SESSION_ID_REQUIRED` (`400`)
- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `SESSION_NOT_FOUND` (`404`)

パス/クエリで session を指定するエンドポイント（`/api/sessions/:sessionId/status`, `/api/verification/bundles/...`, `/api/zkvm-input-hash`）も capability 検証は共通ですが、session 特定エラーの形式が異なるため、各エンドポイントで個別に記載します。

### ボディサイズ制限

共通 JSON パーサーを使うエンドポイントは `API_REQUEST_BODY_LIMIT_BYTES`（既定 16 KiB）を超えると `PAYLOAD_TOO_LARGE` (`413`) を返します。

`POST /api/finalize/cancel` も共通 JSON パーサーを使うため、この制限の対象です。

### エラーレスポンスの形式

多くのエンドポイントは `errorResponse(...)` を通して以下の形式を返します。

- `error`（エラーコード）
- `message`（メッセージ）
- `statusCode`（HTTP ステータス）
- 必要に応じて `details` など

以下のエンドポイントは、session/capability 失敗時は標準形式、handler 内部の個別検証では `{ error: "..." }` 系の独自形式を返す場合があります。

- `GET /api/sessions/:sessionId/status`
- `GET /api/bulletin/consistency-proof`
- `GET /api/bitmap-proof`
- `GET /api/zkvm-input-hash`

### 現行 response で返さない legacy フィールド

以下は過去の public response に存在したものの、現行の `POST /api/finalize`（同期）および `GET /api/verify` のレスポンスには含まれません。
旧クライアントや旧ドキュメントが参照している場合は更新してください。

- バンドルとレポート URL 系: `verificationBundleUrl`, `verificationReportUrl`
- S3 メタデータ系: `s3BundleUrl`, `s3BundleKey`, `s3UploadedAt`, `s3BundleExpiresAt`
- カウント互換エイリアス: `missingIndices`, `invalidIndices`, `countedIndices`, `excludedCount`

バンドルとレポートの取得は `verificationExecutionId` を識別子に `/api/verification/bundles/:sessionId/:executionId` および同 `/report` を組み立てます。

## 基本フロー API

### `POST /api/session`

新規セッションを作成します。
`X-Session-ID` は不要です。

レスポンス（`200`）:

- `data.sessionId`
- `data.electionId`
- `data.electionConfigHash`
- `data.logId`
- `data.contractGeneration`
- `data.capabilityToken`

備考:

- local/mock では設定により `turnstileToken` を省略できます。
- これは開発用 bypass であり、production 契約ではありません。
- production では `POST /api/session` に Turnstile などの server-side abuse protection を有効化します。

### `POST /api/vote`

ユーザー投票を保存し、ボット投票を非同期開始します。

要件:

- ヘッダー: `X-Session-ID` 必須、`X-Session-Capability` 必須
- ボディ: `commitment`, `vote`, `rand`（`turnstileToken` は開発設定により省略可）
- Turnstile 検証あり
- 投票用レート制限あり

レスポンス（`200`）:

- `data.voteId`
- `data.commitment`
- `data.bulletinIndex`
- `data.bulletinRootAtCast`
- `data.timestamp`

主なエラー:

- `CAPTCHA_FAILED` (`403`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)
- `ALREADY_VOTED` (`400`)
- `SESSION_FINALIZED` (`400`)
- `INVALID_REQUEST` (`400`; リクエスト形式不正)
- `INVALID_COMMITMENT` (`400`)
- `DUPLICATE_VOTE` (`409`)
- `PAYLOAD_TOO_LARGE` (`413`)

### `GET /api/progress`

投票進捗を取得します。

レスポンス（`200`）:

- `data.count`
- `data.total`
- `data.completed`
- `data.userVoted`
- `data.finalized`

主なエラー:

- 共通セッションエラー（ヘッダースコープ）のみ

### `POST /api/finalize`

集計と証明生成を開始します。
同期と非同期の 2 形態があります。

要件:

- ヘッダー: `X-Session-ID` 必須、`X-Session-Capability` 必須
- ボディ: `scenarioId`（`S0`-`S5`）, `turnstileToken`（環境により必須）
- Turnstile 検証あり
- zkVM レート制限あり

レスポンス（`200`, 同期）:

- `data.sessionId`
- `data.tally`
- `data.bulletinRoot`
- `data.verifiedTally`
- `data.voteReceipt`
- `data.receipt`
- `data.receiptPublication`（保存時）
- `data.imageId`
- `data.userVote`
- `data.missingSlots`
- `data.invalidPresentedSlots`
- `data.rejectedRecords`
- `data.totalExpected`
- `data.treeSize`
- `data.excludedSlots`
- `data.sthDigest`
- `data.seenBitmapRoot`（条件付き）
- `data.includedBitmapRoot`
- `data.inputCommitment`
- `data.seenIndicesCount`
- `data.journal`
- `data.verificationStatus`
- `data.verificationReport`（条件付き）
- `data.verificationExecutionId`（条件付き）
- `data.tamperSummary`（条件付き）

補足:

- バンドルとレポート取得の識別子は `verificationExecutionId` です。
- クライアントは自身の `sessionId` と `verificationExecutionId` から `/api/verification/bundles/:sessionId/:executionId` および同 `/report` を構築します。

レスポンス（`202`, 非同期）:

- `executionId`
- `statusUrl`
- `state`
- `queue`（`null` の場合あり）

主なエラー:

- `CAPTCHA_FAILED` (`403`)
- `INVALID_REQUEST` (`400`)
- `VERIFICATION_FAILED` (`400`; CT proof unavailable)
- `USER_NOT_VOTED` (`400`)
- `VOTING_NOT_COMPLETE` (`400`)
- `SESSION_ALREADY_FINALIZED` (`400`)
- `ZKVM_RATE_LIMIT_EXCEEDED` (`429`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)
- `PAYLOAD_TOO_LARGE` (`413`)
- `Invalid ImageID` (`400`; 独自形式 `{ error: "Invalid ImageID", details: { expected, actual } }`)

### `POST /api/finalize/cancel`

進行中の非同期集計をキャンセルします。

要件:

- `FINALIZE_ASYNC_MODE=true` のときのみ有効
- ヘッダー: `X-Session-ID`（`x-session-id` も受理）
- ヘッダー: `X-Session-Capability` 必須
- ボディ: `executionId` 必須、`reason` 任意
- キャンセル専用レート制限あり

レスポンス（`200`）:

- `state`

主なエラー:

- `GLOBAL_LIMIT_EXCEEDED` (`503`)
- `PAYLOAD_TOO_LARGE` (`413`)
- `INVALID_REQUEST` (`400`; JSON 不正または payload 不正)
- `ASYNC_FINALIZATION_DISABLED` (`404`)
- `FINALIZATION_NOT_CANCELLABLE` (`409`)
- `CANCELLATION_UNSUPPORTED` (`501`)

### `GET /api/sessions/:sessionId/status`

非同期集計の状態を返します。

要件:

- パスパラメータ `sessionId` 必須
- ヘッダー: `X-Session-Capability` 必須

レスポンス（`200`）:

- `sessionId`
- `finalizationState`（`null` の場合あり）
- `artifactState`（unsupported/corrupt finalized artifact 時のみ）
- `queue`（`null` の場合あり）
- `progress`（条件付き）
- `finalizationResult`（`null` の場合あり）
- `stepFunctions`（`null` の場合あり）
- `asyncFinalizationMode`（`enabled` / `disabled`）

主なエラー:

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `SESSION_NOT_FOUND` (`404`; 標準形式)

handler 固有エラー（独自形式）:

- `400`: Session ID is required

## 検証 API

### `GET /api/verify`

検証画面向けの統合ペイロードを返します。

要件:

- クエリ: `includeJournal=1`（任意）

レスポンス（`200`）:

- `data.electionId`
- `data.electionConfigHash`
- `data.logId`
- `data.tally`
- `data.bulletinRoot`
- `data.scenarioId`
- `data.verificationStatus`
- `data.verificationReport`（条件付き）
- `data.verificationSteps` / `data.verificationChecks`
- `data.imageId`
- `data.tamperDetected`
- `data.verifiedTally`
- `data.missingSlots`
- `data.invalidPresentedSlots`
- `data.rejectedRecords`
- `data.totalExpected`
- `data.treeSize`
- `data.excludedSlots`
- `data.sthDigest`
- `data.seenBitmapRoot`（条件付き）
- `data.includedBitmapRoot`
- `data.inputCommitment`
- `data.seenIndicesCount`（条件付き）
- `data.journalStatus`
- `data.journal`（`includeJournal=1` のとき）
- `data.voteReceipt`（条件付き）
- `data.userVote`
- `data.botVotesSummary`（条件付き）
- `data.verificationExecutionId`（条件付き）
- `data.tamperSummary`（条件付き）

[fail-closed](../appendix/glossary.md#fail-closed) 応答:

- `verificationStatus` が許容セット外の場合、取得可能な current-generation finalized session では `200` の通常 `data` payload を返し、`data.verificationStatus` を `failed` に正規化します。
- unsupported/corrupt finalized artifact の場合は `200` で `{ error, message, artifactState }` を返し、`data` payload は含みません。

補足:

- 署名付き URL の再発行はこのエンドポイントでは扱わず、capability 保護された `/api/verification/bundles/...` 系ルートの責務です。

主なエラー:

- `SESSION_NOT_FINALIZED` (`400`)
- `USER_NOT_VOTED` (`400`)

### `POST /api/verification/run`

サーバー側で STARK レシート検証を実行します。

要件:

- ボディ: JSON オブジェクト（通常は空オブジェクト `{}`）
- zkVM レート制限あり

レスポンス（`200`）:

- `data.verificationStatus`（`success` / `failed` / `dev_mode` / `not_run` / `running`）
- `data.verificationExecutionId`
- `data.estimatedDurationMs`
- `data.idempotent`

挙動:

- 既存結果がある場合や実行中の場合は、再実行せず `idempotent: true` を返します。

主なエラー:

- `SESSION_NOT_FINALIZED` (`400`)
- `INVALID_REQUEST` (`400`)
- `ZKVM_RATE_LIMIT_EXCEEDED` (`429`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)
- `PAYLOAD_TOO_LARGE` (`413`)
- `INTERNAL_ERROR` (`500`)

## バンドル取得 API

両エンドポイントとも `X-Session-Capability` ヘッダーによる capability 保護が必須です。
通常のブラウザと CLI の契約は、capability 保護された API からの配信です。
対象 artifact が S3 にある場合も、API がセッション権限、実行 ID、S3 key を検証したうえで S3 から読み出し、API レスポンスとして返します。

### `GET /api/verification/bundles/:sessionId/:executionId`

秘密データを含まない配布対象アーカイブ `bundle.zip` を返します。
S3-backed bundle が大きい場合は `Range` リクエストが必要になり、API は `206 Partial Content` の range response を返します。

レスポンス:

- `200`: ZIP バイナリ
- `206`: S3-backed bundle の range response
- `413`: bundle が大きく、range download が必要

主なエラー:

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `400`: パラメータ不正
- `404`: バンドル未検出
- `416`: invalid `Range` header
- `500`: artifact 読み込み失敗

### `GET /api/verification/bundles/:sessionId/:executionId/report`

検証レポート `verification.json` を返します。
protected report artifact であり、配布対象アーカイブ `bundle.zip` には含まれません。
S3-backed report も API が保護された本文として返します。
現在のインライン上限を超える report は fail-closed で拒否され、raw S3 URL や presigned URL は通常契約として公開されません。

レスポンス:

- `200`: JSON
- `413`: report が認証済みインライン配信の上限を超過

主なエラー:

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `400`: パラメータ不正
- `404`: レポート未検出
- `500`: artifact 読み込み失敗

## 掲示板 API

### `GET /api/bulletin`

掲示板一覧を返します。

補足:

- 現行 retained owner-scoped inspection route です。
- 通常の public browser と CLI の主導線ではなく、owner-scoped inspection や tooling surface として扱います。

要件:

- クエリ: `offset`, `limit`（任意）

レスポンス（`200`）:

- `commitments`
- `bulletinRoot`
- `treeSize`
- `timestamp`
- `rootHistory`（条件付き）
- `nextOffset` / `hasMore`（ページング時）

主なエラー:

- `INVALID_OFFSET` (`400`)
- `INVALID_LIMIT` (`400`)
- `INVALID_REQUEST` (`400`; `details=BULLETIN_STATE_UNAVAILABLE`)

### `GET /api/bulletin/:voteId/proof`

最小形式の包含証明を返します。

要件:

- セッションは finalized 必須
- パス: `voteId`（UUID v4 形式）

アクセス制御:

- 原則は「そのセッションのユーザー投票」のみ
- 例外としてシナリオ `S3`/`S4` では対象ボット票を許可

レスポンス（`200`）:

- `voteId`
- `proof.leafIndex`
- `proof.merklePath`
- `proof.treeSize`
- `proof.bulletinRootAtCast`

キャッシュ:

- `Cache-Control: private, no-store`
- `Vary: X-Session-ID, X-Session-Capability`

主なエラー:

- `INVALID_VOTE_ID` (`400`)
- `SESSION_NOT_FINALIZED` (`400`)
- `VOTE_NOT_FOUND` (`404`)
- `VERIFICATION_FAILED` (`400`; CT proof unavailable)

### `GET /api/bulletin/consistency-proof`

RFC6962 整合性証明を返します。

補足:

- `/verify` の最終判定は内部チェックパイプライン（`recorded_consistency_proof` を含む）で行うため、この HTTP エンドポイントは検証 tooling と点検用途として扱います。

要件:

- クエリ: `oldSize`, `newSize` 必須

レスポンス（`200`）:

- `oldSize`
- `newSize`
- `rootAtOldSize`
- `rootAtNewSize`
- `proofNodes`
- `oldSubtreeHashes` / `appendSubtreeHashes`（条件付き）
- `timestamp`

主なエラー（handler 固有、独自形式）:

- `400`: `oldSize` / `newSize` 欠落、不正、範囲外、掲示板未初期化、proof 生成失敗
- `500`: consistency proof 生成中の内部エラー

## 補助 API

### `GET /api/bitmap-proof`

ビットマップ証明の材料を返します。

要件:

- クエリ: `i`（0 以上整数）必須
- クエリ: `kind` 任意（`included` / `seen`、省略時は `included`）

備考:

- 全ストア実装で sessionId をキーに保存済み bitmap を参照します。
- `included` は counted された index、`seen` は prover に提示された index を対象にします。

レスポンス（`200`）:

- `leafChunk`
- `auditPath`

キャッシュ:

- `ETag` 対応
- `If-None-Match` 一致時 `304`
- `Cache-Control: private, max-age=86400, stale-while-revalidate=3600, immutable`
- `Vary: X-Session-ID, X-Session-Capability`

主なエラー（handler 固有、独自形式）:

- `INVALID_INDEX` (`400`)
- `INVALID_BITMAP_KIND` (`400`)
- `BITMAP_NOT_FOUND` (`404`)
- `INTERNAL_ERROR` (`500`)

### `GET /api/sth`

STH スナップショットを返します。

要件:

- finalized セッションのみ

レスポンス（`200`）:

- `sth.sthDigest`
- `sth.bulletinRoot`
- `sth.treeSize`
- `sth.timestamp`
- `sth.logId`

備考:

- 現行実装の `sth.timestamp` はジャーナル内時刻ではなく、`session.lastActivity` を返します。

主なエラー:

- `SESSION_NOT_FINALIZED` (`404`; このエンドポイント固有の扱い)
- `INTERNAL_ERROR` (`500`; 例: finalized 済みだが journal が欠落している場合)

### `GET /api/zkvm-input-hash`

セッション由来の zkVM 入力コミットメントを返します。
active public contract は hash-only です。

`sessionId` と `X-Session-Capability` で capability 検証し、finalized/current artifact 状態を確認したうえで `inputCommitment` だけを返します。
private input data、raw witness values、vote opening は返しません。
`includeData=true`, `1`, `yes` などの truthy variant は retired private-data variant であり、通常のブラウザと CLI の契約ではありません。

要件:

- クエリ: `sessionId` 必須
- ヘッダー: `X-Session-Capability` 必須
- クエリ: `includeData` は active schema では受理しません

レスポンス（`200`）:

- `inputCommitment`

主なエラー:

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)

handler 固有エラー（独自形式）:

- `INVALID_REQUEST` (`400`)
- `SESSION_NOT_FOUND` (`404`)
- `SESSION_NOT_FINALIZED` (`400`)
- `CT_PROOF_UNAVAILABLE` (`400`)
- `ROUTE_RETIRED` (`410`; truthy `includeData` variant)
- `INTERNAL_ERROR` (`500`)

## Retired route と internal surface の扱い

以下は active browser と CLI contract ではありません。

- `GET /api/debug/enable`: retired debug route。
  現行 Hono route inventory には登録されず、公開 API として説明しません。
- `GET /api/botdata/:id`: retired private inspection route。
  bot vote opening 相当の private data を返し得た legacy surface であり、active external API として扱いません。
  現行 route definitions には登録されず、API contract metadata では `410 ROUTE_RETIRED` 扱いです。
- `POST /api/finalize/callback`: async finalize worker callback 用の internal/operator-only route。
  通常のブラウザと CLI から呼び出す API ではありません。
- `GET /api/zkvm-input-hash?includeData=<truthy>`: retired private-data variant。
  active `GET /api/zkvm-input-hash` は `inputCommitment` のみを返します。

## 関連する章

- [セッションライフサイクル](./session-lifecycle.md): セッション、capability、finalize の状態遷移
- [チェック一覧](../verification/checks-catalog.md): 各 API レスポンスがどの検証チェックに使われるか
- [用語集](../appendix/glossary.md): `voteReceipt`、`bundle.zip`、`STH`、capability などの用語定義

<!-- source: apps/api/src/server/api/routes/definitions.ts, apps/api/src/server/api/handlers/*, packages/api-contract/src/validation/apiSchemas.ts, apps/api/src/server/api/middleware/session.ts, apps/api/src/server/api/middleware/rateLimit.ts, apps/api/src/server/api/middleware/turnstile.ts, packages/aws-adapters/src/store/mockSessionStore.ts, packages/aws-adapters/src/store/fileMockSessionStore.ts, packages/aws-adapters/src/store/dynamoSessionStore.ts -->
