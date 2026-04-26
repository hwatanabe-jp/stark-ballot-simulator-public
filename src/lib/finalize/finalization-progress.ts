import type { FinalizationState } from '@/types/server';

export type FinalizationStageKey = 'queued' | 'running' | 'verifying' | 'completed';

export type FinalizationStageStatus = 'pending' | 'active' | 'complete' | 'error';

export interface FinalizationStage {
  key: FinalizationStageKey;
  status: FinalizationStageStatus;
}

export interface FinalizationProgressInput {
  state: FinalizationState | null;
  hasResult: boolean;
  isFetchingResult: boolean;
  hasError: boolean;
}

export interface FinalizationProgress {
  value: number;
  stages: FinalizationStage[];
}

const INITIAL_PROGRESS = 10;
const QUEUED_PROGRESS = 25;
const RUNNING_PROGRESS = 60;
const VERIFYING_PROGRESS = 80;
const COMPLETE_PROGRESS = 100;

/**
 * Derive high-level stage status from the current finalization state.
 */
export function computeFinalizationStages(
  state: FinalizationState | null,
  hasResult: boolean,
  isFetchingResult: boolean,
  hasError: boolean,
): FinalizationStage[] {
  if (hasError && state?.status !== 'succeeded') {
    return [
      { key: 'queued', status: 'error' },
      { key: 'running', status: 'error' },
      { key: 'verifying', status: 'error' },
      { key: 'completed', status: 'error' },
    ];
  }

  if (!state) {
    return [
      { key: 'queued', status: 'active' },
      { key: 'running', status: 'pending' },
      { key: 'verifying', status: 'pending' },
      { key: 'completed', status: 'pending' },
    ];
  }

  switch (state.status) {
    case 'pending':
      return [
        { key: 'queued', status: 'active' },
        { key: 'running', status: 'pending' },
        { key: 'verifying', status: 'pending' },
        { key: 'completed', status: 'pending' },
      ];
    case 'running':
      return [
        { key: 'queued', status: 'complete' },
        { key: 'running', status: 'active' },
        { key: 'verifying', status: 'pending' },
        { key: 'completed', status: 'pending' },
      ];
    case 'succeeded':
      if (hasResult) {
        return [
          { key: 'queued', status: 'complete' },
          { key: 'running', status: 'complete' },
          { key: 'verifying', status: 'complete' },
          { key: 'completed', status: 'complete' },
        ];
      }

      if (isFetchingResult) {
        return [
          { key: 'queued', status: 'complete' },
          { key: 'running', status: 'complete' },
          { key: 'verifying', status: 'active' },
          { key: 'completed', status: 'pending' },
        ];
      }

      return [
        { key: 'queued', status: 'complete' },
        { key: 'running', status: 'complete' },
        { key: 'verifying', status: 'pending' },
        { key: 'completed', status: 'pending' },
      ];
    case 'failed':
    case 'timeout':
      return [
        { key: 'queued', status: 'error' },
        { key: 'running', status: 'error' },
        { key: 'verifying', status: 'error' },
        { key: 'completed', status: 'error' },
      ];
    default:
      return [
        { key: 'queued', status: 'pending' },
        { key: 'running', status: 'pending' },
        { key: 'verifying', status: 'pending' },
        { key: 'completed', status: 'pending' },
      ];
  }
}

/**
 * Compute an overall progress value (0-100) for visualization.
 */
export function computeFinalizationProgress({
  state,
  hasResult,
  isFetchingResult,
  hasError,
}: FinalizationProgressInput): FinalizationProgress {
  if (hasError && state?.status !== 'succeeded') {
    return {
      value: INITIAL_PROGRESS,
      stages: computeFinalizationStages(state, hasResult, isFetchingResult, hasError),
    };
  }

  if (!state) {
    return {
      value: INITIAL_PROGRESS,
      stages: computeFinalizationStages(state, hasResult, isFetchingResult, hasError),
    };
  }

  let value = INITIAL_PROGRESS;

  switch (state.status) {
    case 'pending':
      value = QUEUED_PROGRESS;
      break;
    case 'running':
      value = RUNNING_PROGRESS;
      break;
    case 'succeeded':
      value = hasResult ? COMPLETE_PROGRESS : isFetchingResult ? VERIFYING_PROGRESS : RUNNING_PROGRESS;
      break;
    case 'failed':
    case 'timeout':
      value = INITIAL_PROGRESS;
      break;
    default:
      value = INITIAL_PROGRESS;
  }

  return {
    value,
    stages: computeFinalizationStages(state, hasResult, isFetchingResult, hasError),
  };
}
