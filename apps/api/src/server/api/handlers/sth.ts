import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import type { ApiHandlerArguments, RouteBoundResponse, SessionAdmittedContext } from '../context';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { sessionBulletinSthRoute } from '@stark-ballot/api-contract/routes';
import type { SthResponse } from '@stark-ballot/api-contract/schemas/bulletin';
import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import { respondWithRoute, respondWithRouteError } from '../utils/responseSchema';

export interface SessionSthProjectionInput {
  journal: Pick<ZkVMJournal, 'sthDigest' | 'bulletinRoot' | 'treeSize'>;
  timestamp: number;
  logId: string;
}

export function projectSessionSthData({ journal, timestamp, logId }: SessionSthProjectionInput): SthResponse['data'] {
  return {
    sth: {
      sthDigest: journal.sthDigest,
      bulletinRoot: journal.bulletinRoot,
      treeSize: journal.treeSize,
      timestamp,
      logId,
    },
  };
}

/**
 * Return Signed Tree Head data for a finalized session.
 */
export function getSessionBulletinSthHandler({
  context,
}: ApiHandlerArguments<typeof sessionBulletinSthRoute, SessionAdmittedContext>): RouteBoundResponse<
  typeof sessionBulletinSthRoute
> {
  try {
    const { sessionId, session } = context;

    // Check if session is finalized
    if (session.finalization?.state.status !== 'succeeded' || !session.finalization.finalizationResult) {
      logger.warn('[STH API] Session not finalized yet', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
      // Return 404 to distinguish "not ready" from "tampered" per reviewer feedback
      return respondWithRouteError(sessionBulletinSthRoute, {
        code: ErrorCode.SESSION_NOT_FINALIZED,
        status: 404,
        message: 'Session has not been finalized yet. STH data is not available.',
      });
    }
    const { journal } = session.finalization.finalizationResult;

    // Log warnings if critical fields are missing
    if (!journal.sthDigest) {
      logger.warn('[STH API] sthDigest missing in journal', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
    }
    if (!journal.bulletinRoot) {
      logger.warn('[STH API] bulletinRoot missing in journal', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
    }
    if (typeof journal.treeSize !== 'number') {
      logger.warn('[STH API] treeSize missing in journal', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
    }

    // Keep the STH projection nested under data.sth in the canonical public
    // response envelope.
    return respondWithRoute(sessionBulletinSthRoute, {
      status: 200,
      content: 'json',
      body: {
        data: projectSessionSthData({
          journal,
          timestamp: session.voting.lastActivityMs,
          logId: session.identity.logId,
        }),
      },
    });
  } catch (error) {
    logger.error('[STH API] Unexpected error:', error);
    return respondWithRouteError(sessionBulletinSthRoute, { code: ErrorCode.INTERNAL_ERROR, status: 500 });
  }
}
