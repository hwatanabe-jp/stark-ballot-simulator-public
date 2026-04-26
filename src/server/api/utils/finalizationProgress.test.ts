import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FinalizationState } from '@/types/server';
import { interpolateProgress } from '@/lib/finalize/progress-interpolation';
import { deriveFinalizationProgress } from '@/server/api/utils/finalizationProgress';

const originalEnv = { ...process.env };

const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
};

describe('deriveFinalizationProgress', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('returns null when state is missing or not running', () => {
    const now = 1_730_000_000_000;
    const pending: FinalizationState = {
      status: 'pending',
      executionId: 'exec',
      queuedAt: now - 1000,
    };

    expect(deriveFinalizationProgress({ state: null, now })).toBeNull();
    expect(deriveFinalizationProgress({ state: pending, now })).toBeNull();
  });

  it('returns null when startedAt is invalid', () => {
    const now = 1_730_000_000_000;
    const running = {
      status: 'running',
      executionId: 'exec',
      queuedAt: now - 10_000,
      startedAt: Number.NaN,
    } as FinalizationState;

    expect(deriveFinalizationProgress({ state: running, now })).toBeNull();
  });

  it('derives progress for running state using provided duration', () => {
    const startedAt = 1_730_000_000_000;
    const now = startedAt + 60_000;
    const estimatedDurationMs = 240_000;
    const state: FinalizationState = {
      status: 'running',
      executionId: 'exec',
      queuedAt: startedAt - 10_000,
      startedAt,
    };

    const expected = Math.max(1, Math.floor(interpolateProgress(now - startedAt, estimatedDurationMs)));

    expect(
      deriveFinalizationProgress({
        state,
        estimatedDurationMs,
        now,
      }),
    ).toEqual({
      phase: 'running',
      source: 'derived',
      percent: expected,
      updatedAt: now,
    });
  });

  it('falls back to default duration when estimate is missing', () => {
    const startedAt = 1_730_000_000_000;
    const now = startedAt + 150_000;
    const state: FinalizationState = {
      status: 'running',
      executionId: 'exec',
      queuedAt: startedAt - 10_000,
      startedAt,
    };

    const expected = Math.max(1, Math.floor(interpolateProgress(now - startedAt, 360_000)));

    expect(
      deriveFinalizationProgress({
        state,
        now,
      }),
    ).toEqual({
      phase: 'running',
      source: 'derived',
      percent: expected,
      updatedAt: now,
    });
  });
});
