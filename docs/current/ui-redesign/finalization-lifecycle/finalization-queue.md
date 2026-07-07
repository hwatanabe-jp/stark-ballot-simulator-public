# 待ち行列仕様（Finalization Queue）

UI リデザインに合わせた **待ち行列（queue）情報**の仕様をまとめる。

## 参照（優先順）

1. `docs/current/ui-redesign/api-contract.md`
2. `docs/current/ui-redesign/design-spec-transparent-trust.md`
3. `docs/current/ui-redesign/finalization-lifecycle/zkvm-progress.md`
4. `docs/current/guides/6-zkvm_design/final_design.md`（語彙の迷いがある場合）

## 目的

- 集計処理の同時実行枠と典型所要時間を UI に提示する。
- 実行中の進捗は **実測ではなく**、`startedAt` / `estimatedDurationMs` から UI が算出する。
- `queue.*` は position / depth を含まない。Step Functions semaphore 導入後の
  SQS depth は dispatch backlog であり、semaphore 待ちの execution 数や正確な
  queue position ではないため、UI には表示しない。
- 表示する値はそれぞれ source を明示する。`concurrencyLimit` は runtime config、
  `estimatedDurationMs` は典型所要時間の固定値であり、どちらも live queue
  position ではない。

## 用語

- `queuedAt`: キュー投入時刻（epoch ms）
- `startedAt`: 実行開始時刻（epoch ms）。semaphore 導入後は prover capacity を
  取得して proof 実行を開始する時刻を指す
- `estimatedDurationMs`: 推定所要時間（ms）
- `queue.concurrencyLimit`: prover 同時実行枠。`PROVER_MAX_CONCURRENT_PROVERS`
  が最優先、legacy `PROVER_LAMBDA_CONCURRENCY` が fallback、未設定時は `2`
- `queue.estimatedDurationMs`: 典型所要時間。現在は **360000**（6分）の固定値

現在の target async flow では、`pending` が SQS 待機、dispatcher handoff、
Step Functions setup、および Step Functions semaphore 待ちを含む。`running`
は `MarkProverStarted` が semaphore slot 取得後に記録した時点から始まり、
`startedAt` は prover capacity を取得して proof 実行を開始する時刻である。
dispatcher が `StartExecution` に成功しただけでは `running` にしない。

## API 仕様（UI 契約）

### POST `/api/finalize`（Async 202）

- `queue` を返す（返せない場合は `null`）。
- `queue` を返す場合、payload は `{ concurrencyLimit, estimatedDurationMs }` のみ。
- `position`、`depth`、`estimatedStartAt`、`estimatedCompletionAt` は存在しない。

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
    "concurrencyLimit": 2,
    "estimatedDurationMs": 360000
  }
}
```

### GET `/api/sessions/:id/status`（200 / pending）

- `pending` では、`PROVER_WORK_QUEUE_URL` が設定されていれば static estimate として
  `queue` を返す。
- `pending` では `progress` を返さない。
- slot 待ち中は `pending` のまま扱う。
- SQS depth が 0 でも `queue: null` にはしない。SQS depth は表示しない。

```json
{
  "sessionId": "uuid",
  "finalizationState": {
    "status": "pending",
    "executionId": "string",
    "queuedAt": 1730000000000
  },
  "queue": {
    "concurrencyLimit": 2,
    "estimatedDurationMs": 360000
  },
  "finalizationResult": null,
  "stepFunctions": null,
  "asyncFinalizationMode": "enabled"
}
```

### GET `/api/sessions/:id/status`（200 / running）

- `running` でも queue info を返せる場合は同じ payload shape を返す。
- `progress` は `startedAt` と `queue.estimatedDurationMs` から補間する。
- `running` は semaphore slot 取得後の proof 実行開始を意味する。

```json
{
  "sessionId": "uuid",
  "finalizationState": {
    "status": "running",
    "executionId": "string",
    "queuedAt": 1730000000000,
    "startedAt": 1730000360000
  },
  "queue": {
    "concurrencyLimit": 2,
    "estimatedDurationMs": 360000
  },
  "progress": {
    "phase": "running",
    "source": "derived",
    "percent": 42,
    "updatedAt": 1730000390000
  },
  "finalizationResult": null,
  "stepFunctions": null,
  "asyncFinalizationMode": "enabled"
}
```

## 推定値の算出ルール（バックエンド）

### 取得元

Queue info path は SQS `GetQueueAttributes` を呼ばない。SQS の
`ApproximateNumberOfMessages*` は dispatch backlog の運用指標であり、UI queue
payload の source ではない。

### 算出式

- `concurrencyLimit`
  - `PROVER_MAX_CONCURRENT_PROVERS` があれば優先
  - それ以外は legacy `PROVER_LAMBDA_CONCURRENCY`
  - それ以外は `2`
  - target Terraform では `PROVER_MAX_CONCURRENT_PROVERS` が
    `var.prover_max_concurrent_provers` から渡される
- `estimatedDurationMs`
  - **360000**（6分）で固定

## フォールバック / 省略条件

- `FINALIZE_ASYNC_MODE !== 'true'` の場合は `queue: null`。
- `PROVER_WORK_QUEUE_URL` 未設定の場合は `queue: null`。
- SQS 読み取りは行わないため、SQS 取得失敗による `queue: null` は存在しない。
- いずれの場合も **API 自体は成功**させ、UI は欠落を許容する。

## UI 側の前提

- pending 中は進捗バーを 0% に保ち、`queue` があれば同時実行枠と典型所要時間を
  source 付きで表示する。
- running 中は `startedAt` / `estimatedDurationMs` から `ProgressDisplay` が補間する。
- 100% への遷移は時間ではなく、完了状態を受け取ったときの UI アニメーションで行う。
- API の `progress.percent` は参照値に留め、表示上の進捗は UI の補間を正とする。
- UI は exact queue position、SQS depth、推定開始時刻、real-time push notification
  を約束しない。
