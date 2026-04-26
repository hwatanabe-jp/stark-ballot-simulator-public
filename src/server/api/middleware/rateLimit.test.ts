import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { VoteRateLimiter } from '@/lib/rateLimit/voteRateLimit';
import type { ServerRateLimiter } from '@/lib/rateLimit/serverRateLimit';
import {
  consumeVoteRateLimit,
  enforceFinalizeCancelRateLimit,
  enforceFinalizeRateLimit,
  enforceSessionCreateRateLimit,
  enforceVoteRateLimit,
  recordFinalizeRateLimit,
} from './rateLimit';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getStringProperty } from '@/lib/utils/guards';

const originalUseMockStore = process.env.USE_MOCK_STORE;

describe('enforceVoteRateLimit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('consumes attempt limiter when allowed', async () => {
    // Given
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    // When
    const result = await enforceVoteRateLimit(undefined, attemptLimiter);

    // Then
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('0.0.0.0');
    }
    expect(attemptLimiter.consume).toHaveBeenCalledWith('0.0.0.0');
  });

  it('returns GLOBAL_LIMIT_EXCEEDED when blocked', async () => {
    // Given
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 42 }),
    };

    // When
    const result = await enforceVoteRateLimit('203.0.113.5', attemptLimiter);

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote rate limit');
      expect(getStringProperty(payload, 'error')).toBe('GLOBAL_LIMIT_EXCEEDED');
      expect(attemptLimiter.consume).toHaveBeenCalledWith('203.0.113.5');
    }
  });

  it('returns INVALID_REQUEST when client IP is missing in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    const result = await enforceVoteRateLimit(undefined, attemptLimiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote rate limit missing ip');
      expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    }
    expect(attemptLimiter.consume).not.toHaveBeenCalled();
  });

  it('allows missing client IP in production when mock store is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('USE_MOCK_STORE', 'true');
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    const result = await enforceVoteRateLimit(undefined, attemptLimiter);

    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('0.0.0.0');
    }
    expect(attemptLimiter.consume).toHaveBeenCalledWith('0.0.0.0');
  });
});

describe('enforceSessionCreateRateLimit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('consumes session-create limiter when allowed', async () => {
    const limiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 5 }),
    };

    const result = await enforceSessionCreateRateLimit(undefined, limiter);

    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('0.0.0.0');
    }
    expect(limiter.consume).toHaveBeenCalledWith('0.0.0.0');
  });

  it('returns GLOBAL_LIMIT_EXCEEDED when blocked', async () => {
    const limiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 30 }),
    };

    const result = await enforceSessionCreateRateLimit('203.0.113.7', limiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'session create rate limit');
      expect(getStringProperty(payload, 'error')).toBe('GLOBAL_LIMIT_EXCEEDED');
    }
    expect(limiter.consume).toHaveBeenCalledWith('203.0.113.7');
  });
});

describe('enforceFinalizeCancelRateLimit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('consumes cancel limiter when allowed', async () => {
    const limiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 1 }),
    };

    const result = await enforceFinalizeCancelRateLimit('203.0.113.9', limiter);

    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('203.0.113.9');
    }
    expect(limiter.consume).toHaveBeenCalledWith('203.0.113.9');
  });

  it('returns GLOBAL_LIMIT_EXCEEDED when cancel is rate-limited', async () => {
    const limiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 15 }),
    };

    const result = await enforceFinalizeCancelRateLimit('203.0.113.9', limiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'finalize cancel rate limit');
      expect(getStringProperty(payload, 'error')).toBe('GLOBAL_LIMIT_EXCEEDED');
    }
    expect(limiter.consume).toHaveBeenCalledWith('203.0.113.9');
  });
});

describe('consumeVoteRateLimit', () => {
  it('records usage when allowed', async () => {
    const rateLimiter: Pick<VoteRateLimiter, 'check' | 'record' | 'consume'> = {
      check: vi.fn().mockReturnValue({ allowed: true, remaining: 1 }),
      record: vi.fn(),
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    const result = await consumeVoteRateLimit('203.0.113.5', rateLimiter);

    expect(result).toBeNull();
    expect(rateLimiter.consume).toHaveBeenCalledWith('203.0.113.5');
    expect(rateLimiter.record).not.toHaveBeenCalled();
  });

  it('returns GLOBAL_LIMIT_EXCEEDED when blocked', async () => {
    const rateLimiter: Pick<VoteRateLimiter, 'check' | 'record' | 'consume'> = {
      check: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 42 }),
      record: vi.fn(),
      consume: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 42 }),
    };

    const result = await consumeVoteRateLimit('203.0.113.5', rateLimiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote rate limit');
      expect(getStringProperty(payload, 'error')).toBe('GLOBAL_LIMIT_EXCEEDED');
    }
    expect(rateLimiter.record).not.toHaveBeenCalled();
    expect(rateLimiter.consume).toHaveBeenCalledWith('203.0.113.5');
  });
});

describe('enforceFinalizeRateLimit', () => {
  beforeEach(() => {
    process.env.USE_MOCK_STORE = 'false';
  });

  afterEach(() => {
    if (originalUseMockStore === undefined) {
      delete process.env.USE_MOCK_STORE;
    } else {
      process.env.USE_MOCK_STORE = originalUseMockStore;
    }
  });

  it('bypasses checks when mock store is enabled', async () => {
    // Given
    process.env.USE_MOCK_STORE = 'true';

    const rateLimiter: Pick<
      ServerRateLimiter,
      'checkZkVmRateLimit' | 'checkGlobalLimit' | 'recordZkVmExecution' | 'incrementGlobalCount'
    > = {
      checkZkVmRateLimit: vi.fn().mockResolvedValue({ allowed: true, remainingExecutions: 1 }),
      checkGlobalLimit: vi.fn().mockResolvedValue({ allowed: true, currentCount: 0, limit: 10 }),
      recordZkVmExecution: vi.fn().mockResolvedValue(undefined),
      incrementGlobalCount: vi.fn().mockResolvedValue(1),
    };
    const attemptLimiter: Pick<ServerRateLimiter, 'consumeZkVmExecution'> = {
      consumeZkVmExecution: vi.fn().mockResolvedValue({ allowed: true, remainingExecutions: 1 }),
    };

    // When
    const result = await enforceFinalizeRateLimit(undefined, { rateLimiter, attemptLimiter });

    // Then
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('0.0.0.0');
      expect(result.shouldRecord).toBe(false);
    }
    expect(rateLimiter.checkZkVmRateLimit).not.toHaveBeenCalled();
    expect(attemptLimiter.consumeZkVmExecution).not.toHaveBeenCalled();
  });

  it('returns ZKVM_RATE_LIMIT_EXCEEDED when IP limit is hit', async () => {
    // Given
    const rateLimiter: Pick<
      ServerRateLimiter,
      'checkZkVmRateLimit' | 'checkGlobalLimit' | 'recordZkVmExecution' | 'incrementGlobalCount'
    > = {
      checkZkVmRateLimit: vi.fn().mockResolvedValue({
        allowed: false,
        remainingExecutions: 0,
        nextAvailableAt: '2025-01-01T00:00:00.000Z',
      }),
      checkGlobalLimit: vi.fn().mockResolvedValue({ allowed: true, currentCount: 0, limit: 10 }),
      recordZkVmExecution: vi.fn().mockResolvedValue(undefined),
      incrementGlobalCount: vi.fn().mockResolvedValue(1),
    };
    const attemptLimiter: Pick<ServerRateLimiter, 'consumeZkVmExecution'> = {
      consumeZkVmExecution: vi.fn().mockResolvedValue({
        allowed: true,
        remainingExecutions: 0,
        nextAvailableAt: '2025-01-01T00:00:00.000Z',
      }),
    };

    // When
    const result = await enforceFinalizeRateLimit('203.0.113.5', { rateLimiter, attemptLimiter });

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'finalize rate limit');
      expect(getStringProperty(payload, 'error')).toBe('ZKVM_RATE_LIMIT_EXCEEDED');
    }
    expect(rateLimiter.checkGlobalLimit).not.toHaveBeenCalled();
  });
});

describe('recordFinalizeRateLimit', () => {
  it('records counters when enabled', async () => {
    // Given
    const rateLimiter: Pick<ServerRateLimiter, 'recordZkVmExecution' | 'incrementGlobalCount'> = {
      recordZkVmExecution: vi.fn().mockResolvedValue(undefined),
      incrementGlobalCount: vi.fn().mockResolvedValue(1),
    };

    // When
    await recordFinalizeRateLimit(rateLimiter, '203.0.113.5', true);

    // Then
    expect(rateLimiter.recordZkVmExecution).toHaveBeenCalledWith('203.0.113.5');
    expect(rateLimiter.incrementGlobalCount).toHaveBeenCalledWith('daily');
    expect(rateLimiter.incrementGlobalCount).toHaveBeenCalledWith('hourly');
  });

  it('skips recording when disabled', async () => {
    // Given
    const rateLimiter: Pick<ServerRateLimiter, 'recordZkVmExecution' | 'incrementGlobalCount'> = {
      recordZkVmExecution: vi.fn().mockResolvedValue(undefined),
      incrementGlobalCount: vi.fn().mockResolvedValue(1),
    };

    // When
    await recordFinalizeRateLimit(rateLimiter, '203.0.113.5', false);

    // Then
    expect(rateLimiter.recordZkVmExecution).not.toHaveBeenCalled();
    expect(rateLimiter.incrementGlobalCount).not.toHaveBeenCalled();
  });
});
