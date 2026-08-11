/** Return the canonical private-input commitment without exposing private input. */

import { computeInputCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { CtProofUnavailableError } from '@stark-ballot/application/zkvm-input/input-builder';
import {
  buildCanonicalZkVMInputFromSession,
  CanonicalZkVMInputValidationError,
} from '@stark-ballot/application/zkvm-input/private-input-contract';
import type { InputCommitmentResponse } from '@stark-ballot/api-contract/schemas/artifacts';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import type { ApiHandlerArguments, SessionAdmittedContext } from '../context';
import { currentFinalizationInputCommitmentRoute } from '@stark-ballot/api-contract/routes';
import { errorResponse } from '../../http/response';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import { respondWithRoute } from '../utils/responseSchema';

export function computeSessionInputCommitment(session: SessionReadModel): string {
  return computeInputCommitment(
    buildCanonicalZkVMInputFromSession({
      identity: session.identity,
      voting: session.voting,
    }),
  );
}

/** Return the canonical input commitment for the current finalization. */
export function getCurrentFinalizationInputCommitmentHandler({
  context,
}: ApiHandlerArguments<typeof currentFinalizationInputCommitmentRoute, SessionAdmittedContext>): Response {
  try {
    const { sessionId, session } = context;

    // Check if session is finalized
    if (session.finalization?.state.status !== 'succeeded') {
      return errorResponse(
        new ApiError(
          ErrorCode.SESSION_NOT_FINALIZED,
          400,
          'The session must be finalized before calculating the input commitment',
        ),
      );
    }
    let inputCommitment: string;
    try {
      inputCommitment = computeSessionInputCommitment(session);
    } catch (error) {
      if (error instanceof CtProofUnavailableError) {
        return errorResponse(new ApiError(ErrorCode.CT_PROOF_UNAVAILABLE, 400, 'CT proof unavailable'));
      }
      if (error instanceof CanonicalZkVMInputValidationError) {
        logger.error('[API] Invalid zkVM input:', error.errors);
        return errorResponse(new ApiError(ErrorCode.INTERNAL_ERROR, 500, 'Invalid zkVM input structure'));
      }
      throw error;
    }

    const response: InputCommitmentResponse['data'] = {
      inputCommitment,
    };

    logger.info('[API] input commitment requested', {
      session_id_hash: hashSessionIdForLogging(sessionId),
    });

    return respondWithRoute(currentFinalizationInputCommitmentRoute, {
      status: 200,
      content: 'json',
      body: { data: response },
    });
  } catch (error) {
    logger.error('[API] Error calculating input commitment:', error);
    return errorResponse(ErrorCode.INTERNAL_ERROR);
  }
}
