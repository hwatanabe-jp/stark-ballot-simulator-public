import { createDynamoRateLimitStore, DynamoVoteRateLimiter } from '@/lib/rateLimit/dynamoRateLimit';
import { getSessionCreateRateLimitConfig, resolveRateLimitStore } from '@/lib/rateLimit/rateLimitConfig';
import { VoteRateLimiter } from '@/lib/rateLimit/voteRateLimit';

const SESSION_CREATE_SCOPE_PREFIX = 'session-create';

type SessionCreateLimiterInstance = VoteRateLimiter | DynamoVoteRateLimiter;

let sessionCreateRateLimiter: SessionCreateLimiterInstance | null = null;

export function getSessionCreateRateLimiter(): SessionCreateLimiterInstance {
  if (!sessionCreateRateLimiter) {
    const config = getSessionCreateRateLimitConfig();
    sessionCreateRateLimiter =
      resolveRateLimitStore() === 'dynamo'
        ? new DynamoVoteRateLimiter(createDynamoRateLimitStore(), config, SESSION_CREATE_SCOPE_PREFIX)
        : new VoteRateLimiter(config.limit, config.windowMs, config.maxBuckets);
  }
  return sessionCreateRateLimiter;
}

export function resetSessionCreateRateLimiter(): void {
  if (sessionCreateRateLimiter instanceof VoteRateLimiter) {
    sessionCreateRateLimiter.reset();
  }
  sessionCreateRateLimiter = null;
}
