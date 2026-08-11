import type { ApiHandlerArguments, SessionIdentityContext } from '../context';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import { progressRoute } from '@stark-ballot/api-contract/routes';
import { respondWithRoute } from '../utils/responseSchema';
import { deriveBotCountFromVotes } from '@stark-ballot/domain/bulletin/ctSessionState';

interface ProgressSnapshot {
  botCount: number;
  userVoted: boolean;
  finalized: boolean;
}

const normalizeBotCount = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
};

async function resolveProgressSnapshot(
  store: VoteStore & FinalizationLifecycleStore,
  sessionId: string,
): Promise<ProgressSnapshot | null> {
  const [voting, finalization] = await Promise.all([
    store.getVotingRecord(sessionId),
    store.getCurrentFinalizationRecord(sessionId),
  ]);
  if (!voting) {
    return null;
  }
  const userVoteIndex = voting.userParticipation.status === 'cast' ? voting.userParticipation.voteIndex : undefined;
  const derivedBotCount = deriveBotCountFromVotes(voting.votes, userVoteIndex);
  if (derivedBotCount !== voting.botCount) {
    return null;
  }

  return {
    botCount: voting.botCount,
    userVoted: voting.userParticipation.status === 'cast',
    finalized: finalization?.state.status === 'succeeded',
  };
}

/**
 * Return bot voting progress for the current session.
 */
export async function getProgressHandler({
  context,
}: ApiHandlerArguments<typeof progressRoute, SessionIdentityContext>): Promise<Response> {
  const session = await resolveProgressSnapshot(context.store, context.sessionId);
  if (!session) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }

  const count = normalizeBotCount(session.botCount);

  return respondWithRoute(progressRoute, {
    status: 200,
    content: 'json',
    body: {
      data: {
        count,
        total: BOT_COUNT,
        completed: count >= BOT_COUNT,
        userVoted: session.userVoted,
        finalized: session.finalized,
      },
    },
  });
}
