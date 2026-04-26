import { getZkVmRateLimitConfig } from '@/lib/rateLimit/rateLimitConfig';

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
    const cutoff = now - this.timeWindowMs;
    const executions = this.ipExecutions.get(ipAddress) ?? [];
    const validExecutions = executions.filter((timestamp) => timestamp > cutoff);

    if (validExecutions.length >= this.maxExecutions) {
      const oldestExecution = Math.min(...validExecutions);
      return Promise.resolve({
        allowed: false,
        remainingExecutions: 0,
        nextAvailableAt: new Date(oldestExecution + this.timeWindowMs).toISOString(),
      });
    }

    return Promise.resolve({
      allowed: true,
      remainingExecutions: this.maxExecutions - validExecutions.length,
    });
  }

  recordZkVmExecution(ipAddress: string): Promise<void> {
    const now = Date.now();
    const cutoff = now - this.timeWindowMs;
    const executions = this.ipExecutions.get(ipAddress) ?? [];
    const validExecutions = executions.filter((timestamp) => timestamp > cutoff);
    validExecutions.push(now);
    this.ipExecutions.set(ipAddress, validExecutions);
    return Promise.resolve();
  }

  consumeZkVmExecution(ipAddress: string): Promise<RateLimitResult> {
    const now = Date.now();
    const cutoff = now - this.timeWindowMs;
    const executions = this.ipExecutions.get(ipAddress) ?? [];
    const validExecutions = executions.filter((timestamp) => timestamp > cutoff);
    validExecutions.push(now);
    this.ipExecutions.set(ipAddress, validExecutions);

    if (validExecutions.length > this.maxExecutions) {
      const oldestExecution = Math.min(...validExecutions);
      return Promise.resolve({
        allowed: false,
        remainingExecutions: 0,
        nextAvailableAt: new Date(oldestExecution + this.timeWindowMs).toISOString(),
      });
    }

    return Promise.resolve({
      allowed: true,
      remainingExecutions: Math.max(0, this.maxExecutions - validExecutions.length),
    });
  }

  checkGlobalLimit(timeWindow: TimeWindow): Promise<GlobalLimitResult> {
    const limit = this.getLimit(timeWindow);
    const duration = this.getDuration(timeWindow);
    const now = Date.now();
    const windowStart = this.getWindowStart(timeWindow, new Date(now));
    const counter = this.globalCounters.get(timeWindow);

    if (!counter || counter.windowStart !== windowStart) {
      return Promise.resolve({ allowed: true, currentCount: 0, limit });
    }

    if (counter.count >= limit) {
      const windowEnd = counter.windowStart + duration;
      const retryAfter = Math.ceil((windowEnd - now) / 1000);
      return Promise.resolve({ allowed: false, currentCount: counter.count, limit, retryAfter });
    }

    return Promise.resolve({ allowed: true, currentCount: counter.count, limit });
  }

  incrementGlobalCount(timeWindow: TimeWindow): Promise<number> {
    const limit = this.getLimit(timeWindow);
    const now = Date.now();
    const windowStart = this.getWindowStart(timeWindow, new Date(now));
    const counter = this.globalCounters.get(timeWindow);

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
    const limit = this.getLimit(timeWindow);
    const duration = this.getDuration(timeWindow);
    const now = Date.now();
    const windowStart = this.getWindowStart(timeWindow, new Date(now));
    const counter = this.globalCounters.get(timeWindow);

    if (!counter || counter.windowStart !== windowStart) {
      this.globalCounters.set(timeWindow, { windowStart, count: 1 });
      return Promise.resolve({ allowed: true, currentCount: 1, limit });
    }

    counter.count += 1;

    if (counter.count > limit) {
      const windowEnd = counter.windowStart + duration;
      const retryAfter = Math.ceil((windowEnd - now) / 1000);
      return Promise.resolve({ allowed: false, currentCount: counter.count, limit, retryAfter });
    }

    return Promise.resolve({ allowed: true, currentCount: counter.count, limit });
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
