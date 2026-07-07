import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VoteRateLimiter, getVoteRateLimiter, resetVoteRateLimiter } from './voteRateLimit';

describe('VoteRateLimiter', () => {
  beforeEach(() => {
    resetVoteRateLimiter();
  });

  it('allows requests within limit and returns remaining count', () => {
    const limiter = new VoteRateLimiter(3, 1_000);
    const result = limiter.check('203.0.113.1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('blocks requests exceeding limit and returns retryAfter', () => {
    const limiter = new VoteRateLimiter(2, 5_000);
    const ip = '203.0.113.2';
    limiter.record(ip);
    limiter.record(ip);
    const result = limiter.check(ip);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('resets window after expiry', () => {
    vi.useFakeTimers();
    const limiter = new VoteRateLimiter(1, 1_000);
    const ip = '203.0.113.3';
    limiter.record(ip);
    vi.advanceTimersByTime(1_001);
    const result = limiter.check(ip);
    expect(result.allowed).toBe(true);
    vi.useRealTimers();
  });

  it('cleans up buckets when max size exceeded', () => {
    const limiter = new VoteRateLimiter(1, 1_000, 1);
    limiter.record('203.0.113.4');
    limiter.record('203.0.113.5');
    expect(limiter.getActiveBucketCount()).toBeLessThanOrEqual(1);
  });
});

describe('shared voteRateLimiter instance', () => {
  it('shares state between calls', async () => {
    resetVoteRateLimiter();
    const limiter = getVoteRateLimiter();
    const ip = '198.51.100.1';
    for (let i = 0; i < 10; i++) {
      await limiter.record(ip);
    }
    const result = await getVoteRateLimiter().check(ip);
    expect(result.allowed).toBe(false);
  });
});
