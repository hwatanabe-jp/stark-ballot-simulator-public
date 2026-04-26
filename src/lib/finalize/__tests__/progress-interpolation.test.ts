import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { interpolateProgress, easeOutQuad, calculateProgressState } from '../progress-interpolation';

const TOTAL_MS = 360_000;

describe('interpolateProgress (6分見積もり)', () => {
  it('returns 0 at start', () => {
    expect(interpolateProgress(0, TOTAL_MS)).toBe(0);
  });

  it('returns 70 at 168秒 (end of initial segment)', () => {
    expect(interpolateProgress(168_000, TOTAL_MS)).toBe(70);
  });

  it('returns 90 at 248秒 (end of middle segment)', () => {
    expect(interpolateProgress(248_000, TOTAL_MS)).toBe(90);
  });

  it('returns 99 at or beyond total duration', () => {
    expect(interpolateProgress(TOTAL_MS, TOTAL_MS)).toBe(99);
    expect(interpolateProgress(TOTAL_MS * 2, TOTAL_MS)).toBe(99);
  });

  it('monotonically increases within the curve', () => {
    const p1 = interpolateProgress(TOTAL_MS * 0.1, TOTAL_MS);
    const p2 = interpolateProgress(TOTAL_MS * 0.3, TOTAL_MS);
    const p3 = interpolateProgress(TOTAL_MS * 0.5, TOTAL_MS);
    const p4 = interpolateProgress(TOTAL_MS * 0.7, TOTAL_MS);
    const p5 = interpolateProgress(TOTAL_MS * 0.9, TOTAL_MS);

    expect(p1).toBeLessThan(p2);
    expect(p2).toBeLessThan(p3);
    expect(p3).toBeLessThan(p4);
    expect(p4).toBeLessThan(p5);
    expect(p5).toBeLessThan(99);
  });

  it('time per 1% is monotonically non-decreasing', () => {
    // Find the time to reach each percentage point (1-99)
    const timesToReachPercent: number[] = [];
    for (let targetPercent = 1; targetPercent <= 99; targetPercent++) {
      // Binary search to find when we reach targetPercent
      let lo = 0;
      let hi = TOTAL_MS;
      while (hi - lo > 1) {
        const mid = (lo + hi) / 2;
        if (interpolateProgress(mid, TOTAL_MS) < targetPercent) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      timesToReachPercent.push(hi);
    }

    // Calculate time deltas (time to go from p% to (p+1)%)
    const deltas: number[] = [];
    deltas.push(timesToReachPercent[0]); // time to reach 1%
    for (let i = 1; i < timesToReachPercent.length; i++) {
      deltas.push(timesToReachPercent[i] - timesToReachPercent[i - 1]);
    }

    // Verify monotonically non-decreasing (with small tolerance for floating point)
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]).toBeGreaterThanOrEqual(deltas[i - 1] * 0.99);
    }
  });

  it('initial segment: linear progression at 4分/100% rate', () => {
    // At 84 seconds (half of the initial segment), should be at 35%
    const midPhase1 = interpolateProgress(84_000, TOTAL_MS);
    expect(midPhase1).toBeCloseTo(35, 0);
  });

  it('final segment: constant velocity', () => {
    // The final segment is 248-360 seconds, covering 90-99%
    // Should be linear: 9% over 112 seconds = ~0.08%/sec
    const start = interpolateProgress(248_000, TOTAL_MS);
    const mid = interpolateProgress(304_000, TOTAL_MS); // halfway through the final segment
    const end = interpolateProgress(360_000, TOTAL_MS);

    expect(start).toBe(90);
    expect(mid).toBeCloseTo(94.5, 0);
    expect(end).toBe(99);
  });
});

describe('easeOutQuad', () => {
  it('returns 0 at 0 and 1 at 1', () => {
    expect(easeOutQuad(0)).toBe(0);
    expect(easeOutQuad(1)).toBe(1);
  });
});

describe('calculateProgressState', () => {
  const startTime = new Date('2026-01-10T00:00:00.000Z');
  const nowTime = new Date('2026-01-10T00:01:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns waiting state when startedAt is null', () => {
    expect(calculateProgressState(null, null)).toEqual({
      percent: 0,
      isComplete: false,
      isWaiting: true,
    });
  });

  it('returns complete state when isComplete is true', () => {
    expect(calculateProgressState(null, startTime.toISOString(), TOTAL_MS, true)).toEqual({
      percent: 100,
      isComplete: true,
      isWaiting: false,
    });
  });

  it('calculates progress from startedAt timestamp', () => {
    const expected = Math.floor(interpolateProgress(nowTime.getTime() - startTime.getTime(), TOTAL_MS));

    expect(calculateProgressState(null, startTime.toISOString(), TOTAL_MS)).toEqual({
      percent: expected,
      isComplete: false,
      isWaiting: false,
    });
  });
});
