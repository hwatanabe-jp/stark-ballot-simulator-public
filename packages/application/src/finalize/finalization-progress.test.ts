import { describe, expect, it } from 'vitest';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import {
  deriveFinalizationProgress,
  interpolateProgress,
} from '@stark-ballot/application/finalize/finalization-progress';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const TOTAL_MS = 360_000;
const NOW_MS = Date.parse('2026-01-10T00:01:00.000Z');
const FINALIZATION_ID = asFinalizationId('finalization-1');

function runningState(startedAtMs: number): FinalizationState {
  return {
    status: 'running',
    finalizationId: FINALIZATION_ID,
    queuedAtMs: startedAtMs - 10_000,
    startedAtMs,
  };
}

describe('interpolateProgress', () => {
  it.each([
    { elapsedMs: 0, totalMs: TOTAL_MS, expected: 0 },
    { elapsedMs: 168_000, totalMs: TOTAL_MS, expected: 70 },
    { elapsedMs: 248_000, totalMs: TOTAL_MS, expected: 90 },
    { elapsedMs: 304_000, totalMs: TOTAL_MS, expected: 94.5 },
    { elapsedMs: TOTAL_MS, totalMs: TOTAL_MS, expected: 99 },
    { elapsedMs: TOTAL_MS * 2, totalMs: TOTAL_MS, expected: 99 },
  ])('preserves the progress curve at $elapsedMs ms', ({ elapsedMs, totalMs, expected }) => {
    expect(interpolateProgress(elapsedMs, totalMs)).toBeCloseTo(expected);
  });

  it('increases monotonically through the time-based curve without reaching 100', () => {
    const samples = [0.1, 0.3, 0.5, 0.7, 0.9].map((ratio) => interpolateProgress(TOTAL_MS * ratio, TOTAL_MS));

    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThan(samples[index - 1] ?? Number.POSITIVE_INFINITY);
    }
    expect(samples.at(-1)).toBeLessThan(99);
  });

  it('keeps time per percentage point monotonically non-decreasing', () => {
    const timesToReachPercent = Array.from({ length: 99 }, (_, index) => {
      const targetPercent = index + 1;
      let lowerBound = 0;
      let upperBound = TOTAL_MS;
      while (upperBound - lowerBound > 1) {
        const midpoint = (lowerBound + upperBound) / 2;
        if (interpolateProgress(midpoint, TOTAL_MS) < targetPercent) {
          lowerBound = midpoint;
        } else {
          upperBound = midpoint;
        }
      }
      return upperBound;
    });
    const deltas = timesToReachPercent.map((time, index) =>
      index === 0 ? time : time - (timesToReachPercent[index - 1] ?? 0),
    );

    for (let index = 1; index < deltas.length; index += 1) {
      const previousDelta = deltas[index - 1];
      const currentDelta = deltas[index];
      if (previousDelta === undefined || currentDelta === undefined) {
        throw new Error('Expected every progress percentage to have a time delta');
      }
      expect(currentDelta).toBeGreaterThanOrEqual(previousDelta * 0.99);
    }
  });

  it('preserves the initial linear-segment midpoint', () => {
    expect(interpolateProgress(84_000, TOTAL_MS)).toBeCloseTo(35, 0);
  });

  it.each([
    { label: 'negative elapsed time', elapsedMs: -1, totalMs: TOTAL_MS, expected: 0 },
    {
      label: 'positive infinite elapsed time',
      elapsedMs: Number.POSITIVE_INFINITY,
      totalMs: TOTAL_MS,
      expected: 99,
    },
    {
      label: 'negative infinite elapsed time',
      elapsedMs: Number.NEGATIVE_INFINITY,
      totalMs: TOTAL_MS,
      expected: 0,
    },
    { label: 'NaN elapsed time', elapsedMs: Number.NaN, totalMs: TOTAL_MS, expected: 99 },
    { label: 'NaN total time', elapsedMs: 0, totalMs: Number.NaN, expected: 99 },
    { label: 'zero total at zero elapsed', elapsedMs: 0, totalMs: 0, expected: 99 },
    { label: 'zero total after start', elapsedMs: 1, totalMs: 0, expected: 99 },
    { label: 'zero total before start', elapsedMs: -1, totalMs: 0, expected: 0 },
  ])('preserves $label behavior', ({ elapsedMs, totalMs, expected }) => {
    expect(interpolateProgress(elapsedMs, totalMs)).toBe(expected);
  });
});

describe('deriveFinalizationProgress', () => {
  it('returns null when state is missing or not running', () => {
    const pending: FinalizationState = {
      status: 'pending',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: NOW_MS - 1_000,
    };
    const succeeded: FinalizationState = {
      status: 'succeeded',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: NOW_MS - 10_000,
      startedAtMs: NOW_MS - 9_000,
      completedAtMs: NOW_MS,
    };

    expect(deriveFinalizationProgress({ state: null, now: NOW_MS })).toBeNull();
    expect(deriveFinalizationProgress({ state: pending, now: NOW_MS })).toBeNull();
    expect(deriveFinalizationProgress({ state: succeeded, now: NOW_MS })).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'returns null when startedAtMs is %s',
    (startedAtMs) => {
      expect(deriveFinalizationProgress({ state: runningState(startedAtMs), now: NOW_MS })).toBeNull();
    },
  );

  it('derives running progress with the provided duration and injected current time', () => {
    const startedAtMs = NOW_MS - 60_000;
    const estimatedDurationMs = 240_000;

    expect(
      deriveFinalizationProgress({
        state: runningState(startedAtMs),
        estimatedDurationMs,
        now: NOW_MS,
      }),
    ).toEqual({
      phase: 'running',
      source: 'derived',
      percent: Math.max(1, Math.floor(interpolateProgress(60_000, estimatedDurationMs))),
      updatedAtMs: NOW_MS,
    });
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'uses the default duration for invalid estimate %s',
    (estimatedDurationMs) => {
      const startedAtMs = NOW_MS - 150_000;
      const expected = Math.max(1, Math.floor(interpolateProgress(150_000, TOTAL_MS)));

      expect(
        deriveFinalizationProgress({
          state: runningState(startedAtMs),
          ...(estimatedDurationMs === undefined ? {} : { estimatedDurationMs }),
          now: NOW_MS,
        }),
      ).toMatchObject({ percent: expected });
    },
  );

  it('floors a positive fractional duration before interpolation', () => {
    expect(
      deriveFinalizationProgress({
        state: runningState(NOW_MS),
        estimatedDurationMs: 0.5,
        now: NOW_MS,
      }),
    ).toMatchObject({ percent: 99 });
  });

  it('clamps pre-start running progress to one percent', () => {
    expect(
      deriveFinalizationProgress({
        state: runningState(NOW_MS + 60_000),
        estimatedDurationMs: TOTAL_MS,
        now: NOW_MS,
      }),
    ).toMatchObject({ percent: 1 });
  });
});
