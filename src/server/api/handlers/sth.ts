import { ErrorCode } from '@/lib/errors/apiErrors';
import type { ApiResponse } from '@/types';
import type { ApiContext } from '@/server/api/context';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { logger } from '@/lib/utils/logger';
import { validateSessionWithCapability } from '@/server/api/middleware/session';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

/**
 * Mock STH (Signed Tree Head) API endpoint for E2E testing
 *
 * Returns session's STH data in the format expected by parseSthResponse()
 * from src/lib/verification/sth-verifier.ts
 *
 * This endpoint is designed for test environments where external STH sources
 * are not available. It retrieves STH data from the session's finalization result.
 */
/**
 * Return Signed Tree Head data for a finalized session.
 */
export async function getSthHandler({ request, store }: ApiContext): Promise<Response> {
  try {
    const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
    if (sessionResult instanceof Response) {
      return sessionResult;
    }
    const { sessionId, session } = sessionResult;

    // Check if session is finalized
    if (!session.finalized) {
      logger.warn('[STH API] Session not finalized yet:', sessionId);
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
      logger.warn('[STH API] Finalization result missing for finalized session:', sessionId);
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
      logger.warn('[STH API] sthDigest missing in journal:', sessionId);
    }
    if (!journal.bulletinRoot) {
      logger.warn('[STH API] bulletinRoot missing in journal:', sessionId);
    }
    if (typeof journal.treeSize !== 'number') {
      logger.warn('[STH API] treeSize missing in journal:', sessionId);
    }

    // Return STH data in the format expected by parseSthResponse()
    // parseSthResponse extracts: record = data.sth ?? data (src/lib/verification/sth-verifier.ts:79)
    // So we return { sth: { ... } } directly (not wrapped in ApiResponse)
    return jsonResponse({
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
