import { describe, expect, it } from 'vitest';
import type { FinalizationState } from '@/types/server';
import { computeFinalizationProgress, computeFinalizationStages } from '../finalization-progress';

const baseState: FinalizationState = {
  status: 'pending',
  executionId: '01HZ3JQ4ABXYZ7890DEF123456',
  queuedAt: 1_730_000_000_000,
};

describe('computeFinalizationStages', () => {
  it('returns initial stages when state is null', () => {
    const stages = computeFinalizationStages(null, false, false, false);
    expect(stages).toEqual([
      { key: 'queued', status: 'active' },
      { key: 'running', status: 'pending' },
      { key: 'verifying', status: 'pending' },
      { key: 'completed', status: 'pending' },
    ]);
  });

  it('marks running stage active when state is running', () => {
    const stages = computeFinalizationStages(
      { ...baseState, status: 'running', startedAt: 1_730_000_000_500 },
      false,
      false,
      false,
    );
    expect(stages).toEqual([
      { key: 'queued', status: 'complete' },
      { key: 'running', status: 'active' },
      { key: 'verifying', status: 'pending' },
      { key: 'completed', status: 'pending' },
    ]);
  });

  it('marks all stages as complete when results are available', () => {
    const stages = computeFinalizationStages(
      {
        ...baseState,
        status: 'succeeded',
        startedAt: 1_730_000_000_500,
        completedAt: 1_730_000_001_000,
      },
      true,
      false,
      false,
    );
    expect(stages).toEqual([
      { key: 'queued', status: 'complete' },
      { key: 'running', status: 'complete' },
      { key: 'verifying', status: 'complete' },
      { key: 'completed', status: 'complete' },
    ]);
  });

  it('marks all stages as error when failure detected', () => {
    const stages = computeFinalizationStages(
      {
        ...baseState,
        status: 'failed',
        failedAt: 1_730_000_001_500,
        error: { code: 'USER_CANCELLED', message: 'User cancelled' },
      },
      false,
      false,
      true,
    );
    expect(stages.every((stage) => stage.status === 'error')).toBe(true);
  });
});

describe('computeFinalizationProgress', () => {
  it('returns initial progress when no state', () => {
    const { value } = computeFinalizationProgress({
      state: null,
      hasResult: false,
      isFetchingResult: false,
      hasError: false,
    });
    expect(value).toBe(10);
  });

  it('returns queued progress for pending state', () => {
    const { value } = computeFinalizationProgress({
      state: baseState,
      hasResult: false,
      isFetchingResult: false,
      hasError: false,
    });
    expect(value).toBeGreaterThan(10);
  });

  it('returns verifying progress when succeeded but results still fetching', () => {
    const { value } = computeFinalizationProgress({
      state: {
        ...baseState,
        status: 'succeeded',
        startedAt: 1_730_000_000_500,
        completedAt: 1_730_000_000_900,
      },
      hasResult: false,
      isFetchingResult: true,
      hasError: false,
    });
    expect(value).toBe(80);
  });

  it('returns complete progress when results ready', () => {
    const { value } = computeFinalizationProgress({
      state: {
        ...baseState,
        status: 'succeeded',
        startedAt: 1_730_000_000_500,
        completedAt: 1_730_000_000_900,
      },
      hasResult: true,
      isFetchingResult: false,
      hasError: false,
    });
    expect(value).toBe(100);
  });

  it('returns initial progress when failure occurs', () => {
    const { value } = computeFinalizationProgress({
      state: {
        ...baseState,
        status: 'timeout',
        timeoutAt: 1_730_000_001_200,
      },
      hasResult: false,
      isFetchingResult: false,
      hasError: true,
    });
    expect(value).toBe(10);
  });
});
