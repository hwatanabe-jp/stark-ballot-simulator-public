import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationFailedPayload } from '@stark-ballot/application/finalize/finalization-store';
import {
  isAwsFinalizationRuntimeTransitionStore,
  type AwsFinalizationRuntimeMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import type { ApiHandlerArguments, ClientRateLimitedContext, SessionAdmittedContext } from '../context';
import { cancelFinalizationRoute } from '@stark-ballot/api-contract/routes';
import { errorResponse } from '../../http/response';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { logger } from '@stark-ballot/diagnostics/logger';
import { respondWithRoute } from '../utils/responseSchema';
import { projectFinalizationResourceForPublicResponse } from '../utils/finalizationStateProjection';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { emitCanonicalEvent } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { FinalizationDependencies } from '../../composition/finalizationDependencies';

type FinalizationRuntimeReadModel = FinalizationState & AwsFinalizationRuntimeMetadata;

function isCancellable(
  state: FinalizationRuntimeReadModel | null,
  finalizationId: string,
): state is FinalizationRuntimeReadModel & Extract<FinalizationState, { status: 'pending' | 'running' }> {
  if (!state) {
    return false;
  }
  if (state.finalizationId !== finalizationId) {
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

async function tryStopExecution(
  stopExecution: FinalizationDependencies['stopFinalizationExecution'],
  arn: string,
  reason: string,
): Promise<void> {
  try {
    await stopExecution(arn, reason);
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
type CancelFinalizationContext = SessionAdmittedContext &
  ClientRateLimitedContext & {
    finalizationDependencies: Pick<FinalizationDependencies, 'stopFinalizationExecution'>;
  };

export async function cancelFinalizationHandler({
  input,
  context,
}: ApiHandlerArguments<typeof cancelFinalizationRoute, CancelFinalizationContext>): Promise<Response> {
  const { sessionId: sessionIdResult, session, store, runtimeProfile } = context;
  const { finalizationId } = input.params;
  const { reason } = input.body;
  const dependencies = context.finalizationDependencies;

  if (runtimeProfile.finalization.mode !== 'async') {
    return buildErrorResponse('Async finalization is disabled', 404);
  }

  const finalizationRecord = session.finalization;
  const runtimeMetadata =
    finalizationRecord?.finalizationId === finalizationId
      ? await store.getAwsFinalizationRuntimeMetadata(sessionIdResult, finalizationId)
      : undefined;
  const currentState: FinalizationRuntimeReadModel | null = finalizationRecord
    ? {
        ...finalizationRecord.state,
        ...runtimeMetadata,
      }
    : null;
  if (!isCancellable(currentState, finalizationId)) {
    emitCanonicalEvent({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'cancel',
      reason: 'FINALIZATION_NOT_CANCELLABLE',
      session_id_hash: hashSessionIdForLogging(sessionIdResult),
      finalization_id: finalizationId,
    });
    return buildErrorResponse('Finalization cannot be cancelled in its current state', 409);
  }

  const cancellationReason = reason?.trim().length ? reason.trim() : 'Cancelled by user request';

  if (currentState.stepFunctionsArn) {
    try {
      await tryStopExecution(dependencies.stopFinalizationExecution, currentState.stepFunctionsArn, cancellationReason);
    } catch (error) {
      logger.warn('[Cancel Finalization] Failed to stop Step Functions execution', error);
    }
  }

  const failedPayload: FinalizationFailedPayload = {
    finalizationId,
    queuedAtMs: currentState.queuedAtMs,
    ...omitUndefinedProperties({
      startedAtMs: 'startedAtMs' in currentState ? currentState.startedAtMs : undefined,
    }),
    failedAtMs: Date.now(),
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
    finalization_id: finalizationId,
  });
  const failedState = isAwsFinalizationRuntimeTransitionStore(store)
    ? await store.markAwsFinalizationFailed(sessionIdResult, {
        ...failedPayload,
        ...omitUndefinedProperties({ stepFunctionsArn: currentState.stepFunctionsArn }),
      })
    : (await store.markFinalizationFailed(sessionIdResult, failedPayload)).state;

  const resource = projectFinalizationResourceForPublicResponse({
    state: failedState,
    runtimeDiagnostics: {
      asyncMode: 'enabled',
    },
  });
  return respondWithRoute(cancelFinalizationRoute, {
    status: 200,
    content: 'json',
    body: {
      data: resource,
    },
  });
}
