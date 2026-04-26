# UI リデザイン API 契約（現行実装）

UI リデザインで利用する API の現行契約を `docs/current/ui-redesign/` に集約する。
本文中の endpoint / payload / verification contract は、現ブランチの実装
（`src/server/api/handlers/*`, `src/lib/validation/apiSchemas.ts`）と照合した shape を優先する。
コードと本文が不一致の場合は、現行コードと route/schema tests を正とする。

## 前提

- **現行実装契約**: 本書は現在の UI/API が使う shape を記録する。将来の変更案ではなく、変更時は handler、schema、tests、関連ドキュメントを同時に更新する。
- **語彙と型の正規化**: `docs/current/guides/6-zkvm_design/final_design.md` を語彙の**正**とし、**API は正規名のみを返す/受ける**。alias は移行メモとしてのみ記載する。
- **擬似進捗（ブラウザ算出）**: 進捗率は“実測値”ではない。API は _開始時刻・待ち行列情報_ を返し、**ブラウザ側で一意な算出式**（時間ベース補間）から曲線進行を生成する。API 側が `progress` を返す場合でも **演出用の参考値**であり、UI は算出値を優先する。
- **待機列情報**: ECS Fargate の待機列・同時実行枠の情報は **バックエンド実装を増やして提供する**。現行実装では **非同期モードが有効で `PROVER_WORK_QUEUE_URL` が設定され、SQS メトリクス取得に成功した場合のみ** `queue` に object を返し、それ以外では **`queue: null`** とする（schema 上は省略も許容）。
- **改ざん指示**: UI はシナリオ記号を表示しない。**API は `scenarioId` を必須**とし、`S0..S5` を扱う（`tamperScenarioId` は採用しない）。`S0` は「改ざんなし」。**単一選択のみ**（組み合わせは将来拡張）。
- **tally 形状の統一**: `tally` は常に `{ counts: { A..E }, totalVotes }` で返す（`tally` の直下に集計値を置かない）。
- **検証開始のタイミング**: `/verify` は到達時に自動で検証シーケンスを開始し、**準備中表示が終わるまで結果を表示しない**。API が検証結果を既に返せる状態でも UI は非表示を維持する。
- **ボット検証**: `/api/verify` から `botVotes` は返さない。**オンデマンド取得のみ**にする。`botVotesSummary.affectedBotIds` は **S3/S4 のみ**返す（S5 は表示しない）。契約は **配列** とし、UI は 0..n 件を許容する。現行デモシナリオでは通常 1 件だが、暗号学的な証拠ではなく**教育用シミュレーション由来の特権情報**であることを明示する。
- **ボット ID の同一性**: `botId` は **該当ボット票の `bulletinIndex` と一致**し、`botVotesSummary.affectedBotIds` と `/api/botdata/:id` で同一の ID を使用する。**ユーザー票の index とは衝突しない**ことを保証する（例: user=0, bot=1..63 の予約ドメイン）。
- **Bulletin commitments**: `bulletin.commitments` は廃止しないが、`/api/verify` には含めない。**Recorded-as-Cast を行う場合**は `/api/bulletin`（ページング可）で取得するか、`/api/bulletin/:voteId/proof` で **対象票のみ**取得する。`/api/verify` では `bulletinRoot` / `treeSize` のみ返す。
- **/result 分離採用**: 結果フェーズは `/result` に分離する。
- **契約は本フォルダで一元管理**。

## 共通仕様

- **Base path**: `/api`（Next.js Route Handler または Hono 経由で同一仕様）
- **Content-Type**: `application/json`
- **エンベロープ**: ほとんどの API は `ApiResponse` 形式で返す。
  - 例: `{ "data": { ... } }`
  - エラー: `{ "error": "ERROR_CODE", "message": "...", "statusCode": 400, ... }`
  - 例外: `/api/finalize` の **Async** 応答、`/api/finalize/cancel`、`/api/sessions/:id/status`、`/api/sth`、ファイル配信系、および各 endpoint 節で **非 ApiResponse** と明記したものはラップ無し
- **セッション識別**:
  - `X-Session-ID` は **header-scoped な session endpoint** に送る。
  - 対象例: `/api/vote`, `/api/progress`, `/api/finalize`, `/api/finalize/cancel`, `/api/verify`, `/api/verification/run`, `/api/bulletin/*`, `/api/bitmap-proof`, `/api/sth`, `/api/botdata/:id`
  - **session-scoped mutation / read / restore / verification 系は `X-Session-Capability` が必須**。
  - path-scoped endpoint（`/api/sessions/:id/status`, `/api/verification/bundles/*`）は `sessionId` を path から解決するため、**`X-Session-Capability` のみ必須**で `X-Session-ID` は不要。
- **Turnstile**: `turnstileToken` は JSON body に含める（本番では必須）
- **値形式**
  - Hex: 原則 `0x` + 64 hex（32-byte, lower-case 推奨）。ただし raw Merkle/bitmap materials など endpoint 個別仕様はその記述を優先する
  - 時刻: epoch millis（例: `queuedAt` / `startedAt`）
  - `VerificationStatus`: `success | failed | dev_mode | not_run | running`
- **語彙/命名規約（final_design 優先）**
  - 以降の API 契約は `docs/current/guides/6-zkvm_design/final_design.md` の語彙を**正**とする。
  - 正規名: `bulletinRoot`, `treeSize`, `sthDigest`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `verifiedTally`, `bulletinRootAtCast`
  - alias（過去仕様/実装で使われる可能性のある名称）: `merkleRoot` / `tally.merkleRoot` / `rootAtTime` は **移行メモ用途のみ**。UI/ API は受け付けない。
- **正規化ルール**
  - **旧名/別名は受け付けない**。混入した場合は **エラー** または **無視** とし、UI 表示に露出させない。
  - 包含証明/整合性証明は現行では RFC 6962 / CT path として暗黙に扱う。
- **推定値の扱い（進捗/待機列）**
  - **SQS**: queue depth / position は **Approximate** な値として扱う。
  - **ECS**: `concurrencyLimit` は実行枠の推定（`runningCount/desiredCount` 等）として扱う。
  - **Step Functions**: execution の状態・開始/終了時刻の参照先。
  - いずれも UI 表示用の推定値とし、正確性は保証しない。

### 共通型（抜粋）

- `ScenarioId`: `S0 | S1 | S2 | S3 | S4 | S5`
- `scenarioId`（必須）: `ScenarioId`（**未指定は不可。改ざんなしは `S0` を送信**）
- `BotId`: `1..63`（`bulletinIndex` と一致、ユーザー票の index は除外）
- `Tally`:
  - `counts`: `{ A: number; B: number; C: number; D: number; E: number }`
  - `totalVotes`: number
  - `tamperedCount?`: number
- `BulletinState`:
  - `bulletinRoot`: string
  - `treeSize`: number
- `InclusionProof`:
  - `leafIndex`: number
  - `treeSize`: number
  - `merklePath`: string[]
  - `bulletinRootAtCast`: string
- `JournalStatus`: `available | omitted | unavailable`
- `VerificationStepId`:
  - `cast_as_intended | recorded_as_cast | counted_as_recorded | stark_verification`
- `VerificationStepStatus`:
  - `success | failed | running | not_run | pending`
- `VerificationStep`:
  - `id`: `VerificationStepId`
  - `status`: `VerificationStepStatus`
  - `inputs`: string[]（知識パネルの正規キー）
  - **`inputs` の解釈**: 知識パネルのキー名リストであり、**UI 生成のキー（例: `proofBundleStatus`）を含んでもよい**。この場合でも API がその実体値を返すとは限らない。
  - **`status` の意味**:
    - `pending`: 検証フローに含まれるが未開始（順次表示の待機状態）
    - `not_run`: 実行されていない/されない（ユーザー未開始・前提欠如など）
- `VerificationEvidence`:
  - `local | public | zk | demo`
- `VerificationCheckId`:
  - Cast-as-Intended:
    - `cast_receipt_present`
    - `cast_choice_range`
    - `cast_random_format`
    - `cast_commitment_match`
  - Recorded-as-Cast:
    - `recorded_commitment_in_bulletin`
    - `recorded_index_in_range`
    - `recorded_root_at_cast_consistent`
    - `recorded_inclusion_proof`
    - `recorded_consistency_proof`
    - `recorded_sth_third_party`
  - Counted-as-Recorded:
    - `counted_input_sanity`
    - `counted_unique_indices`
    - `counted_unique_commitments`
    - `counted_tally_consistent`
    - `counted_missing_indices_zero`
    - `counted_expected_vs_tree_size`
    - `counted_election_manifest_consistent`
    - `counted_close_statement_consistent`
    - `counted_my_vote_included`
    - `counted_input_commitment_match`
  - STARK Verification:
    - `stark_image_id_match`
    - `stark_receipt_verify`
- `VerificationCheck`:
  - `id`: `VerificationCheckId`
  - `status`: `VerificationStepStatus`
  - `evidence`: `VerificationEvidence`
  - `inputs`: string[]（知識パネルの正規キー）
  - `derivedFrom?`: `VerificationCheckId`（他項目の結果を参照する場合）
  - **`inputs` の解釈**: `VerificationStep.inputs` と同様（UI 生成のキーを含んでもよい）

### UI 生成データ（API 非依存）

- `proofBundleStatus`: ダウンロード状態から UI が導出（初期は「未ダウンロード」）
- `knowledgePanel.new`: 追加/更新直後の強調状態（アニメーション用）
- `verificationSteps` の表示順・遅延演出は UI 側で制御（API は結果のみ返す）
- `verificationChecks` は**詳細チェック結果**で、表示順は UI 側で制御（API は結果のみ返す）

---

## エンドポイント（UI 使用）

### POST `/api/session`

新規セッション作成。

**Request**

- Body（省略可。session-create Turnstile が有効な環境では送信）:

```json
{
  "turnstileToken": "string"
}
```

**Response 200 (ApiResponse)**

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

---

### POST `/api/vote`

投票 + Bot 投票開始。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Body**

```json
{
  "vote": "A",
  "rand": "0x...",
  "commitment": "0x...",
  "turnstileToken": "string"
}
```

**Response 200 (ApiResponse)**

```json
{
  "data": {
    "voteId": "uuid",
    "commitment": "0x...",
    "bulletinIndex": 12,
    "bulletinRootAtCast": "0x...",
    "timestamp": 1730000000000
  }
}
```

**主なエラー**

- `SESSION_ID_REQUIRED`, `SESSION_CAPABILITY_REQUIRED`, `SESSION_CAPABILITY_INVALID`, `INVALID_VOTE_CHOICE`, `INVALID_COMMITMENT`
- `ALREADY_VOTED`, `SESSION_FINALIZED`, `CAPTCHA_FAILED`, `DUPLICATE_VOTE`

---

### GET `/api/progress`

Bot 投票進捗。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Response 200 (ApiResponse)**

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

**備考**

- 現行実装では `count`, `total`, `completed`, `userVoted`, `finalized` を返す。
- `distribution`, `distributionKind`, `updatedAt`, `animationSeed` は**将来拡張のために schema 上は許容されるが、現行 handler では返却を保証しない**。
- UI は **数値表示を行わず**、視覚的な「増加感」のみを表現する（デザイン意図は `docs/current/ui-redesign/design-spec-transparent-trust.md` を参照）。

---

### POST `/api/finalize`

集計の開始。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Body**

```json
{
  "scenarioId": "S1",
  "turnstileToken": "string"
}
```

- `scenarioId` は **必須**。改ざんなしは `S0` を送信する。
- UI は単一選択のため、送信は `scenarioId` の単一値のみ。

**Response 202 (Async / 非 ApiResponse)**

```json
{
  "executionId": "string",
  "statusUrl": "https://.../api/sessions/:sessionId/status",
  "state": {
    "status": "pending",
    "executionId": "string",
    "queuedAt": 1730000000000
  },
  "queue": {
    "position": 3,
    "depth": 8,
    "concurrencyLimit": 2,
    "estimatedStartAt": 1730000020000,
    "estimatedDurationMs": 360000,
    "estimatedCompletionAt": 1730000380000
  }
}
```

**備考**

- `queue.*` は推定値（SQS/ECS 由来）として扱う。
- `queue` を返す場合、`estimatedDurationMs` は **必須**（擬似進捗の一意算出に利用）。
- 現行実装では `queue` は **pending かつ queue depth を観測できた場合**に限って object になる。`pending` でも depth が 0 なら `queue: null` になりうる。
- 非同期モードが無効、`PROVER_WORK_QUEUE_URL` 未設定、または SQS メトリクス取得に失敗した場合、現行 handler は **`queue: null`** を返す（schema 上は省略も許容）。

**Response 200 (Sync / ApiResponse)**

```json
{
  "data": {
    "sessionId": "uuid",
    "tally": {
      "counts": { "A": 1, "B": 2, "C": 3, "D": 4, "E": 5 },
      "totalVotes": 64,
      "tamperedCount": 0
    },
    "bulletinRoot": "0x...",
    "verifiedTally": [1, 2, 3, 4, 5],
    "voteReceipt": {
      "voteId": "uuid",
      "commitment": "0x...",
      "bulletinIndex": 0,
      "bulletinRootAtCast": "0x...",
      "timestamp": 1730000000000,
      "inputCommitment": "0x..."
    },
    "receipt": {
      "imageId": "0x...",
      "seal": "base64...",
      "journal": "base64...",
      "metadata": { "isFake": false }
    },
    "receiptPublication": { "receiptHash": "0x...", "boardIndex": 1 },
    "imageId": "0x...",
    "userVote": {
      "commitment": "0x...",
      "voteId": "uuid",
      "proof": {
        "leafIndex": 0,
        "merklePath": ["0x..."],
        "treeSize": 64,
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
      "methodVersion": 12,
      "bulletinRoot": "0x...",
      "treeSize": 64,
      "seenBitmapRoot": "0x...",
      "includedBitmapRoot": "0x...",
      "inputCommitment": "0x..."
    },
    "verificationStatus": "success",
    "verificationReport": { "status": "success", "duration_ms": 1234 },
    "verificationExecutionId": "string",
    "tamperSummary": {
      "ignoredVotes": 0,
      "recountedVotes": 0,
      "userRecountedTo": null,
      "affectedBotIds": []
    }
  }
}
```

- `journal` は current public journal 全体を含む。上の例では主要 field のみを抜粋している。

**主なエラー**

- `SESSION_ID_REQUIRED`, `USER_NOT_VOTED`, `VOTING_NOT_COMPLETE`
- `SESSION_ALREADY_FINALIZED`, `CAPTCHA_FAILED`, `ZKVM_RATE_LIMIT_EXCEEDED`
- `INVALID_SCENARIO`

---

### POST `/api/finalize/cancel`

進行中の Async 集計をキャンセルする。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Body**

```json
{
  "executionId": "string",
  "reason": "Cancelled by user request"
}
```

- `executionId` は必須。
- `reason` は任意（最大 256 chars）。未指定時は `"Cancelled by user request"` が使われる。

**Response 200 (非 ApiResponse)**

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

**備考**

- 現行 handler は `FINALIZE_ASYNC_MODE=true` のときのみ有効。
- `finalizationState.status` が `pending | running` で、かつ body の `executionId` が現在の state と一致する場合のみキャンセル可能。
- Step Functions 実行 ARN があり `PROVER_STEP_FUNCTIONS_ENABLED=true` の場合は `StopExecution` を試みる。停止 API 呼び出しに失敗しても、session state の fail-closed 更新は継続する。
- 成功時は `state.status=failed` とし、`error.code=USER_CANCELLED` を返す。

**主なエラー**

- `SESSION_ID_REQUIRED`, `SESSION_CAPABILITY_REQUIRED`, `SESSION_CAPABILITY_INVALID`
- `SESSION_NOT_FOUND`, `GLOBAL_LIMIT_EXCEEDED`, `UNSUPPORTED_CURRENT_ARTIFACT`, `CORRUPT_OR_UNREADABLE_FINALIZED_STATE`
- handler 固有の非標準 error payload: `Async finalization disabled` (`404`), `Invalid JSON body` (`400`), payload validation error (`400`), `Store does not support cancellation` (`501`), `Finalization cannot be cancelled in its current state` (`409`)

---

### GET `/api/sessions/:sessionId/status`

Async 集計のステータス。

**Headers**

- `X-Session-Capability: <capabilityToken>`

**Response 200 (非 ApiResponse)**

```json
{
  "sessionId": "uuid",
  "finalizationState": {
    "status": "pending",
    "executionId": "string",
    "queuedAt": 1730000000000
  },
  "queue": {
    "position": 3,
    "depth": 3,
    "concurrencyLimit": 2,
    "estimatedStartAt": 1730000020000,
    "estimatedDurationMs": 360000,
    "estimatedCompletionAt": 1730000380000
  },
  "finalizationResult": null,
  "stepFunctions": null,
  "asyncFinalizationMode": "enabled"
}
```

**Response 200 (running 例 / 非 ApiResponse)**

```json
{
  "sessionId": "uuid",
  "finalizationState": {
    "status": "running",
    "executionId": "string",
    "queuedAt": 1730000000000,
    "startedAt": 1730000020000
  },
  "queue": null,
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

**備考**

- `progress` は **実測ではない**。現行 API では **`finalizationState.status=running` のときだけ** `startedAt` と `estimatedDurationMs` から導出して返す。
- **UI の正**: ブラウザ側で `queuedAt` / `startedAt` / `estimatedDurationMs` から擬似進捗を算出する。`progress.percent` は参考値であり、**演出用の算出値は UI を正とする**。
- `pending` では `progress` は返らない。UI は `finalizationState` と `queue` の時刻情報から待機状態を表現する。
- `queue.*` は推定値（SQS/ECS 由来）として扱う。
- `queue` は **pending 時のみ object を返す**（running では現行 handler は **`queue: null`** を返す）。
- 現行 UI/API では、**`queue` が消えて `progress` が出始めたこと**を実行開始のシグナルとして扱う。`queue.position=0` を前提にしない。
- `queue` の構造は `/api/finalize` の Async 応答と同じ。
- `queue` を返す場合、`estimatedDurationMs` は **必須**（擬似進捗の一意算出に利用）。
- finalized artifact が現行 contract と一致しない場合、`artifactState`（`unsupported_current_artifact | corrupt_or_unreadable`）を返す。この場合 `finalizationResult` は `null` で、`finalizationState` は失敗状態へ投影されることがある。
- `stepFunctions` は Step Functions の DescribeExecution 情報（存在する場合のみ）。
- 非同期モードが無効、`PROVER_WORK_QUEUE_URL` 未設定、または SQS メトリクス取得に失敗した場合、現行 handler は **`queue: null`** を返す（schema 上は省略も許容）。
- `finalizationResult` は **集計完了時のみ**返す。`finalizationState=null` でも **同期集計が完了している場合は返却される**。

---

### GET `/api/verify?includeJournal=1`

集計済みセッションの検証用データ取得。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Query**

- `includeJournal=1`: session に保持された `journal` を含めて返す（大容量のため **明示指定時のみ**。未指定時は `journalStatus=omitted`）

**備考**

- `includeJournal=1` のメリット:
  - Counted-as-Recorded の詳細検証（`journal` 依存）を UI/ローカルで実行できる
  - 監査・検証ログの透明性を担保できる
- `includeJournal=1` のデメリット:
  - 応答サイズが大きく、表示/保存が重くなる
  - 通信/メモリ負荷が増える（モバイルで顕著）
  - 不要な画面でも payload を重くする
- `botVotes` は返さない（プライバシー保護のため）。
- `bulletin.commitments` は返さない（サイズ削減のため）。必要な場合は `/api/bulletin` を利用する。
- 対象ボットは `botVotesSummary.affectedBotIds` を参照し、詳細は `/api/botdata/:id` で取得する。
- `/api/bulletin/:voteId/proof` は **投票者の voteId** または **affectedBotIds に含まれる bot の voteId** のみ取得可能。
- `journal` は `includeJournal=1` 指定時のみ含まれ、未指定時は省略される。
- `journalStatus` の現行 handler 挙動は `available | omitted`。schema 上は forward-compatible な予約値として `unavailable` も許容する。
  - `available`: `journal` を含む（session data 上で利用可能）
  - `omitted`: `includeJournal` 未指定のため省略
  - `unavailable`: schema 予約値。現行 handler は返さない
- `journal` の現行 public contract は `methodVersion=12` で、`seenBitmapRoot` を含みうる。
- `journal` が canonical な proof-bound payload。`verifiedTally`, `bulletinRoot`, `sthDigest`, `seenIndicesCount`, `missingSlots`, `invalidPresentedSlots`, `rejectedRecords`, `excludedSlots`, `seenBitmapRoot`, `includedBitmapRoot`, `inputCommitment`, `treeSize`, `totalExpected` の top-level 重複項目は、現行では response mirror とみなし、authority は `journal` に置く。
- persisted な input-side authority は `publicInputArtifact` に置く。検証時にはそこから内部 adapter として `publicInputSummary` を導出することがあるが、現行の public response は top-level `publicInputSummary` を返さない。`electionManifest`, `closeStatement`, `tally`, `tamperDetected`, `tamperSummary`, `scenarios`, `verification*` も journal-derived cache ではなく、authority class が異なるため top-level cache と同列に canonicalize しない。
- top-level `imageId` は verifier 実行前の host claim。`journal.imageId` は comparison-only metadata。verifier 実行後の proved identity は `verificationReport.receipt_image_id`。
- 現行 count field の意味:
  - `missingSlots`: guest に提示されなかった bulletin slot 数（slot ベース）
  - `invalidPresentedSlots`: 提示された in-range slot のうち未計上になった slot 数（slot ベース）
  - `rejectedRecords`: guest に提示された record のうち reject された件数（record ベース）
  - `excludedSlots`: fail-closed 判定に使う slot ベース除外数（`missingSlots + invalidPresentedSlots`）
- fail-closed 判定は **`excludedSlots` を正**とする。`rejectedRecords` は record ベースの explainability 用であり、slot partition に単純加算しない。
- 個票 explainability は `seenBitmapRoot` / `includedBitmapRoot` と private bitmap artifact に依存する。count field だけで各 index の状態を完全には説明しない。
- `userVote.proof` は `InclusionProof`。省略される場合、Recorded-as-Cast のために `/api/bulletin/:voteId/proof` を取得する。
- `userVote.vote` / `userVote.random` は **現行 `/api/verify` では返さない**。投票時の private data はクライアント側に留める。
- `botVotesSummary.affectedBotIds` は ScenarioProcessor の changes から抽出する **教育デモ用の特権データ**。契約上は配列で、現行デモでは通常 1 件。S5 の場合は返さない（ボット検証画面を出さない）。
- `botVotesSummary.source` は **必須**（例: `scenario_simulation`）。暗号学的証拠ではないことを明示する。
- `/api/verify` は `verificationReport` を返すが、詳細レポートの direct URL は返さない。詳細レポート取得は `/api/verification/bundles/:sessionId/:executionId/report` を使用する。
- `proofBundleStatus` は **UI 側のダウンロード状態**から導出する（API が返す場合は表示上のヒントに限る）。
- `verificationSteps[].status` は **その stage の required checks から導出**される。`/api/verify` では Cast-as-Intended は client-side 扱いのため、step/check ともに `not_run` が返る。
- `verificationChecks` は **常に current `VerificationCheckId` の全 22 件**を返す。`verificationSteps[].inputs` は各 step の check 定義から集約され、Counted stage には `electionManifest` / `closeStatement` 由来の key も含まれる。
- 以下の JSON 例では `verificationChecks` は抜粋のみを掲載し、実レスポンスは 22 件すべてを含む。

**Current artifact fail-closed Response 200 (非 ApiResponse)**

```json
{
  "error": "UNSUPPORTED_CURRENT_ARTIFACT",
  "message": "Finalized state is unsupported for the current contract generation",
  "artifactState": "unsupported_current_artifact"
}
```

- `artifactState` は `unsupported_current_artifact | corrupt_or_unreadable`。
- UI はこの応答を検証失敗として扱い、成功表示にしてはならない。

**Response 200 (ApiResponse)**

```json
{
  "data": {
    "electionId": "uuid",
    "electionConfigHash": "0x...",
    "logId": "string",
    "tally": {
      "counts": { "A": 1, "B": 2, "C": 3, "D": 4, "E": 5 },
      "totalVotes": 64,
      "tamperedCount": 0
    },
    "bulletinRoot": "0x...",
    "scenarioId": "S0",
    "verificationStatus": "success",
    "verificationReport": { "status": "success", "duration_ms": 1234 },
    "imageId": "0x...",
    "tamperDetected": false,
    "verifiedTally": [1, 2, 3, 4, 5],
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
        "merklePath": ["0x..."],
        "treeSize": 64,
        "bulletinRootAtCast": "0x..."
      }
    },
    "verificationExecutionId": "string",
    "tamperSummary": {
      "ignoredVotes": 0,
      "recountedVotes": 0,
      "userRecountedTo": null
    },
    "verificationSteps": [
      {
        "id": "cast_as_intended",
        "status": "not_run",
        "inputs": ["user.voteId", "user.commitment", "user.choice", "user.random", "electionId"]
      },
      {
        "id": "recorded_as_cast",
        "status": "success",
        "inputs": ["user.commitment", "user.voteReceipt", "user.merklePath", "treeSize", "bulletinRoot", "sthDigest"]
      },
      {
        "id": "counted_as_recorded",
        "status": "success",
        "inputs": [
          "proofBundleStatus",
          "bulletinRoot",
          "treeSize",
          "tally.counts",
          "tally.totalVotes",
          "missingSlots",
          "invalidPresentedSlots",
          "totalExpected",
          "electionManifest",
          "electionId",
          "electionConfigHash",
          "closeStatement",
          "logId",
          "timestamp",
          "sthDigest",
          "includedBitmapRoot",
          "user.voteReceipt",
          "inputCommitment"
        ]
      },
      {
        "id": "stark_verification",
        "status": "success",
        "inputs": ["imageId", "proofBundleStatus"]
      }
    ],
    "verificationChecks": [
      {
        "id": "cast_receipt_present",
        "status": "not_run",
        "evidence": "local",
        "inputs": ["user.voteId", "user.commitment"]
      },
      {
        "id": "recorded_consistency_proof",
        "status": "success",
        "evidence": "public",
        "inputs": ["user.voteReceipt", "user.merklePath", "bulletinRoot", "treeSize"]
      },
      {
        "id": "counted_election_manifest_consistent",
        "status": "success",
        "evidence": "public",
        "inputs": ["electionManifest", "electionId", "electionConfigHash", "proofBundleStatus"]
      },
      {
        "id": "counted_close_statement_consistent",
        "status": "success",
        "evidence": "public",
        "inputs": ["closeStatement", "logId", "timestamp", "sthDigest", "bulletinRoot", "treeSize"]
      },
      {
        "id": "counted_my_vote_included",
        "status": "success",
        "evidence": "zk",
        "inputs": ["includedBitmapRoot", "user.voteReceipt"]
      },
      {
        "id": "stark_receipt_verify",
        "status": "success",
        "evidence": "zk",
        "inputs": ["proofBundleStatus"]
      }
    ]
  }
}
```

---

### GET `/api/bulletin`

Bulletin board から `commitments` とルート情報を取得する。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Query（任意）**

- `offset`: 取得開始位置（ページング用）
- `limit`: 取得件数（ページング用）

**Response 200 (非 ApiResponse)**

```json
{
  "commitments": ["0x...", "0x..."],
  "bulletinRoot": "0x...",
  "treeSize": 64,
  "timestamp": 1730000000000,
  "rootHistory": [{ "timestamp": 1730000000000, "bulletinRoot": "0x...", "treeSize": 64 }],
  "nextOffset": 20,
  "hasMore": true
}
```

**備考**

- `commitments` は大きくなりうるため、UI ではページング取得を推奨。
- `commitments` は **bulletinIndex 順**のスライス。`bulletinRoot` / `treeSize` は全体の値。
- `offset/limit` を指定した場合は `nextOffset` / `hasMore` を返す（未指定時は `null` or 省略）。
- `rootHistory` がある場合、各要素は `bulletinRoot` を正規名とする。

**主なエラー**

- `INVALID_OFFSET`, `INVALID_LIMIT`
- `INVALID_REQUEST`（`details: BULLETIN_STATE_UNAVAILABLE`）

---

### GET `/api/bulletin/:voteId/proof`

単一投票の包含証明（Recorded-as-Cast 用）。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**制約**

- セッションが **finalize 済み**であること。
- 取得可能な `voteId` は以下に限定:
  - 投票者自身の `voteId`
  - `scenarioId` が **S3/S4** の場合のみ、`botVotesSummary.affectedBotIds` に含まれる bot の `voteId`
- 該当しない場合は `VOTE_NOT_FOUND` を返す。S5 は対象外。
- 取得対象でも exact CT proof が利用できない場合は `VERIFICATION_FAILED`（`details: CT_PROOF_UNAVAILABLE`）を返す。

**Response 200 (非 ApiResponse)**

```json
{
  "voteId": "uuid",
  "proof": {
    "leafIndex": 0,
    "merklePath": ["0x..."],
    "treeSize": 64,
    "bulletinRootAtCast": "0x..."
  }
}
```

**主なエラー**

- `INVALID_VOTE_ID`, `SESSION_NOT_FINALIZED`, `VOTE_NOT_FOUND`
- `VERIFICATION_FAILED`（`details: CT_PROOF_UNAVAILABLE`）

---

### GET `/api/bulletin/consistency-proof?oldSize=&newSize=`

分割ビュー攻撃対策のための整合性証明。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Query**

- `oldSize`: 旧 checkpoint の tree size（必須, non-negative integer）
- `newSize`: 新 checkpoint の tree size（必須, non-negative integer）

**Response 200 (非 ApiResponse)**

```json
{
  "oldSize": 12,
  "newSize": 64,
  "rootAtOldSize": "ab12...",
  "rootAtNewSize": "cd34...",
  "proofNodes": ["ef56..."],
  "timestamp": 1730000000000
}
```

**備考**

- `oldSize <= newSize <= currentTreeSize` を満たす必要がある。
- `oldSize=0` は許容され、その場合 `proofNodes` は空になりうる。
- **この endpoint の現行 handler は `rootAtOldSize` / `rootAtNewSize` / `proofNodes` を `0x` なしの raw hex で返す**（他 endpoint の 32-byte hex ルールとは別扱い）。
- `oldSubtreeHashes` / `appendSubtreeHashes` は schema 上の optional field。現行の bulletin handler（RFC 6962 / CT path）では通常は返さない。返る場合は `"size:hash"` 形式の debug metadata とみなす。
- client-side の Recorded-as-Cast 整合性検証では主に `rootAtOldSize`, `rootAtNewSize`, `proofNodes` を用いる。

---

### GET `/api/bitmap-proof?i=&kind=included|seen`

Counted-as-Recorded の explainability 用に bitmap Merkle proof 材料を取得する。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Query**

- `i`: 対象 index（0-based, 必須）
- `kind`: `included | seen`（省略時は `included`）

**Response 200 (非 ApiResponse)**

```json
{
  "leafChunk": "00ff...",
  "auditPath": [{ "hash": "aabb...", "position": "right" }]
}
```

**備考**

- `included` は counted bitmap、`seen` は prover に提示された index bitmap を表す。
- `leafChunk` は 32-byte chunk の hex 文字列（`0x` なし, 64 chars）。
- `auditPath` は `{ hash, position }[]`。`hash` は 32-byte hex（`0x` なし, 64 chars）、`position` は `left | right`。
- 返すのは **raw materials のみ**で、bit 解釈と root 検証はクライアント側で行う。
- Cache-Control は `private, immutable`（24h）想定。

---

### GET `/api/sth`

STH（Signed Tree Head）スナップショットを返す。第三者 STH 照合で same-origin source として使われる。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**制約**

- セッションが **finalize 済み**であること。
- finalized artifact が現行 contract と一致しない場合は fail-closed error を返す。

**Response 200 (非 ApiResponse)**

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

**備考**

- `sth` object は `src/lib/verification/sth-verifier.ts` の parser が読む shape。
- `sth.timestamp` は journal 内 timestamp ではなく、現行 handler では `session.lastActivity` を返す。
- same-origin の `/api/sth` には session auth headers を転送する。cross-origin の third-party STH source には capability token を送らない。

**主なエラー**

- `SESSION_ID_REQUIRED`, `SESSION_CAPABILITY_REQUIRED`, `SESSION_CAPABILITY_INVALID`
- `SESSION_NOT_FINALIZED` (`404`; この endpoint 固有の扱い)
- `UNSUPPORTED_CURRENT_ARTIFACT`, `CORRUPT_OR_UNREADABLE_FINALIZED_STATE`, `INTERNAL_ERROR`

### POST `/api/verification/run`

STARK 検証の実行（必要時）。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**Body**

```json
{}
```

**Response 200 (ApiResponse)**

```json
{
  "data": {
    "verificationStatus": "running",
    "verificationExecutionId": "string",
    "estimatedDurationMs": 4000,
    "idempotent": true
  }
}
```

**備考**

- `idempotent=true` は「新規実行せず、既存の実行状態を返した」ことを意味する。
- `estimatedDurationMs` は UI 用の目安（**固定値でも可**）で、実測ではない。

---

### GET `/api/verification/bundles/:sessionId/:executionId`

### GET `/api/verification/bundles/:sessionId/:executionId/report`

ローカル検証用のバンドル / レポート取得。UI は `sessionId` と `verificationExecutionId` からこの endpoint を組み立てて利用する。

**Headers**

- `X-Session-Capability: <capabilityToken>`

**備考**

- path-scoped endpoint のため `X-Session-ID` は不要。
- `bundle` / `report` は、S3 配信が有効な環境では presigned URL へ `302` redirect することがある。
- `bundle.zip` は **public bundle** を返す。現行 contract:
  - sync: `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`, `journal.json`, `metadata.json`（+ optional `sth.json`, `consistency-proof.json`）
  - async: `public-input.json`, `election-manifest.json`, `close-statement.json`, `receipt.json`, `journal.json`
- public `bundle.zip` に **含めない**: `input.json`, `verification.json`, `included-bitmap.json`, `seen-bitmap.json`
- `/report` は authenticated な `verification.json` を返す。

---

### GET `/api/botdata/:id`

ボット検証用の投票データを **オンデマンド取得**。

**Headers**

- `X-Session-ID: <sessionId>`
- `X-Session-Capability: <capabilityToken>`

**制約**

- 現行実装での server-side 制約は **finalize 済み + `id` が有効範囲内 + 対応する bot vote が存在すること**。
- UI 上は `botVotesSummary.affectedBotIds` に含まれる ID のみをリンク対象とする。
- `scenarioId` が **S3/S4** 以外では通常 `botVotesSummary` 自体が表示されない。
- `id` は **botId（bulletinIndex と一致）**。`affectedBotIds` と同一の ID ドメインを使用する。
- 応答生成は bulletin からの包含証明生成に依存するため、proof 生成や hex 正規化に失敗した場合は `INTERNAL_ERROR` を返す。

**Response 200 (ApiResponse)**

```json
{
  "data": {
    "id": 12,
    "vote": "B",
    "random": "0x...",
    "commitment": "0x...",
    "voteId": "uuid",
    "timestamp": 1730000000000,
    "proof": {
      "leafIndex": 12,
      "merklePath": ["0x..."],
      "treeSize": 64,
      "bulletinRootAtCast": "0x..."
    }
  }
}
```

**主なエラー**

- `INVALID_BOT_ID`, `BOT_DATA_NOT_FOUND`, `SESSION_NOT_FINALIZED`, `INTERNAL_ERROR`

---

## 改ざんシナリオ ID マッピング

UI ラベルは自由だが、API 送信は以下の ID を利用する。

| ScenarioId | 意味（参考）             |
| ---------- | ------------------------ |
| S0         | 改ざんなし               |
| S1         | あなたの票の除外         |
| S2         | 発表結果改ざん（あなた） |
| S3         | ボット票の除外           |
| S4         | 発表結果改ざん（ボット） |
| S5         | 複合改ざん（除外のみ）   |

**注記**

- S2 / S4 は **教育用シミュレーション**（発表結果改ざん）。zkVM入力・証明は正しい集計のまま。
- UI は記号を出さず、内部的に `S0..S5` へマッピングして送信する。

---

## Breaking Changes Log

- 2026-01-07: `tally` 形状を `{ counts, totalVotes }` に統一（直下集計値を廃止）
- 2026-01-07: `rootAtTime` を `bulletinRootAtCast` に統一（InclusionProof）
- 2026-01-07: `/api/verify` から `botVotes` を廃止し、`/api/botdata/:id` のオンデマンド取得に一本化
- 2026-01-07: `/api/sessions/:id/status` の待機列情報を `queue` オブジェクトに統一
- 2026-01-07: `/api/bulletin` の `rootHistory[].bulletinRoot` を正規名化（`root` は廃止）
- 2026-03-26: `/api/verify` の verification contract を **22 checks / stage-required derivation** に更新
- 2026-03-26: `/api/verify` の current payload に `seenBitmapRoot` / `journal.methodVersion=12` を反映
- 2026-03-26: `/api/bitmap-proof` の `kind=included|seen` と public/private bundle 境界を追記
