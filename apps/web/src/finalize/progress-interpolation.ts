const PHASE1_END_RATIO = 168 / 360;
const PHASE2_END_RATIO = 248 / 360;
const DEFAULT_TOTAL_MS = 360000;

export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function linearDeceleration(t: number): number {
  const k = 0.808;
  return (t * (2 - k * t)) / (2 - k);
}

export function interpolateProgress(elapsed: number, total: number = DEFAULT_TOTAL_MS): number {
  const ratio = Math.min(1, Math.max(0, elapsed / total));

  if (ratio < 1) {
    if (ratio <= PHASE1_END_RATIO) {
      return (ratio / PHASE1_END_RATIO) * 70;
    }
    if (ratio <= PHASE2_END_RATIO) {
      const segment = (ratio - PHASE1_END_RATIO) / (PHASE2_END_RATIO - PHASE1_END_RATIO);
      return 70 + linearDeceleration(segment) * 20;
    }
    const segment = (ratio - PHASE2_END_RATIO) / (1 - PHASE2_END_RATIO);
    return 90 + segment * 9;
  }

  return 99;
}

export function completeProgress(): number {
  return 100;
}

export interface ProgressState {
  percent: number;
  isComplete: boolean;
  isWaiting: boolean;
}

export function calculateProgressState(
  _queuedAt: string | null,
  startedAt: string | null,
  estimatedDurationMs: number = DEFAULT_TOTAL_MS,
  isComplete: boolean = false,
): ProgressState {
  if (isComplete) {
    return { percent: 100, isComplete: true, isWaiting: false };
  }

  if (!startedAt) {
    return { percent: 0, isComplete: false, isWaiting: true };
  }

  const now = Date.now();
  const startTime = new Date(startedAt).getTime();
  const elapsed = now - startTime;
  const percent = interpolateProgress(elapsed, estimatedDurationMs);

  return { percent: Math.floor(percent), isComplete: false, isWaiting: false };
}
