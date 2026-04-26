import {
  createDynamoVoteAttemptLimiter,
  createDynamoVoteRateLimiter,
  type DynamoVoteRateLimiter,
} from '@/lib/rateLimit/dynamoRateLimit';
import {
  getRateLimitAttemptMultiplier,
  getVoteRateLimitConfig,
  resolveRateLimitStore,
} from '@/lib/rateLimit/rateLimitConfig';

type Timestamp = number;

interface VoteWindow {
  windowStart: Timestamp;
  count: number;
}

const DEFAULT_CONFIG = getVoteRateLimitConfig();
const ATTEMPT_MULTIPLIER = getRateLimitAttemptMultiplier();

export class VoteRateLimiter {
  private readonly buckets = new Map<string, VoteWindow>();

  constructor(
    private readonly limit = DEFAULT_CONFIG.limit,
    private readonly windowMs = DEFAULT_CONFIG.windowMs,
    private readonly maxBuckets = DEFAULT_CONFIG.maxBuckets,
  ) {}

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

export function getVoteRateLimiter(): VoteLimiterInstance {
  if (!voteRateLimiter) {
    voteRateLimiter = resolveRateLimitStore() === 'dynamo' ? createDynamoVoteRateLimiter() : new VoteRateLimiter();
  }
  return voteRateLimiter;
}

export function getVoteAttemptLimiter(): VoteLimiterInstance {
  if (!voteAttemptLimiter) {
    if (resolveRateLimitStore() === 'dynamo') {
      voteAttemptLimiter = createDynamoVoteAttemptLimiter();
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
