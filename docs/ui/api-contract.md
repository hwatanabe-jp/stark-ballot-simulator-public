# UI 向け API 契約（現行実装）

本書は現行 UI が利用する API と、検証画面から参照可能な owner-scoped evidence API の契約をまとめる。
将来案や移行履歴ではなく、現在の route inventory、schema、handler、tests を記述対象とする。

実装上の正は次の順で確認する。

1. `packages/api-contract/src/routes/inventory.ts`
2. `packages/api-contract/src/schemas/*` の各 resource module（canonical aggregate は
   `packages/api-contract/src/schemas/index.ts`）
3. `apps/api/src/server/api/routes/definitions.ts` と `routes/hono.ts`
4. `apps/api/src/server/api/handlers/*`、`apps/web/src/api/*` と route/schema/client tests

本書と実装が不一致の場合は実装を正とし、handler、schema、tests、関連ドキュメントを同時に更新する。

## Route inventory

Base path は `/api`。以下は schema object を保持する `TARGET_API_ROUTE_CONTRACTS`
と現行 Hono registration に対応する。path/query/header/body の admission は route
定義から一度だけ行い、browser と mock transport は同じ canonical path builder と
response schema を使用する。

### Active UI / browser lifecycle

| Method | Path                                                                           | Auth scope                | 主用途                           |
| ------ | ------------------------------------------------------------------------------ | ------------------------- | -------------------------------- |
| POST   | `/sessions`                                                                    | public mutation           | セッション作成                   |
| POST   | `/sessions/:sessionId/votes`                                                   | path session + capability | ユーザー票の記録                 |
| GET    | `/sessions/:sessionId/progress`                                                | path session + capability | Bot 投票進捗                     |
| POST   | `/sessions/:sessionId/finalizations`                                           | path session + capability | 同期/非同期集計の開始            |
| POST   | `/sessions/:sessionId/finalizations/:finalizationId/cancel`                    | path session + capability | 進行中の非同期集計のキャンセル   |
| GET    | `/sessions/:sessionId/finalizations/current`                                   | path session + capability | 現在の集計 resource の取得       |
| GET    | `/sessions/:sessionId/finalizations/:finalizationId/verification`              | path session + capability | strict verification resource     |
| POST   | `/sessions/:sessionId/finalizations/:finalizationId/verification`              | path session + capability | STARK receipt 検証の開始/再取得  |
| POST   | `/sessions/:sessionId/finalizations/:finalizationId/verification/observations` | path session + capability | browser-local cast checks の観測 |
| GET    | `/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`          | path session + capability | public bundle の認証済み取得     |
| GET    | `/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`          | path session + capability | protected report の認証済み取得  |

### Active retained owner inspection / evidence

これらは通常の画面遷移そのものではないが、owner-scoped verification evidence を取得する現行 route である。
full-bulletin や private bitmap sidecar を public anonymous surface として公開するものではない。

| Method | Path                                                                        | Auth scope                    | 主用途                              |
| ------ | --------------------------------------------------------------------------- | ----------------------------- | ----------------------------------- |
| GET    | `/sessions/:sessionId/bulletin`                                             | path session + capability     | bulletin commitments の owner 閲覧  |
| GET    | `/sessions/:sessionId/bulletin/consistency-proof`                           | path session + capability     | RFC 6962 consistency proof          |
| GET    | `/sessions/:sessionId/votes/:voteId/inclusion-proof`                        | path session + capability     | 許可された個票の inclusion proof    |
| GET    | `/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex` | path session + capability     | ユーザー票 index の bitmap proof    |
| GET    | `/sessions/:sessionId/bulletin/sth`                                         | same-origin path + capability | same-origin STH source              |
| GET    | `/sessions/:sessionId/finalizations/current/input-commitment`               | path session + capability     | finalized input commitment の再計算 |

### Internal-only

| Method | Path                                                                   | Lifecycle              | 現行 runtime contract                                                   |
| ------ | ---------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| POST   | `/internal/sessions/:sessionId/finalizations/:finalizationId/callback` | internal-operator-only | HMAC callback 用。通常 Lambda registration と browser contract から除外 |

## 共通仕様

### HTTP envelope と認証

- public non-artifact JSON endpoint の `Content-Type` は `application/json`。
- 成功応答は `{ "data": { ... }, "meta": { "requestId": "..." } }`。
- エラー応答は
  `{ "error": { "code": "ERROR_CODE", "message": "...", "details": { "kind": "..." } }, "meta": { "requestId": "..." } }`。
  `details` は任意の strict tagged union（`validation`, `rateLimit`, `bodyLimit`,
  `verificationState`, `proofRange`）であり、HTTP status を JSON に重複させない。
- raw `bundle.zip`、protected report artifact の `verification.json`、internal finalize callback protocol は
  共通 envelope の明示的な例外。
- session resource route は path の `sessionId` を authority とし、
  `X-Session-Capability` のみ送る。public API に別の session identity header はない。
- capability token は同一 origin の session route にだけ送る。absolute HTTPS auditor URL は
  application と同じ origin でも external source として扱い、capability や repository-specific
  session header を転送しない。

`POST /sessions`、`POST /sessions/:sessionId/votes`、
`POST /sessions/:sessionId/finalizations` の canonical UI field は
`turnstileToken`。API request schema は `cf-turnstile-response` と `cfTurnstileResponse` を受理しない。
本番での必須条件と bypass 可否は route admission control と runtime config に従う。
セッション作成の profile ごとの受付条件と主要応答は
[POST `/api/sessions`](#post-apisessions) にまとめる。

### 値と共通型

- `ScenarioId`: `S0 | S1 | S2 | S3 | S4 | S5`
- `VoteChoice`: `A | B | C | D | E`
- 時刻: epoch milliseconds。時刻、duration、tree size、vote index は非負の safe integer
  （最大 `Number.MAX_SAFE_INTEGER`）。journal とその count/tally projection はより狭い
  `uint32` domain（`0..4294967295`）を使い、journal の `treeSize` は正数。
- 整数 query/path 値は leading zero、符号、小数、指数表記のない10進文字列を受理し、
  safe integer と確認してから number に変換する。`0` の可否と追加上限は endpoint ごとに定める。
- `VerificationStatus`: `success | failed | dev_mode | not_run | running`
- `VerificationStepStatus`: `success | failed | running | not_run | pending`
- 通常の 32-byte hex: `0x` prefix 付き canonical value を返す。bitmap raw material は endpoint 個別仕様を使う。
- canonical 名: `bulletinRoot`, `treeSize`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`,
  `inputCommitment`, `verifiedTally`, `bulletinRootAtCast`
- `merkleRoot`, `rootAtTime` などの旧名を UI contract として受け付けない。
- `finalizationId` は create、current state、verification work、observation、bundle/report locator を
  一貫して識別する唯一の repository lifecycle ID。snake_case の event/message field は
  `finalization_id` とし、別の nested identity へ fallback しない。

```ts
type Tally = {
  counts: { A: number; B: number; C: number; D: number; E: number };
  totalVotes: number;
  tamperedCount?: number;
};

type InclusionProof = {
  leafIndex: number;
  treeSize: number;
  merklePath: string[];
  bulletinRootAtCast: string;
};

type VerificationStep = {
  id: 'cast_as_intended' | 'recorded_as_cast' | 'counted_as_recorded' | 'stark_verification';
  status: VerificationStepStatus;
  inputs: string[];
  error?: string;
};

type VerificationCheckBase = {
  id: VerificationCheckId;
  evidence: 'local' | 'public' | 'zk' | 'demo';
  inputs: string[];
  derivedFrom?: VerificationCheckId;
};

type VerificationCheck = VerificationCheckBase &
  (
    | { status: VerificationStepStatus; noteKey?: never }
    | { status: 'failed' | 'not_run'; noteKey: VerificationCheckNoteKey }
  );

type VerificationCheckNoteKey =
  | 'pages.verify.stepsCard.notes.myVoteIncluded.notPresented'
  | 'pages.verify.stepsCard.notes.myVoteIncluded.presentedButInvalid'
  | 'pages.verify.stepsCard.notes.myVoteIncluded.excluded'
  | 'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt'
  | 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable';
```

`Tally.totalVotes` は A–E の合計と一致する。`counts`、`totalVotes`、`tamperedCount` は
`uint32`。共通 `Tally` の `tamperedCount` は optional だが、finalization と verification の
`presentation.tally` では必須である。

`VerificationStep.inputs` は必須。`error` は failed step にだけ付けられる、省略可能な
空白だけではない文字列。
`noteKey` は `failed | not_run` check の説明用公開 i18n key である。

`VerificationCheckId` は次の 22 件。

- Cast-as-Intended:
  `cast_receipt_present`, `cast_choice_range`, `cast_random_format`, `cast_commitment_match`
- Recorded-as-Cast:
  `recorded_commitment_in_bulletin`, `recorded_index_in_range`, `recorded_root_at_cast_consistent`,
  `recorded_inclusion_proof`, `recorded_consistency_proof`, `recorded_sth_third_party`
- Counted-as-Recorded:
  `counted_input_sanity`, `counted_unique_indices`, `counted_unique_commitments`, `counted_tally_consistent`,
  `counted_missing_indices_zero`, `counted_expected_vs_tree_size`, `counted_election_manifest_consistent`,
  `counted_close_statement_consistent`, `counted_my_vote_included`, `counted_input_commitment_match`
- STARK Verification:
  `stark_image_id_match`, `stark_receipt_verify`

`verification.steps[].status` は stage の現在 required な checks から導出する。
required check が `failed`, `not_run`, `pending`, `running` の場合、完全な verified state にしてはならない。

### UI presentation-only state

次は API authority ではない。

- `proofBundleStatus`: authenticated bundle の UI download state から導出
- knowledge item の `isNew` / `addedAt`: browser 内の更新 metadata（表示アニメーションには使用しない）
- verification step/check の表示順と段階表示
- 集計中の時間ベース補間

verification observation POST も verdict authority ではない。browser-local cast checks を bounded
telemetry として server に伝えるだけで、送信成功/失敗によって UI の検証結果を変更しない。

## 横断ポリシー

### Queue と擬似進捗

queue payload は次だけを返す。

```ts
type FinalizationQueue = {
  concurrencyLimit: number;
  estimatedDurationMs: number;
};
```

- `concurrencyLimit` は `PROVER_MAX_CONCURRENT_PROVERS`、default `2` の順。
- `estimatedDurationMs` の現行 default は `360000`。
- SQS depth、queue position、estimated start/completion は公開 payload に含めない。
- create の async 応答と current resource で同じ `FinalizationResource` shape を使う。
- current resource の `runtimeDiagnostics.progress` は `running` のときに
  `startedAtMs` と estimate から導出する参考値。
- UI は `queuedAtMs`, `startedAtMs`,
  `runtimeDiagnostics.queue.estimatedDurationMs` から表示曲線を算出し、API の
  `runtimeDiagnostics.progress.percent` を実測値として扱わない。
- pending/running では queue object を返しうる。terminal state、queue URL 未設定、非 async path では `null` または省略。
- internal prover/verification SQS message は numeric generation field を持たず、closed discriminator
  `recordType: "prover-work"` または `recordType: "verification-work"` を使う。

### Verification artifact authority と admission

- finalization resource では `result.authority.journal`、verification resource では optional include の
  `journal.value` が proof-bound public journal の canonical authority。
- finalization resource の `result.presentation` と verification resource の `proofAuthority` にある
  `verifiedTally`, `bulletinRoot`, `treeSize`, `sthDigest`, bitmap roots, count fields,
  `inputCommitment` は journal からの response projection/mirror。
- persisted input-side authority は `publicInputArtifact`。private `input.json` を browser API で返さない。
- host claim は `result.authority.imageId` または `proofAuthority.imageId`、`journal.imageId` は
  comparison metadata。`result.presentation.verificationReport` または `verifierResult.report` が
  production success（`status="success"`, `dev_mode_receipt=false`）で、`expected_image_id` と
  `receipt_image_id` が一致する場合に、その `receipt_image_id` を proved identity と扱う。
  failed / dev-mode report の ImageID や report のない status だけでは production proof を示さない。
- `missingSlots` は guest に提示されなかった bulletin slot 数。
- `invalidPresentedSlots` は提示済み in-range slot のうち未計上の slot 数。
- `rejectedRecords` は reject された record 数であり、slot partition ではない。
- `excludedSlots = missingSlots + invalidPresentedSlots` を fail-closed 判定に使う。
- `excludedSlots > 0` は成功 verdict を許可しない。

finalization / verification response schema は object shape に加えて、次の相互整合性を
admission 時に検証する。矛盾する値を補正して成功 resource にしない。

- journal の count/slot partition と tally 合計、journal とその response mirror、存在する
  ImageID 同士を照合する。finalization の election manifest と close statement は同時に
  存在または省略し、存在時は自身の hash/digest と journal authority に整合する必要がある。
- report は terminal status と一致し、`not_run | running` に付けない。report の
  `expected_image_id` は host claim と一致し、success report は一致する
  `receipt_image_id` と `dev_mode_receipt=false` を持つ。failed report は ImageID mismatch
  自体を失敗証拠として保持できる。public report projection は private path を含まず、full
  report artifact の配布は下記の protected endpoint が担う。
- verification は全22 checks と全4 steps を canonical な順序・metadata・inputs で返す。
  公開証拠から評価できる check status、derived check とその source、stage status と
  presentation policy を相互照合する。`fullyVerifiedLabelEligible=true` には required
  checks の全成功、整合した proof/voter evidence、dev-mode や missing evidence の不在、
  `ready` な verified display が必要で、STARK status 単独では許可しない。
- voter evidence の ID、commitment、cast index/root、input commitment と proof authority の
  範囲・値を照合する。finalization の available voter evidence は CT inclusion proof 自体も
  検証し、verification resource も公開証拠に反する inclusion-success claim を拒否する。
- `scenarioId` / `scenarios`、claimed tally、tampered count、tamper summary、検出結果を
  journal の集計・除外情報と照合する。教育用の説明も矛盾した組み合わせを受理しない。

正確な admission 条件は `packages/api-contract/src/schemas/{finalizations,verification}.ts` と
`packages/verification/src/verification/verification-presentation-policy.ts` が所有する。

### Bot privacy と scenario evidence

- `GET /sessions/:sessionId/finalizations/:finalizationId/verification` は `botVotes`、bot の `random`、
  private opening を返さない。
- browser/CLI 向け route は bot vote opening を返さない。
- `botVotesSummary.affectedBotIds` は S3/S4 のみ返しうる。S5 では返さない。
- `affectedBotIds` は配列で、ID は対象 bot vote の `bulletinIndex` と同じ domain（通常 user=0, bot=1..63）。
- `botVotesSummary.source` は必須。例は `scenario_simulation`。
- これらは教育シナリオ由来の privileged explanation であり、暗号学的 evidence ではない。

### Bundle と report の公開境界

- bundle/report は raw S3 URL に redirect せず、capability-checked endpoint が body を返す。
- public `bundle.zip` の required artifacts:
  `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`, `journal.json`
- sync bundle は `metadata.json` を含み、`sth.json` と `consistency-proof.json` を optional で含みうる。
- public bundle に含めない:
  `input.json`, `verification.json`, `included-bitmap.json`, `seen-bitmap.json`
- protected `verification.json` は `/artifacts/report` からだけ取得する。
- completed ZIP は default-deny manifest に対する archive admission を通過したものだけを配布する。
- bundle は byte ranges をサポートする。4 MiB を超える bundle の range なし request は fail closed。
- report が 4 MiB を超える場合は fail closed。
- runtime は一つの artifact reader を明示的に選び、reader failure 時に別 backend へ fallback しない。

## Active UI endpoint details

### POST `/api/sessions`

新規セッションを作成する。

**Body**

```json
{
  "turnstileToken": "string"
}
```

body は schema 上省略可能だが、受付条件は解決済み runtime profile によって決まる。

| Runtime profile / target              | セッション作成の受付条件                                                |
| ------------------------------------- | ----------------------------------------------------------------------- |
| local profiles                        | Turnstile bypass を許可し、token なしで作成可能                         |
| `target-aws-async` / develop          | origin 検証済みの operator-gated 経路で作成可能。Turnstile token は不要 |
| `target-aws-async` / main             | 公開作成を受け付ける。server-side Turnstile 検証が必須で bypass は不可  |
| `target-aws-async-quiesced` / develop | 新規作成を受け付けず、origin 検証後も `404 SESSION_NOT_FOUND`           |

target API は各 route の処理に先立ち、CloudFront の origin 検証 header
`X-Stark-Ballot-Origin-Verify` をサーバー側の期待値と照合する。欠落・不一致は
`403 SAME_ORIGIN_REQUIRED`。これは CloudFront から API への経路検証であり、browser が
送る session capability ではない。また、STH endpoint が別途行う `Origin` と
`Sec-Fetch-Site` の same-origin 検証とも別の条件である。

main の作成要求では `turnstileToken` を server-side Siteverify に送り、成功応答、
`action="session"`、設定された許可 hostname との一致を確認する。token 欠落、challenge
失敗、action または hostname の不一致は `403 CAPTCHA_FAILED` となり、セッションを作成しない。
これらの admission に加え、request schema、rate limit、セッション容量制限を通過すると
以下の `200` 応答を返す。

**Wire response 200**

```json
{
  "data": {
    "sessionId": "uuid",
    "electionId": "uuid",
    "electionConfigHash": "0x...",
    "logId": "string",
    "capabilityToken": "signed-token"
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

### POST `/api/sessions/:sessionId/votes`

ユーザー票を記録し、Bot 投票を開始する。

**Headers**

- `X-Session-Capability`

session identity は path からだけ導出し、handler は別の identity source を参照しない。

**Body**

```json
{
  "vote": "A",
  "rand": "0x...",
  "commitment": "0x...",
  "turnstileToken": "string"
}
```

**Wire response 200**

```json
{
  "data": {
    "voteId": "uuid",
    "commitment": "0x...",
    "bulletinIndex": 0,
    "bulletinRootAtCast": "0x...",
    "castAtMs": 1730000000000
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

### GET `/api/sessions/:sessionId/progress`

**Headers**

- `X-Session-Capability`

session identity は path からだけ導出し、handler は別の identity source を参照しない。

**Wire response 200**

```json
{
  "data": {
    "count": 63,
    "total": 63,
    "completed": true,
    "userVoted": true,
    "finalized": false
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

handler は上記 5 field を返す。schema は `distribution`, `distributionKind`, `updatedAtMs`, `animationSeed` も
optional で許容するが、現行 handler の保証ではない。

### POST `/api/sessions/:sessionId/finalizations`

**Headers**

- `X-Session-Capability`

path の `sessionId` が authority であり、認証には `X-Session-Capability` だけを送る。

**Body**

```json
{
  "scenarioId": "S0",
  "turnstileToken": "string"
}
```

`scenarioId` は必須。改ざんなしでも `S0` を送る。複数 scenario の同時指定はしない。

**Wire response 202 (async)**

```json
{
  "data": {
    "finalizationId": "string",
    "status": "pending",
    "queuedAtMs": 1730000000000,
    "runtimeDiagnostics": {
      "asyncMode": "enabled",
      "queue": {
        "concurrencyLimit": 2,
        "estimatedDurationMs": 360000
      }
    }
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

`runtimeDiagnostics.queue` は横断ポリシーの shape で、schema 上 `null` または省略も許容する。

**Wire response 200 (sync)**

```json
{
  "data": {
    "finalizationId": "string",
    "status": "succeeded",
    "queuedAtMs": 1730000000000,
    "startedAtMs": 1730000000100,
    "completedAtMs": 1730000000200,
    "runtimeDiagnostics": {
      "asyncMode": "disabled"
    },
    "result": {
      "authority": {
        "imageId": "0x...",
        "journal": {
          "electionId": "uuid",
          "electionConfigHash": "0x...",
          "methodVersion": 14,
          "bulletinRoot": "0x...",
          "treeSize": 64,
          "totalExpected": 64,
          "sthDigest": "0x...",
          "verifiedTally": [13, 12, 14, 11, 14],
          "totalVotes": 64,
          "validVotes": 64,
          "invalidVotes": 0,
          "seenIndicesCount": 64,
          "missingSlots": 0,
          "invalidPresentedSlots": 0,
          "rejectedRecords": 0,
          "seenBitmapRoot": "0x...",
          "includedBitmapRoot": "0x...",
          "excludedSlots": 0,
          "inputCommitment": "0x..."
        }
      },
      "presentation": {
        "tally": {
          "counts": { "A": 13, "B": 12, "C": 14, "D": 11, "E": 14 },
          "totalVotes": 64,
          "tamperedCount": 0
        },
        "verifiedTally": [13, 12, 14, 11, 14],
        "tamperDetected": false,
        "scenarios": [],
        "bulletinRoot": "0x...",
        "missingSlots": 0,
        "invalidPresentedSlots": 0,
        "rejectedRecords": 0,
        "totalExpected": 64,
        "treeSize": 64,
        "excludedSlots": 0,
        "sthDigest": "0x...",
        "seenBitmapRoot": "0x...",
        "includedBitmapRoot": "0x...",
        "inputCommitment": "0x...",
        "seenIndicesCount": 64,
        "verificationStatus": "success",
        "verificationReport": {
          "status": "success",
          "verifier_version": "example",
          "verified_at": "2024-10-27T03:33:20Z",
          "duration_ms": 100,
          "expected_image_id": "0x...",
          "receipt_image_id": "0x...",
          "dev_mode_receipt": false
        }
      },
      "voterEvidence": {
        "state": "available",
        "voteReceipt": {
          "voteId": "uuid",
          "commitment": "0x...",
          "bulletinIndex": 0,
          "bulletinRootAtCast": "0x...",
          "castAtMs": 1730000000000,
          "inputCommitment": "0x..."
        },
        "userVote": {
          "commitment": "0x...",
          "voteId": "uuid",
          "proof": {
            "leafIndex": 0,
            "treeSize": 1,
            "merklePath": [],
            "bulletinRootAtCast": "0x..."
          }
        }
      },
      "artifactAvailability": {
        "bundle": "available",
        "report": "available",
        "includedBitmap": "available",
        "seenBitmap": "available"
      }
    }
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

sync `200` と async `202` は同じ strict `FinalizationResource` union を返す。
resource は lifecycle fields、`runtimeDiagnostics`、成功時の `result` に分かれる。
`result` は proof-bound `authority`、derived `presentation`、discriminated
`voterEvidence`、`artifactAvailability` の四 partition であり、古い flat result shape は受理しない。
`journal` は current public journal 全体である。
この例の UUID/hex は説明用 placeholder。cast proof は user vote だけがある tree size 1 の
snapshot、journal はその後の64票の final tree を表す。

- `presentation.scenarios` は S0 なら `[]`、それ以外は S1–S5 のいずれか一つ。
- `voterEvidence.state="available"` は journal と一致する `voteReceipt.inputCommitment` を
  必須とする。`verification-gated` branch は receipt/proof を含まない。
- `artifactAvailability.report` は public report の存在と一致する。failed status では sanitizer
  が public report を省略しても protected artifact が available の場合がある。
- `seenBitmap="available"` は `includedBitmap="available"` を必要とする。bundle と bitmap の
  配布可否はそれぞれの artifact availability で判断する。

### POST `/api/sessions/:sessionId/finalizations/:finalizationId/cancel`

進行中の async finalization を user request として失敗状態へ遷移させる。

**Headers**

- `X-Session-Capability`

path の `sessionId` が authority である。

**Body**

```json
{
  "reason": "Cancelled by user request"
}
```

- `finalizationId` は path authority であり、body に重複させない。
- `reason` は optional、最大 256 chars。
- async mode が有効で、現在の state が `pending | running`、path の finalization ID が一致する場合だけ受け付ける。

**Wire response 200**

```json
{
  "data": {
    "status": "failed",
    "finalizationId": "string",
    "queuedAtMs": 1730000000000,
    "startedAtMs": 1730000020000,
    "failedAtMs": 1730000030000,
    "error": {
      "code": "USER_CANCELLED",
      "message": "Cancelled by user request"
    },
    "runtimeDiagnostics": {
      "asyncMode": "enabled"
    }
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

### GET `/api/sessions/:sessionId/finalizations/current`

**Headers**

- `X-Session-Capability`

path の `sessionId` が authority である。

**Wire response 200**

```json
{
  "data": {
    "status": "running",
    "finalizationId": "string",
    "queuedAtMs": 1730000000000,
    "startedAtMs": 1730000020000,
    "runtimeDiagnostics": {
      "asyncMode": "enabled",
      "queue": {
        "concurrencyLimit": 2,
        "estimatedDurationMs": 360000
      },
      "progress": {
        "phase": "running",
        "source": "derived",
        "percent": 42,
        "updatedAtMs": 1730000030000
      },
      "orchestrator": null
    }
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

- `data` は `pending | running | succeeded | failed | timeout` の `FinalizationResource` または `null`。
- `runtimeDiagnostics.progress` は running 時だけ返しうる derived estimate。
- succeeded resource は create response と同じ partitioned `result` を返す。
- unsupported/corrupt current artifact は standard fail-closed error envelope になる。
- Step Functions projection は `runtimeDiagnostics.orchestrator` に置き、proof や finalization authority にしない。

### GET `/api/sessions/:sessionId/finalizations/:finalizationId/verification?include=journal`

path で指定した current finalization の strict verification resource を返す。

**Headers**

- `X-Session-Capability`

`sessionId` と `finalizationId` は path だけが authority である。

**Query**

- 未指定: `journal = { "representation": "omitted" }`
- `include=journal`: `journal = { "representation": "included", "value": { ... } }`

**Fail-closed wire response 200**

```json
{
  "data": {
    "availability": "unavailable",
    "finalizationId": "string",
    "reason": "finalization_not_current",
    "message": "Requested finalization is not the current finalized authority"
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

`availability="unavailable"` の `reason` は `finalization_not_current |
user_vote_unavailable`、`availability="corrupt"` の `reason` は `invalid_artifact |
incomplete_session_authority | session_identity_mismatch | voter_evidence_mismatch`。どちらも
`finalizationId` と安全な `message` が必須で、UI は成功表示にしてはならない。unknown/malformed
resource も web admission で `reason="invalid_artifact"` の `corrupt` に畳み込む。

**Wire response 200（`verification.steps` / `checks` の配列要素のみ抜粋）**

```json
{
  "data": {
    "availability": "available",
    "finalizationId": "string",
    "proofAuthority": {
      "electionId": "uuid",
      "electionConfigHash": "0x...",
      "logId": "0x...",
      "bulletinRoot": "0x...",
      "imageId": "0x...",
      "verifiedTally": [13, 12, 14, 11, 14],
      "missingSlots": 0,
      "invalidPresentedSlots": 0,
      "rejectedRecords": 0,
      "totalExpected": 64,
      "treeSize": 64,
      "excludedSlots": 0,
      "sthDigest": "0x...",
      "seenBitmapRoot": "0x...",
      "includedBitmapRoot": "0x...",
      "inputCommitment": "0x...",
      "seenIndicesCount": 64
    },
    "presentation": {
      "tally": {
        "counts": { "A": 13, "B": 12, "C": 14, "D": 11, "E": 14 },
        "totalVotes": 64,
        "tamperedCount": 0
      },
      "scenarioId": "S0",
      "tamperDetected": false,
      "policy": {
        "summary": { "status": "missing_evidence", "tone": "warning" },
        "stageStatuses": {
          "cast_as_intended": "not_run",
          "recorded_as_cast": "success",
          "counted_as_recorded": "success",
          "stark_verification": "success"
        },
        "evidenceFullyVerified": false,
        "fullyVerifiedLabelEligible": false,
        "display": {
          "readiness": "ready",
          "source": "summary",
          "status": "warning",
          "renderedStatus": "warning"
        },
        "publishedTallyMismatch": false,
        "devModeEvidence": false,
        "missingEvidence": true
      }
    },
    "verifierResult": {
      "status": "success"
    },
    "verification": {
      "steps": [
        {
          "id": "cast_as_intended",
          "status": "not_run",
          "inputs": ["user.voteId", "user.commitment"]
        }
      ],
      "checks": [
        {
          "id": "cast_receipt_present",
          "status": "not_run",
          "evidence": "local",
          "inputs": ["user.voteId", "user.commitment"]
        }
      ]
    },
    "voterEvidence": {
      "availability": "available",
      "voteReceipt": {
        "voteId": "uuid",
        "commitment": "0x...",
        "bulletinIndex": 0,
        "bulletinRootAtCast": "0x...",
        "castAtMs": 1730000000000,
        "inputCommitment": "0x..."
      },
      "userVote": {
        "commitment": "0x...",
        "voteId": "uuid",
        "proof": {
          "leafIndex": 0,
          "treeSize": 64,
          "merklePath": ["0x..."],
          "bulletinRootAtCast": "0x..."
        }
      }
    },
    "journal": { "representation": "omitted" }
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

- 実際の response は全22 checks と全4 steps を返す。上記配列は構造の説明用抜粋であり、
  このままでは complete inventory の admission を通過しない。
- server projection では Cast-as-Intended は client-side authority のため `not_run`。
- browser は dependency-free な shared local-cast evaluator で local vote opening を評価し、
  server checks に overlay して shared presentation policy を再評価する。
- `userVote.vote` と `userVote.random` は返さない。
- exact proof がない場合は `voterEvidence.availability="unavailable"` と reason を返し、関連 check
  を fail closed にする。
- available branch の `voteReceipt.inputCommitment` は必須。unavailable branch の
  `reason="vote_id_unavailable"` は `userVote.commitment` のみ、
  `reason="exact_proof_unavailable"` はそれに加えて `userVote.voteId` を必須とし、receipt/proof
  を含まない。
- `proofAuthority`, `presentation`, `verifierResult`, `verification`, `voterEvidence`, `journal` は
  available branch の required group。flat compatibility field は受理しない。

### POST `/api/sessions/:sessionId/finalizations/:finalizationId/verification`

STARK receipt verification を開始するか、同一 finalization の現在状態を返す。

**Headers**

- `X-Session-Capability`

session/finalization identity は path のみ。body への identity fallback はない。

**Body**

```json
{}
```

**Wire response 200**

```json
{
  "data": {
    "verificationStatus": "running",
    "finalizationId": "string",
    "estimatedDurationMs": 4000,
    "idempotent": false
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

- `idempotent=true`: 新規実行せず、既存 terminal/running state を返した。
- `estimatedDurationMs` は UI estimate。
- finalized/current artifact、bundle locator、expected ImageID が揃わない場合は fail closed。

### POST `/api/sessions/:sessionId/finalizations/:finalizationId/verification/observations`

browser が local vote opening から評価した 4 件の Cast-as-Intended status を、現在の finalization に
一度だけ紐付ける。これは privacy-safe bounded observation であり、server-side checks や UI verdict の authority ではない。

**Headers**

- `X-Session-Capability`
- `Content-Type: application/json`

session/finalization identity は path のみである。

**Body**

```json
{
  "castChecks": {
    "cast_receipt_present": "success",
    "cast_choice_range": "success",
    "cast_random_format": "success",
    "cast_commitment_match": "success"
  }
}
```

- 4 key はすべて必須。
- 各 status は `success | failed | not_run`。
- path の `finalizationId` は `[A-Za-z0-9-]+` に一致する safe single path segment。
- path identity は現在の finalized result と一致し、server verification が
  `success | failed | dev_mode` の terminal state でなければならない。
- 最初の valid observation を durable に記録する。
- 同じ fingerprint の再送は idempotent。
- 同一 finalization に異なる observation、stale finalization、non-terminal finalization は
  `409 VERIFICATION_OBSERVATION_CONFLICT`。

**Wire response 200**

```json
{
  "data": {
    "status": "recorded"
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

`status` は `recorded | idempotent`。

UI は verification sequence 完了後、pending check がなく、server payload が検証済みで、表示 verdict が terminal の場合に
best-effort で送る。network error や API error を理由に displayed verdict を変更せず、送信で vote opening 自体を渡さない。

主な state-specific fail-closed error は `SESSION_NOT_FINALIZED`, `USER_NOT_VOTED`,
`VERIFICATION_OBSERVATION_CONFLICT`。

### GET finalization artifact bundle / report

- `/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle`
- `/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/report`

**Headers**

- `X-Session-Capability`

path の session/finalization identity と finalized result の authority が一致する必要がある。
bundle は `200` または valid range に対する `206`。invalid range は `416`。
content と privacy boundary は「Bundle と report の公開境界」に従う。

## Retained owner-inspection endpoint details

### GET `/api/sessions/:sessionId/bulletin?offset=&limit=`

**Headers**

- `X-Session-Capability`

**Wire response 200**

```json
{
  "data": {
    "commitments": ["0x..."],
    "bulletinRoot": "0x...",
    "treeSize": 64,
    "generatedAtMs": 1730000000000,
    "rootHistory": [
      {
        "recordedAtMs": 1730000000000,
        "treeSize": 64,
        "bulletinRoot": "0x..."
      }
    ]
  },
  "meta": {
    "requestId": "trusted-request-id",
    "page": { "nextOffset": null, "hasMore": false }
  }
}
```

- `offset` は共通の整数 wire 規則に従う non-negative safe integer。
- `limit` は positive integer、最大 1000。
- paging 指定時だけ envelope の `meta.page` に
  `{ "nextOffset": 20 | null, "hasMore": true | false }` を返す。
- commitments は bulletin index 順の slice。root/tree size は全体の値。

### GET `/api/sessions/:sessionId/votes/:voteId/inclusion-proof`

**Headers**

- `X-Session-Capability`

finalized session で、次の vote ID だけ取得できる。

- session user 自身の vote ID
- S3/S4 で `affectedBotIds` に含まれる bot index に対応する vote ID

S5 では bot vote はすべて対象外。S3/S4 でも `affectedBotIds` にない bot vote は対象外。
非許可 ID は `VOTE_NOT_FOUND`。
exact CT material がない場合の public error code は `VERIFICATION_FAILED`。内部の
`CT_PROOF_UNAVAILABLE` reason は public `details` として公開しない。

**Wire response 200**

```json
{
  "data": {
    "voteId": "uuid",
    "proof": {
      "leafIndex": 0,
      "treeSize": 64,
      "merklePath": ["0x..."],
      "bulletinRootAtCast": "0x..."
    }
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

### GET `/api/sessions/:sessionId/bulletin/consistency-proof?fromTreeSize=&toTreeSize=`

**Headers**

- `X-Session-Capability`

両 query は共通の整数 wire 規則に従い、
`0 <= fromTreeSize <= toTreeSize <= currentTreeSize` を要求する。

**Wire response 200**

```json
{
  "data": {
    "fromTreeSize": 12,
    "toTreeSize": 64,
    "rootAtFromTreeSize": "0x...",
    "rootAtToTreeSize": "0x...",
    "proofNodes": ["0x..."],
    "generatedAtMs": 1730000000000
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

`fromTreeSize=0` と `fromTreeSize=toTreeSize` では proof nodes は空になりうる。
`oldSubtreeHashes` / `appendSubtreeHashes` は optional debug metadata で、通常の client verification は
normalized `rootAtFromTreeSize`, `rootAtToTreeSize`, `proofNodes` を使う。

### GET `/api/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex`

**Headers**

- `X-Session-Capability`

**Path**

- `voteIndex`: 共通の整数 wire 規則に従う non-negative safe integer。
  authenticated session user の `userVoteIndex` と同じ値だけを許可
- `kind`: required `included | seen`

任意 index の inspection endpoint ではない。32-byte chunk は隣接する最大 255 vote の bit を含みうるため、
handler は user vote index 以外を `INVALID_BITMAP_PROOF_REQUEST` で拒否する。

**Wire response 200**

```json
{
  "data": {
    "leafChunk": "00ff...",
    "auditPath": [{ "hash": "aabb...", "position": "right" }]
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

- `leafChunk` と `auditPath[].hash` は `0x` なし 64-char hex。
- `position` は `left | right`。
- server は raw proof material を返し、bit extraction と root verification は client が行う。
- response は private cache、ETag、`Vary: X-Session-Capability` を使う。matching
  `If-None-Match` には同じ cache header と空 body の `304` を返す。

### GET `/api/sessions/:sessionId/bulletin/sth`

same-origin STH source。static browser configuration では concrete session ID ではなく exact
template `/api/sessions/:sessionId/bulletin/sth` を使用し、API composition が typed path builder で
current session に解決する。optional query は `auditorId` のみ。

**Headers**

- `X-Session-Capability`

**Constraints**

- finalized/current artifact が必要。
- `Origin` が request URL の origin と異なる場合は `403 SAME_ORIGIN_REQUIRED`。
- `Sec-Fetch-Site` が存在する場合、`same-origin | none` 以外は `403 SAME_ORIGIN_REQUIRED`。
- absolute HTTPS auditor source は origin にかかわらず source 自身を external request として取得し、
  session capability や repository-specific session header を転送しない。

**Wire response 200**

```json
{
  "data": {
    "sth": {
      "sthDigest": "0x...",
      "bulletinRoot": "0x...",
      "treeSize": 64,
      "timestamp": 1730000000000,
      "logId": "0x..."
    }
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

`timestamp` は現行 handler では `session.lastActivity`。
未 finalized はこの endpoint 固有の `404 SESSION_NOT_FINALIZED`。

External auditor response は flat canonical record
`{ "sthDigest": "...", "bulletinRoot"?: "...", "treeSize"?: 64, "timestamp"?: ..., "logId"?: "..." }`
だけを受理する。same-origin envelope、`digest` / `root` / `log_id` alias、その他の fallback shape は
external source では受理しない。

### GET `/api/sessions/:sessionId/finalizations/current/input-commitment`

finalized session の canonical zkVM input から `inputCommitment` を再計算する hash-only endpoint。
private input data は返さない。

**Headers**

- `X-Session-Capability`

query は受理しない。`sessionId` は path authority であり、private-input selector や
compatibility parser は存在しない。

**Wire response 200**

```json
{
  "data": {
    "inputCommitment": "0x..."
  },
  "meta": { "requestId": "trusted-request-id" }
}
```

## Scenario ID mapping

UI は内部 ID をラベルとして表示する必要はないが、
`POST /api/sessions/:sessionId/finalizations` には次を送る。

| ID  | 教育シナリオ                   |
| --- | ------------------------------ |
| S0  | 改ざんなし                     |
| S1  | ユーザー票の除外               |
| S2  | ユーザーに関する発表結果改ざん |
| S3  | Bot 票の除外                   |
| S4  | Bot に関する発表結果改ざん     |
| S5  | 複合シナリオ（現行は除外中心） |

S2/S4 は claimed tally の教育用改ざんであり、zkVM input、journal、receipt は正しい集計を保持する。
