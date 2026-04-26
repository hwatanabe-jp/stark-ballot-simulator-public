import { SFNClient, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import type { ApiContext } from '@/server/api/context';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import { SessionStatusResponseSchema } from '@/lib/validation/apiSchemas';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { buildFinalizationQueueInfo } from '@/server/api/utils/finalizationQueueInfo';
import { deriveFinalizationProgress } from '@/server/api/utils/finalizationProgress';
import { logger } from '@/lib/utils/logger';
import { validateSessionCapabilityForSession } from '@/server/api/middleware/session';
import { projectFinalizationResultForPublicResponse } from '@/lib/finalize/finalization-result';
import {
  hasSessionFinalizationBranch,
  isSupportedCurrentArtifactState,
  isUnsupportedLiveSessionContract,
  resolveSessionFinalizationArtifactState,
} from '@/lib/contract';
import type { FinalizationState } from '@/types/server';
import {
  describeCurrentArtifactError,
  resolveCurrentArtifactErrorCode,
} from '@/server/api/utils/currentArtifactErrors';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { resolveSupportedFinalizedRead } from '@/server/api/utils/currentArtifactAdmission';

let sfnClient: SFNClient | null = null;

function getStepFunctionsClient(): SFNClient {
  if (!sfnClient) {
    sfnClient = new SFNClient({});
  }
  return sfnClient;
}

/**
 * Override the Step Functions client for tests.
 */
export function _setStepFunctionsClient(client: SFNClient | null): void {
  sfnClient = client;
}

function projectUnsupportedFinalizationState(
  state: FinalizationState | null,
  artifactState: 'unsupported_current_artifact' | 'corrupt_or_unreadable',
  failedAt: number,
): FinalizationState | null {
  if (!state) {
    return null;
  }

  const startedAt =
    state.status === 'running' ||
    state.status === 'succeeded' ||
    state.status === 'failed' ||
    state.status === 'timeout'
      ? state.startedAt
      : undefined;
  const failureTimestamp = state.status === 'failed' ? state.failedAt : failedAt;

  return {
    status: 'failed',
    executionId: state.executionId,
    queuedAt: state.queuedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    failedAt: failureTimestamp,
    error: {
      code: resolveCurrentArtifactErrorCode(artifactState),
      message: describeCurrentArtifactError(artifactState),
      details: {
        artifactState,
      },
    },
    ...(state.stepFunctionsArn ? { stepFunctionsArn: state.stepFunctionsArn } : {}),
  };
}

function projectFinalizationStateForPublicResponse(state: FinalizationState | null): FinalizationState | null {
  if (!state) {
    return null;
  }

  const publicState = { ...(state as FinalizationState & { bundleMetadata?: unknown }) };
  delete publicState.bundleMetadata;
  return publicState;
}

/**
 * Return async finalization status for a session.
 */
export async function getSessionStatusHandler({
  request,
  params,
  store,
}: ApiContext<{ sessionId: string }>): Promise<Response> {
  const asyncDisabled = process.env.FINALIZE_ASYNC_MODE !== 'true';
  const sessionId = params?.sessionId;
  if (!sessionId) {
    return jsonResponse({ error: 'Session ID is required' }, { status: 400 });
  }

  const capabilityResult = validateSessionCapabilityForSession(request.headers, sessionId);
  if (capabilityResult instanceof Response) {
    return capabilityResult;
  }

  const session = await store.getSession(sessionId);
  if (!session) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }

  let stepFunctionsDetails: {
    executionArn: string;
    status: string | null;
    startTime: number | null;
    stopTime: number | null;
    error: string | null;
    cause: string | null;
  } | null = null;

  const storedFinalizationState = session.finalizationState ?? null;
  const finalizedRead = resolveSupportedFinalizedRead(session);
  const finalizationArtifactState = finalizedRead.artifactState ?? resolveSessionFinalizationArtifactState(session);
  const hasStatusVisibleArtifact = hasSessionFinalizationBranch(session) || finalizationArtifactState !== null;
  if (
    isUnsupportedLiveSessionContract({
      finalized: session.finalized,
      contractGeneration: session.contractGeneration,
    }) &&
    !hasStatusVisibleArtifact
  ) {
    return errorResponse(ErrorCode.SESSION_NOT_FOUND);
  }
  const canProjectCurrentStatus =
    finalizationArtifactState === null || isSupportedCurrentArtifactState(finalizationArtifactState);
  const unsupportedArtifactState =
    finalizationArtifactState && !isSupportedCurrentArtifactState(finalizationArtifactState)
      ? finalizationArtifactState
      : null;
  const finalizationState = canProjectCurrentStatus
    ? storedFinalizationState
    : projectUnsupportedFinalizationState(
        storedFinalizationState,
        unsupportedArtifactState as 'unsupported_current_artifact' | 'corrupt_or_unreadable',
        session.lastActivity,
      );
  const canonicalFinalizationResult =
    canProjectCurrentStatus && session.finalized ? (finalizedRead.finalizationResult ?? undefined) : undefined;
  const canExposeFinalizationResult =
    canProjectCurrentStatus &&
    session.finalized &&
    (finalizationState === null || finalizationState.status === 'succeeded');
  const finalizationResult =
    canExposeFinalizationResult && canonicalFinalizationResult
      ? projectFinalizationResultForPublicResponse(canonicalFinalizationResult)
      : null;
  const stepFunctionsArn = finalizationState?.stepFunctionsArn;
  const shouldDescribe =
    !asyncDisabled &&
    canProjectCurrentStatus &&
    process.env.PROVER_STEP_FUNCTIONS_ENABLED === 'true' &&
    Boolean(stepFunctionsArn);

  if (shouldDescribe && stepFunctionsArn) {
    try {
      const client = getStepFunctionsClient();
      const response = await client.send(new DescribeExecutionCommand({ executionArn: stepFunctionsArn }));
      stepFunctionsDetails = {
        executionArn: response.executionArn ?? stepFunctionsArn,
        status: response.status ?? null,
        startTime: response.startDate ? response.startDate.getTime() : null,
        stopTime: response.stopDate ? response.stopDate.getTime() : null,
        error: response.error ?? null,
        cause: response.cause ?? null,
      };
    } catch (error) {
      logger.error('[Status API] Failed to describe Step Functions execution', error);
    }
  }

  const queueUrl = process.env.PROVER_WORK_QUEUE_URL;
  const shouldIncludeQueue =
    !asyncDisabled &&
    canProjectCurrentStatus &&
    Boolean(queueUrl) &&
    finalizationState !== null &&
    finalizationState.status === 'pending';
  const queueInfo = shouldIncludeQueue
    ? await buildFinalizationQueueInfo({
        queueUrl,
        state: finalizationState,
      })
    : null;

  const progress = canProjectCurrentStatus
    ? deriveFinalizationProgress({
        state: finalizationState,
        estimatedDurationMs: queueInfo?.estimatedDurationMs,
      })
    : undefined;

  return respondWithSchema(
    SessionStatusResponseSchema,
    {
      sessionId: session.sessionId,
      finalizationState: projectFinalizationStateForPublicResponse(finalizationState),
      ...(unsupportedArtifactState ? { artifactState: unsupportedArtifactState } : {}),
      queue: queueInfo,
      ...(progress ? { progress } : {}),
      finalizationResult,
      stepFunctions: stepFunctionsDetails,
      asyncFinalizationMode: asyncDisabled ? 'disabled' : 'enabled',
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
