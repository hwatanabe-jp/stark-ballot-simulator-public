# 待ち行列仕様（Finalization Queue）

集計処理の待機状態、典型所要時間、および時間ベースの進捗表示について、現在の
server API と UI の契約をまとめる。ここで扱う queue 情報は presentation 用の
static estimate であり、実際の待ち行列位置や実測進捗ではない。

## 参照（優先順）

1. `docs/ui/api-contract.md`
2. `docs/ui/design-spec-transparent-trust.md`
3. `docs/ui/finalization-lifecycle/zkvm-progress.md`
4. `docs/zkvm/final-design.md`（語彙の迷いがある場合）

## Target profile の admission

Queue authority は loose な環境変数フラグではなく、起動時に解決済みの runtime
profile から決まる。

- 通常の target UI/API path は `target-aws-async` を使う。この profile は
  finalization mode が async で、SQS と Step Functions を選択する。
- `target-aws-async-quiesced` も既存の async work を読み取れる server recovery
  posture だが、新しい public session は受け付けず、browser profile ではない。
- Target async profile は `PROVER_WORK_QUEUE_URL` を必須とする。値が欠落または
  target account / region / resource name と整合しない場合は profile resolution
  が fail closed になり、handler の queue projection まで進まない。
- Local server profile の finalization mode は sync であり、target prover queue
  authority を持たない。Browser mock が表示確認用の estimate を返す場合も、AWS
  queue の実測 evidence ではない。

## Finalization lifecycle

### `pending`

`queuedAtMs` は finalization work を queue に投入した時刻（epoch ms）である。
Target async flow の `pending` は、SQS 待機、dispatcher handoff、Step Functions
setup、および DynamoDB semaphore の slot 待ちを含む。Dispatcher が
`StartExecution` に成功しただけでは `running` に遷移しない。

### `running`

Step Functions が prover slot を取得した後、`MarkProverStarted` が running state
を記録する。`startedAtMs` はこの proof 実行開始時刻（epoch ms）であり、UI と API
の擬似進捗はこの時刻を起点にする。

### Terminal state

`succeeded`、`failed`、`timeout` は terminal state である。Queue estimate は
pending/running の presentation aid なので、current resource の terminal state
では `runtimeDiagnostics.queue` は `null` になる。

## Queue estimate の authority

Queue info path は SQS `GetQueueAttributes` を呼ばない。SQS の
`ApproximateNumberOfMessages*` は dispatcher backlog の運用指標であり、Step
Functions semaphore の待機 execution 数や exact queue position ではないため、
public queue payload の source にしない。

`runtimeDiagnostics.queue` が存在する場合の shape は次の 2 field だけである。

```ts
type FinalizationQueue = {
  concurrencyLimit: number;
  estimatedDurationMs: number;
};
```

- `concurrencyLimit` は `PROVER_MAX_CONCURRENT_PROVERS` を数値化し、有限かつ
  `0` より大きい場合は `Math.floor` した値を使い、それ以外は `2` とする。Target Terraform は
  `var.prover_max_concurrent_provers` を positive integer として検証し、この環境変数へ
  渡す。Terraform default は `2` である。
- `estimatedDurationMs` は典型所要時間であり、現在は **360000**（6分）の固定値である。
- `position`、`depth`、`estimatedStartAt`、`estimatedCompletionAt`、source label は
  public queue payload に含めない。

## Status ごとの queue projection

| Response path / state                                 | `runtimeDiagnostics.queue` |
| ----------------------------------------------------- | -------------------------- |
| Target async POST accepted (`202`, `pending`)         | static estimate object     |
| Target async current (`pending` / `running`)          | static estimate object     |
| Current resource (`succeeded` / `failed` / `timeout`) | `null`                     |
| Non-async current resource                            | `null`                     |
| Sync POST succeeded (`200`)                           | field を省略               |

Public schema は `runtimeDiagnostics.queue` の object、`null`、省略を受理する。Target
async profile の queue URL は admission 時に必須なので、正常に解決された target
pending/running path では static estimate object を返す。Queue projection 自体は
SQS read を行わないため、SQS attribute 取得失敗によって payload が欠落する経路はない。

## API envelope

Finalization success response は共通して top-level の
`{ data, meta: { requestId } }` envelope を使う。

### POST `/api/sessions/:sessionId/finalizations`（Async 202）

```json
{
  "data": {
    "status": "pending",
    "finalizationId": "string",
    "queuedAtMs": 1730000000000,
    "runtimeDiagnostics": {
      "asyncMode": "enabled",
      "queue": {
        "concurrencyLimit": 2,
        "estimatedDurationMs": 360000
      }
    }
  },
  "meta": {
    "requestId": "request-id"
  }
}
```

### GET `/api/sessions/:sessionId/finalizations/current`（200 / pending）

Pending resource は `runtimeDiagnostics.progress` を返さない。Semaphore slot 待ち中も
pending のままであり、SQS depth が 0 であっても target queue authority が存在する
限り static estimate object を返す。

```json
{
  "data": {
    "status": "pending",
    "finalizationId": "string",
    "queuedAtMs": 1730000000000,
    "runtimeDiagnostics": {
      "asyncMode": "enabled",
      "queue": {
        "concurrencyLimit": 2,
        "estimatedDurationMs": 360000
      }
    }
  },
  "meta": {
    "requestId": "request-id"
  }
}
```

### GET `/api/sessions/:sessionId/finalizations/current`（200 / running）

Running resource は queue estimate に加え、`runtimeDiagnostics.progress` を derived
hint として返しうる。`runtimeDiagnostics.orchestrator` は Step Functions details を
取得できた場合だけ返す optional diagnostics であり、progress や finalization state
の authority ではない。

```json
{
  "data": {
    "status": "running",
    "finalizationId": "string",
    "queuedAtMs": 1730000000000,
    "startedAtMs": 1730000360000,
    "runtimeDiagnostics": {
      "asyncMode": "enabled",
      "queue": {
        "concurrencyLimit": 2,
        "estimatedDurationMs": 360000
      },
      "progress": {
        "phase": "running",
        "source": "derived",
        "percent": 12,
        "updatedAtMs": 1730000390000
      },
      "orchestrator": {
        "status": "RUNNING",
        "startTimeMs": 1730000060000,
        "stopTimeMs": null
      }
    }
  },
  "meta": {
    "requestId": "request-id"
  }
}
```

## Progress duration fallback

API の `runtimeDiagnostics.progress` と UI の `ProgressDisplay` は同じ補間関数を使う。

- `running` では `elapsed = now - startedAtMs` として 1–99% を導出する。
- Queue object がある場合は `runtimeDiagnostics.queue.estimatedDurationMs` を duration
  に使う。
- Queue duration が欠落した場合は **360000ms** を使う。Target server の current
  producer が返す static estimate は常に正の固定値である。
- Pending では API の `runtimeDiagnostics.progress` を省略し、UI は 0% に保つ。
- 時間経過だけで 100% にはしない。UI は完了状態を受け取ったときだけ短い animation
  で 100% へ遷移する。

API の `runtimeDiagnostics.progress.percent` は presentation 用の derived hint であり、
実測進捗ではない。UI は `startedAtMs` と duration から再計算した値を表示の authority
とする。

## UI presentation

- Pending では queue object がある場合だけ queue panel を表示し、典型所要時間だけを
  見せる。`concurrencyLimit`、capacity、position、depth、source label は表示しない。
- Running では queue panel を表示せず、時間ベースの進捗と単一の processing label を
  表示する。
- UI は exact queue position、SQS depth、推定開始/完了時刻、real-time push
  notification を約束しない。
