# エンドポイント一覧

この章は、ブラウザと CLI から利用する外部向け API の現行 contract を記載します。
パス、request/response schema、公開エラー、認証境界の authority は
`packages/api-contract/src/routes/inventory.ts` と `packages/api-contract/src/schemas/` です。
内部 callback と過去の flat route は public API に含めません。

## API runtime 構成

同じ route inventory と handler を、ローカルの static Hono server と AWS Lambda runtime から利用します。

| ランタイム         | 用途                | 主な入口                              |
| ------------------ | ------------------- | ------------------------------------- |
| Static Hono server | ローカルと test API | `scripts/dev/static-hono-server.ts`   |
| Hono on Lambda     | AWS Lambda API      | `infra/lambdas/public-api/handler.ts` |

以下のパスはすべて `/api` を base path とします。

<a id="active-browser-と-cli-api-一覧"></a>

## Active API 一覧

| メソッド | パス                                                                                                                                                                | 主用途                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `POST`   | [`/api/sessions`](#post-apisessions)                                                                                                                                | セッション作成                |
| `POST`   | [`/api/sessions/:sessionId/votes`](#post-apisessionssessionidvotes)                                                                                                 | 投票送信                      |
| `GET`    | [`/api/sessions/:sessionId/progress`](#get-apisessionssessionidprogress)                                                                                            | ボット投票進捗                |
| `POST`   | [`/api/sessions/:sessionId/finalizations`](#post-apisessionssessionidfinalizations)                                                                                 | 集計/証明生成                 |
| `GET`    | [`/api/sessions/:sessionId/finalizations/current`](#get-apisessionssessionidfinalizationscurrent)                                                                   | current finalization 取得     |
| `POST`   | [`/api/sessions/:sessionId/finalizations/:finalizationId/cancel`](#post-apisessionssessionidfinalizationsfinalizationidcancel)                                      | 非同期集計キャンセル          |
| `GET`    | [`/api/sessions/:sessionId/finalizations/:finalizationId/verification`](#get-apisessionssessionidfinalizationsfinalizationidverification)                           | 検証 resource 取得            |
| `POST`   | [`/api/sessions/:sessionId/finalizations/:finalizationId/verification`](#post-apisessionssessionidfinalizationsfinalizationidverification)                          | STARK 検証実行                |
| `POST`   | [`/api/sessions/:sessionId/finalizations/:finalizationId/verification/observations`](#post-apisessionssessionidfinalizationsfinalizationidverificationobservations) | browser-local cast 観測の記録 |
| `GET`    | [`/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`](#get-apisessionssessionidfinalizationsfinalizationidartifactsbundle)                    | バンドル ZIP 取得             |
| `GET`    | [`/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`](#get-apisessionssessionidfinalizationsfinalizationidartifactsreport)                    | 検証レポート取得              |
| `GET`    | [`/api/sessions/:sessionId/bulletin`](#get-apisessionssessionidbulletin)                                                                                            | bulletin inspection           |
| `GET`    | [`/api/sessions/:sessionId/bulletin/consistency-proof`](#get-apisessionssessionidbulletinconsistency-proof)                                                         | RFC 6962 整合性証明           |
| `GET`    | [`/api/sessions/:sessionId/votes/:voteId/inclusion-proof`](#get-apisessionssessionidvotesvoteidinclusion-proof)                                                     | 投票包含証明                  |
| `GET`    | [`/api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex`](#get-apisessionssessionidfinalizationscurrentbitmap-proofskindvoteindex)          | bitmap 証明材料               |
| `GET`    | [`/api/sessions/:sessionId/bulletin/sth`](#get-apisessionssessionidbulletinsth)                                                                                     | STH スナップショット          |
| `GET`    | [`/api/sessions/:sessionId/finalizations/current/input-commitment`](#get-apisessionssessionidfinalizationscurrentinput-commitment)                                  | zkVM input commitment         |

## 共通 contract

### セッション capability

`POST /api/sessions` 以外の active route は、次の組み合わせで session owner を特定します。

- `sessionId`: URL path parameter
- `X-Session-Capability`: 必須 request header

`X-Session-ID` header は現行 contract に含まれません。`finalizationId` を含む route は、path の
`finalizationId` も current finalization authority と照合します。

共通の capability エラーは次のとおりです。

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `SESSION_NOT_FOUND` (`404`; session を読む route)

### JSON success envelope

artifact 本文を返す route を除く public JSON success は、strict な envelope を使います。

```json
{
  "data": {},
  "meta": {
    "requestId": "request-id"
  }
}
```

schema にない追加フィールドは受理しません。bulletin の pagination 情報だけは、page request 時に
`meta.page` として追加されます。

### JSON error envelope

public route の標準エラーは HTTP status を本文に重複させず、次の形を使います。

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid request",
    "details": {
      "kind": "validation",
      "issues": {
        "formErrors": [],
        "fieldErrors": {}
      }
    }
  },
  "meta": {
    "requestId": "request-id"
  }
}
```

`details` は任意で、公開 schema が許可する tagged detail だけを返します。全 route に共通し得る
エラーは `INVALID_REQUEST` (`400`)、target origin 検証の `SAME_ORIGIN_REQUIRED` (`403`)、
予期しない handler failure の `INTERNAL_ERROR` (`500`) です。

### ボディサイズ、Turnstile、レート制限

JSON body を持つ active route は `API_REQUEST_BODY_LIMIT_BYTES`（既定 16 KiB）の対象で、超過時は
`PAYLOAD_TOO_LARGE` (`413`) を返します。

| route                                | Turnstile         | application rate limit                           |
| ------------------------------------ | ----------------- | ------------------------------------------------ |
| `POST /api/sessions`                 | `session` action  | client IP 単位                                   |
| `POST .../votes`                     | `vote` action     | session と client IP 単位                        |
| `POST .../finalizations`             | `finalize` action | session と client IP 単位                        |
| `POST .../cancel`                    | なし              | session と client IP 単位                        |
| `POST .../verification`              | なし              | session と client IP 単位                        |
| `POST .../verification/observations` | なし              | 専用制限なし。API Gateway の既定 throttle を使用 |

Turnstile token は body の `turnstileToken` に置きます。production の bypass は認めず、session 作成の
develop 例外も operator-gated runtime に限定されます。

## セッションと投票

### `POST /api/sessions`

新規セッションと capability token を発行します。

request body:

- `turnstileToken`（環境により必須）
- body 省略時は空 object として扱います

response (`200`) の `data`:

- `sessionId`
- `electionId`
- `electionConfigHash`
- `logId`
- `capabilityToken`

主な固有エラー:

- `CAPTCHA_FAILED` (`403`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)
- `SESSION_LIMIT_EXCEEDED` (`503`)

### `POST /api/sessions/:sessionId/votes`

ユーザー投票を保存し、ボット投票を開始します。

request body:

- `commitment`: 32-byte hex
- `vote`: `A` / `B` / `C` / `D` / `E`
- `rand`: 32-byte hex
- `turnstileToken`（環境により必須）

response (`200`) の `data`:

- `voteId`
- `commitment`
- `bulletinIndex`
- `bulletinRootAtCast`
- `castAtMs`

主な固有エラー:

- `CAPTCHA_FAILED` (`403`)
- `ALREADY_VOTED` (`400`)
- `SESSION_FINALIZED` (`400`)
- `INVALID_COMMITMENT` (`400`)
- `DUPLICATE_VOTE` (`409`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)

### `GET /api/sessions/:sessionId/progress`

投票進捗を返します。

response (`200`) の `data`:

- `count`
- `total`
- `completed`
- `userVoted`
- `finalized`
- `distribution`（任意。`A`-`E` の simulated count）
- `distributionKind`（任意。存在する場合は `simulated`）
- `updatedAtMs`（任意）
- `animationSeed`（任意）

## Finalization API

### Finalization resource

作成、current 取得、キャンセルは同じ finalization resource schema を返します。共通フィールドは次のとおりです。

- `finalizationId`
- `status`: `pending` / `running` / `succeeded` / `failed` / `timeout`
- `queuedAtMs`
- `runtimeDiagnostics`
  - `asyncMode`: `enabled` / `disabled`
  - `queue`（任意または `null`）
  - `progress`（任意。running phase の派生進捗）
  - `orchestrator`（任意または `null`）

status ごとの追加フィールド:

| status      | 追加フィールド                                                     |
| ----------- | ------------------------------------------------------------------ |
| `pending`   | なし                                                               |
| `running`   | `startedAtMs`                                                      |
| `succeeded` | `startedAtMs`, `completedAtMs`, `result`                           |
| `failed`    | `startedAtMs`（任意）, `failedAtMs`, `error.code`, `error.message` |
| `timeout`   | `startedAtMs`（任意）, `timeoutAtMs`                               |

`succeeded` の `result` は、authority と presentation を混在させず次の group に分けます。

- `authority`: `imageId`, `journal` と、任意の `receipt`, `electionManifest`, `closeStatement`
- `presentation`: tally、bitmap root、input commitment、verification status などの公開表示 projection
- `voterEvidence`: `state=available` または `state=verification-gated`
- `artifactAvailability`: `bundle`, `report`, `includedBitmap`, `seenBitmap` ごとの
  `available` / `unavailable`。bitmap の `available` は current finalization に durable に admit された sidecar があることを示す

### `POST /api/sessions/:sessionId/finalizations`

集計と証明生成を開始します。

request body:

- `scenarioId`: `S0`-`S5`
- `turnstileToken`（環境により必須）

response:

- `200`: 同期処理後の finalization resource
- `202`: 受理された非同期 finalization resource

どちらも `{ data: FinalizationResource, meta }` です。返さない旧フィールドは
[現行 response で返さない legacy フィールド](#現行-response-で返さない-legacy-フィールド)にまとめています。

主な固有エラー:

- `CAPTCHA_FAILED` (`403`)
- `USER_NOT_VOTED` (`400`)
- `VOTING_NOT_COMPLETE` (`400`)
- `SESSION_ALREADY_FINALIZED` (`400`)
- `INVALID_IMAGE_ID` (`400`)
- `VERIFICATION_FAILED` (`400`)
- `ZKVM_RATE_LIMIT_EXCEEDED` (`429`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)
- `INVALID_FINALIZATION_ARTIFACT` (`500`)

### `GET /api/sessions/:sessionId/finalizations/current`

current finalization を返します。まだ finalization がない場合も成功で、`data` は `null` です。
存在する場合は上記の finalization resource を返します。

### `POST /api/sessions/:sessionId/finalizations/:finalizationId/cancel`

path で指定した進行中 finalization をキャンセルします。

request body:

- `reason`（任意、最大 256 文字）
- body に `executionId` や `finalizationId` は置きません

response (`200`) はキャンセル後の finalization resource です。

主な固有エラー:

- `ASYNC_FINALIZATION_DISABLED` (`404`)
- `FINALIZATION_NOT_CANCELLABLE` (`409`)
- `CANCELLATION_UNSUPPORTED` (`501`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)

## 検証 API

### `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification`

指定 finalization の検証 resource を返します。

query:

- `include=journal`（任意）

response (`200`) の `data` は `availability` による strict union です。

`availability=available`:

- `finalizationId`
- `proofAuthority`: election identity、bulletin root、Image ID、verified tally、bitmap root、input commitment など
- `presentation`: tally、scenario、tamper 情報と fail-closed presentation policy
- `verifierResult`: `status` と任意の公開 `report`
- `verification`: `checks` と `steps`
- `voterEvidence`: `availability=available` または `availability=unavailable`
- `journal`: `representation=included` の `value`、または `representation=omitted`

`availability=unavailable`:

- `finalizationId`
- `reason`: `finalization_not_current` / `user_vote_unavailable`
- `message`

`availability=corrupt`:

- `finalizationId`
- `reason`: `invalid_artifact` / `incomplete_session_authority` / `session_identity_mismatch` /
  `voter_evidence_mismatch`
- `message`

unavailable/corrupt response に available 用の authority や検証フィールドは混在しません。

主な固有エラー:

- `SESSION_NOT_FINALIZED` (`400`)
- `USER_NOT_VOTED` (`400`)

### `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification`

サーバー側の STARK receipt 検証を実行します。

- request body: strict な空 object `{}`
- response (`200`) の `data`:
  - `verificationStatus`
  - `finalizationId`
  - `estimatedDurationMs`
  - `idempotent`

主な固有エラー:

- `SESSION_NOT_FINALIZED` (`400`)
- `ZKVM_RATE_LIMIT_EXCEEDED` (`429`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)

<a id="post-apiverificationobservation"></a>

### `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations`

browser-local の cast check 結果だけを durable observation として記録します。client が overall verdict や
server-side check を指定する API ではありません。

request body の `castChecks` は、次の 4 キーをすべて含む strict object です。各値は
`success` / `failed` / `not_run` のいずれかです。

- `cast_receipt_present`
- `cast_choice_range`
- `cast_random_format`
- `cast_commitment_match`

finalization identity は path で指定するため、body に execution/finalization ID は含めません。

response (`200`) の `data.status`:

- `recorded`: 初回記録
- `idempotent`: 同一内容の再送

主な固有エラー:

- `VERIFICATION_OBSERVATION_CONFLICT` (`409`; 異なる内容による再送)
- `SESSION_NOT_FINALIZED` (`400`)
- `USER_NOT_VOTED` (`400`)

## Artifact 取得 API

両 route とも `X-Session-Capability` を要求し、session と finalization identity を検証してから artifact を
返します。通常 contract として raw S3 URL や presigned URL は公開しません。

### `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`

秘密データを含まない配布対象 `bundle.zip` を返します。

- `200`: ZIP binary
- `206`: `Range` に対する partial content
- 大きい S3-backed bundle は range download が必須

主な固有エラー:

- `INVALID_BUNDLE_REFERENCE` (`400`)
- `BUNDLE_NOT_FOUND` (`404`)
- `BUNDLE_DOWNLOAD_FAILED` (`500`)
- `BUNDLE_REQUIRES_RANGE_DOWNLOAD` (`413`)
- `INVALID_RANGE` (`416`)

<a id="get-apiverificationbundlessessionidexecutionidreport"></a>

### `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`

protected report artifact `verification.json` を JSON 本文として返します。これは配布対象 `bundle.zip` には
含まれません。

主な固有エラー:

- `INVALID_BUNDLE_REFERENCE` (`400`)
- `REPORT_NOT_FOUND` (`404`)
- `REPORT_DOWNLOAD_FAILED` (`500`)
- `REPORT_DOWNLOAD_TOO_LARGE` (`413`)

## Bulletin と証明 API

### `GET /api/sessions/:sessionId/bulletin`

owner-scoped bulletin inspection を返します。

query:

- `offset`（任意、0 以上の整数）
- `limit`（任意、1-1000）

response (`200`):

- `data.commitments`
- `data.bulletinRoot`
- `data.treeSize`
- `data.generatedAtMs`
- `data.rootHistory`（任意）
- `meta.page.nextOffset`, `meta.page.hasMore`（pagination request 時）

主な固有エラー:

- `INVALID_OFFSET` (`400`)

そのほかの不正な query は `INVALID_REQUEST` (`400`) です。

### `GET /api/sessions/:sessionId/bulletin/consistency-proof`

RFC 6962 consistency proof を返します。

query:

- `fromTreeSize`（必須、0 以上の整数）
- `toTreeSize`（必須、0 以上の整数）

response (`200`) の `data`:

- `fromTreeSize`
- `toTreeSize`
- `rootAtFromTreeSize`
- `rootAtToTreeSize`
- `proofNodes`
- `oldSubtreeHashes` / `appendSubtreeHashes`（任意）
- `generatedAtMs`

主な固有エラー:

- `INVALID_SIZE` (`400`)

### `GET /api/sessions/:sessionId/votes/:voteId/inclusion-proof`

指定した投票の最小包含証明を返します。session は finalized である必要があり、proof ownership と
finalization authority を検証します。

response (`200`) の `data`:

- `voteId`
- `proof.leafIndex`
- `proof.treeSize`
- `proof.merklePath`
- `proof.bulletinRootAtCast`

主な固有エラー:

- `INVALID_VOTE_ID` (`400`)
- `VOTE_NOT_FOUND` (`404`)
- `VERIFICATION_FAILED` (`400`; CT proof unavailable)
- `SESSION_NOT_FINALIZED` (`400`)

### `GET /api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex`

succeeded current finalization に admit された bitmap evidence から proof 材料を返します。

path parameter:

- `kind`: `included` / `seen`
- `voteIndex`: 0 以上の整数

response (`200`) の `data`:

- `leafChunk`
- `auditPath[]`: `hash`, `position` (`left` / `right`)

`If-None-Match` を受理し、一致時は `304` を返します。

主な固有エラー:

- `INVALID_BITMAP_PROOF_REQUEST` (`400`)
- `USER_NOT_VOTED` (`400`)

### `GET /api/sessions/:sessionId/bulletin/sth`

finalized session の STH snapshot を返します。

query:

- `auditorId`（任意、1-64 文字の英数字、`.`、`_`、`-`）

browser request は same-origin である必要があります。CLI/server-to-server request でも session capability は
必須です。

response (`200`) の `data.sth`:

- `sthDigest`
- `bulletinRoot`
- `treeSize`
- `timestamp`
- `logId`

主な固有エラー:

- `SESSION_NOT_FINALIZED` (`404`)
- `SAME_ORIGIN_REQUIRED` (`403`; 同一 origin 検証失敗)

### `GET /api/sessions/:sessionId/finalizations/current/input-commitment`

current finalization の zkVM input commitment だけを返します。private input data、raw witness、vote opening は
返しません。

response (`200`) の `data`:

- `inputCommitment`

主な固有エラー:

- `SESSION_NOT_FINALIZED` (`400`)
- `CT_PROOF_UNAVAILABLE` (`400`)
- `INTERNAL_ERROR` (`500`; commitment validation または handler failure)

## Retired route と internal surface

過去の flat route（`/api/session`、`/api/vote`、`/api/finalize`、`/api/verify`、
`/api/verification/bundles/...`、`/api/bulletin`、`/api/sth`、`/api/bitmap-proof`、
`/api/zkvm-input-hash` など）は route inventory に登録されず、compatibility alias もありません。

finalization worker callback は internal/operator-only surface であり、public route inventory、browser CORS、
この章の request/response contract の対象外です。debug route と private inspection route も active external API
として扱いません。

## 現行 response で返さない legacy フィールド

現行 finalization、verification、artifact response は次の旧フィールドを返しません。

- artifact URL: `verificationBundleUrl`, `verificationReportUrl`
- S3 metadata: `s3BundleUrl`, `s3BundleKey`, `s3UploadedAt`, `s3BundleExpiresAt`
- count alias: `missingIndices`, `invalidIndices`, `countedIndices`, `excludedCount`
- 旧 finalization locator/state: `executionId`, `statusUrl`, `state`, `finalizationState`

bundle と report は finalization-scoped artifact route から capability 保護付きで取得します。

## 関連する章

- [セッションライフサイクル](./session-lifecycle.md): セッション、capability、finalization の状態遷移
- [チェック一覧](../verification/checks-catalog.md): verification checks の意味
- [公開境界](../verification/public-boundary.md): public artifact と owner-scoped access の区別
- [用語集](../appendix/glossary.md): receipt、bundle、STH、capability など

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/*, packages/api-contract/src/routes/inventory.test.ts, packages/api-contract/src/schemas/*.test.ts, apps/api/src/server/api/routes/hono.ts, apps/web/src/api/* -->
