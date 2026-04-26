import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DuplicateDetectorCache } from './duplicate-detector-cache';

describe('DuplicateDetectorCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses detectors when accessed within the TTL window', () => {
    const cache = new DuplicateDetectorCache({
      ttlMs: 60_000,
      cleanupIntervalMs: 10_000,
    });

    const detector = cache.getOrCreate('session-1');

    vi.advanceTimersByTime(40_000);
    const sameDetector = cache.getOrCreate('session-1');

    expect(sameDetector).toBe(detector);

    vi.advanceTimersByTime(30_000);
    const stillSameDetector = cache.getOrCreate('session-1');

    expect(stillSameDetector).toBe(detector);
  });

  it('evicts detectors after TTL expiration on subsequent access', () => {
    const cache = new DuplicateDetectorCache({
      ttlMs: 60_000,
      cleanupIntervalMs: 10_000,
    });

    const detector = cache.getOrCreate('session-1');
    detector.checkDuplicate('vote-1', 'commit-1');

    vi.advanceTimersByTime(61_000);

    const refreshedDetector = cache.getOrCreate('session-1');

    expect(refreshedDetector).not.toBe(detector);
    expect(refreshedDetector.checkDuplicate('vote-1', 'commit-1').isDuplicate).toBe(false);
  });
});
