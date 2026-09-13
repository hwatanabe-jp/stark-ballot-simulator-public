# エンドポイント一覧

セッション作成から証拠の取得まで、ブラウザと CLI が呼び出す API の要求・応答をまとめます。すべてのパスは `/api` で始まります。

<a id="active-browser-と-cli-api-一覧"></a>

## API 一覧

| メソッド | パス                                                                                                                                                                | 主用途                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `POST`   | [`/api/sessions`](#post-apisessions)                                                                                                                                | セッション作成             |
| `POST`   | [`/api/sessions/:sessionId/votes`](#post-apisessionssessionidvotes)                                                                                                 | 投票送信                   |
| `GET`    | [`/api/sessions/:sessionId/progress`](#get-apisessionssessionidprogress)                                                                                            | ボット投票進捗             |
| `POST`   | [`/api/sessions/:sessionId/finalizations`](#post-apisessionssessionidfinalizations)                                                                                 | 集計/証明生成              |
| `GET`    | [`/api/sessions/:sessionId/finalizations/current`](#get-apisessionssessionidfinalizationscurrent)                                                                   | 現在の集計を取得           |
| `POST`   | [`/api/sessions/:sessionId/finalizations/:finalizationId/cancel`](#post-apisessionssessionidfinalizationsfinalizationidcancel)                                      | 非同期集計キャンセル       |
| `GET`    | [`/api/sessions/:sessionId/finalizations/:finalizationId/verification`](#get-apisessionssessionidfinalizationsfinalizationidverification)                           | 検証データ取得             |
| `POST`   | [`/api/sessions/:sessionId/finalizations/:finalizationId/verification`](#post-apisessionssessionidfinalizationsfinalizationidverification)                          | STARK 検証実行             |
| `POST`   | [`/api/sessions/:sessionId/finalizations/:finalizationId/verification/observations`](#post-apisessionssessionidfinalizationsfinalizationidverificationobservations) | ブラウザの Cast 観測を記録 |
| `GET`    | [`/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`](#get-apisessionssessionidfinalizationsfinalizationidartifactsbundle)                    | バンドル ZIP 取得          |
| `GET`    | [`/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`](#get-apisessionssessionidfinalizationsfinalizationidartifactsreport)                    | 検証レポート取得           |
| `GET`    | [`/api/sessions/:sessionId/bulletin`](#get-apisessionssessionidbulletin)                                                                                            | 掲示板の確認               |
| `GET`    | [`/api/sessions/:sessionId/bulletin/consistency-proof`](#get-apisessionssessionidbulletinconsistency-proof)                                                         | RFC 6962 整合性証明        |
| `GET`    | [`/api/sessions/:sessionId/votes/:voteId/inclusion-proof`](#get-apisessionssessionidvotesvoteidinclusion-proof)                                                     | 投票包含証明               |
| `GET`    | [`/api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex`](#get-apisessionssessionidfinalizationscurrentbitmap-proofskindvoteindex)          | ビットマップの証明材料     |
| `GET`    | [`/api/sessions/:sessionId/bulletin/sth`](#get-apisessionssessionidbulletinsth)                                                                                     | STH スナップショット       |
| `GET`    | [`/api/sessions/:sessionId/finalizations/current/input-commitment`](#get-apisessionssessionidfinalizationscurrentinput-commitment)                                  | 入力コミットメント         |

## 共通仕様

### セッション capability

`POST /api/sessions` 以外の API は、次の組み合わせでセッションの所有者を特定します。

- `sessionId`: URL のパスパラメーター
- `X-Session-Capability`: 必須ヘッダー

集計 ID を含む URL では、`finalizationId` も現在の集計と照合します。

セッション認証の共通エラーは次のとおりです。

- `SESSION_CAPABILITY_REQUIRED` (`401`)
- `SESSION_CAPABILITY_INVALID` (`401`)
- `SESSION_CAPABILITY_EXPIRED` (`401`)
- `SESSION_NOT_FOUND` (`404`; セッションを読み取る API)

### JSON の成功応答

JSON の成功応答は、結果を `data`、要求 ID を `meta` に入れます。ファイル取得 API は、そのファイルの本文を直接返します。

```json
{
  "data": {},
  "meta": {
    "requestId": "request-id"
  }
}
```

スキーマにない追加フィールドは受理しません。掲示板のページ情報だけは、ページを指定した要求時に
`meta.page` として追加されます。

### JSON のエラー応答

公開 API の標準エラーは HTTP ステータス を本文に重複させず、次の形を使います。

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

`details` は任意で、公開スキーマが許可する種類の詳細情報だけを返します。すべての API に共通し得る
エラーは `INVALID_REQUEST` (`400`)、AWS 上のオリジン検証の `SAME_ORIGIN_REQUIRED` (`403`)、
ハンドラー内の予期しない失敗に対する `INTERNAL_ERROR` (`500`) です。

### 数値のクエリー・パスパラメーター

掲示板の `offset`、整合性証明の `fromTreeSize` / `toTreeSize`、ビットマップ証明の
`voteIndex` は、`0..Number.MAX_SAFE_INTEGER`（9,007,199,254,740,991）の10進整数文字列を
受理します。`0` 自体を除く先頭ゼロ、符号、指数表記、小数、範囲超過は拒否し、丸めません。
掲示板の `limit` は先頭ゼロのない10進整数文字列で `1..1000` に限定します。

### ボディサイズ、Turnstile、レート制限

JSON 本文 を持つ API は `API_REQUEST_BODY_LIMIT_BYTES`（既定 16 KiB）の対象で、超過時は
`PAYLOAD_TOO_LARGE` (`413`) を返します。

| API                                  | Turnstile         | アプリ内のレート制限                                  |
| ------------------------------------ | ----------------- | ----------------------------------------------------- |
| `POST /api/sessions`                 | `session` action  | クライアント IP 単位                                  |
| `POST .../votes`                     | `vote` action     | session と クライアント IP 単位                       |
| `POST .../finalizations`             | `finalize` action | session と クライアント IP 単位                       |
| `POST .../cancel`                    | なし              | session と クライアント IP 単位                       |
| `POST .../verification`              | なし              | session と クライアント IP 単位                       |
| `POST .../verification/observations` | なし              | 専用制限なし。API Gateway の既定の呼び出し制限 を使用 |

Turnstile のトークンは本文の `turnstileToken` に置きます。AWS の main では、表で action を示した三つの API で検査を必須とします。AWS の develop では、運用者用の入口制限を通った要求に限り省略します。
[ローカルの四つのプロファイル](../aws/runtime-boundary.md#semantic-runtime-profiles)では Turnstile を省略します。

## セッションと投票

### `POST /api/sessions`

新規セッションと capability token を発行します。

要求本文:

- `turnstileToken`（環境により必須）
- 本文省略時は空オブジェクトとして扱います

応答 (`200`) の `data`:

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

ユーザー投票を保存し、ボット63票の保存完了を待って投票レシートを返します。
同一セッションで同じ選択・乱数・コミットメントを再送すると、未完了のボット処理を再開し、
保存済みの票 ID・投票時刻・投票時ルートを返します。別の投票内容への変更は `ALREADY_VOTED` で拒否します。
集計開始後の同一投票の再送はレシートの取得だけを行い、票を追加しません。

通信切断や `INTERNAL_ERROR` (`500`) は、投票が未保存であることを意味しません。
同じ投票内容を保持して再試行してください。認証・レート制限・環境ごとの Turnstile 検証は再送にも適用されます。
この復旧は再試行を契機に行い、利用者の離脱後にバックグラウンドで完了させる保証ではありません。

要求本文:

- `commitment`: 32 バイトの16進文字列
- `vote`: `A` / `B` / `C` / `D` / `E`
- `rand`: 32 バイトの16進文字列
- `turnstileToken`（環境により必須）

応答 (`200`) の `data`:

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

応答 (`200`) の `data`:

- `count`
- `total`
- `completed`
- `userVoted`
- `finalized`
- `distribution`（任意。`A`-`E` のシミュレーション上の票数）
- `distributionKind`（任意。存在する場合は `simulated`）
- `updatedAtMs`（任意）
- `animationSeed`（任意）

## Finalization API

### Finalization resource

集計の作成・現在状態の取得・キャンセルは、同じ集計リソース形式で返します。共通フィールドは次のとおりです。

- `finalizationId`
- `status`: `pending` / `running` / `succeeded` / `failed` / `timeout`
- `queuedAtMs`
- `runtimeDiagnostics`
  - `asyncMode`: `enabled` / `disabled`
  - `queue`（任意または `null`）
  - `progress`（任意。実行中の段階から導出した進捗）
  - `orchestrator`（任意または `null`）

`status` ごとの追加フィールド:

| status      | 追加フィールド                                                     |
| ----------- | ------------------------------------------------------------------ |
| `pending`   | なし                                                               |
| `running`   | `startedAtMs`                                                      |
| `succeeded` | `startedAtMs`, `completedAtMs`, `result`                           |
| `failed`    | `startedAtMs`（任意）, `failedAtMs`, `error.code`, `error.message` |
| `timeout`   | `startedAtMs`（任意）, `timeoutAtMs`                               |

`succeeded` の `result` は、証明に結び付く値、画面表示、投票者の証拠、ファイル取得の可否に分かれます。

- `authority`: `imageId`, `journal` と、任意の `receipt`, `electionManifest`, `closeStatement`
- `presentation`: 得票数、ビットマップルート、入力コミットメント、検証状態などの表示用データ
- `voterEvidence`: `state=available` または `state=verification-gated`
- `artifactAvailability`: `bundle`, `report`, `includedBitmap`, `seenBitmap` ごとの
  `available` / `unavailable`。ビットマップの `available` は、現在の集計に結び付く別ファイルが検査済みで保存されていることを示す

スキーマは、ジャーナルと表示用データに重複する値、Image ID、公開監査ファイル、レポートと状態、投票者の証拠、シナリオ、ファイル取得可否の整合性を検査します。表示の得票数と証明の得票数が違う場合は、改ざんシナリオの証拠として保持できます。ただし、シナリオや検証結果の説明もその差と一致している必要があります。

### `POST /api/sessions/:sessionId/finalizations`

集計と証明生成を開始します。

要求本文:

- `scenarioId`: `S0`-`S5`
- `turnstileToken`（環境により必須）

応答:

- `200`: 同期処理後の集計リソース
- `202`: 受け付けた非同期集計のリソース

どちらも `{ data: FinalizationResource, meta }` の形で返します。

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

現在の集計を返します。まだ集計がない場合も成功応答となり、`data` は `null` です。存在する場合は上記の集計リソースを返します。

### `POST /api/sessions/:sessionId/finalizations/:finalizationId/cancel`

URL のパスで指定した実行中の集計 をキャンセルします。

要求本文:

- `reason`（任意、最大 256 文字）
- 本文に `executionId` や `finalizationId` は置きません

応答 (`200`) はキャンセル後の集計リソース です。

主な固有エラー:

- `ASYNC_FINALIZATION_DISABLED` (`404`)
- `FINALIZATION_NOT_CANCELLABLE` (`409`)
- `GLOBAL_LIMIT_EXCEEDED` (`503`)

## 検証 API

### `GET /api/sessions/:sessionId/finalizations/:finalizationId/verification`

指定した集計の検証データ を返します。

クエリー:

- `include=journal`（任意）

応答 (`200`) の `data` は `availability=available` です。

- `finalizationId`
- `proofAuthority`: 選挙の識別情報、掲示板ルート、Image ID、証明内の集計、ビットマップルート、入力コミットメントなど
- `presentation`: 表示集計、シナリオ、改ざん情報、表示可否の判定
- `verifierResult`: `status` と任意の公開 `report`
- `verification`: `checks` と `steps`
- `voterEvidence`: `availability=available` または `availability=unavailable`
- `journal`: `representation=included` の `value`、または `representation=omitted`

`available` の応答は、チェックと段階の構成、証明に結び付く値、レポートと状態、投票者の証拠、付属ジャーナル、シナリオ、表示判定の相互整合性も検査します。表示の得票数と証明の得票数の差は検証対象として保持できますが、その差を無視したチェック成功や Verified 表示を許すデータは受理しません。

検証データ全体の読み取り準備で `unavailable` / `corrupt` と判定された場合、現在の API は `INTERNAL_ERROR` (`500`) を返します。これは、取得できた応答の中で投票者の証拠だけが `voterEvidence.availability=unavailable` になる場合とは異なります。

主な固有エラー:

- `SESSION_NOT_FINALIZED` (`400`)
- `USER_NOT_VOTED` (`400`)
- `INTERNAL_ERROR` (`500`、検証データの読み取り準備に失敗した場合を含む)

### `POST /api/sessions/:sessionId/finalizations/:finalizationId/verification`

サーバー側の STARK レシート検証を実行します。

- 要求本文: 追加フィールドを許さない空オブジェクト `{}`
- 応答 (`200`) の `data`:
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

ブラウザで確認した Cast チェックの結果を観測記録として保存します。最終判定やサーバー側チェックの結果は、クライアントから指定できません。

要求本文の `castChecks` は次の 4 キーをすべて含み、他のキーを許しません。各値は
`success` / `failed` / `not_run` のいずれかです。

- `cast_receipt_present`
- `cast_choice_range`
- `cast_random_format`
- `cast_commitment_match`

集計 ID は URL のパスで指定するため、本文には含めません。

応答 (`200`) の `data.status`:

- `recorded`: 初回記録
- `idempotent`: 同一内容の再送

主な固有エラー:

- `VERIFICATION_OBSERVATION_CONFLICT` (`409`; 異なる内容による再送)
- `SESSION_NOT_FINALIZED` (`400`)
- `USER_NOT_VOTED` (`400`)

## Artifact 取得 API

二つの API とも `X-Session-Capability` を要求し、セッションと集計 ID を確認してからファイルを返します。S3 の保存先 URL や署名付き URL を返してそちらから取得させる方式ではありません。

### `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`

秘密データを含まない配布対象 `bundle.zip` を返します。

- `200`: ZIP のバイト列
- `206`: `Range` で要求した部分のバイト列
- S3 に保存した大きい ZIP は範囲を指定した取得が必須

主な固有エラー:

- `INVALID_BUNDLE_REFERENCE` (`400`)
- `BUNDLE_NOT_FOUND` (`404`)
- `BUNDLE_DOWNLOAD_FAILED` (`500`)
- `BUNDLE_REQUIRES_RANGE_DOWNLOAD` (`413`)
- `INVALID_RANGE` (`416`)

<a id="get-apiverificationbundlessessionidexecutionidreport"></a>

### `GET /api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`

認証付きで取得するレポート `verification.json` を JSON 本文として返します。これは配布対象 `bundle.zip` には
含まれません。

主な固有エラー:

- `INVALID_BUNDLE_REFERENCE` (`400`)
- `REPORT_NOT_FOUND` (`404`)
- `REPORT_DOWNLOAD_FAILED` (`500`)
- `REPORT_DOWNLOAD_TOO_LARGE` (`413`)

## 掲示板と証明 API

### `GET /api/sessions/:sessionId/bulletin`

セッション所有者に、その掲示板の内容を返します。

クエリー:

- `offset`（任意、[数値のクエリー・パスパラメーター](#数値のクエリーパスパラメーター) の非負整数）
- `limit`（任意、1-1000）

応答 (`200`):

- `data.commitments`
- `data.bulletinRoot`
- `data.treeSize`
- `data.generatedAtMs`
- `data.rootHistory`（任意）
- `meta.page.nextOffset`, `meta.page.hasMore`（ページを指定した要求時）

主な固有エラー:

- `INVALID_OFFSET` (`400`)

そのほかの不正なクエリー は `INVALID_REQUEST` (`400`) です。

### `GET /api/sessions/:sessionId/bulletin/consistency-proof`

RFC 6962 の整合性証明 を返します。

クエリー:

- `fromTreeSize`（必須、[数値のクエリー・パスパラメーター](#数値のクエリーパスパラメーター) の非負整数）
- `toTreeSize`（必須、同じ数値契約の非負整数）

応答 (`200`) の `data`:

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

指定した投票の包含証明を返します。セッションの集計が完了している必要があり、証明の所有者と現在の集計との対応を検査します。

応答 (`200`) の `data`:

- `voteId`
- `proof.leafIndex`
- `proof.treeSize`
- `proof.merklePath`
- `proof.bulletinRootAtCast`

主な固有エラー:

- `INVALID_VOTE_ID` (`400`)
- `VOTE_NOT_FOUND` (`404`)
- `VERIFICATION_FAILED` (`400`; 掲示板の証明を取得できない)
- `SESSION_NOT_FINALIZED` (`400`)

### `GET /api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex`

成功した現在の集計に結び付くビットマップから、証明を作る材料を返します。

パスパラメーター:

- `kind`: `included` / `seen`
- `voteIndex`: [数値のクエリー・パスパラメーター](#数値のクエリーパスパラメーター) の非負整数。セッションの利用者自身の投票位置に限定し、他の位置 は `INVALID_BITMAP_PROOF_REQUEST` (`400`) で拒否する

応答 (`200`) の `data`:

- `leafChunk`
- `auditPath[]`: `hash`, `position` (`left` / `right`)

`If-None-Match` を受理し、一致時は `304` を返します。

主な固有エラー:

- `INVALID_BITMAP_PROOF_REQUEST` (`400`)
- `USER_NOT_VOTED` (`400`)

### `GET /api/sessions/:sessionId/bulletin/sth`

集計済みセッションの STH を返します。

クエリー:

- `auditorId`（任意、1-64 文字の英数字、`.`、`_`、`-`）

ブラウザからの要求は同一オリジンである必要があります。CLI やサーバー間の要求でもセッション capability は必須です。

応答 (`200`) の `data.sth`:

- `sthDigest`
- `bulletinRoot`
- `treeSize`
- `timestamp`
- `logId`

主な固有エラー:

- `SESSION_NOT_FINALIZED` (`404`)
- `SAME_ORIGIN_REQUIRED` (`403`; 同一オリジン 検証失敗)

### `GET /api/sessions/:sessionId/finalizations/current/input-commitment`

現在の集計の入力コミットメントだけを返します。投票先や乱数などの秘密入力は含みません。

応答 (`200`) の `data`:

- `inputCommitment`

主な固有エラー:

- `SESSION_NOT_FINALIZED` (`400`)
- `CT_PROOF_UNAVAILABLE` (`400`)
- `INTERNAL_ERROR` (`500`; コミットメントの検査やハンドラー処理の失敗)

<!-- source: packages/api-contract/src/routes/inventory.ts, packages/api-contract/src/schemas/*, packages/api-contract/src/routes/inventory.test.ts, packages/api-contract/src/schemas/*.test.ts, apps/api/src/server/api/routes/hono.ts, apps/web/src/api/* -->
