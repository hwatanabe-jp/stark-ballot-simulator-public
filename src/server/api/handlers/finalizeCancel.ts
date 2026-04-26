import { z } from 'zod';
import { SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import type { FinalizationState } from '@/types/server';
import type { ApiContext } from '@/server/api/context';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { logger } from '@/lib/utils/logger';
import { isCurrentArtifactBoundaryError } from '@/lib/contract';
import { hasSessionFinalizationBranch, isUnsupportedLiveSessionContract } from '@/lib/contract';
import { requireSessionId, validateSessionCapabilityForSession } from '@/server/api/middleware/session';
import { enforceFinalizeCancelRateLimit } from '@/server/api/middleware/rateLimit';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveUnsupportedSessionArtifactState,
} from '@/server/api/utils/currentArtifactAdmission';

const cancelSchema = z.object({
  executionId: z.string().min(10),
  reason: z.string().max(256).optional(),
});

let cachedStepFunctionsClient: SFNClient | null = null;

function getStepFunctionsClient(): SFNClient {
  if (!cachedStepFunctionsClient) {
    cachedStepFunctionsClient = new SFNClient({});
  }
  return cachedStepFunctionsClient;
}

/**
 * Override the Step Functions client for tests.
 */
export function _setStepFunctionsClient(client: SFNClient | null): void {
  cachedStepFunctionsClient = client;
}

function isCancellable(
  state: FinalizationState | null,
  executionId: string,
): state is Extract<FinalizationState, { status: 'pending' | 'running' }> {
  if (!state) {
    return false;
  }
  if (state.executionId !== executionId) {
    return false;
  }
  return state.status === 'pending' || state.status === 'running';
}

function buildErrorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, { status });
}

async function tryStopExecution(arn: string, reason: string): Promise<void> {
  try {
    const client = getStepFunctionsClient();
    await client.send(
      new StopExecutionCommand({
        executionArn: arn,
        cause: reason,
      }),
    );
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
  if (process.env.FINALIZE_ASYNC_MODE !== 'true') {
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
      contractGeneration: session.contractGeneration,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return buildErrorResponse('Invalid JSON body', 400);
  }

  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return buildErrorResponse(parsed.error.issues[0]?.message ?? 'Invalid payload', 400);
  }
  const { executionId, reason } = parsed.data;

  if (typeof store.markFinalizationFailed !== 'function') {
    return buildErrorResponse('Store does not support cancellation', 501);
  }

  const currentState = session.finalizationState ?? null;
  if (!isCancellable(currentState, executionId)) {
    return buildErrorResponse('Finalization cannot be cancelled in its current state', 409);
  }

  const cancellationReason = reason?.trim().length ? reason.trim() : 'Cancelled by user request';

  if (
    process.env.PROVER_STEP_FUNCTIONS_ENABLED === 'true' &&
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
    failedState = await store.markFinalizationFailed(sessionIdResult, {
      executionId,
      queuedAt: currentState.queuedAt,
      contractGeneration,
      startedAt: 'startedAt' in currentState ? currentState.startedAt : undefined,
      failedAt: Date.now(),
      error: {
        code: 'USER_CANCELLED',
        message: cancellationReason,
      },
      stepFunctionsArn: currentState.stepFunctionsArn,
    });
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      return buildUnsupportedFinalizedArtifactResponse(error.artifactState);
    }
    throw error;
  }

  return jsonResponse(
    {
      state: failedState,
    },
    { status: 200 },
  );
}
