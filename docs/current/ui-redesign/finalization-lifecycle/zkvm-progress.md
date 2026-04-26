# zkVM 進捗の取り扱い

zkVM（集計）の進捗表示に関する仕様。**進捗は実測値ではなく、時間ベースの擬似進捗**として扱う。

## 参照（優先順）

1. `docs/current/ui-redesign/api-contract.md`
2. `docs/current/ui-redesign/design-spec-transparent-trust.md`
3. `docs/current/ui-redesign/finalization-lifecycle/finalization-queue.md`

## 基本方針

- 進捗は **`queuedAt` / `startedAt` / `estimatedDurationMs` から一意に算出**する。
- API が `progress` を返す場合でも、**UI の算出結果を正**とする。
- `estimatedDurationMs` が無い場合のデフォルトは **360000ms（6分）**。
- **100% は完了イベントでのみ到達**（時間ベースでは 99% まで）。
- 早期完了時も **滑らかに 100% へ遷移**させる（急な飛び値は避ける）。

## 表示フェーズ

### 1. pending（待機中）

- `startedAt` が無い場合は待機中として扱う。
- 進捗率は **表示しない**（または 0% 固定）。
- 待ち行列情報（`queue`）がある場合のみ表示する。

### 2. running（実行中）

- `startedAt` が入った時点で **1% から開始**。
- `elapsed = now - startedAt` を用いて補間し、0-99% を算出。
- 進捗曲線は「透明な信頼」デザイン定義書に準拠：
  - 0-70%: 線形
  - 70-90%: 線形減速（速度が徐々に落ちる）
  - 90-99%: 等速度（線形）

### 3. succeeded（完了）

- 完了イベントで **100% に到達**。
- UI は 99% → 100% を短いアニメーションで補完する。

## API 取り扱い

- `/api/sessions/:id/status` の `progress` は **任意**。
- 返す場合は `source: "derived"` とし、**UI と同一の補間関数**を使う。
- UI は常に `queuedAt` / `startedAt` / `estimatedDurationMs` から再計算する。

## 実装メモ

- 補間関数は `src/lib/finalize/progress-interpolation.ts` を参照。
- サーバ側の参考値生成は `src/server/api/utils/finalizationProgress.ts` を参照。
