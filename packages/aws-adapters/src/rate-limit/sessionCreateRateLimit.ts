import {
  createDynamoRateLimitStore,
  DynamoVoteRateLimiter,
} from '@stark-ballot/aws-adapters/rate-limit/dynamoRateLimit';
import { getSessionCreateRateLimitConfig } from '@stark-ballot/aws-adapters/rate-limit/rateLimitConfig';
import { VoteRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/voteRateLimit';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

const SESSION_CREATE_SCOPE_PREFIX = 'session-create';

type SessionCreateLimiterInstance = VoteRateLimiter | DynamoVoteRateLimiter;

let sessionCreateRateLimiter: SessionCreateLimiterInstance | null = null;

export function getSessionCreateRateLimiter(profile: ResolvedRuntimeProfile): SessionCreateLimiterInstance {
  if (!sessionCreateRateLimiter) {
    const config = getSessionCreateRateLimitConfig();
    sessionCreateRateLimiter =
      profile.rateLimit.store === 'dynamo'
        ? new DynamoVoteRateLimiter(createDynamoRateLimitStore(profile), config, SESSION_CREATE_SCOPE_PREFIX)
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
