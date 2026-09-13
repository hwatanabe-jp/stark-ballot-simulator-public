import {
  createDynamoVoteAttemptLimiter,
  createDynamoVoteRateLimiter,
  type DynamoVoteRateLimiter,
} from '@stark-ballot/aws-adapters/rate-limit/dynamoRateLimit';
import {
  getRateLimitAttemptMultiplier,
  getVoteRateLimitConfig,
} from '@stark-ballot/aws-adapters/rate-limit/rateLimitConfig';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

type Timestamp = number;

interface VoteWindow {
  windowStart: Timestamp;
  count: number;
}

const DEFAULT_CONFIG = getVoteRateLimitConfig();
const ATTEMPT_MULTIPLIER = getRateLimitAttemptMultiplier();

export class VoteRateLimiter {
  private readonly buckets = new Map<string, VoteWindow>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxBuckets: number;

  constructor(
    limit = DEFAULT_CONFIG.limit,
    windowMs = DEFAULT_CONFIG.windowMs,
    maxBuckets = DEFAULT_CONFIG.maxBuckets,
  ) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxBuckets = maxBuckets;
  }

  check(ipAddress: string): { allowed: boolean; remaining: number; retryAfter?: number } {
    const now = Date.now();
    const record = this.buckets.get(ipAddress);

    if (!record || now - record.windowStart >= this.windowMs) {
      return { allowed: true, remaining: this.limit - 1 };
    }

    if (record.count >= this.limit) {
      const retryAfter = Math.ceil((record.windowStart + this.windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    return { allowed: true, remaining: this.limit - record.count - 1 };
  }

  record(ipAddress: string): void {
    const now = Date.now();
    const record = this.buckets.get(ipAddress);

    if (!record || now - record.windowStart >= this.windowMs) {
      if (this.buckets.size >= this.maxBuckets) {
        this.cleanupExpired(now);
        if (this.buckets.size >= this.maxBuckets) {
          const oldestKey = this.buckets.keys().next().value;
          if (oldestKey) {
            this.buckets.delete(oldestKey);
          }
        }
      }
      this.buckets.set(ipAddress, { windowStart: now, count: 1 });
      return;
    }

    record.count += 1;
  }

  consume(ipAddress: string): { allowed: boolean; remaining: number; retryAfter?: number } {
    const now = Date.now();
    let record = this.buckets.get(ipAddress);

    if (!record || now - record.windowStart >= this.windowMs) {
      if (this.buckets.size >= this.maxBuckets) {
        this.cleanupExpired(now);
        if (this.buckets.size >= this.maxBuckets) {
          const oldestKey = this.buckets.keys().next().value;
          if (oldestKey) {
            this.buckets.delete(oldestKey);
          }
        }
      }
      record = { windowStart: now, count: 0 };
    }

    record.count += 1;
    this.buckets.set(ipAddress, record);

    if (record.count > this.limit) {
      const retryAfter = Math.ceil((record.windowStart + this.windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    return { allowed: true, remaining: Math.max(0, this.limit - record.count) };
  }

  reset(): void {
    this.buckets.clear();
  }

  getActiveBucketCount(): number {
    return this.buckets.size;
  }

  private cleanupExpired(now: number): void {
    for (const [ip, window] of this.buckets.entries()) {
      if (now - window.windowStart >= this.windowMs) {
        this.buckets.delete(ip);
      }
    }
  }
}

type VoteLimiterInstance = VoteRateLimiter | DynamoVoteRateLimiter;

let voteRateLimiter: VoteLimiterInstance | null = null;
let voteAttemptLimiter: VoteLimiterInstance | null = null;

export function getVoteRateLimiter(profile: ResolvedRuntimeProfile): VoteLimiterInstance {
  if (!voteRateLimiter) {
    voteRateLimiter =
      profile.rateLimit.store === 'dynamo' ? createDynamoVoteRateLimiter(profile) : new VoteRateLimiter();
  }
  return voteRateLimiter;
}

export function getVoteAttemptLimiter(profile: ResolvedRuntimeProfile): VoteLimiterInstance {
  if (!voteAttemptLimiter) {
    if (profile.rateLimit.store === 'dynamo') {
      voteAttemptLimiter = createDynamoVoteAttemptLimiter(profile);
    } else {
      const config = getVoteRateLimitConfig();
      voteAttemptLimiter = new VoteRateLimiter(config.limit * ATTEMPT_MULTIPLIER, config.windowMs, config.maxBuckets);
    }
  }
  return voteAttemptLimiter;
}

export function resetVoteRateLimiter(): void {
  if (voteRateLimiter instanceof VoteRateLimiter) {
    voteRateLimiter.reset();
  }
  if (voteAttemptLimiter instanceof VoteRateLimiter) {
    voteAttemptLimiter.reset();
  }
  voteRateLimiter = null;
  voteAttemptLimiter = null;
}
