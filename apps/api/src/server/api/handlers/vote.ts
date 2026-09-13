import { completeVoteSubmission } from '@stark-ballot/application/session/complete-vote-submission';
import { prepareUserVoteSubmission } from '@stark-ballot/application/session/submit-vote';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import type {
  ApiHandlerArguments,
  ClientRateLimitedContext,
  RouteBoundResponse,
  SessionAdmittedContext,
} from '../context';
import { consumeVoteRateLimit } from '../middleware/rateLimit';
import { submitVoteRoute } from '@stark-ballot/api-contract/routes';
import { admitRouteErrorResponse, respondWithRoute } from '../utils/responseSchema';
import { respondWithApplicationError } from '../utils/applicationErrorResponse';

type SubmitVoteContext = SessionAdmittedContext & ClientRateLimitedContext;

export async function submitVoteHandler({
  input,
  context,
}: ApiHandlerArguments<typeof submitVoteRoute, SubmitVoteContext>): Promise<
  RouteBoundResponse<typeof submitVoteRoute>
> {
  const { session, sessionId, store, rateLimitClientIp, runtimeProfile } = context;
  const { commitment, vote, rand } = input.body;

  // Generate unique vote ID and timestamp
  const voteId = generateVoteId();
  const timestamp = Date.now();

  const prepared = prepareUserVoteSubmission(session, { voteId, timestamp, vote, rand, commitment });
  if (!prepared.ok) {
    return respondWithApplicationError(submitVoteRoute, prepared.error);
  }

  const consumeResult = await consumeVoteRateLimit(runtimeProfile, rateLimitClientIp);
  if (consumeResult instanceof Response) {
    return admitRouteErrorResponse(submitVoteRoute, consumeResult);
  }

  const result = await completeVoteSubmission(store, sessionId, prepared.value);
  if (!result.ok) return respondWithApplicationError(submitVoteRoute, result.error);
  const receipt = result.value;

  return respondWithRoute(submitVoteRoute, {
    status: 200,
    content: 'json',
    body: {
      data: {
        voteId: receipt.voteId,
        commitment: receipt.commitment,
        bulletinIndex: receipt.bulletinIndex,
        bulletinRootAtCast: receipt.bulletinRootAtCast,
        castAtMs: receipt.timestamp,
      },
    },
  });
}
