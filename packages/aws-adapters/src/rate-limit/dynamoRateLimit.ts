import { getSharedDynamoDocumentClient } from '@stark-ballot/aws-adapters/aws/dynamodbConfig';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { DynamoRateLimitStore, type RateLimitStore } from './dynamoRateLimitStore';
import { getRateLimitAttemptMultiplier, getVoteRateLimitConfig, getZkVmRateLimitConfig } from './rateLimitConfig';

interface VoteRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
}

interface ZkVmRateLimitResult {
  allowed: boolean;
  remainingExecutions: number;
  nextAvailableAt?: string;
}

interface GlobalLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  retryAfter?: number;
}

interface VoteLimiterConfig {
  limit: number;
  windowMs: number;
}

interface ZkVmLimiterConfig {
  maxExecutions: number;
  windowMs: number;
  dailyLimit: number;
  hourlyLimit: number;
}

const GLOBAL_COUNTER_TTL_BUFFER_MS = 5 * 60 * 1000;
const VOTE_SCOPE_PREFIX = 'vote';
const VOTE_ATTEMPT_SCOPE_PREFIX = 'vote-attempt';
const ZKVM_SCOPE_PREFIX = 'zkvm';
const ZKVM_ATTEMPT_SCOPE_PREFIX = 'zkvm-attempt';

function buildIpScope(ipAddress: string, scopePrefix: string): string {
  return `${scopePrefix}#${ipAddress}`;
}

function formatNumber(value: number, length: number): string {
  return value.toString().padStart(length, '0');
}

function getDailyWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

function getHourlyWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0));
}

function buildGlobalKey(timeWindow: 'daily' | 'hourly', windowStart: Date): string {
  const year = windowStart.getUTCFullYear();
  const month = formatNumber(windowStart.getUTCMonth() + 1, 2);
  const day = formatNumber(windowStart.getUTCDate(), 2);

  if (timeWindow === 'daily') {
    return `global#daily#${year}${month}${day}`;
  }

  const hour = formatNumber(windowStart.getUTCHours(), 2);
  return `global#hourly#${year}${month}${day}${hour}`;
}

function getWindowDurationMs(timeWindow: 'daily' | 'hourly'): number {
  return timeWindow === 'daily' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
}

function computeRetryAfter(windowStart: number, durationMs: number, now: number): number {
  const windowEnd = windowStart + durationMs;
  return Math.max(0, Math.ceil((windowEnd - now) / 1000));
}

function buildNextAvailableAt(oldestTimestamp: number, windowMs: number): string {
  return new Date(oldestTimestamp + windowMs).toISOString();
}

function computeRemaining(limit: number, count: number): number {
  return Math.max(0, limit - count - 1);
}

function computeGlobalCounterExpiry(windowStart: number, durationMs: number): number {
  return windowStart + durationMs + GLOBAL_COUNTER_TTL_BUFFER_MS;
}

export function createDynamoRateLimitStore(profile: ResolvedRuntimeProfile): DynamoRateLimitStore {
  if (profile.rateLimit.store !== 'dynamo' || profile.external.kind !== 'aws') {
    throw new Error('DynamoDB rate limiting requires a target AWS runtime profile.');
  }
  return new DynamoRateLimitStore({
    eventsTableName: profile.external.dynamo.rateLimitEventsTable,
    countersTableName: profile.external.dynamo.rateLimitCountersTable,
    documentClient: getSharedDynamoDocumentClient(profile),
  });
}

interface EventWindow {
  now: number;
  cutoff: number;
  scope: string;
}

function currentEventWindow(ipAddress: string, scopePrefix: string, windowMs: number): EventWindow {
  const now = Date.now();
  const cutoff = now - windowMs;
  const scope = buildIpScope(ipAddress, scopePrefix);
  return { now, cutoff, scope };
}

async function consumeEventWindow(
  store: RateLimitStore,
  ipAddress: string,
  scopePrefix: string,
  windowMs: number,
): Promise<EventWindow & { count: number }> {
  const window = currentEventWindow(ipAddress, scopePrefix, windowMs);
  await store.recordEvent(window.scope, window.now, window.now + windowMs);
  const count = await store.countEvents(window.scope, window.cutoff);
  return { ...window, count };
}

function recordWindowEvent(
  store: RateLimitStore,
  ipAddress: string,
  scopePrefix: string,
  windowMs: number,
): Promise<void> {
  const now = Date.now();
  const scope = buildIpScope(ipAddress, scopePrefix);
  return store.recordEvent(scope, now, now + windowMs);
}

export class DynamoVoteRateLimiter {
  private readonly store: RateLimitStore;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly scopePrefix: string;

  constructor(store: RateLimitStore, config: VoteLimiterConfig, scopePrefix: string = VOTE_SCOPE_PREFIX) {
    this.store = store;
    this.limit = config.limit;
    this.windowMs = config.windowMs;
    this.scopePrefix = scopePrefix;
  }

  async check(ipAddress: string): Promise<VoteRateLimitResult> {
    const { now, cutoff, scope } = currentEventWindow(ipAddress, this.scopePrefix, this.windowMs);
    const count = await this.store.countEvents(scope, cutoff);

    if (count >= this.limit) {
      return this.deniedVote(scope, cutoff, now);
    }

    return { allowed: true, remaining: computeRemaining(this.limit, count) };
  }

  async record(ipAddress: string): Promise<void> {
    await recordWindowEvent(this.store, ipAddress, this.scopePrefix, this.windowMs);
  }

  async consume(ipAddress: string): Promise<VoteRateLimitResult> {
    const { now, cutoff, scope, count } = await consumeEventWindow(
      this.store,
      ipAddress,
      this.scopePrefix,
      this.windowMs,
    );

    if (count > this.limit) {
      return this.deniedVote(scope, cutoff, now);
    }

    return { allowed: true, remaining: Math.max(0, this.limit - count) };
  }
  private async deniedVote(scope: string, cutoff: number, now: number): Promise<VoteRateLimitResult> {
    const oldest = await this.store.getOldestEventTimestamp(scope, cutoff);
    const retryAfter = oldest ? computeRetryAfter(oldest, this.windowMs, now) : Math.ceil(this.windowMs / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }
}

export class DynamoServerRateLimiter {
  private readonly store: RateLimitStore;
  private readonly maxExecutions: number;
  private readonly windowMs: number;
  private readonly dailyLimit: number;
  private readonly hourlyLimit: number;
  private readonly scopePrefix: string;

  constructor(store: RateLimitStore, config: ZkVmLimiterConfig, scopePrefix: string = ZKVM_SCOPE_PREFIX) {
    this.store = store;
    this.maxExecutions = config.maxExecutions;
    this.windowMs = config.windowMs;
    this.dailyLimit = config.dailyLimit;
    this.hourlyLimit = config.hourlyLimit;
    this.scopePrefix = scopePrefix;
  }

  async checkZkVmRateLimit(ipAddress: string): Promise<ZkVmRateLimitResult> {
    const { now, cutoff, scope } = currentEventWindow(ipAddress, this.scopePrefix, this.windowMs);
    const count = await this.store.countEvents(scope, cutoff);

    if (count >= this.maxExecutions) {
      return this.deniedExecution(scope, cutoff, now);
    }

    return {
      allowed: true,
      remainingExecutions: this.maxExecutions - count,
    };
  }

  async recordZkVmExecution(ipAddress: string): Promise<void> {
    await recordWindowEvent(this.store, ipAddress, this.scopePrefix, this.windowMs);
  }

  async consumeZkVmExecution(ipAddress: string): Promise<ZkVmRateLimitResult> {
    const { now, cutoff, scope, count } = await consumeEventWindow(
      this.store,
      ipAddress,
      this.scopePrefix,
      this.windowMs,
    );

    if (count > this.maxExecutions) {
      return this.deniedExecution(scope, cutoff, now);
    }

    return {
      allowed: true,
      remainingExecutions: Math.max(0, this.maxExecutions - count),
    };
  }

  private async deniedExecution(scope: string, cutoff: number, now: number): Promise<ZkVmRateLimitResult> {
    const oldest = await this.store.getOldestEventTimestamp(scope, cutoff);
    return {
      allowed: false,
      remainingExecutions: 0,
      nextAvailableAt: buildNextAvailableAt(oldest || now, this.windowMs),
    };
  }

  private globalWindow(timeWindow: 'daily' | 'hourly') {
    const now = new Date();
    const windowStart = timeWindow === 'daily' ? getDailyWindowStart(now) : getHourlyWindowStart(now);
    const durationMs = getWindowDurationMs(timeWindow);
    return {
      now,
      windowStart,
      durationMs,
      key: buildGlobalKey(timeWindow, windowStart),
      limit: timeWindow === 'daily' ? this.dailyLimit : this.hourlyLimit,
    };
  }

  async checkGlobalLimit(timeWindow: 'daily' | 'hourly'): Promise<GlobalLimitResult> {
    const { now, windowStart, key, limit, durationMs } = this.globalWindow(timeWindow);
    const currentCount = (await this.store.getCounter(key)) ?? 0;

    if (currentCount >= limit) {
      return {
        allowed: false,
        currentCount,
        limit,
        retryAfter: computeRetryAfter(windowStart.getTime(), durationMs, now.getTime()),
      };
    }

    return { allowed: true, currentCount, limit };
  }

  async incrementGlobalCount(timeWindow: 'daily' | 'hourly'): Promise<number> {
    const { windowStart, key, durationMs } = this.globalWindow(timeWindow);
    const expiresAt = computeGlobalCounterExpiry(windowStart.getTime(), durationMs);
    return await this.store.incrementCounter(key, expiresAt);
  }

  async consumeGlobalLimit(timeWindow: 'daily' | 'hourly'): Promise<GlobalLimitResult> {
    const { now, windowStart, key, limit, durationMs } = this.globalWindow(timeWindow);
    const expiresAt = computeGlobalCounterExpiry(windowStart.getTime(), durationMs);
    const currentCount = await this.store.incrementCounter(key, expiresAt);

    if (currentCount > limit) {
      return {
        allowed: false,
        currentCount,
        limit,
        retryAfter: computeRetryAfter(windowStart.getTime(), durationMs, now.getTime()),
      };
    }

    return { allowed: true, currentCount, limit };
  }
}

export function createDynamoVoteRateLimiter(profile: ResolvedRuntimeProfile): DynamoVoteRateLimiter {
  return new DynamoVoteRateLimiter(createDynamoRateLimitStore(profile), getVoteRateLimitConfig());
}

export function createDynamoServerRateLimiter(profile: ResolvedRuntimeProfile): DynamoServerRateLimiter {
  return new DynamoServerRateLimiter(createDynamoRateLimitStore(profile), getZkVmRateLimitConfig());
}

export function createDynamoVoteAttemptLimiter(profile: ResolvedRuntimeProfile): DynamoVoteRateLimiter {
  const config = getVoteRateLimitConfig();
  const multiplier = getRateLimitAttemptMultiplier();
  return new DynamoVoteRateLimiter(
    createDynamoRateLimitStore(profile),
    { ...config, limit: config.limit * multiplier },
    VOTE_ATTEMPT_SCOPE_PREFIX,
  );
}

export function createDynamoServerAttemptLimiter(profile: ResolvedRuntimeProfile): DynamoServerRateLimiter {
  const config = getZkVmRateLimitConfig();
  const multiplier = getRateLimitAttemptMultiplier();
  return new DynamoServerRateLimiter(
    createDynamoRateLimitStore(profile),
    { ...config, maxExecutions: config.maxExecutions * multiplier },
    ZKVM_ATTEMPT_SCOPE_PREFIX,
  );
}
