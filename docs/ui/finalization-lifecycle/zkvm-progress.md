# zkVM 進捗の取り扱い

zkVM（集計）の進捗表示に関する仕様。**進捗は実測値ではなく、時間ベースの擬似進捗**として扱う。

## 参照（優先順）

1. `docs/ui/api-contract.md`
2. `docs/ui/design-spec-transparent-trust.md`
3. `docs/ui/finalization-lifecycle/finalization-queue.md`

## 基本方針

- running の表示進捗は **`startedAtMs` / `estimatedDurationMs` から一意に算出**する。
- API が `runtimeDiagnostics.progress` を返す場合でも、**UI の算出結果を正**とする。
- `estimatedDurationMs` が無い場合のデフォルトは **360000ms（6分）**。
- **100% は完了イベントでのみ到達**（時間ベースでは 99% まで）。
- 早期完了時も **滑らかに 100% へ遷移**させる（急な飛び値は避ける）。

## 表示フェーズ

### 1. pending（待機中）

- lifecycle の `status: "pending"` を待機中として扱う。`running` resource では
  `startedAtMs` が必須。
- 進捗率は **0% 固定**で表示する。
- 待ち行列情報（`runtimeDiagnostics.queue`）がある場合のみ表示する。

### 2. running（実行中）

- `elapsed = now - startedAtMs` を用いて補間した値を切り捨て、**1-99%** を表示する。
  実行開始直後は最低 1% とし、途中から表示する場合は経過時間に応じた値から始める。
- 進捗曲線は共有 `interpolateProgress()` の実装に従う：
  - 0-70%: 線形
  - 70-90%: 線形減速（速度が徐々に落ちる）
  - 90-99%: 等速度（線形）

### 3. succeeded（完了）

- `pending` / `running` から `succeeded` に遷移した場合は、その時点の表示進捗から
  100% までを短いアニメーションで補完する。
- 初回表示時にすでに `succeeded` なら、最初から 100% を表示する。

## API 取り扱い

`GET /api/sessions/:sessionId/finalizations/current` は保存済みの lifecycle state を返す。
閲覧によって実行基盤の状態を照合したり、terminal state へ遷移させたりはしない。
実行基盤との照合は閲覧とは独立した
[定期 writer](../../architecture/context-map.md#finalization-reconciliation) が担う。
進捗の診断値は presentation 用であり、finalization の完了や検証成功の根拠にはしない。

- `/api/sessions/:sessionId/finalizations/current` の `runtimeDiagnostics.progress` は **任意**。
- 返す場合は `source: "derived"` とし、**UI と同一の補間関数**を使う。
- UI は running の間、`startedAtMs` /
  `runtimeDiagnostics.queue.estimatedDurationMs` から再計算する。

## 実装メモ

- 補間関数と状態投影の単一 authority は
  `packages/application/src/finalize/finalization-progress.ts`。
- UI、API、mock API は同じ browser-safe module を利用する。mock API と test は
  決定的な投影のため `now` を明示的に渡し、API は未指定時の `Date.now()` を使う。
  UI は `Date.now()` から経過時間を求めて共通の補間関数に渡す。
