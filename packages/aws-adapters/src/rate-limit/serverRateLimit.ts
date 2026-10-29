import { getZkVmRateLimitConfig } from '@stark-ballot/aws-adapters/rate-limit/rateLimitConfig';

export interface RateLimitResult {
  allowed: boolean;
  remainingExecutions: number;
  nextAvailableAt?: string;
}

export interface GlobalLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  retryAfter?: number;
}

type TimeWindow = 'daily' | 'hourly';

interface GlobalCounter {
  windowStart: number;
  count: number;
}

interface ZkVmRateLimitConfig {
  maxExecutions: number;
  windowMs: number;
  dailyLimit: number;
  hourlyLimit: number;
}

export class ServerRateLimiter {
  private readonly ipExecutions = new Map<string, number[]>();
  private readonly globalCounters = new Map<TimeWindow, GlobalCounter>();

  private readonly maxExecutions: number;
  private readonly timeWindowMs: number;
  private readonly dailyLimit: number;
  private readonly hourlyLimit: number;

  constructor(config: ZkVmRateLimitConfig = getZkVmRateLimitConfig()) {
    this.maxExecutions = config.maxExecutions;
    this.timeWindowMs = config.windowMs;
    this.dailyLimit = config.dailyLimit;
    this.hourlyLimit = config.hourlyLimit;
  }

  checkZkVmRateLimit(ipAddress: string): Promise<RateLimitResult> {
    const now = Date.now();
    const validExecutions = this.recentExecutions(ipAddress, now);

    if (validExecutions.length >= this.maxExecutions) {
      return Promise.resolve(this.deniedExecution(validExecutions));
    }

    return Promise.resolve({
      allowed: true,
      remainingExecutions: this.maxExecutions - validExecutions.length,
    });
  }

  recordZkVmExecution(ipAddress: string): Promise<void> {
    const now = Date.now();
    const validExecutions = this.recentExecutions(ipAddress, now);
    validExecutions.push(now);
    this.ipExecutions.set(ipAddress, validExecutions);
    return Promise.resolve();
  }

  consumeZkVmExecution(ipAddress: string): Promise<RateLimitResult> {
    const now = Date.now();
    const validExecutions = this.recentExecutions(ipAddress, now);
    validExecutions.push(now);
    this.ipExecutions.set(ipAddress, validExecutions);

    if (validExecutions.length > this.maxExecutions) {
      return Promise.resolve(this.deniedExecution(validExecutions));
    }

    return Promise.resolve({
      allowed: true,
      remainingExecutions: Math.max(0, this.maxExecutions - validExecutions.length),
    });
  }

  checkGlobalLimit(timeWindow: TimeWindow): Promise<GlobalLimitResult> {
    const { limit, duration, now, windowStart, counter } = this.currentWindow(timeWindow);

    if (!counter || counter.windowStart !== windowStart) {
      return Promise.resolve({ allowed: true, currentCount: 0, limit });
    }

    if (counter.count >= limit) {
      return Promise.resolve(this.deniedGlobalCount(counter, limit, duration, now));
    }

    return Promise.resolve({ allowed: true, currentCount: counter.count, limit });
  }

  incrementGlobalCount(timeWindow: TimeWindow): Promise<number> {
    const { limit, windowStart, counter } = this.currentWindow(timeWindow);

    if (!counter || counter.windowStart !== windowStart) {
      this.globalCounters.set(timeWindow, { windowStart, count: 1 });
      return Promise.resolve(1);
    }

    if (counter.count >= limit) {
      return Promise.resolve(counter.count);
    }

    counter.count += 1;
    return Promise.resolve(counter.count);
  }

  consumeGlobalLimit(timeWindow: TimeWindow): Promise<GlobalLimitResult> {
    const { limit, duration, now, windowStart, counter } = this.currentWindow(timeWindow);

    if (!counter || counter.windowStart !== windowStart) {
      this.globalCounters.set(timeWindow, { windowStart, count: 1 });
      return Promise.resolve({ allowed: true, currentCount: 1, limit });
    }

    counter.count += 1;

    if (counter.count > limit) {
      return Promise.resolve(this.deniedGlobalCount(counter, limit, duration, now));
    }

    return Promise.resolve({ allowed: true, currentCount: counter.count, limit });
  }

  private recentExecutions(ipAddress: string, now: number): number[] {
    const cutoff = now - this.timeWindowMs;
    return (this.ipExecutions.get(ipAddress) ?? []).filter((timestamp) => timestamp > cutoff);
  }

  private deniedExecution(executions: number[]): RateLimitResult {
    return {
      allowed: false,
      remainingExecutions: 0,
      nextAvailableAt: new Date(Math.min(...executions) + this.timeWindowMs).toISOString(),
    };
  }

  private currentWindow(timeWindow: TimeWindow) {
    const now = Date.now();
    return {
      limit: this.getLimit(timeWindow),
      duration: this.getDuration(timeWindow),
      now,
      windowStart: this.getWindowStart(timeWindow, new Date(now)),
      counter: this.globalCounters.get(timeWindow),
    };
  }

  private deniedGlobalCount(counter: GlobalCounter, limit: number, duration: number, now: number): GlobalLimitResult {
    return {
      allowed: false,
      currentCount: counter.count,
      limit,
      retryAfter: Math.ceil((counter.windowStart + duration - now) / 1000),
    };
  }

  private getLimit(timeWindow: TimeWindow): number {
    return timeWindow === 'daily' ? this.dailyLimit : this.hourlyLimit;
  }

  private getDuration(timeWindow: TimeWindow): number {
    return timeWindow === 'daily' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  }

  private getWindowStart(timeWindow: TimeWindow, now: Date): number {
    if (timeWindow === 'daily') {
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
    }
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0);
  }
}
