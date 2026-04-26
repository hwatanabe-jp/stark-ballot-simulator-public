import type { ApiContext } from '@/server/api/context';
import { ErrorCode } from '@/lib/errors/apiErrors';
import {
  isSupportedCurrentArtifactState,
  isUnsupportedLiveSessionContract,
  resolveSessionFinalizationArtifactState,
} from '@/lib/contract';
import { errorResponse } from '@/server/http/response';
import { requireSessionId, validateSessionCapabilityForSession } from '@/server/api/middleware/session';
import type { SessionSummary, VoteStore } from '@/types/voteStore';
import { BOT_COUNT } from '@/shared/constants';
import { ProgressResponseSchema } from '@/lib/validation/apiSchemas';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import { deriveBotCountFromVotes, resolveCanonicalUserVoteIndex } from '@/lib/store/ctSessionState';

type ProgressSnapshot = Pick<SessionSummary, 'botCount' | 'contractGeneration' | 'userVoteIndex' | 'finalized'>;

const normalizeBotCount = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
};

function shouldRejectProgressSnapshot(snapshot: {
  finalized: boolean;
  contractGeneration?: string;
  finalizationArtifactState?: SessionSummary['finalizationArtifactState'] | null;
}): boolean {
  if (
    isUnsupportedLiveSessionContract({
      finalized: snapshot.finalized,
      contractGeneration: snapshot.contractGeneration,
    })
  ) {
    return true;
  }

  return Boolean(
    snapshot.finalizationArtifactState && !isSupportedCurrentArtifactState(snapshot.finalizationArtifactState),
  );
}

async function resolveProgressSnapshot(store: VoteStore, sessionId: string): Promise<ProgressSnapshot | null> {
  if (store.getSessionSummary) {
    const summary = await store.getSessionSummary(sessionId);
    if (!summary) {
      return null;
    }

    if (shouldRejectProgressSnapshot(summary)) {
      return null;
    }

    return {
      botCount: summary.botCount,
      contractGeneration: summary.contractGeneration,
      userVoteIndex: summary.userVoteIndex,
      finalized: summary.finalized,
    };
  }

  const session = await store.getSession(sessionId);
  if (!session) {
    return null;
  }
  if (
    shouldRejectProgressSnapshot({
      finalized: session.finalized,
      contractGeneration: session.contractGeneration,
      finalizationArtifactState: resolveSessionFinalizationArtifactState(session),
    })
  ) {
    return null;
  }

  return {
    botCount: deriveBotCountFromVotes(session.votes, session.userVoteIndex),
    contractGeneration: session.contractGeneration,
    userVoteIndex: resolveCanonicalUserVoteIndex(session.votes, session.userVoteIndex),
    finalized: session.finalized,
  };
}

/**
 * Return bot voting progress for the current session.
 */
export async function getProgressHandler({ request, store }: ApiContext): Promise<Response> {
  const sessionIdResult = requireSessionId(request.headers);
  if (sessionIdResult instanceof Response) {
    return sessionIdResult;
  }
  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionIdResult);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const session = await resolveProgressSnapshot(store, sessionIdResult);
  if (!session) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }

  const count = normalizeBotCount(session.botCount);

  return respondWithSchema(ProgressResponseSchema, {
    data: {
      count,
      total: BOT_COUNT,
      completed: count >= BOT_COUNT,
      userVoted: session.userVoteIndex !== undefined,
      finalized: session.finalized,
    },
  });
}
