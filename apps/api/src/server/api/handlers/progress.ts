import type { ApiContext } from '../context';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import {
  isSupportedCurrentArtifactState,
  isUnsupportedLiveSessionContract,
  resolveSessionFinalizationArtifactState,
} from '@stark-ballot/domain/contract';
import { errorResponse } from '../../http/response';
import { requireSessionId, validateSessionCapabilityForSession } from '../middleware/session';
import type { SessionSummary, VoteStore } from '@stark-ballot/domain/types/voteStore';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import { ProgressResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { respondWithSchema } from '../utils/responseSchema';
import { deriveBotCountFromVotes, resolveCanonicalUserVoteIndex } from '@stark-ballot/domain/bulletin/ctSessionState';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

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
      ...omitUndefinedProperties({ contractGeneration: snapshot.contractGeneration }),
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
      ...omitUndefinedProperties({ contractGeneration: summary.contractGeneration }),
      ...omitUndefinedProperties({ userVoteIndex: summary.userVoteIndex }),
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
      ...omitUndefinedProperties({ contractGeneration: session.contractGeneration }),
      finalizationArtifactState: resolveSessionFinalizationArtifactState(session),
    })
  ) {
    return null;
  }

  return {
    botCount: deriveBotCountFromVotes(session.votes, session.userVoteIndex),
    ...omitUndefinedProperties({ contractGeneration: session.contractGeneration }),
    ...omitUndefinedProperties({ userVoteIndex: resolveCanonicalUserVoteIndex(session.votes, session.userVoteIndex) }),
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
