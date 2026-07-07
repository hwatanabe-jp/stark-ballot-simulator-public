import {
  createDynamoRateLimitStore,
  DynamoVoteRateLimiter,
} from '@stark-ballot/aws-adapters/rate-limit/dynamoRateLimit';
import {
  getFinalizeCancelRateLimitConfig,
  resolveRateLimitStore,
} from '@stark-ballot/aws-adapters/rate-limit/rateLimitConfig';
import { VoteRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/voteRateLimit';

const FINALIZE_CANCEL_SCOPE_PREFIX = 'finalize-cancel';

type FinalizeCancelLimiterInstance = VoteRateLimiter | DynamoVoteRateLimiter;

let finalizeCancelRateLimiter: FinalizeCancelLimiterInstance | null = null;

export function getFinalizeCancelRateLimiter(): FinalizeCancelLimiterInstance {
  if (!finalizeCancelRateLimiter) {
    const config = getFinalizeCancelRateLimitConfig();
    finalizeCancelRateLimiter =
      resolveRateLimitStore() === 'dynamo'
        ? new DynamoVoteRateLimiter(createDynamoRateLimitStore(), config, FINALIZE_CANCEL_SCOPE_PREFIX)
        : new VoteRateLimiter(config.limit, config.windowMs, config.maxBuckets);
  }
  return finalizeCancelRateLimiter;
}

export function resetFinalizeCancelRateLimiter(): void {
  if (finalizeCancelRateLimiter instanceof VoteRateLimiter) {
    finalizeCancelRateLimiter.reset();
  }
  finalizeCancelRateLimiter = null;
}
