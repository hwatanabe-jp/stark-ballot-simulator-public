/**
 * /api/zkvm-input-hash endpoint
 * Calculates and returns the hash of zkVM input data.
 */

import { computeInputCommitment } from '@/lib/zkvm/types';
import { CtProofUnavailableError } from '@/lib/zkvm/input-builder';
import {
  buildCanonicalZkVMInputFromSession,
  CanonicalZkVMInputValidationError,
} from '@/lib/zkvm/private-input-contract';
import type { ZkVMInputHashResponse, ZkVMInputHashError } from '@/lib/types/api/zkvm-input-hash';
import type { ApiContext } from '@/server/api/context';
import { jsonResponse } from '@/server/http/response';
import { logger } from '@/lib/utils/logger';
import { validateSessionCapabilityForSession } from '@/server/api/middleware/session';
import { resolveDebugLogPayloadFromRequest } from '@/server/http/debugLog';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

/**
 * Parse boolean query parameter
 */
function parseBooleanParam(value: string | null): boolean {
  if (!value) return false;
  const lowered = value.toLowerCase();
  return lowered === 'true' || lowered === '1' || lowered === 'yes';
}

function canReadSensitiveInputData(request: Request): boolean {
  const debugPayload = resolveDebugLogPayloadFromRequest(request);
  return debugPayload?.level === 'debug';
}

/**
 * GET /api/zkvm-input-hash
 * Returns the hash of zkVM input data for a given session
 */
/**
 * Return the hash of zkVM input data for a session.
 */
export async function getZkvmInputHashHandler({ request, store }: ApiContext): Promise<Response> {
  try {
    // Parse query parameters
    const searchParams = new URL(request.url).searchParams;
    const sessionId = searchParams.get('sessionId');
    const includeData = parseBooleanParam(searchParams.get('includeData'));

    // Validate request
    if (!sessionId) {
      const error: ZkVMInputHashError = {
        error: 'Session ID is required',
        code: 'INVALID_REQUEST',
        details: 'Please provide a sessionId query parameter',
      };
      return jsonResponse(error, { status: 400 });
    }

    const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionId);
    if (capabilityResult instanceof Response) {
      return capabilityResult;
    }

    if (includeData && !canReadSensitiveInputData(request)) {
      const error: ZkVMInputHashError = {
        error: 'Sensitive zkVM input data requires debug authorization',
        code: 'INCLUDE_DATA_FORBIDDEN',
        details: 'Enable signed debug access and retry includeData=true',
      };
      return jsonResponse(error, { status: 403 });
    }

    // Get session from store
    const session = await store.getSession(sessionId);
    if (!session) {
      const error: ZkVMInputHashError = {
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND',
        details: `No session found with ID: ${sessionId}`,
      };
      return jsonResponse(error, { status: 404 });
    }

    // Check if session is finalized
    if (!session.finalized) {
      const error: ZkVMInputHashError = {
        error: 'Session is not finalized',
        code: 'SESSION_NOT_FINALIZED',
        details: 'The session must be finalized before calculating input hash',
      };
      return jsonResponse(error, { status: 400 });
    }
    const finalizedRead = resolveSupportedFinalizedRead(session);
    if (finalizedRead.artifactState) {
      return buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState);
    }

    // Build zkVM input from session
    let zkVMInput;
    try {
      zkVMInput = buildCanonicalZkVMInputFromSession(session);
    } catch (error) {
      if (error instanceof CtProofUnavailableError) {
        const response: ZkVMInputHashError = {
          error: 'CT proof unavailable',
          code: 'CT_PROOF_UNAVAILABLE',
          details: error.message,
        };
        return jsonResponse(response, { status: 400 });
      }
      if (error instanceof CanonicalZkVMInputValidationError) {
        logger.error('[API] Invalid zkVM input:', error.errors);
        const response: ZkVMInputHashError = {
          error: 'Invalid zkVM input structure',
          code: 'INTERNAL_ERROR',
          details: error.errors.join('; '),
        };
        return jsonResponse(response, { status: 500 });
      }
      throw error;
    }

    // Calculate input commitment
    const inputCommitment = computeInputCommitment(zkVMInput);

    // Build response
    const response: ZkVMInputHashResponse = {
      inputCommitment,
    };

    // Include data if requested
    if (includeData) {
      response.data = {
        zkVMInput,
        votesCount: zkVMInput.votes.length,
        treeSize: zkVMInput.treeSize,
        bulletinRoot: zkVMInput.bulletinRoot,
        electionId: zkVMInput.electionId,
        timestamp: zkVMInput.timestamp,
      };
    }

    // Log the request
    logger.info(`[API] zkvm-input-hash requested for session ${sessionId}, includeData=${includeData}`);

    return jsonResponse(response, { status: 200 });
  } catch (error) {
    logger.error('[API] Error in zkvm-input-hash:', error);

    const errorResponse: ZkVMInputHashError = {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };

    return jsonResponse(errorResponse, { status: 500 });
  }
}
