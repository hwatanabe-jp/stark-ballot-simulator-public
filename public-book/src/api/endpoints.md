# エンドポイント一覧

この文書は、外部クライアント向け API のレスポンス形状・要件を現行実装ベースで記載します。session-scoped / capability 保護 API も含むため、無認証公開 API ではありません。

## 対象外（内部向け）

以下は内部運用/デバッグ用途のため、この文書の詳細対象外です。

- `GET /api/debug/enable`
- `POST /api/finalize/callback`

## デュアルランタイム構成

API ハンドラはフレームワーク非依存の共通実装で、Next.js と Hono(Lambda) の両方から利用されます。

| ランタイム            | 用途               | 主な入口                                |
| --------------------- | ------------------ | --------------------------------------- |
| Next.js Route Handler | ローカル開発 / SSR | `src/app/api/**/route.ts`               |
| Hono on Lambda        | AWS デプロイ API   | `amplify/functions/hono-api/handler.ts` |

## 外部クライアント向け API 一覧

| メソッド | パス                                                                                                                | 主用途                      | `X-Session-ID` | `X-Session-Capability` |
| -------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------- | ---------------------- |
| `POST`   | [`/api/session`](#post-apisession)                                                                                  | セッション作成              | 不要           | 不要                   |
| `POST`   | [`/api/vote`](#post-apivote)                                                                                        | 投票送信                    | 必須           | 必須                   |
| `GET`    | [`/api/progress`](#get-apiprogress)                                                                                 | ボット投票進捗              | 必須           | 必須                   |
| `POST`   | [`/api/finalize`](#post-apifinalize)                                                                                | 集計/証明生成               | 必須           | 必須                   |
| `POST`   | [`/api/finalize/cancel`](#post-apifinalizecancel)                                                                   | 非同期集計キャンセル        | 必須           | 必須                   |
| `GET`    | [`/api/sessions/:sessionId/status`](#get-apisessionssessionidstatus)                                                | 非同期集計ステータス        | 不要           | 必須                   |
| `GET`    | [`/api/verify`](#get-apiverify)                                                                                     | 検証ペイロード取得          | 必須           | 必須                   |
| `POST`   | [`/api/verification/run`](#post-apiverificationrun)                                                                 | STARK 検証実行              | 必須           | 必須                   |
| `GET`    | [`/api/verification/bundles/:sessionId/:executionId`](#get-apiverificationbundlessessionidexecutionid)              | バンドル ZIP 取得           | 不要           | 必須                   |
| `GET`    | [`/api/verification/bundles/:sessionId/:executionId/report`](#get-apiverificationbundlessessionidexecutionidreport) | 検証レポート取得            | 不要           | 必須                   |
| `GET`    | [`/api/bulletin`](#get-apibulletin)                                                                                 | 掲示板一覧（inspection）    | 必須           | 必須                   |
| `GET`    | [`/api/bulletin/:voteId/proof`](#get-apibulletinvoteidproof)                                                        | 最小包含証明                | 必須           | 必須                   |
| `GET`    | [`/api/bulletin/consistency-proof`](#get-apibulletinconsistency-proof)                                              | 整合性証明（tooling）       | 必須           | 必須                   |
| `GET`    | [`/api/botdata/:id`](#get-apibotdataid)                                                                             | ボット投票データ（tooling） | 必須           | 必須                   |
| `GET`    | [`/api/bitmap-proof`](#get-apibitmap-proof)                                                                         | ビットマップ証明材料        | 必須           | 必須                   |
| `GET`    | [`/api/sth`](#get-apisth)                                                                                           | STH スナップショット        | 必須           | 必須                   |
| `GET`    | [`/api/zkvm-input-hash`](#get-apizkvm-input-hash)                                                                   | zkVM 入力コミットメント     | 不要           | 必須                   |

## 共通の実装上の注意

### ミドルウェア構成

ミドルウェアは「全リクエスト共通の固定チェーン」ではなく、エンドポイント実装ごとに必要な検証を呼び出す方式です。セッションヘッダーの要否は上記一覧テーブルを参照してください。

| 区分                                     | 代表エンドポイント                                                                                                            | Turnstile    | レート制限       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- |
| セッション作成                           | `POST /api/session`                                                                                                           | 環境設定次第 | セッション作成用 |
| 投票                                     | `POST /api/vote`                                                                                                              | あり         | 投票用           |
| 集計                                     | `POST /api/finalize`                                                                                                          | あり         | zkVM 用          |
| 非同期集計キャンセル                     | `POST /api/finalize/cancel`                                                                                                   | なし         | キャンセル専用   |
| 検証実行                                 | `POST /api/verification/run`                                                                                                  | なし         | zkVM 用          |
| 読み取り（セッションスコープ）           | `GET /api/progress`, `GET /api/bulletin*`, `GET /api/botdata/:id`, `GET /api/bitmap-proof`, `GET /api/sth`, `GET /api/verify` | なし         | なし             |
| 読み取り（path/query で session を指す） | `GET /api/sessions/:sessionId/status`, `GET /api/verification/bundles/...`, `GET /api/zkvm-input-hash`                        | なし         | なし             |

### 共通セッションエラー（ヘッダースコープ）

`X-Session-ID` / `X-Session-Capability` をヘッダーで受け取る session-scoped エンドポイントは、session/capability 失敗時に以下の共通エラーを返します。各エンドポイントの「主なエラー」欄ではこれらを省略し、固有エラーのみ記載します。

- `SESSION_ID_REQUIRED` (`400`)
- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `SESSION_NOT_FOUND` (`404`)

パス/クエリで session を指定するエンドポイント（`/api/sessions/:sessionId/status`, `/api/verification/bundles/...`, `/api/zkvm-input-hash`）も capability 検証は共通ですが、session 特定エラーの形式が異なるため、各エンドポイントで個別に記載します。

### ボディサイズ制限

共通 JSON パーサーを使うエンドポイントは `API_REQUEST_BODY_LIMIT_BYTES`（既定 16 KiB）を超えると `PAYLOAD_TOO_LARGE` (`413`) を返します。

例外:

- `POST /api/finalize/cancel` は現状 `request.json()` を直接使うため、この共通サイズ制限の対象外です。JSON 不正や payload 不正は handler 固有の `400` を返します。

### エラーレスポンスの形式

多くのエンドポイントは `errorResponse(...)` を通して以下の形式を返します。

- `error`（エラーコード）
- `message`（メッセージ）
- `statusCode`（HTTP ステータス）
- 必要に応じて `details` など

以下のエンドポイントは、session/capability 失敗時は標準形式、handler 内部の個別検証では `{ error: "..." }` 系の独自形式を返します。

- `POST /api/finalize/cancel`
- `GET /api/sessions/:sessionId/status`
- `GET /api/bulletin/consistency-proof`
- `GET /api/bitmap-proof`
- `GET /api/zkvm-input-hash`

### 現行 response で返さない legacy フィールド

以下は過去の public response に存在したものの、現行の `POST /api/finalize`（同期）および `GET /api/verify` のレスポンスには含まれません。旧クライアントや旧ドキュメントが参照している場合は更新してください。

- バンドル/レポート URL 系: `verificationBundleUrl`, `verificationReportUrl`
- S3 メタデータ系: `s3BundleUrl`, `s3BundleKey`, `s3UploadedAt`, `s3BundleExpiresAt`
- カウント互換エイリアス: `missingIndices`, `invalidIndices`, `countedIndices`, `excludedCount`

バンドルとレポートの取得は `verificationExecutionId` を識別子に `/api/verification/bundles/:sessionId/:executionId` および同 `/report` を組み立てます。

---

## 基本フロー API

### `POST /api/session`

新規セッションを作成します。`X-Session-ID` は不要です。

レスポンス（`200`）:

- `data.sessionId`
- `data.electionId`
- `data.electionConfigHash`
- `data.logId`
- `data.contractGeneration`
- `data.capabilityToken`

備考:

- `SESSION_CREATE_TURNSTILE_REQUIRED=1` の場合、`turnstileToken` が必要です。

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

主なエラー: 共通セッションエラー（ヘッダースコープ）のみ。

### `POST /api/finalize`

集計と証明生成を開始します。同期/非同期の 2 形態があります。

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

- バンドル/レポート取得の識別子は `verificationExecutionId` です。クライアントは自身の `sessionId` と `verificationExecutionId` から `/api/verification/bundles/:sessionId/:executionId` および同 `/report` を構築します。

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

handler 固有エラー（独自形式）:

- `404`: Async finalization disabled
- `400`: Invalid JSON body / payload 不正
- `409`: 現在状態ではキャンセル不可
- `501`: ストアが cancellation 非対応

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

---

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

---

## バンドル取得 API

両エンドポイントとも `X-Session-Capability` ヘッダーによる capability 保護が必須です。
S3 配信条件が揃っている場合（対象 artifact が S3 にアップロード済みで、`USE_S3=true` または Lambda ランタイム）、`302` で短命な presigned URL にリダイレクトします。

### `GET /api/verification/bundles/:sessionId/:executionId`

秘密データを含まない配布対象アーカイブ `bundle.zip` を返します。

レスポンス:

- `200`: ZIP バイナリ
- `302`: S3 presigned URL へリダイレクト

主なエラー:

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `400`: パラメータ不正
- `404`: バンドル未検出
- `500`: ダウンロード URL 生成失敗 / 読み込み失敗

### `GET /api/verification/bundles/:sessionId/:executionId/report`

検証レポート `verification.json` を返します。非公開レポートであり、配布対象アーカイブ `bundle.zip` には含まれません。

レスポンス:

- `200`: JSON
- `302`: S3 presigned URL へリダイレクト

主なエラー:

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `400`: パラメータ不正
- `404`: レポート未検出
- `500`: ダウンロード URL 生成失敗 / 読み込み失敗

---

## 掲示板 API

### `GET /api/bulletin`

掲示板一覧を返します。

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

- `/verify` の最終判定は内部チェックパイプライン（`recorded_consistency_proof` を含む）で行うため、この HTTP エンドポイントは検証ツール・点検用途として扱います。

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

- `400`: `oldSize` / `newSize` 欠落・不正・範囲外、掲示板未初期化、proof 生成失敗
- `500`: consistency proof 生成中の内部エラー

### `GET /api/botdata/:id`

ボット投票（`1..63`）のデータと証明を返します。

補足:

- 将来の bot verification UI の building block であり、現行 `/verify` ページの最終判定には参加しません

要件:

- セッション finalized 必須

レスポンス（`200`）:

- `data.id`
- `data.vote`
- `data.random`
- `data.commitment`
- `data.voteId`
- `data.timestamp`
- `data.proof`（`leafIndex`, `merklePath`, `treeSize`, `bulletinRootAtCast`）

主なエラー:

- `INVALID_BOT_ID` (`400`)
- `SESSION_NOT_FINALIZED` (`400`)
- `BOT_DATA_NOT_FOUND` (`404`)
- `INTERNAL_ERROR` (`500`; CT proof を組み立てられない場合を含む)

---

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

要件:

- クエリ: `sessionId` 必須
- ヘッダー: `X-Session-Capability` 必須
- クエリ: `includeData` 任意（`true` / `1` / `yes` で有効）
- `includeData=true` は debug authorization が必要

レスポンス（`200`）:

- `inputCommitment`
- `data`（`includeData` 有効時のみ）

主なエラー:

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)

handler 固有エラー（独自形式）:

- `INVALID_REQUEST` (`400`)
- `SESSION_NOT_FOUND` (`404`)
- `SESSION_NOT_FINALIZED` (`400`)
- `CT_PROOF_UNAVAILABLE` (`400`)
- `INCLUDE_DATA_FORBIDDEN` (`403`)
- `INTERNAL_ERROR` (`500`)

## 関連する章

- [セッションライフサイクル](./session-lifecycle.md) — セッション・capability・finalize の状態遷移
- [チェック一覧](../verification/checks-catalog.md) — 各 API レスポンスがどの検証チェックに使われるか
- [用語集](../appendix/glossary.md) — `voteReceipt`、`bundle.zip`、`STH`、capability などの用語定義

<!-- source: src/server/api/routes/registry.ts, src/server/api/handlers/*, src/lib/validation/apiSchemas.ts, src/server/api/middleware/session.ts, src/server/api/middleware/rateLimit.ts, src/server/api/middleware/turnstile.ts, src/lib/store/mockSessionStore.ts, src/lib/store/fileMockSessionStore.ts, src/lib/store/amplifySessionStore.ts -->
