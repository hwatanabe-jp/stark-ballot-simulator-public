import type { FinalizationState } from '@/types/server';
import { interpolateProgress } from '@/lib/finalize/progress-interpolation';

const DEFAULT_ESTIMATED_DURATION_MS = 360000;

export type FinalizationProgress = {
  phase: 'running';
  source: 'derived';
  percent: number;
  updatedAt: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveEstimatedDurationMs(estimatedDurationMs?: number): number {
  if (isFiniteNumber(estimatedDurationMs) && estimatedDurationMs > 0) {
    return Math.floor(estimatedDurationMs);
  }
  return DEFAULT_ESTIMATED_DURATION_MS;
}

/**
 * Derive a time-based progress hint for running finalizations.
 */
export function deriveFinalizationProgress(params: {
  state: FinalizationState | null;
  estimatedDurationMs?: number;
  now?: number;
}): FinalizationProgress | null {
  const { state, estimatedDurationMs, now = Date.now() } = params;
  if (!state || state.status !== 'running') {
    return null;
  }

  const startedAt = state.startedAt;
  if (!isFiniteNumber(startedAt)) {
    return null;
  }

  const duration = resolveEstimatedDurationMs(estimatedDurationMs);
  const elapsed = Math.max(0, now - startedAt);
  const rawPercent = interpolateProgress(elapsed, duration);
  const percent = Math.min(99, Math.max(1, Math.floor(rawPercent)));

  return {
    phase: 'running',
    source: 'derived',
    percent,
    updatedAt: now,
  };
}
