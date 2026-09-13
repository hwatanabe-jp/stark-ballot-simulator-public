import {
  createDynamoRateLimitStore,
  DynamoVoteRateLimiter,
} from '@stark-ballot/aws-adapters/rate-limit/dynamoRateLimit';
import { getFinalizeCancelRateLimitConfig } from '@stark-ballot/aws-adapters/rate-limit/rateLimitConfig';
import { VoteRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/voteRateLimit';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

const FINALIZE_CANCEL_SCOPE_PREFIX = 'finalize-cancel';

type FinalizeCancelLimiterInstance = VoteRateLimiter | DynamoVoteRateLimiter;

let finalizeCancelRateLimiter: FinalizeCancelLimiterInstance | null = null;

export function getFinalizeCancelRateLimiter(profile: ResolvedRuntimeProfile): FinalizeCancelLimiterInstance {
  if (!finalizeCancelRateLimiter) {
    const config = getFinalizeCancelRateLimitConfig();
    finalizeCancelRateLimiter =
      profile.rateLimit.store === 'dynamo'
        ? new DynamoVoteRateLimiter(createDynamoRateLimitStore(profile), config, FINALIZE_CANCEL_SCOPE_PREFIX)
        : new VoteRateLimiter(config.limit, config.windowMs, config.maxBuckets);
  }
  return finalizeCancelRateLimiter;
}
