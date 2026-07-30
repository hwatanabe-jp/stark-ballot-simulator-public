# UI 向け API 契約（現行実装）

本書は現行 UI が利用する API と、検証画面から参照可能な owner-scoped evidence API の契約をまとめる。
将来案や移行履歴ではなく、現在の route inventory、schema、handler、tests を記述対象とする。

実装上の正は次の順で確認する。

1. `apps/api/src/server/api/routes/definitions.ts`
2. `packages/api-contract/src/api-contract/routes.ts`
3. `packages/api-contract/src/validation/apiSchemas.ts`
4. `apps/api/src/server/api/handlers/*` と route/schema tests

本書と実装が不一致の場合は実装を正とし、handler、schema、tests、関連ドキュメントを同時に更新する。

## Route inventory

Base path は `/api`。以下は `TARGET_API_ROUTE_CONTRACTS` と現行 Hono registration に対応する。

### Active UI / browser lifecycle

| Method | Path                                                   | Auth scope                  | 主用途                           |
| ------ | ------------------------------------------------------ | --------------------------- | -------------------------------- |
| POST   | `/session`                                             | public mutation             | セッション作成                   |
| POST   | `/vote`                                                | header session + capability | ユーザー票の記録                 |
| GET    | `/progress`                                            | header session + capability | Bot 投票進捗                     |
| POST   | `/finalize`                                            | header session + capability | 同期/非同期集計の開始            |
| POST   | `/finalize/cancel`                                     | header session + capability | 進行中の非同期集計のキャンセル   |
| GET    | `/sessions/:sessionId/status`                          | path session + capability   | 集計状態の取得                   |
| GET    | `/verify`                                              | header session + capability | 検証用 public projection         |
| POST   | `/verification/run`                                    | header session + capability | STARK receipt 検証の開始/再取得  |
| POST   | `/verification/observation`                            | header session + capability | browser-local cast checks の観測 |
| GET    | `/verification/bundles/:sessionId/:executionId`        | path session + capability   | public bundle の認証済み取得     |
| GET    | `/verification/bundles/:sessionId/:executionId/report` | path session + capability   | protected report の認証済み取得  |

### Active retained owner inspection / evidence

これらは通常の画面遷移そのものではないが、owner-scoped verification evidence を取得する現行 route である。
full-bulletin や private bitmap sidecar を public anonymous surface として公開するものではない。

| Method | Path                          | Auth scope                       | 主用途                              |
| ------ | ----------------------------- | -------------------------------- | ----------------------------------- |
| GET    | `/bulletin`                   | header session + capability      | bulletin commitments の owner 閲覧  |
| GET    | `/bulletin/consistency-proof` | header session + capability      | RFC 6962 consistency proof          |
| GET    | `/bulletin/:voteId/proof`     | header session + capability      | 許可された個票の inclusion proof    |
| GET    | `/bitmap-proof`               | header session + capability      | ユーザー票 index の bitmap proof    |
| GET    | `/sth`                        | same-origin session + capability | same-origin STH source              |
| GET    | `/zkvm-input-hash`            | query session + capability       | finalized input commitment の再計算 |

### Retired / internal-only

| Method | Path                 | Lifecycle              | 現行 runtime contract                                                   |
| ------ | -------------------- | ---------------------- | ----------------------------------------------------------------------- |
| GET    | `/debug/enable`      | retired                | Hono runtime に登録せず、公開 debug activation を提供しない             |
| GET    | `/botdata/:id`       | retired                | Hono runtime に登録せず、bot opening を公開しない                       |
| POST   | `/finalize/callback` | internal-operator-only | HMAC callback 用。通常 Lambda registration と browser contract から除外 |

## 共通仕様

### HTTP envelope と認証

- JSON endpoint の `Content-Type` は `application/json`。
- 多くの成功応答は `{ "data": { ... } }` の `ApiResponse`。
- 標準エラーは `{ "error": "ERROR_CODE", "message": "...", "statusCode": 400, ... }`。
- `/finalize` の async 応答、`/finalize/cancel`、session status、bulletin/bitmap/STH/hash endpoint、
  bundle/report 配信、fail-closed artifact 応答は endpoint 個別の非 `ApiResponse` shape を使う。
- header-scoped route は `X-Session-ID` と `X-Session-Capability` を送る。
- path-scoped route は path の `sessionId` を authority とし、`X-Session-Capability` のみ送る。
- `/zkvm-input-hash` は query の `sessionId` を authority とし、`X-Session-Capability` のみ送る。
- capability token は同一 origin の session route にだけ送る。第三者 origin へ転送しない。

`POST /session`、`POST /vote`、`POST /finalize` の canonical UI field は `turnstileToken`。
request schema は Turnstile 境界との互換のため `cf-turnstile-response` と `cfTurnstileResponse` も許容する。
本番での必須条件と bypass 可否は route admission control と runtime config に従う。

### 値と共通型

- `ScenarioId`: `S0 | S1 | S2 | S3 | S4 | S5`
- `VoteChoice`: `A | B | C | D | E`
- 時刻: epoch milliseconds
- `VerificationStatus`: `success | failed | dev_mode | not_run | running`
- `VerificationStepStatus`: `success | failed | running | not_run | pending`
- 通常の 32-byte hex: `0x` prefix 付き canonical value を返す。bitmap raw material は endpoint 個別仕様を使う。
- canonical 名: `bulletinRoot`, `treeSize`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`,
  `inputCommitment`, `verifiedTally`, `bulletinRootAtCast`
- `merkleRoot`, `rootAtTime` などの旧名を UI contract として受け付けない。

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
  inputs?: string[];
  error?: string;
};

type VerificationCheck = {
  id: VerificationCheckId;
  status: VerificationStepStatus;
  evidence: 'local' | 'public' | 'zk' | 'demo';
  inputs: string[];
  noteKey?:
    | 'pages.verify.stepsCard.notes.myVoteIncluded.notPresented'
    | 'pages.verify.stepsCard.notes.myVoteIncluded.presentedButInvalid'
    | 'pages.verify.stepsCard.notes.myVoteIncluded.excluded'
    | 'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt'
    | 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable';
  derivedFrom?: VerificationCheckId;
};
```

現行 handler は `VerificationStep.inputs` を生成するが、public response schema では `inputs` と `error` は optional。
`noteKey` は `counted_my_vote_included` などの explainability 表示に使う公開 i18n key である。

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

`verificationSteps[].status` は stage の現在 required な checks から導出する。
required check が `failed`, `not_run`, `pending`, `running` の場合、完全な verified state にしてはならない。

### UI presentation-only state

次は API authority ではない。

- `proofBundleStatus`: authenticated bundle の UI download state から導出
- `knowledgePanel.new`: UI animation state
- verification step/check の表示順と段階表示
- 集計/検証中の時間ベース補間

`POST /verification/observation` も verdict authority ではない。browser-local cast checks を bounded telemetry として
server に伝えるだけで、送信成功/失敗によって UI の検証結果を変更しない。

## 横断ポリシー

### Queue と擬似進捗

queue payload は次だけを返す。

```ts
type FinalizationQueue = {
  concurrencyLimit: number;
  estimatedDurationMs: number;
};
```

- `concurrencyLimit` は `PROVER_MAX_CONCURRENT_PROVERS`、legacy `PROVER_LAMBDA_CONCURRENCY`、default `2` の順。
- `estimatedDurationMs` の現行 default は `360000`。
- SQS depth、queue position、estimated start/completion は公開 payload に含めない。
- `/finalize` の async 応答と session status で同じ shape を使う。
- status route の `progress` は `running` のときに `startedAt` と estimate から導出する参考値。
- UI は `queuedAt`, `startedAt`, `estimatedDurationMs` から表示曲線を算出し、API の `progress.percent` を実測値として扱わない。
- pending/running では queue object を返しうる。terminal state、queue URL 未設定、非 async path では `null` または省略。

### Verification artifact authority

- `journal` が proof-bound public payload の canonical authority。
- top-level の `verifiedTally`, `bulletinRoot`, `treeSize`, `sthDigest`, bitmap roots, count fields,
  `inputCommitment` は response projection/mirror。
- persisted input-side authority は `publicInputArtifact`。private `input.json` を browser API で返さない。
- top-level `imageId` は host claim、`journal.imageId` は comparison metadata、
  verifier 後の proved identity は `verificationReport.receipt_image_id`。
- `missingSlots` は guest に提示されなかった bulletin slot 数。
- `invalidPresentedSlots` は提示済み in-range slot のうち未計上の slot 数。
- `rejectedRecords` は reject された record 数であり、slot partition ではない。
- `excludedSlots = missingSlots + invalidPresentedSlots` を fail-closed 判定に使う。
- `excludedSlots > 0` は成功 verdict を許可しない。

### Bot privacy と scenario evidence

- `/verify` は `botVotes`、bot の `random`、private opening を返さない。
- retired `/botdata/:id` を browser/CLI から利用しない。
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
- protected `verification.json` は `/report` からだけ取得する。
- S3-backed bundle は byte ranges をサポートする。4 MiB を超える bundle の range なし request は fail closed。
- S3-backed report が 4 MiB を超える場合は fail closed。

## Active UI endpoint details

### POST `/api/session`

新規セッションを作成する。

**Body**

```json
{
  "turnstileToken": "string"
}
```

body は schema 上省略可能。runtime admission が Turnstile を要求する場合は token が必要。

**Response 200 (`ApiResponse`)**

```json
{
  "data": {
    "sessionId": "uuid",
    "electionId": "uuid",
    "electionConfigHash": "0x...",
    "logId": "string",
    "contractGeneration": "2026-04-zkvm-current-v1",
    "capabilityToken": "signed-token"
  }
}
```

### POST `/api/vote`

ユーザー票を記録し、Bot 投票を開始する。

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Body**

```json
{
  "vote": "A",
  "rand": "0x...",
  "commitment": "0x...",
  "turnstileToken": "string"
}
```

**Response 200 (`ApiResponse`)**

```json
{
  "data": {
    "voteId": "uuid",
    "commitment": "0x...",
    "bulletinIndex": 0,
    "bulletinRootAtCast": "0x...",
    "timestamp": 1730000000000
  }
}
```

### GET `/api/progress`

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Response 200 (`ApiResponse`)**

```json
{
  "data": {
    "count": 63,
    "total": 63,
    "completed": true,
    "userVoted": true,
    "finalized": false
  }
}
```

handler は上記 5 field を返す。schema は `distribution`, `distributionKind`, `updatedAt`, `animationSeed` も
optional で許容するが、現行 handler の保証ではない。

### POST `/api/finalize`

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Body**

```json
{
  "scenarioId": "S0",
  "turnstileToken": "string"
}
```

`scenarioId` は必須。改ざんなしでも `S0` を送る。複数 scenario の同時指定はしない。

**Response 202 (async、非 `ApiResponse`)**

```json
{
  "executionId": "string",
  "statusUrl": "https://example.test/api/sessions/session-id/status",
  "state": {
    "status": "pending",
    "executionId": "string",
    "queuedAt": 1730000000000
  },
  "queue": {
    "concurrencyLimit": 2,
    "estimatedDurationMs": 360000
  }
}
```

`queue` は横断ポリシーの shape で、schema 上 `null` または省略も許容する。

**Response 200 (sync、`ApiResponse`)**

```json
{
  "data": {
    "sessionId": "uuid",
    "tally": {
      "counts": { "A": 13, "B": 12, "C": 14, "D": 11, "E": 14 },
      "totalVotes": 64,
      "tamperedCount": 0
    },
    "bulletinRoot": "0x...",
    "verifiedTally": [13, 12, 14, 11, 14],
    "voteReceipt": {
      "voteId": "uuid",
      "commitment": "0x...",
      "bulletinIndex": 0,
      "bulletinRootAtCast": "0x...",
      "timestamp": 1730000000000,
      "inputCommitment": "0x..."
    },
    "imageId": "0x...",
    "userVote": {
      "commitment": "0x...",
      "voteId": "uuid",
      "proof": {
        "leafIndex": 0,
        "treeSize": 64,
        "merklePath": ["0x..."],
        "bulletinRootAtCast": "0x..."
      }
    },
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
    "journal": {
      "methodVersion": 14,
      "bulletinRoot": "0x...",
      "treeSize": 64,
      "includedBitmapRoot": "0x...",
      "inputCommitment": "0x..."
    },
    "verificationStatus": "success",
    "verificationExecutionId": "string"
  }
}
```

`receipt`, `receiptPublication`, `verificationReport`, `tamperSummary`, `seenBitmapRoot` は schema 上 optional。
`journal` は current public journal 全体であり、例は主要 field のみ。

### POST `/api/finalize/cancel`

進行中の async finalization を user request として失敗状態へ遷移させる。

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Body**

```json
{
  "executionId": "string",
  "reason": "Cancelled by user request"
}
```

- `executionId` は必須で safe path segment、10 chars 以上。
- `reason` は optional、最大 256 chars。
- async mode が有効で、現在の state が `pending | running`、execution ID が一致する場合だけ受け付ける。

**Response 200 (非 `ApiResponse`)**

```json
{
  "state": {
    "status": "failed",
    "executionId": "string",
    "queuedAt": 1730000000000,
    "startedAt": 1730000020000,
    "failedAt": 1730000030000,
    "error": {
      "code": "USER_CANCELLED",
      "message": "Cancelled by user request"
    }
  }
}
```

### GET `/api/sessions/:sessionId/status`

**Headers**

- `X-Session-Capability`

`X-Session-ID` は不要。

**Response 200 (非 `ApiResponse`)**

```json
{
  "sessionId": "uuid",
  "finalizationState": {
    "status": "running",
    "executionId": "string",
    "queuedAt": 1730000000000,
    "startedAt": 1730000020000
  },
  "queue": {
    "concurrencyLimit": 2,
    "estimatedDurationMs": 360000
  },
  "progress": {
    "phase": "running",
    "source": "derived",
    "percent": 42,
    "updatedAt": 1730000030000
  },
  "finalizationResult": null,
  "stepFunctions": null,
  "asyncFinalizationMode": "enabled"
}
```

- `finalizationState` は `pending | running | succeeded | failed | timeout` または `null`。
- `progress` は running 時だけ返しうる derived estimate。
- completed session では `finalizationResult` を返す。sync completion では `finalizationState=null` でも結果がありうる。
- unsupported/corrupt artifact では `artifactState` を返し、結果を fail closed に投影する。
- `stepFunctions` は DescribeExecution projection または `null`。

### GET `/api/verify?includeJournal=1`

finalized session の検証用 public projection を返す。

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Query**

- 未指定: `journal` を省略し、`journalStatus="omitted"`
- `includeJournal=1`: current public `journal` を含め、`journalStatus="available"`
- schema は forward-compatible に `journalStatus="unavailable"` も許容するが、現行 handler は返さない

**Fail-closed Response 200 (非 `ApiResponse`)**

```json
{
  "error": "UNSUPPORTED_CURRENT_ARTIFACT",
  "message": "Finalized state is unsupported for the current contract generation",
  "artifactState": "unsupported_current_artifact"
}
```

`error` は `UNSUPPORTED_CURRENT_ARTIFACT | CORRUPT_OR_UNREADABLE_FINALIZED_STATE`、
`artifactState` は `unsupported_current_artifact | corrupt_or_unreadable`。
UI は成功表示にしてはならない。

**Response 200 (`ApiResponse`、抜粋)**

```json
{
  "data": {
    "electionId": "uuid",
    "electionConfigHash": "0x...",
    "logId": "string",
    "tally": {
      "counts": { "A": 13, "B": 12, "C": 14, "D": 11, "E": 14 },
      "totalVotes": 64,
      "tamperedCount": 0
    },
    "bulletinRoot": "0x...",
    "scenarioId": "S0",
    "verificationStatus": "success",
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
    "seenIndicesCount": 64,
    "journalStatus": "omitted",
    "voteReceipt": {
      "voteId": "uuid",
      "commitment": "0x...",
      "bulletinIndex": 0,
      "bulletinRootAtCast": "0x...",
      "timestamp": 1730000000000,
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
    },
    "verificationExecutionId": "string",
    "verificationSteps": [
      {
        "id": "cast_as_intended",
        "status": "not_run",
        "inputs": ["user.voteId", "user.commitment"]
      }
    ],
    "verificationChecks": [
      {
        "id": "cast_receipt_present",
        "status": "not_run",
        "evidence": "local",
        "inputs": ["user.voteId", "user.commitment"]
      }
    ]
  }
}
```

- `verificationChecks` は現行 22 check をすべて返す。例は抜粋。
- server projection では Cast-as-Intended は client-side authority のため `not_run`。
- browser は local vote opening から cast checks を評価する。
- `userVote.vote` と `userVote.random` は返さない。
- `userVote.proof` は optional。なければ許可された vote-proof endpoint から取得する。
- `verificationReport`, `verificationSteps`, `verificationChecks`, `voteReceipt`, `userVote`,
  `botVotesSummary`, `tamperSummary`, `seenBitmapRoot`, `verificationExecutionId` などは schema 上 optional。

### POST `/api/verification/run`

STARK receipt verification を開始するか、同一 execution の現在状態を返す。

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Body**

```json
{}
```

**Response 200 (`ApiResponse`)**

```json
{
  "data": {
    "verificationStatus": "running",
    "verificationExecutionId": "string",
    "estimatedDurationMs": 4000,
    "idempotent": false
  }
}
```

- `idempotent=true`: 新規実行せず、既存 terminal/running state を返した。
- `estimatedDurationMs` は UI estimate。
- finalized/current artifact、bundle locator、expected ImageID が揃わない場合は fail closed。

### POST `/api/verification/observation`

browser が local vote opening から評価した 4 件の Cast-as-Intended status を、現在の verification execution に
一度だけ紐付ける。これは privacy-safe bounded observation であり、server-side checks や UI verdict の authority ではない。

**Headers**

- `X-Session-ID`
- `X-Session-Capability`
- `Content-Type: application/json`

**Body**

```json
{
  "verificationExecutionId": "string",
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
- `verificationExecutionId` は safe single path segment、最大 256 chars。
- `verificationExecutionId` は現在の finalized result と一致し、server verification が
  `success | failed | dev_mode` の terminal state でなければならない。
- 最初の valid observation を durable に記録する。
- 同じ fingerprint の再送は idempotent。
- 同一 execution に異なる observation、stale execution、non-terminal execution は
  `409 VERIFICATION_OBSERVATION_CONFLICT`。

**Response 200 (`ApiResponse`)**

```json
{
  "data": {
    "status": "recorded"
  }
}
```

`status` は `recorded | idempotent`。

UI は verification sequence 完了後、pending check がなく、server payload が検証済みで、表示 verdict が terminal の場合に
best-effort で送る。network error や API error を理由に displayed verdict を変更せず、送信で vote opening 自体を渡さない。

主な fail-closed error は `SESSION_NOT_FINALIZED`, `UNSUPPORTED_CURRENT_ARTIFACT`,
`CORRUPT_OR_UNREADABLE_FINALIZED_STATE`, `VERIFICATION_OBSERVATION_CONFLICT`。

### GET verification bundle / report

- `/api/verification/bundles/:sessionId/:executionId`
- `/api/verification/bundles/:sessionId/:executionId/report`

**Headers**

- `X-Session-Capability`

`X-Session-ID` は不要。path の session/execution identity と finalized result の authority が一致する必要がある。
bundle は `200` または valid range に対する `206`。invalid range は `416`。
content と privacy boundary は「Bundle と report の公開境界」に従う。

## Retained owner-inspection endpoint details

### GET `/api/bulletin?offset=&limit=`

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Response 200 (非 `ApiResponse`)**

```json
{
  "commitments": ["0x..."],
  "bulletinRoot": "0x...",
  "treeSize": 64,
  "timestamp": 1730000000000,
  "rootHistory": [
    {
      "timestamp": 1730000000000,
      "treeSize": 64,
      "bulletinRoot": "0x..."
    }
  ],
  "nextOffset": 20,
  "hasMore": true
}
```

- `offset` は non-negative integer。
- `limit` は positive integer、最大 1000。
- paging 指定時だけ `nextOffset` / `hasMore` を返す。`nextOffset` は終端で `null`。
- commitments は bulletin index 順の slice。root/tree size は全体の値。

### GET `/api/bulletin/:voteId/proof`

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

finalized session で、次の vote ID だけ取得できる。

- session user 自身の vote ID
- S3/S4 で `affectedBotIds` に含まれる bot index に対応する vote ID

S5 では bot vote はすべて対象外。S3/S4 でも `affectedBotIds` にない bot vote は対象外。
非許可 ID は `VOTE_NOT_FOUND`。
exact CT material がない場合は `VERIFICATION_FAILED`、`details: CT_PROOF_UNAVAILABLE`。

**Response 200 (非 `ApiResponse`)**

```json
{
  "voteId": "uuid",
  "proof": {
    "leafIndex": 0,
    "treeSize": 64,
    "merklePath": ["0x..."],
    "bulletinRootAtCast": "0x..."
  }
}
```

### GET `/api/bulletin/consistency-proof?oldSize=&newSize=`

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

`0 <= oldSize <= newSize <= currentTreeSize` を要求する。

**Response 200 (非 `ApiResponse`)**

```json
{
  "oldSize": 12,
  "newSize": 64,
  "rootAtOldSize": "0x...",
  "rootAtNewSize": "0x...",
  "proofNodes": ["0x..."],
  "timestamp": 1730000000000
}
```

`oldSize=0` と `oldSize=newSize` では proof nodes は空になりうる。
`oldSubtreeHashes` / `appendSubtreeHashes` は optional debug metadata で、通常の client verification は
normalized `rootAtOldSize`, `rootAtNewSize`, `proofNodes` を使う。

### GET `/api/bitmap-proof?i=&kind=included|seen`

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Query**

- `i`: authenticated session user の `userVoteIndex` と同じ値だけを許可
- `kind`: `included | seen`、default `included`

任意 index の inspection endpoint ではない。32-byte chunk は隣接する最大 255 vote の bit を含みうるため、
handler は user vote index 以外を `INVALID_BITMAP_PROOF_REQUEST` で拒否する。

**Response 200 (非 `ApiResponse`)**

```json
{
  "leafChunk": "00ff...",
  "auditPath": [{ "hash": "aabb...", "position": "right" }]
}
```

- `leafChunk` と `auditPath[].hash` は `0x` なし 64-char hex。
- `position` は `left | right`。
- server は raw proof material を返し、bit extraction と root verification は client が行う。
- response は private cache、ETag、`Vary: X-Session-ID, X-Session-Capability` を使う。

### GET `/api/sth`

same-origin STH source。cross-origin request を明示的に拒否する。

**Headers**

- `X-Session-ID`
- `X-Session-Capability`

**Constraints**

- finalized/current artifact が必要。
- `Origin` が request URL の origin と異なる場合は `403 SAME_ORIGIN_REQUIRED`。
- `Sec-Fetch-Site` が存在する場合、`same-origin | none` 以外は `403 SAME_ORIGIN_REQUIRED`。
- third-party STH source は別 origin の source 自身を直接取得し、この endpoint の session capability を転送しない。

**Response 200 (非 `ApiResponse`)**

```json
{
  "sth": {
    "sthDigest": "0x...",
    "bulletinRoot": "0x...",
    "treeSize": 64,
    "timestamp": 1730000000000,
    "logId": "0x..."
  }
}
```

`timestamp` は現行 handler では `session.lastActivity`。
未 finalized はこの endpoint 固有の `404 SESSION_NOT_FINALIZED`。

### GET `/api/zkvm-input-hash?sessionId=...`

finalized session の canonical zkVM input から `inputCommitment` を再計算する hash-only endpoint。
private input data は返さない。

**Headers**

- `X-Session-Capability`

**Query**

- `sessionId`: 必須
- `includeData`: truthy (`true | 1 | yes`) variant は retired で `410 ROUTE_RETIRED`

**Response 200 (非 `ApiResponse`)**

```json
{
  "inputCommitment": "0x..."
}
```

## Scenario ID mapping

UI は内部 ID をラベルとして表示する必要はないが、`POST /finalize` には次を送る。

| ID  | 教育シナリオ                   |
| --- | ------------------------------ |
| S0  | 改ざんなし                     |
| S1  | ユーザー票の除外               |
| S2  | ユーザーに関する発表結果改ざん |
| S3  | Bot 票の除外                   |
| S4  | Bot に関する発表結果改ざん     |
| S5  | 複合シナリオ（現行は除外中心） |

S2/S4 は claimed tally の教育用改ざんであり、zkVM input、journal、receipt は正しい集計を保持する。
