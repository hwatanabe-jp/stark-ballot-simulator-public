const INITIAL_LINEAR_END_RATIO = 168 / 360;
const DECELERATION_END_RATIO = 248 / 360;
const DEFAULT_ESTIMATED_DURATION_MS = 360_000;

export type FinalizationProgressSourceState = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout';
  startedAtMs?: unknown;
};

export type FinalizationProgress = {
  phase: 'running';
  source: 'derived';
  percent: number;
  updatedAtMs: number;
};

export interface ProgressState {
  percent: number;
  isComplete: boolean;
  isWaiting: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function linearDeceleration(t: number): number {
  const k = 0.808;
  return (t * (2 - k * t)) / (2 - k);
}

function resolveEstimatedDurationMs(estimatedDurationMs?: number): number {
  if (isFiniteNumber(estimatedDurationMs) && estimatedDurationMs > 0) {
    return Math.floor(estimatedDurationMs);
  }
  return DEFAULT_ESTIMATED_DURATION_MS;
}

/**
 * Returns time-based progress in the range 0–99.
 *
 * Reaching 100 remains reserved for an explicit completion signal.
 */
export function interpolateProgress(elapsed: number, total: number = DEFAULT_ESTIMATED_DURATION_MS): number {
  const ratio = Math.min(1, Math.max(0, elapsed / total));

  if (ratio < 1) {
    if (ratio <= INITIAL_LINEAR_END_RATIO) {
      return (ratio / INITIAL_LINEAR_END_RATIO) * 70;
    }
    if (ratio <= DECELERATION_END_RATIO) {
      const segment = (ratio - INITIAL_LINEAR_END_RATIO) / (DECELERATION_END_RATIO - INITIAL_LINEAR_END_RATIO);
      return 70 + linearDeceleration(segment) * 20;
    }
    const segment = (ratio - DECELERATION_END_RATIO) / (1 - DECELERATION_END_RATIO);
    return 90 + segment * 9;
  }

  return 99;
}

/**
 * Projects the queue, running, and completion states used by progress views.
 */
export function calculateProgressState(params: {
  queuedAt: string | null;
  startedAt: string | null;
  estimatedDurationMs?: number;
  isComplete?: boolean;
  now: number;
}): ProgressState {
  const { startedAt, estimatedDurationMs = DEFAULT_ESTIMATED_DURATION_MS, isComplete = false, now } = params;

  if (isComplete) {
    return { percent: 100, isComplete: true, isWaiting: false };
  }

  if (!startedAt) {
    return { percent: 0, isComplete: false, isWaiting: true };
  }

  const startTime = new Date(startedAt).getTime();
  const elapsed = now - startTime;
  const percent = interpolateProgress(elapsed, estimatedDurationMs);

  return { percent: Math.floor(percent), isComplete: false, isWaiting: false };
}

/**
 * Derives the public time-based progress hint for a running finalization.
 */
export function deriveFinalizationProgress(params: {
  state: FinalizationProgressSourceState | null;
  estimatedDurationMs?: number;
  now?: number;
}): FinalizationProgress | null {
  const { state, estimatedDurationMs, now = Date.now() } = params;
  if (!state || state.status !== 'running') {
    return null;
  }

  const startedAtMs = state.startedAtMs;
  if (!isFiniteNumber(startedAtMs)) {
    return null;
  }

  const duration = resolveEstimatedDurationMs(estimatedDurationMs);
  const elapsed = Math.max(0, now - startedAtMs);
  const rawPercent = interpolateProgress(elapsed, duration);
  const percent = Math.min(99, Math.max(1, Math.floor(rawPercent)));

  return {
    phase: 'running',
    source: 'derived',
    percent,
    updatedAtMs: now,
  };
}
