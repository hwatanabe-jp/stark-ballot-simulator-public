import { getVoteAttemptLimiter, getVoteRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/voteRateLimit';
import {
  createDynamoServerAttemptLimiter,
  createDynamoServerRateLimiter,
} from '@stark-ballot/aws-adapters/rate-limit/dynamoRateLimit';
import {
  getRateLimitAttemptMultiplier,
  getZkVmRateLimitConfig,
} from '@stark-ballot/aws-adapters/rate-limit/rateLimitConfig';
import { ServerRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/serverRateLimit';
import { getSessionCreateRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/sessionCreateRateLimit';
import { getFinalizeCancelRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/finalizeCancelRateLimit';
import { RateLimitStoreError } from '@stark-ballot/aws-adapters/rate-limit/dynamoRateLimitStore';
import type { GlobalLimitResult, RateLimitResult } from '@stark-ballot/aws-adapters/rate-limit/serverRateLimit';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashIpForLogging } from '@stark-ballot/diagnostics/logging';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

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

function shouldAllowUnknownClientIp(profile: ResolvedRuntimeProfile): boolean {
  return profile.rateLimit.allowUnknownClientIp;
}

function resolveClientIp(profile: ResolvedRuntimeProfile, clientIp?: string | null): string | null {
  if (clientIp && clientIp.trim().length > 0) {
    return clientIp.trim();
  }
  return shouldAllowUnknownClientIp(profile) ? '0.0.0.0' : null;
}

function getFinalizeRateLimiter(profile: ResolvedRuntimeProfile): FinalizeLimiter {
  if (!finalizeRateLimiterInstance) {
    finalizeRateLimiterInstance =
      profile.rateLimit.store === 'dynamo' ? createDynamoServerRateLimiter(profile) : new ServerRateLimiter();
  }
  return finalizeRateLimiterInstance;
}

function getFinalizeAttemptLimiter(profile: ResolvedRuntimeProfile): FinalizeAttemptLimiter {
  if (!finalizeAttemptLimiterInstance) {
    if (profile.rateLimit.store === 'dynamo') {
      finalizeAttemptLimiterInstance = createDynamoServerAttemptLimiter(profile);
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
  profile: ResolvedRuntimeProfile,
  clientIp?: string | null,
  limiter: VoteAttemptLimiter = getVoteAttemptLimiter(profile),
): Promise<VoteRateLimitContext | Response> {
  const resolvedClientIp = resolveClientIp(profile, clientIp);
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
      return errorResponse(
        ErrorCode.GLOBAL_LIMIT_EXCEEDED,
        omitUndefinedProperties({ retryAfter: rateResult.retryAfter }),
      );
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
  profile: ResolvedRuntimeProfile,
  clientIp?: string | null,
  limiter: SessionCreateLimiter = getSessionCreateRateLimiter(profile),
): Promise<SessionCreateRateLimitContext | Response> {
  const resolvedClientIp = resolveClientIp(profile, clientIp);
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
      return errorResponse(
        ErrorCode.GLOBAL_LIMIT_EXCEEDED,
        omitUndefinedProperties({ retryAfter: rateResult.retryAfter }),
      );
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
  profile: ResolvedRuntimeProfile,
  clientIp?: string | null,
  limiter: VoteAttemptLimiter = getFinalizeCancelRateLimiter(profile),
): Promise<FinalizeCancelRateLimitContext | Response> {
  const resolvedClientIp = resolveClientIp(profile, clientIp);
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
      return errorResponse(
        ErrorCode.GLOBAL_LIMIT_EXCEEDED,
        omitUndefinedProperties({ retryAfter: rateResult.retryAfter }),
      );
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
  profile: ResolvedRuntimeProfile,
  clientIp: string,
  limiter: VoteLimiter = getVoteRateLimiter(profile),
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
      return errorResponse(
        ErrorCode.GLOBAL_LIMIT_EXCEEDED,
        omitUndefinedProperties({ retryAfter: rateResult.retryAfter }),
      );
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
  profile: ResolvedRuntimeProfile,
  clientIp?: string | null,
  options: { rateLimiter?: FinalizeLimiter; attemptLimiter?: FinalizeAttemptLimiter } = {},
): Promise<FinalizeRateLimitContext | Response> {
  const resolvedClientIp = resolveClientIp(profile, clientIp);
  if (!resolvedClientIp) {
    return errorResponse(ErrorCode.INVALID_REQUEST, { reason: 'client_ip_missing' });
  }
  const rateLimiter = options.rateLimiter ?? getFinalizeRateLimiter(profile);
  const attemptLimiter = options.attemptLimiter ?? getFinalizeAttemptLimiter(profile);

  if (profile.rateLimit.store === 'memory') {
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
        ...omitUndefinedProperties({ retryAfter: ensureGlobalLimitRetryAfter(dailyLimit) }),
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
        ...omitUndefinedProperties({ retryAfter: ensureGlobalLimitRetryAfter(hourlyLimit) }),
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
