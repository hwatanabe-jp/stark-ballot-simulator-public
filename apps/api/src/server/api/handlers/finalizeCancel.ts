import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationFailedPayload } from '@stark-ballot/application/finalize/finalization-store';
import {
  parseAwsFinalizationRuntimeState,
  type AwsFinalizationRuntimeState,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { isAwsFinalizationRuntimeTransitionStore } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import type { ApiContext } from '../context';
import { errorResponse } from '../../http/response';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { FinalizeCancelResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { logger } from '@stark-ballot/diagnostics/logger';
import { isCurrentArtifactBoundaryError } from '@stark-ballot/domain/contract';
import { hasSessionFinalizationBranch, isUnsupportedLiveSessionContract } from '@stark-ballot/domain/contract';
import { requireSessionId, validateSessionCapabilityForSession } from '../middleware/session';
import { enforceFinalizeCancelRateLimit } from '../middleware/rateLimit';
import { parseFinalizeCancelRequest } from '../middleware/validation';
import { respondWithSchema } from '../utils/responseSchema';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveUnsupportedSessionArtifactState,
} from '../utils/currentArtifactAdmission';
import { projectFinalizationStateForPublicResponse } from '../utils/finalizationStateProjection';
import { stopFinalizationExecution } from '../adapters/finalizationStepFunctions';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { emitCanonicalEvent } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

function isCancellable(
  state: AwsFinalizationRuntimeState | null,
  executionId: string,
): state is AwsFinalizationRuntimeState & Extract<FinalizationState, { status: 'pending' | 'running' }> {
  if (!state) {
    return false;
  }
  if (state.executionId !== executionId) {
    return false;
  }
  return state.status === 'pending' || state.status === 'running';
}

function buildErrorResponse(message: string, status: number): Response {
  const error =
    status === 404
      ? ErrorCode.ASYNC_FINALIZATION_DISABLED
      : status === 501
        ? ErrorCode.CANCELLATION_UNSUPPORTED
        : ErrorCode.FINALIZATION_NOT_CANCELLABLE;
  return errorResponse(new ApiError(error, status, message));
}

async function tryStopExecution(arn: string, reason: string): Promise<void> {
  try {
    await stopFinalizationExecution(arn, reason);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'ExecutionDoesNotExist' ||
        error.name === 'ExecutionAlreadyCompleted' ||
        /Execution(DoesNotExist|AlreadyCompleted)/.test(error.message))
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Cancel an in-flight async finalization.
 */
export async function cancelFinalizationHandler({ request, store, clientIp }: ApiContext): Promise<Response> {
  if (process.env['FINALIZE_ASYNC_MODE'] !== 'true') {
    return buildErrorResponse('Async finalization disabled', 404);
  }

  const sessionIdResult = requireSessionId(request.headers);
  if (sessionIdResult instanceof Response) {
    return sessionIdResult;
  }

  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionIdResult);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const session = await store.getSession(sessionIdResult);
  if (!session) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }

  const unsupportedArtifactState = resolveUnsupportedSessionArtifactState(session);
  const hasVisibleArtifact = hasSessionFinalizationBranch(session) || unsupportedArtifactState !== null;
  if (
    isUnsupportedLiveSessionContract({
      finalized: session.finalized,
      ...omitUndefinedProperties({ contractGeneration: session.contractGeneration }),
    }) &&
    !hasVisibleArtifact
  ) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }
  if (unsupportedArtifactState) {
    return buildUnsupportedFinalizedArtifactResponse(unsupportedArtifactState);
  }

  const rateLimitResult = await enforceFinalizeCancelRateLimit(clientIp);
  if (rateLimitResult instanceof Response) {
    return rateLimitResult;
  }

  const parsedBody = await parseFinalizeCancelRequest(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }
  const { executionId, reason } = parsedBody.data;

  if (typeof store.markFinalizationFailed !== 'function') {
    return buildErrorResponse('Store does not support cancellation', 501);
  }

  const currentState = parseAwsFinalizationRuntimeState(session.finalizationState) ?? null;
  if (!isCancellable(currentState, executionId)) {
    emitCanonicalEvent({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'cancel',
      reason: 'FINALIZATION_NOT_CANCELLABLE',
      session_id_hash: hashSessionIdForLogging(sessionIdResult),
      execution_id: executionId,
    });
    return buildErrorResponse('Finalization cannot be cancelled in its current state', 409);
  }

  const cancellationReason = reason?.trim().length ? reason.trim() : 'Cancelled by user request';

  if (
    process.env['PROVER_STEP_FUNCTIONS_ENABLED'] === 'true' &&
    currentState.stepFunctionsArn &&
    typeof currentState.stepFunctionsArn === 'string'
  ) {
    try {
      await tryStopExecution(currentState.stepFunctionsArn, cancellationReason);
    } catch (error) {
      logger.warn('[Cancel Finalization] Failed to stop Step Functions execution', error);
    }
  }

  let failedState;
  try {
    const contractGeneration = session.contractGeneration;
    if (typeof contractGeneration !== 'string' || contractGeneration.trim().length === 0) {
      return errorResponse(ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT);
    }
    const failedPayload: FinalizationFailedPayload = {
      executionId,
      queuedAt: currentState.queuedAt,
      ...omitUndefinedProperties({ contractGeneration: contractGeneration }),
      ...omitUndefinedProperties({ startedAt: 'startedAt' in currentState ? currentState.startedAt : undefined }),
      failedAt: Date.now(),
      error: {
        code: 'USER_CANCELLED',
        message: cancellationReason,
      },
      observability: {
        source: 'cancel',
        reason: 'USER_CANCELLED',
      },
    };
    emitCanonicalEvent({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'cancel',
      reason: 'USER_CANCELLED',
      session_id_hash: hashSessionIdForLogging(sessionIdResult),
      execution_id: executionId,
    });
    failedState = isAwsFinalizationRuntimeTransitionStore(store)
      ? await store.markAwsFinalizationFailed(sessionIdResult, {
          ...failedPayload,
          ...omitUndefinedProperties({ stepFunctionsArn: currentState.stepFunctionsArn }),
        })
      : await store.markFinalizationFailed(sessionIdResult, failedPayload);
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      return buildUnsupportedFinalizedArtifactResponse(error.artifactState);
    }
    throw error;
  }

  return respondWithSchema(
    FinalizeCancelResponseSchema,
    {
      state: projectFinalizationStateForPublicResponse(failedState),
    },
    { status: 200 },
  );
}
