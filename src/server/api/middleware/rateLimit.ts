import { getVoteAttemptLimiter, getVoteRateLimiter } from '@/lib/rateLimit/voteRateLimit';
import { createDynamoServerAttemptLimiter, createDynamoServerRateLimiter } from '@/lib/rateLimit/dynamoRateLimit';
import {
  getRateLimitAttemptMultiplier,
  getZkVmRateLimitConfig,
  resolveRateLimitStore,
} from '@/lib/rateLimit/rateLimitConfig';
import { ServerRateLimiter } from '@/lib/rateLimit/serverRateLimit';
import { getSessionCreateRateLimiter } from '@/lib/rateLimit/sessionCreateRateLimit';
import { getFinalizeCancelRateLimiter } from '@/lib/rateLimit/finalizeCancelRateLimit';
import { RateLimitStoreError } from '@/lib/rateLimit/dynamoRateLimitStore';
import type { GlobalLimitResult, RateLimitResult } from '@/lib/rateLimit/serverRateLimit';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { errorResponse } from '@/server/http/response';
import { logger } from '@/lib/utils/logger';
import { hashIpForLogging } from '@/lib/utils/logging';

type MaybePromise<T> = T | Promise<T>;
type VoteLimiter = {
  check: (ipAddress: string) => MaybePromise<{ allowed: boolean; remaining: number; retryAfter?: number }>;
  record: (ipAddress: string) => MaybePromise<void>;
  consume?: (ipAddress: string) => MaybePromise<{ allowed: boolean; remaining: number; retryAfter?: number }>;
};
type VoteAttemptLimiter = {
  consume: (ipAddress: string) => MaybePromise<{ allowed: boolean; remaining: number; retryAfter?: number }>;
};
type SessionCreateLimiter = {
  consume: (ipAddress: string) => MaybePromise<{ allowed: boolean; remaining: number; retryAfter?: number }>;
};
type FinalizeLimiter = Pick<
  ServerRateLimiter,
  'checkZkVmRateLimit' | 'checkGlobalLimit' | 'recordZkVmExecution' | 'incrementGlobalCount'
>;
type FinalizeAttemptLimiter = Pick<ServerRateLimiter, 'consumeZkVmExecution'>;
type FinalizeRecorder = Pick<ServerRateLimiter, 'recordZkVmExecution' | 'incrementGlobalCount'>;

/**
 * Vote rate limit result data.
 */
export interface VoteRateLimitContext {
  clientIp: string;
}

/**
 * Session-create rate limit result data.
 */
export interface SessionCreateRateLimitContext {
  clientIp: string;
}

/**
 * Finalize-cancel rate limit result data.
 */
export interface FinalizeCancelRateLimitContext {
  clientIp: string;
}

/**
 * Finalize rate limit result data.
 */
export interface FinalizeRateLimitContext {
  clientIp: string;
  rateLimiter: FinalizeLimiter;
  shouldRecord: boolean;
}

let finalizeRateLimiterInstance: FinalizeLimiter | null = null;
let finalizeAttemptLimiterInstance: FinalizeAttemptLimiter | null = null;

function shouldAllowUnknownClientIp(): boolean {
  const raw = process.env.ALLOW_UNKNOWN_CLIENT_IP;
  if (raw && raw.trim().length > 0) {
    switch (raw.trim().toLowerCase()) {
      case '1':
      case 'true':
      case 'yes':
      case 'on':
        return true;
      default:
        return false;
    }
  }
  if (process.env.USE_MOCK_STORE === 'true') {
    return true;
  }
  return process.env.NODE_ENV !== 'production';
}

function resolveClientIp(clientIp?: string | null): string | null {
  if (clientIp && clientIp.trim().length > 0) {
    return clientIp.trim();
  }
  return shouldAllowUnknownClientIp() ? '0.0.0.0' : null;
}

function getFinalizeRateLimiter(): FinalizeLimiter {
  if (!finalizeRateLimiterInstance) {
    finalizeRateLimiterInstance =
      resolveRateLimitStore() === 'dynamo' ? createDynamoServerRateLimiter() : new ServerRateLimiter();
  }
  return finalizeRateLimiterInstance;
}

function getFinalizeAttemptLimiter(): FinalizeAttemptLimiter {
  if (!finalizeAttemptLimiterInstance) {
    if (resolveRateLimitStore() === 'dynamo') {
      finalizeAttemptLimiterInstance = createDynamoServerAttemptLimiter();
    } else {
      const config = getZkVmRateLimitConfig();
      const multiplier = getRateLimitAttemptMultiplier();
      finalizeAttemptLimiterInstance = new ServerRateLimiter({
        ...config,
        maxExecutions: config.maxExecutions * multiplier,
      });
    }
  }
  return finalizeAttemptLimiterInstance;
}

function handleRateLimitError(error: unknown): Response {
  let errorPayload: Record<string, unknown>;
  if (error instanceof RateLimitStoreError) {
    const cause = error.cause;
    const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined;
    errorPayload = {
      operation: error.operation,
      ...(causeMessage ? { cause: causeMessage } : {}),
    };
  } else {
    errorPayload = {
      message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown_error',
    };
  }
  logger.error('rate limit storage error', {
    event: 'rate_limit_error',
    rate_limit: { hit: false, reason: 'storage_error' },
    error: errorPayload,
  });
  return errorResponse(ErrorCode.GLOBAL_LIMIT_EXCEEDED, { reason: 'rate_limit_unavailable' });
}

/**
 * Enforce vote submission rate limits.
 */
export async function enforceVoteRateLimit(
  clientIp?: string | null,
  limiter: VoteAttemptLimiter = getVoteAttemptLimiter(),
): Promise<VoteRateLimitContext | Response> {
  const resolvedClientIp = resolveClientIp(clientIp);
  if (!resolvedClientIp) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { reason: 'client_ip_missing' });
  }
  try {
    const rateResult = await limiter.consume(resolvedClientIp);
    if (!rateResult.allowed) {
      logger.warn('rate limit exceeded', {
        event: 'rate_limit_hit',
        rate_limit: {
          hit: true,
          reason: 'vote_attempt',
          ip_hash: hashIpForLogging(resolvedClientIp),
        },
      });
      return errorResponse(ErrorCode.GLOBAL_LIMIT_EXCEEDED, { retryAfter: rateResult.retryAfter });
    }
    return { clientIp: resolvedClientIp };
  } catch (error) {
    return handleRateLimitError(error);
  }
}

/**
 * Enforce session creation rate limits.
 */
export async function enforceSessionCreateRateLimit(
  clientIp?: string | null,
  limiter: SessionCreateLimiter = getSessionCreateRateLimiter(),
): Promise<SessionCreateRateLimitContext | Response> {
  const resolvedClientIp = resolveClientIp(clientIp);
  if (!resolvedClientIp) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { reason: 'client_ip_missing' });
  }
  try {
    const rateResult = await limiter.consume(resolvedClientIp);
    if (!rateResult.allowed) {
      logger.warn('rate limit exceeded', {
        event: 'rate_limit_hit',
        rate_limit: {
          hit: true,
          reason: 'session_create',
          ip_hash: hashIpForLogging(resolvedClientIp),
        },
      });
      return errorResponse(ErrorCode.GLOBAL_LIMIT_EXCEEDED, { retryAfter: rateResult.retryAfter });
    }

    return { clientIp: resolvedClientIp };
  } catch (error) {
    return handleRateLimitError(error);
  }
}

/**
 * Enforce finalize-cancel rate limits.
 */
export async function enforceFinalizeCancelRateLimit(
  clientIp?: string | null,
  limiter: VoteAttemptLimiter = getFinalizeCancelRateLimiter(),
): Promise<FinalizeCancelRateLimitContext | Response> {
  const resolvedClientIp = resolveClientIp(clientIp);
  if (!resolvedClientIp) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { reason: 'client_ip_missing' });
  }
  try {
    const rateResult = await limiter.consume(resolvedClientIp);
    if (!rateResult.allowed) {
      logger.warn('rate limit exceeded', {
        event: 'rate_limit_hit',
        rate_limit: {
          hit: true,
          reason: 'finalize_cancel',
          ip_hash: hashIpForLogging(resolvedClientIp),
        },
      });
      return errorResponse(ErrorCode.GLOBAL_LIMIT_EXCEEDED, { retryAfter: rateResult.retryAfter });
    }

    return { clientIp: resolvedClientIp };
  } catch (error) {
    return handleRateLimitError(error);
  }
}

/**
 * Consume vote rate limits after validation succeeds.
 */
export async function consumeVoteRateLimit(
  clientIp: string,
  limiter: VoteLimiter = getVoteRateLimiter(),
): Promise<Response | null> {
  try {
    const rateResult =
      typeof limiter.consume === 'function' ? await limiter.consume(clientIp) : await limiter.check(clientIp);
    if (!rateResult.allowed) {
      logger.warn('rate limit exceeded', {
        event: 'rate_limit_hit',
        rate_limit: {
          hit: true,
          reason: 'vote_consume',
          ip_hash: hashIpForLogging(clientIp),
        },
      });
      return errorResponse(ErrorCode.GLOBAL_LIMIT_EXCEEDED, { retryAfter: rateResult.retryAfter });
    }
    if (typeof limiter.consume !== 'function') {
      await limiter.record(clientIp);
    }
    return null;
  } catch (error) {
    return handleRateLimitError(error);
  }
}

function ensureRateLimitNextAvailableAt(result: RateLimitResult): string {
  if (!result.nextAvailableAt) {
    throw new Error('Rate limiter missing nextAvailableAt for blocked IP');
  }
  return result.nextAvailableAt;
}

function ensureGlobalLimitRetryAfter(result: GlobalLimitResult): number {
  if (result.retryAfter === undefined) {
    throw new Error('Rate limiter missing retryAfter for global limit');
  }
  return result.retryAfter;
}

/**
 * Enforce finalize rate limits (zkVM execution + global limits).
 */
export async function enforceFinalizeRateLimit(
  clientIp?: string | null,
  options: { rateLimiter?: FinalizeLimiter; attemptLimiter?: FinalizeAttemptLimiter } = {},
): Promise<FinalizeRateLimitContext | Response> {
  const resolvedClientIp = resolveClientIp(clientIp);
  if (!resolvedClientIp) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { reason: 'client_ip_missing' });
  }
  const rateLimiter = options.rateLimiter ?? getFinalizeRateLimiter();
  const attemptLimiter = options.attemptLimiter ?? getFinalizeAttemptLimiter();

  if (process.env.USE_MOCK_STORE === 'true') {
    return { clientIp: resolvedClientIp, rateLimiter, shouldRecord: false };
  }

  try {
    const attemptRateLimit = await attemptLimiter.consumeZkVmExecution(resolvedClientIp);
    if (!attemptRateLimit.allowed) {
      logger.warn('rate limit exceeded', {
        event: 'rate_limit_hit',
        rate_limit: {
          hit: true,
          reason: 'zkvm_attempt',
          ip_hash: hashIpForLogging(resolvedClientIp),
        },
      });
      return errorResponse(ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED, {
        nextAvailableAt: ensureRateLimitNextAvailableAt(attemptRateLimit),
        remainingExecutions: attemptRateLimit.remainingExecutions,
      });
    }

    const ipRateLimit = await rateLimiter.checkZkVmRateLimit(resolvedClientIp);
    if (!ipRateLimit.allowed) {
      logger.warn('rate limit exceeded', {
        event: 'rate_limit_hit',
        rate_limit: {
          hit: true,
          reason: 'zkvm_ip',
          ip_hash: hashIpForLogging(resolvedClientIp),
        },
      });
      return errorResponse(ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED, {
        nextAvailableAt: ensureRateLimitNextAvailableAt(ipRateLimit),
        remainingExecutions: ipRateLimit.remainingExecutions,
      });
    }

    const dailyLimit = await rateLimiter.checkGlobalLimit('daily');
    if (!dailyLimit.allowed) {
      logger.warn('rate limit exceeded', {
        event: 'rate_limit_hit',
        rate_limit: {
          hit: true,
          reason: 'global_daily',
          ip_hash: hashIpForLogging(resolvedClientIp),
        },
      });
      return errorResponse(ErrorCode.GLOBAL_LIMIT_EXCEEDED, {
        retryAfter: ensureGlobalLimitRetryAfter(dailyLimit),
      });
    }

    const hourlyLimit = await rateLimiter.checkGlobalLimit('hourly');
    if (!hourlyLimit.allowed) {
      logger.warn('rate limit exceeded', {
        event: 'rate_limit_hit',
        rate_limit: {
          hit: true,
          reason: 'global_hourly',
          ip_hash: hashIpForLogging(resolvedClientIp),
        },
      });
      return errorResponse(ErrorCode.GLOBAL_LIMIT_EXCEEDED, {
        retryAfter: ensureGlobalLimitRetryAfter(hourlyLimit),
      });
    }

    return { clientIp: resolvedClientIp, rateLimiter, shouldRecord: true };
  } catch (error) {
    return handleRateLimitError(error);
  }
}

/**
 * Record finalize rate limit usage after successful processing.
 */
export async function recordFinalizeRateLimit(
  rateLimiter: FinalizeRecorder,
  clientIp: string,
  shouldRecord: boolean,
): Promise<void> {
  if (!shouldRecord) {
    return;
  }

  await rateLimiter.recordZkVmExecution(clientIp);
  await rateLimiter.incrementGlobalCount('daily');
  await rateLimiter.incrementGlobalCount('hourly');
}
