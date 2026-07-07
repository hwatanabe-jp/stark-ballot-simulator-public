import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRateLimiter } from './serverRateLimit';

describe('ServerRateLimiter (in-memory)', () => {
  let rateLimiter: ServerRateLimiter;

  beforeEach(() => {
    rateLimiter = new ServerRateLimiter();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkZkVmRateLimit / recordZkVmExecution', () => {
    it('allows first execution and tracks remaining count', async () => {
      const ip = '192.0.2.1';

      const initial = await rateLimiter.checkZkVmRateLimit(ip);
      expect(initial.allowed).toBe(true);
      expect(initial.remainingExecutions).toBe(50);

      await rateLimiter.recordZkVmExecution(ip);

      const afterFirst = await rateLimiter.checkZkVmRateLimit(ip);
      expect(afterFirst.allowed).toBe(true);
      expect(afterFirst.remainingExecutions).toBe(49);
    });

    it('rejects when execution limit is exceeded within 24 hours', async () => {
      const ip = '198.51.100.42';

      for (let i = 0; i < 50; i++) {
        await rateLimiter.recordZkVmExecution(ip);
        vi.advanceTimersByTime(1_000);
      }

      const result = await rateLimiter.checkZkVmRateLimit(ip);
      expect(result.allowed).toBe(false);
      expect(result.remainingExecutions).toBe(0);
      expect(result.nextAvailableAt).toBeDefined();
    });

    it('expires executions older than 24 hours', async () => {
      const ip = '203.0.113.5';

      await rateLimiter.recordZkVmExecution(ip);
      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours

      const result = await rateLimiter.checkZkVmRateLimit(ip);
      expect(result.allowed).toBe(true);
      expect(result.remainingExecutions).toBe(50);
    });
  });

  describe('checkGlobalLimit / incrementGlobalCount', () => {
    it('allows increments under the hourly limit', async () => {
      const firstCheck = await rateLimiter.checkGlobalLimit('hourly');
      expect(firstCheck.allowed).toBe(true);
      expect(firstCheck.currentCount).toBe(0);
      expect(firstCheck.limit).toBe(100);

      await rateLimiter.incrementGlobalCount('hourly');

      const afterIncrement = await rateLimiter.checkGlobalLimit('hourly');
      expect(afterIncrement.allowed).toBe(true);
      expect(afterIncrement.currentCount).toBe(1);
    });

    it('rejects when hourly limit exceeded and exposes retryAfter', async () => {
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

      for (let i = 0; i < 100; i++) {
        await rateLimiter.incrementGlobalCount('hourly');
      }

      const result = await rateLimiter.checkGlobalLimit('hourly');
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(100);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('resets counters when the time window rolls over', async () => {
      for (let i = 0; i < 50; i++) {
        await rateLimiter.incrementGlobalCount('daily');
      }

      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours

      const result = await rateLimiter.checkGlobalLimit('daily');
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
    });
  });
});
