import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { DynamoServerRateLimiter, DynamoVoteRateLimiter } from './dynamoRateLimit';
import type { RateLimitStore } from './dynamoRateLimitStore';

class FakeRateLimitStore implements RateLimitStore {
  private readonly events = new Map<string, number[]>();
  private readonly counters = new Map<string, number>();

  countEvents(scope: string, sinceTimestamp: number): Promise<number> {
    const events = this.events.get(scope) ?? [];
    return Promise.resolve(events.filter((timestamp) => timestamp > sinceTimestamp).length);
  }

  getOldestEventTimestamp(scope: string, sinceTimestamp: number): Promise<number | null> {
    const events = this.events.get(scope) ?? [];
    const filtered = events.filter((timestamp) => timestamp > sinceTimestamp).sort((a, b) => a - b);
    return Promise.resolve(filtered.length > 0 ? filtered[0] : null);
  }

  recordEvent(scope: string, timestamp: number, _expiresAt: number): Promise<void> {
    void _expiresAt;
    const events = this.events.get(scope) ?? [];
    events.push(timestamp);
    this.events.set(scope, events);
    return Promise.resolve();
  }

  getCounter(key: string): Promise<number | null> {
    return Promise.resolve(this.counters.get(key) ?? null);
  }

  incrementCounter(key: string, _expiresAt: number): Promise<number> {
    void _expiresAt;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }
}

describe('DynamoVoteRateLimiter (store-backed)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests within limit and returns remaining count', async () => {
    const store = new FakeRateLimitStore();
    const limiter = new DynamoVoteRateLimiter(store, { limit: 2, windowMs: 1000 });

    const first = await limiter.check('203.0.113.1');
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);

    await limiter.record('203.0.113.1');

    const second = await limiter.check('203.0.113.1');
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
  });

  it('blocks when limit is exceeded and returns retryAfter', async () => {
    const store = new FakeRateLimitStore();
    const limiter = new DynamoVoteRateLimiter(store, { limit: 2, windowMs: 1000 });

    await limiter.record('203.0.113.2');
    vi.setSystemTime(new Date('2025-01-01T00:00:00.100Z'));
    await limiter.record('203.0.113.2');

    vi.setSystemTime(new Date('2025-01-01T00:00:00.200Z'));
    const result = await limiter.check('203.0.113.2');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });
});

describe('DynamoServerRateLimiter (store-backed)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks per-IP executions within window', async () => {
    const store = new FakeRateLimitStore();
    const limiter = new DynamoServerRateLimiter(store, {
      maxExecutions: 2,
      windowMs: 1000,
      dailyLimit: 10,
      hourlyLimit: 10,
    });

    const initial = await limiter.checkZkVmRateLimit('198.51.100.1');
    expect(initial.allowed).toBe(true);
    expect(initial.remainingExecutions).toBe(2);

    await limiter.recordZkVmExecution('198.51.100.1');
    const afterFirst = await limiter.checkZkVmRateLimit('198.51.100.1');
    expect(afterFirst.allowed).toBe(true);
    expect(afterFirst.remainingExecutions).toBe(1);
  });

  it('blocks when per-IP execution limit is exceeded', async () => {
    const store = new FakeRateLimitStore();
    const limiter = new DynamoServerRateLimiter(store, {
      maxExecutions: 2,
      windowMs: 1000,
      dailyLimit: 10,
      hourlyLimit: 10,
    });

    await limiter.recordZkVmExecution('198.51.100.2');
    vi.setSystemTime(new Date('2025-01-01T00:00:00.100Z'));
    await limiter.recordZkVmExecution('198.51.100.2');

    vi.setSystemTime(new Date('2025-01-01T00:00:00.200Z'));
    const result = await limiter.checkZkVmRateLimit('198.51.100.2');
    expect(result.allowed).toBe(false);
    expect(result.remainingExecutions).toBe(0);
    expect(result.nextAvailableAt).toBeDefined();
  });

  it('blocks when global limit is exceeded', async () => {
    const store = new FakeRateLimitStore();
    const limiter = new DynamoServerRateLimiter(store, {
      maxExecutions: 2,
      windowMs: 1000,
      dailyLimit: 1,
      hourlyLimit: 1,
    });

    await limiter.incrementGlobalCount('hourly');

    const result = await limiter.checkGlobalLimit('hourly');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });
});
