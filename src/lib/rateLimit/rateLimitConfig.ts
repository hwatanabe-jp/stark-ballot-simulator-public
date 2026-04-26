type RateLimitStoreKind = 'memory' | 'dynamo';

const DEFAULT_ZKVM_MAX_EXECUTIONS = 50;
const DEFAULT_ZKVM_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ZKVM_GLOBAL_DAILY_LIMIT = 1000;
const DEFAULT_ZKVM_GLOBAL_HOURLY_LIMIT = 100;
const DEFAULT_VOTE_LIMIT = 10;
const DEFAULT_VOTE_WINDOW_MS = 60_000;
const DEFAULT_VOTE_MAX_BUCKETS = 10_000;
const DEFAULT_SESSION_CREATE_LIMIT = 30;
const DEFAULT_SESSION_CREATE_WINDOW_MS = 60_000;
const DEFAULT_SESSION_CREATE_MAX_BUCKETS = 10_000;
const DEFAULT_FINALIZE_CANCEL_LIMIT = 5;
const DEFAULT_FINALIZE_CANCEL_WINDOW_MS = 60_000;
const DEFAULT_FINALIZE_CANCEL_MAX_BUCKETS = 10_000;
const DEFAULT_RATE_LIMIT_ATTEMPT_MULTIPLIER = 2;

function readPositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function getZkVmRateLimitConfig(): {
  maxExecutions: number;
  windowMs: number;
  dailyLimit: number;
  hourlyLimit: number;
} {
  return {
    maxExecutions: readPositiveNumber(process.env.ZKVM_RATE_LIMIT_PER_IP, DEFAULT_ZKVM_MAX_EXECUTIONS),
    windowMs: readPositiveNumber(process.env.ZKVM_RATE_LIMIT_WINDOW_MS, DEFAULT_ZKVM_WINDOW_MS),
    dailyLimit: readPositiveNumber(process.env.ZKVM_GLOBAL_DAILY_LIMIT, DEFAULT_ZKVM_GLOBAL_DAILY_LIMIT),
    hourlyLimit: readPositiveNumber(process.env.ZKVM_GLOBAL_HOURLY_LIMIT, DEFAULT_ZKVM_GLOBAL_HOURLY_LIMIT),
  };
}

export function getVoteRateLimitConfig(): {
  limit: number;
  windowMs: number;
  maxBuckets: number;
} {
  return {
    limit: readPositiveNumber(process.env.VOTE_RATE_LIMIT, DEFAULT_VOTE_LIMIT),
    windowMs: readPositiveNumber(process.env.VOTE_RATE_LIMIT_WINDOW_MS, DEFAULT_VOTE_WINDOW_MS),
    maxBuckets: readPositiveNumber(process.env.VOTE_RATE_LIMIT_MAX_BUCKETS, DEFAULT_VOTE_MAX_BUCKETS),
  };
}

export function getSessionCreateRateLimitConfig(): {
  limit: number;
  windowMs: number;
  maxBuckets: number;
} {
  return {
    limit: readPositiveNumber(process.env.SESSION_CREATE_RATE_LIMIT, DEFAULT_SESSION_CREATE_LIMIT),
    windowMs: readPositiveNumber(process.env.SESSION_CREATE_RATE_LIMIT_WINDOW_MS, DEFAULT_SESSION_CREATE_WINDOW_MS),
    maxBuckets: readPositiveNumber(
      process.env.SESSION_CREATE_RATE_LIMIT_MAX_BUCKETS,
      DEFAULT_SESSION_CREATE_MAX_BUCKETS,
    ),
  };
}

export function getFinalizeCancelRateLimitConfig(): {
  limit: number;
  windowMs: number;
  maxBuckets: number;
} {
  return {
    limit: readPositiveNumber(process.env.FINALIZE_CANCEL_RATE_LIMIT, DEFAULT_FINALIZE_CANCEL_LIMIT),
    windowMs: readPositiveNumber(process.env.FINALIZE_CANCEL_RATE_LIMIT_WINDOW_MS, DEFAULT_FINALIZE_CANCEL_WINDOW_MS),
    maxBuckets: readPositiveNumber(
      process.env.FINALIZE_CANCEL_RATE_LIMIT_MAX_BUCKETS,
      DEFAULT_FINALIZE_CANCEL_MAX_BUCKETS,
    ),
  };
}

export function resolveRateLimitStore(): RateLimitStoreKind {
  if (process.env.NODE_ENV === 'test' || process.env.USE_MOCK_STORE === 'true') {
    return 'memory';
  }

  const raw = process.env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if (raw === 'dynamo') {
    return 'dynamo';
  }
  return 'memory';
}

export function getRateLimitAttemptMultiplier(): number {
  return DEFAULT_RATE_LIMIT_ATTEMPT_MULTIPLIER;
}

export function getRateLimitTableNames(): { eventsTable?: string; countersTable?: string } {
  const eventsTable = process.env.RATE_LIMIT_EVENTS_TABLE?.trim();
  const countersTable = process.env.RATE_LIMIT_COUNTERS_TABLE?.trim();
  return {
    eventsTable: eventsTable && eventsTable.length > 0 ? eventsTable : undefined,
    countersTable: countersTable && countersTable.length > 0 ? countersTable : undefined,
  };
}

export function requireRateLimitTableNames(): { eventsTable: string; countersTable: string } {
  const { eventsTable, countersTable } = getRateLimitTableNames();
  if (!eventsTable || !countersTable) {
    throw new Error(
      'RATE_LIMIT_EVENTS_TABLE and RATE_LIMIT_COUNTERS_TABLE must be set when using DynamoDB rate limiting.',
    );
  }
  return { eventsTable, countersTable };
}
