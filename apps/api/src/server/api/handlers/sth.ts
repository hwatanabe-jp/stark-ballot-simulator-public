import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import type { ApiResponse } from '@stark-ballot/api-contract';
import type { ApiContext } from '../context';
import { errorResponse, jsonResponse } from '../../http/response';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { validateSessionWithCapability } from '../middleware/session';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '../utils/currentArtifactAdmission';
import { SthResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { respondWithSchema } from '../utils/responseSchema';

function requireSameOriginRequest(request: Request): Response | null {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin')?.trim();
  if (origin) {
    try {
      if (new URL(origin).origin !== requestOrigin) {
        return errorResponse(ErrorCode.SAME_ORIGIN_REQUIRED);
      }
    } catch {
      return errorResponse(ErrorCode.SAME_ORIGIN_REQUIRED);
    }
  }

  const secFetchSite = request.headers.get('Sec-Fetch-Site')?.trim().toLowerCase();
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return errorResponse(ErrorCode.SAME_ORIGIN_REQUIRED);
  }

  return null;
}

/**
 * Mock STH (Signed Tree Head) API endpoint for E2E testing
 *
 * Returns session's STH data in the format expected by parseSthResponse()
 * from packages/verification/src/verification/sth-verifier.ts
 *
 * This endpoint is designed for test environments where external STH sources
 * are not available. It retrieves STH data from the session's finalization result.
 */
/**
 * Return Signed Tree Head data for a finalized session.
 */
export async function getSthHandler({ request, store }: ApiContext): Promise<Response> {
  try {
    const sameOriginResult = requireSameOriginRequest(request);
    if (sameOriginResult) {
      return sameOriginResult;
    }

    const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
    if (sessionResult instanceof Response) {
      return sessionResult;
    }
    const { sessionId, session } = sessionResult;

    // Check if session is finalized
    if (!session.finalized) {
      logger.warn('[STH API] Session not finalized yet', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
      // Return 404 to distinguish "not ready" from "tampered" per reviewer feedback
      return jsonResponse<ApiResponse>(
        {
          error: ErrorCode.SESSION_NOT_FINALIZED,
          message: 'Session has not been finalized yet. STH data is not available.',
        },
        { status: 404 },
      );
    }
    const finalizedRead = resolveSupportedFinalizedRead(session);
    if (finalizedRead.artifactState) {
      return buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState);
    }
    if (!finalizedRead.finalizationResult) {
      logger.warn('[STH API] Finalization result missing for finalized session', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
      return jsonResponse<ApiResponse>(
        {
          error: ErrorCode.SESSION_NOT_FINALIZED,
          message: 'Session has not been finalized yet. STH data is not available.',
        },
        { status: 404 },
      );
    }

    const { journal } = finalizedRead.finalizationResult;

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

    // Return STH data in the format expected by parseSthResponse()
    // parseSthResponse extracts: record = data.sth ?? data (packages/verification/src/verification/sth-verifier.ts:79)
    // So we return { sth: { ... } } directly (not wrapped in ApiResponse)
    return respondWithSchema(SthResponseSchema, {
      sth: {
        sthDigest: journal.sthDigest,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        timestamp: session.lastActivity,
        logId: session.logId ?? '',
      },
    });
  } catch (error) {
    logger.error('[STH API] Unexpected error:', error);
    return errorResponse(ErrorCode.INTERNAL_ERROR);
  }
}
