/**
 * Progress Interpolation - 「透明な信頼」デザインシステム
 *
 * 集計進行中の進捗バー用。実測値ではなく時間ベースで擬似進捗を生成。
 *
 * 進捗曲線（6分=360秒見積もり）:
 * - 序盤区間 (0-168秒, 0-70%): 線形進行（4分で100%ペース = 2.4秒/1%）
 * - 中盤区間 (168-248秒, 70-90%): 線形減速（速度比 1:5.2 で減速）
 * - 終盤区間 (248-360秒, 90-99%): 等速度（12.4秒/1%）
 * - 100%: 完了イベントでのみ設定
 *
 * 設計目標: 1%あたりの所要時間が単調増加（または平坦）となり、
 * ユーザーに「減速している」という自然な印象を与える。
 *
 * Reference: docs/current/ui-redesign/design-spec-transparent-trust.md
 */

// 区間境界（ratio）
const PHASE1_END_RATIO = 168 / 360; // ≈ 0.467
const PHASE2_END_RATIO = 248 / 360; // ≈ 0.689

// デフォルト総見積もり時間（6分）
const DEFAULT_TOTAL_MS = 360000;

/**
 * EaseOutQuad イージング関数
 * 汎用（他モジュールで使用される可能性あり）
 */
export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * 線形減速補間関数
 *
 * 中盤区間 (70-90%) で使用。速度が線形に減少する。
 * t=0 で最大速度（序盤区間終了時の速度）、t=1 で最小速度（終盤区間の等速度）に滑らかに接続。
 *
 * 速度比: 序盤区間終了時 2.4秒/1% → 終盤区間開始時 12.4秒/1% ≈ 1:5.2
 * k = 0.808 は速度減少率（積分により導出）
 */
function linearDeceleration(t: number): number {
  const k = 0.808;
  return (t * (2 - k * t)) / (2 - k);
}

/**
 * 進捗値の非線形補間関数（時間ベース、0-99%）
 *
 * @param elapsed - 経過時間（ミリ秒）
 * @param total - 推定総時間（ミリ秒）、デフォルト360000（6分）
 * @returns 0-99 の進捗値（100は completeProgress() でのみ設定）
 */
export function interpolateProgress(elapsed: number, total: number = DEFAULT_TOTAL_MS): number {
  // クランプ: 0-1の範囲に制限
  const ratio = Math.min(1, Math.max(0, elapsed / total));

  if (ratio < 1) {
    if (ratio <= PHASE1_END_RATIO) {
      // 序盤区間 (0-70%): 線形進行
      return (ratio / PHASE1_END_RATIO) * 70;
    } else if (ratio <= PHASE2_END_RATIO) {
      // 中盤区間 (70-90%): 線形減速
      const segment = (ratio - PHASE1_END_RATIO) / (PHASE2_END_RATIO - PHASE1_END_RATIO);
      return 70 + linearDeceleration(segment) * 20;
    } else {
      // 終盤区間 (90-99%): 等速度（線形）
      const segment = (ratio - PHASE2_END_RATIO) / (1 - PHASE2_END_RATIO);
      return 90 + segment * 9;
    }
  }

  // ratio === 1 の場合は99%を返す（100%は完了イベントで設定）
  return 99;
}

/**
 * 完了時に呼び出す関数（ECS Fargate完了コールバック受信時）
 */
export function completeProgress(): number {
  return 100;
}

/**
 * 進捗状態の型
 */
export interface ProgressState {
  percent: number;
  isComplete: boolean;
  isWaiting: boolean;
}

/**
 * キュー情報から進捗状態を計算
 *
 * @param queuedAt - キュー追加時刻（ISO 8601）
 * @param startedAt - 実行開始時刻（ISO 8601）、nullの場合はキュー待機中
 * @param estimatedDurationMs - 推定実行時間（ミリ秒）
 * @param isComplete - 完了フラグ
 * @returns 進捗状態
 */
export function calculateProgressState(
  _queuedAt: string | null,
  startedAt: string | null,
  estimatedDurationMs: number = 360000,
  isComplete: boolean = false,
): ProgressState {
  // 完了済み
  if (isComplete) {
    return { percent: 100, isComplete: true, isWaiting: false };
  }

  // キュー待機中（startedAt が null）
  if (!startedAt) {
    return { percent: 0, isComplete: false, isWaiting: true };
  }

  // 実行中
  const now = Date.now();
  const startTime = new Date(startedAt).getTime();
  const elapsed = now - startTime;
  const percent = interpolateProgress(elapsed, estimatedDurationMs);

  return { percent: Math.floor(percent), isComplete: false, isWaiting: false };
}
