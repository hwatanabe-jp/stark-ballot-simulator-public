# 待ち行列仕様（Finalization Queue）

UI リデザインに合わせた **待ち行列（queue）情報**の仕様をまとめる。

## 参照（優先順）

1. `docs/current/ui-redesign/api-contract.md`
2. `docs/current/ui-redesign/design-spec-transparent-trust.md`
3. `docs/current/ui-redesign/finalization-lifecycle/zkvm-progress.md`
4. `docs/current/guides/6-zkvm_design/final_design.md`（語彙の迷いがある場合）

## 目的

- 集計処理の待機列・推定所要時間を UI に提示する。
- 進捗は **実測ではなく**、`queuedAt` / `startedAt` / `estimatedDurationMs` から **一意に算出**する。
- `queue.*` は **近似値**（SQS/ECS 由来）として扱う。

## 用語

- `queuedAt`: キュー投入時刻（epoch ms）
- `startedAt`: 実行開始時刻（epoch ms）
- `estimatedDurationMs`: 推定所要時間（ms）
- `queue.position`: 近似的な待機位置（0 は実行開始を意味する）
- `queue.depth`: 近似的な待機列の深さ
- `queue.concurrencyLimit`: 推定同時実行枠

## API 仕様（UI 契約）

### POST `/api/finalize`（Async 202）

- `queue` を返す（返せない場合は `null`）。
- `queue` を返す場合、`estimatedDurationMs` は必須。

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

### GET `/api/sessions/:id/status`（200）

- `pending` の場合に `queue` を返す（返せない場合は `null`）。`running` では省略する。
- `queue.position = 0` は **実行開始**を意味する。

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
  "progress": {
    "phase": "pending",
    "source": "derived",
    "percent": 12,
    "updatedAt": 1730000009000
  },
  "finalizationResult": null,
  "stepFunctions": null,
  "asyncFinalizationMode": "enabled"
}
```

## 推定値の算出ルール（バックエンド）

### 取得元（SQS の Approximate 指標）

- `ApproximateNumberOfMessages`
- `ApproximateNumberOfMessagesNotVisible`
- `ApproximateNumberOfMessagesDelayed`

### 算出式

- `depth = visible + notVisible + delayed`
- `position`
  - `pending`: `depth`
  - `running/terminal`: `0`
- `concurrencyLimit`
  - `PROVER_LAMBDA_CONCURRENCY` があれば優先
  - それ以外は `2`
- `estimatedDurationMs`
  - **360000**（6分）で固定
- `estimatedStartAt`
  - `pending`: `queuedAt + floor((position - 1) / concurrencyLimit) * estimatedDurationMs`
  - `running/terminal`: `startedAt` を優先（無ければ `queuedAt`）
- `estimatedCompletionAt = estimatedStartAt + estimatedDurationMs`

## フォールバック / 省略条件

- `FINALIZE_ASYNC_MODE !== 'true'` の場合は `queue: null`。
- `PROVER_WORK_QUEUE_URL` 未設定 or SQS 取得失敗時は `queue: null`。
- いずれの場合も **API 自体は成功**させ、UI は欠落を許容する。

## UI 側の前提

- 進捗は `queuedAt` / `startedAt` / `estimatedDurationMs` から **UI が算出**する。
- `progress.percent` は参照値に留め、UI の補間関数が正とする。
