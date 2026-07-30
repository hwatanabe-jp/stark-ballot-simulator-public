import type {
  FinalizationFailedPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type { ApiContext } from '../context';
import { respondWithSchema } from '../utils/responseSchema';
import { SessionStatusResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { errorResponse, jsonResponse } from '../../http/response';
import { buildFinalizationQueueInfo } from '../utils/finalizationQueueInfo';
import { deriveFinalizationProgress } from '../utils/finalizationProgress';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { emitCanonicalEvent, type FinalizationEventReason } from '@stark-ballot/diagnostics/canonicalEvents';
import { validateSessionCapabilityForSession } from '../middleware/session';
import {
  parseAwsFinalizationRuntimeState,
  type AwsFinalizationRuntimeState,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { isAwsFinalizationRuntimeTransitionStore } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import {
  hasSessionFinalizationBranch,
  isCurrentArtifactBoundaryError,
  isSupportedCurrentArtifactState,
  isUnsupportedLiveSessionContract,
  resolveSessionFinalizationArtifactState,
} from '@stark-ballot/domain/contract';
import { describeCurrentArtifactError, resolveCurrentArtifactErrorCode } from '../utils/currentArtifactErrors';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { resolveSupportedFinalizedRead } from '../utils/currentArtifactAdmission';
import { projectFinalizationStateForPublicResponse } from '../utils/finalizationStateProjection';
import {
  describeFinalizationExecution,
  type StepFunctionsExecutionDetails,
} from '../adapters/finalizationStepFunctions';
import { projectFinalizationResultForPublicResponse } from '../utils/finalizationResultProjection';

const PENDING_DESCRIBE_GRACE_MS = 60_000;
const DEFAULT_PENDING_DISPATCH_DEADLINE_SECONDS = 900;
const TERMINAL_EXECUTION_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']);

function projectUnsupportedFinalizationState(
  state: AwsFinalizationRuntimeState | null,
  artifactState: 'unsupported_current_artifact' | 'corrupt_or_unreadable',
  failedAt: number,
): AwsFinalizationRuntimeState | null {
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
  };
}

function projectTerminalStepFunctionsState(
  state: AwsFinalizationRuntimeState | null,
  stepFunctionsDetails: StepFunctionsExecutionDetails | null,
): AwsFinalizationRuntimeState | null {
  if (!state || state.status !== 'running' || !stepFunctionsDetails?.status) {
    return state;
  }

  const terminalAt = stepFunctionsDetails.stopTime ?? Date.now();
  if (stepFunctionsDetails.status === 'TIMED_OUT') {
    return {
      status: 'timeout',
      executionId: state.executionId,
      queuedAt: state.queuedAt,
      startedAt: state.startedAt,
      timeoutAt: terminalAt,
      ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
    };
  }

  if (['FAILED', 'ABORTED', 'SUCCEEDED'].includes(stepFunctionsDetails.status)) {
    return {
      status: 'failed',
      executionId: state.executionId,
      queuedAt: state.queuedAt,
      startedAt: state.startedAt,
      failedAt: terminalAt,
      error: {
        code: `STEP_FUNCTIONS_EXECUTION_${stepFunctionsDetails.status}`,
        message: 'Finalization Step Functions execution reached a terminal state before callback state was persisted.',
      },
      ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
    };
  }

  return state;
}

function resolvePositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isExecutionDoesNotExistError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/ExecutionDoesNotExist/.test(error.name) || /ExecutionDoesNotExist|execution does not exist/i.test(error.message))
  );
}

function buildExecutionArn(stateMachineArn: string | undefined, executionId: string): string | null {
  if (!stateMachineArn) {
    return null;
  }
  const arnParts = stateMachineArn.split(':');
  if (
    arnParts.length !== 7 ||
    arnParts[0] !== 'arn' ||
    arnParts[2] !== 'states' ||
    arnParts[5] !== 'stateMachine' ||
    !arnParts[6]
  ) {
    return null;
  }
  return `${arnParts.slice(0, 5).join(':')}:execution:${arnParts[6]}:${executionId}`;
}

function isTerminalExecutionStatus(status: string | null | undefined): status is string {
  return typeof status === 'string' && TERMINAL_EXECUTION_STATUSES.has(status);
}

function resolveFailureCodeForExecutionStatus(status: string): FinalizationEventReason {
  if (status === 'FAILED') {
    return 'PROVER_EXECUTION_FAILED';
  }
  if (status === 'ABORTED') {
    return 'PROVER_EXECUTION_ABORTED';
  }
  return 'FINALIZATION_OUTCOME_UNRECORDED';
}

function resolveFailureMessageForExecutionStatus(status: string): string {
  if (status === 'FAILED') {
    return 'Finalization Step Functions execution failed.';
  }
  if (status === 'ABORTED') {
    return 'Finalization Step Functions execution was aborted.';
  }
  if (status === 'SUCCEEDED') {
    return 'Finalization Step Functions execution succeeded without recording the finalization result.';
  }
  return `Finalization Step Functions execution ${status} before recording an outcome.`;
}

function buildExecutionStatusDetails(stepFunctionsDetails: StepFunctionsExecutionDetails): Record<string, unknown> {
  return omitUndefinedProperties({
    executionStatus: stepFunctionsDetails.status ?? undefined,
    startTime: stepFunctionsDetails.startTime ?? undefined,
    stopTime: stepFunctionsDetails.stopTime ?? undefined,
  });
}

function buildFailedRuntimeState(
  state: AwsFinalizationRuntimeState & { status: 'pending' | 'running' },
  failedAt: number,
  error: FinalizationFailedPayload['error'],
): AwsFinalizationRuntimeState {
  return {
    status: 'failed',
    executionId: state.executionId,
    queuedAt: state.queuedAt,
    ...omitUndefinedProperties({ startedAt: state.status === 'running' ? state.startedAt : undefined }),
    failedAt,
    error,
    ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
  };
}

async function persistFailedState(params: {
  store: ApiContext['store'];
  sessionId: string;
  state: AwsFinalizationRuntimeState & { status: 'pending' | 'running' };
  contractGeneration: string | undefined;
  failedAt: number;
  error: FinalizationFailedPayload['error'];
  reason: FinalizationEventReason;
}): Promise<AwsFinalizationRuntimeState | null> {
  const { store, sessionId, state, contractGeneration, failedAt, error, reason } = params;
  if (!isAwsFinalizationRuntimeTransitionStore(store) || !contractGeneration) {
    return null;
  }
  try {
    const failedPayload: FinalizationFailedPayload = {
      executionId: state.executionId,
      queuedAt: state.queuedAt,
      contractGeneration,
      ...omitUndefinedProperties({ startedAt: state.status === 'running' ? state.startedAt : undefined }),
      failedAt,
      error,
      observability: {
        source: 'reconcile',
        reason,
      },
    };
    emitCanonicalEvent({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'reconcile',
      reason,
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: state.executionId,
    });
    return await store.markAwsFinalizationFailed(sessionId, {
      ...failedPayload,
      ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
    });
  } catch (error_) {
    if (isCurrentArtifactBoundaryError(error_)) {
      throw error_;
    }
    logger.warn('[Status API] Failed to persist reconciled failed finalization state', error_);
    return null;
  }
}

async function persistTimedOutState(params: {
  store: ApiContext['store'];
  sessionId: string;
  state: AwsFinalizationRuntimeState & { status: 'running' };
  contractGeneration: string | undefined;
  timeoutAt: number;
}): Promise<AwsFinalizationRuntimeState | null> {
  const { store, sessionId, state, contractGeneration, timeoutAt } = params;
  if (!isAwsFinalizationRuntimeTransitionStore(store) || !contractGeneration) {
    return null;
  }
  try {
    const timeoutPayload: FinalizationTimedOutPayload = {
      executionId: state.executionId,
      queuedAt: state.queuedAt,
      contractGeneration,
      startedAt: state.startedAt,
      timeoutAt,
      observability: {
        source: 'reconcile',
        reason: 'EXECUTION_TIMED_OUT',
      },
    };
    emitCanonicalEvent({
      event: 'finalize_transition_attempted',
      to: 'timeout',
      source: 'reconcile',
      reason: 'EXECUTION_TIMED_OUT',
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: state.executionId,
    });
    return await store.markAwsFinalizationTimedOut(sessionId, {
      ...timeoutPayload,
      ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
    });
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      throw error;
    }
    logger.warn('[Status API] Failed to persist reconciled timeout finalization state', error);
    return null;
  }
}

async function reconcilePendingFinalizationState(params: {
  store: ApiContext['store'];
  sessionId: string;
  state: AwsFinalizationRuntimeState & { status: 'pending' };
  contractGeneration: string | undefined;
}): Promise<{
  state: AwsFinalizationRuntimeState;
  stepFunctionsDetails: StepFunctionsExecutionDetails | null;
}> {
  const { store, sessionId, state, contractGeneration } = params;
  const ageMs = Date.now() - state.queuedAt;
  if (ageMs < PENDING_DESCRIBE_GRACE_MS) {
    return { state, stepFunctionsDetails: null };
  }

  const executionArn = buildExecutionArn(process.env['PROVER_STATE_MACHINE_ARN'], state.executionId);
  if (!executionArn) {
    logger.warn('[Status API] Cannot reconcile pending finalization without a valid Step Functions ARN', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      executionId: state.executionId,
      configuredStateMachineArn: process.env['PROVER_STATE_MACHINE_ARN'] ?? null,
    });
    return { state, stepFunctionsDetails: null };
  }

  const deadlineSeconds = resolvePositiveIntegerEnv(
    'FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS',
    DEFAULT_PENDING_DISPATCH_DEADLINE_SECONDS,
  );
  const ageSeconds = Math.floor(ageMs / 1000);

  try {
    const stepFunctionsDetails = await describeFinalizationExecution(executionArn);
    const executionStatus = stepFunctionsDetails.status;
    if (executionStatus === 'RUNNING') {
      return { state, stepFunctionsDetails };
    }
    if (!isTerminalExecutionStatus(executionStatus)) {
      return { state, stepFunctionsDetails };
    }

    const failedAt = Date.now();
    const error = {
      code: 'FINALIZATION_OUTCOME_UNRECORDED',
      message: resolveFailureMessageForExecutionStatus(executionStatus),
      details: buildExecutionStatusDetails(stepFunctionsDetails),
    };
    const persistedState = await persistFailedState({
      store,
      sessionId,
      state: { ...state, stepFunctionsArn: executionArn },
      contractGeneration,
      failedAt,
      error,
      reason: 'FINALIZATION_OUTCOME_UNRECORDED',
    });
    return {
      state: persistedState ?? buildFailedRuntimeState({ ...state, stepFunctionsArn: executionArn }, failedAt, error),
      stepFunctionsDetails,
    };
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      throw error;
    }
    if (!isExecutionDoesNotExistError(error)) {
      logger.error('[Status API] Failed to describe pending Step Functions execution', error);
      return { state, stepFunctionsDetails: null };
    }
    if (ageSeconds <= deadlineSeconds) {
      return { state, stepFunctionsDetails: null };
    }

    const failedAt = Date.now();
    const failedError = {
      code: 'FINALIZATION_DISPATCH_TIMEOUT',
      message: `Finalization dispatch did not start within ${deadlineSeconds} seconds.`,
      details: {
        ageSeconds,
      },
    };
    const persistedState = await persistFailedState({
      store,
      sessionId,
      state,
      contractGeneration,
      failedAt,
      error: failedError,
      reason: 'FINALIZATION_DISPATCH_TIMEOUT',
    });
    return {
      state: persistedState ?? buildFailedRuntimeState(state, failedAt, failedError),
      stepFunctionsDetails: null,
    };
  }
}

async function reconcileRunningFinalizationState(params: {
  store: ApiContext['store'];
  sessionId: string;
  state: AwsFinalizationRuntimeState & { status: 'running' };
  contractGeneration: string | undefined;
}): Promise<{
  state: AwsFinalizationRuntimeState;
  stepFunctionsDetails: StepFunctionsExecutionDetails | null;
}> {
  const { store, sessionId, state, contractGeneration } = params;
  if (!state.stepFunctionsArn) {
    return { state, stepFunctionsDetails: null };
  }

  try {
    const stepFunctionsDetails = await describeFinalizationExecution(state.stepFunctionsArn);
    const executionStatus = stepFunctionsDetails.status;
    if (!isTerminalExecutionStatus(executionStatus)) {
      return { state, stepFunctionsDetails };
    }

    const terminalAt = stepFunctionsDetails.stopTime ?? Date.now();
    if (executionStatus === 'TIMED_OUT') {
      const persistedState = await persistTimedOutState({
        store,
        sessionId,
        state,
        contractGeneration,
        timeoutAt: terminalAt,
      });
      return {
        state: persistedState ?? state,
        stepFunctionsDetails,
      };
    }

    const error = {
      code: resolveFailureCodeForExecutionStatus(executionStatus),
      message: resolveFailureMessageForExecutionStatus(executionStatus),
      details: buildExecutionStatusDetails(stepFunctionsDetails),
    };
    const persistedState = await persistFailedState({
      store,
      sessionId,
      state,
      contractGeneration,
      failedAt: terminalAt,
      error,
      reason: resolveFailureCodeForExecutionStatus(executionStatus),
    });
    return {
      state: persistedState ?? state,
      stepFunctionsDetails,
    };
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      throw error;
    }
    logger.error('[Status API] Failed to describe Step Functions execution', error);
    return { state, stepFunctionsDetails: null };
  }
}

/**
 * Return async finalization status for a session.
 */
export async function getSessionStatusHandler({
  request,
  params,
  store,
}: ApiContext<{ sessionId: string }>): Promise<Response> {
  const asyncDisabled = process.env['FINALIZE_ASYNC_MODE'] !== 'true';
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

  let stepFunctionsDetails: StepFunctionsExecutionDetails | null = null;

  const storedFinalizationState = parseAwsFinalizationRuntimeState(session.finalizationState) ?? null;
  const finalizedRead = resolveSupportedFinalizedRead(session);
  const finalizationArtifactState = finalizedRead.artifactState ?? resolveSessionFinalizationArtifactState(session);
  const hasStatusVisibleArtifact = hasSessionFinalizationBranch(session) || finalizationArtifactState !== null;
  if (
    isUnsupportedLiveSessionContract({
      finalized: session.finalized,
      ...omitUndefinedProperties({ contractGeneration: session.contractGeneration }),
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
  let finalizationState = canProjectCurrentStatus
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
  const shouldReconcileStepFunctions =
    !asyncDisabled &&
    canProjectCurrentStatus &&
    process.env['PROVER_STEP_FUNCTIONS_ENABLED'] === 'true' &&
    finalizationState !== null &&
    (finalizationState.status === 'pending' || finalizationState.status === 'running');

  if (shouldReconcileStepFunctions && finalizationState?.status === 'pending') {
    const reconciled = await reconcilePendingFinalizationState({
      store,
      sessionId,
      state: finalizationState,
      contractGeneration: session.contractGeneration,
    });
    finalizationState = reconciled.state;
    stepFunctionsDetails = reconciled.stepFunctionsDetails;
  } else if (shouldReconcileStepFunctions && finalizationState?.status === 'running') {
    const reconciled = await reconcileRunningFinalizationState({
      store,
      sessionId,
      state: finalizationState,
      contractGeneration: session.contractGeneration,
    });
    finalizationState = reconciled.state;
    stepFunctionsDetails = reconciled.stepFunctionsDetails;
  }
  finalizationState = projectTerminalStepFunctionsState(finalizationState, stepFunctionsDetails);

  const queueUrl = process.env['PROVER_WORK_QUEUE_URL'];
  const shouldIncludeQueue =
    !asyncDisabled &&
    canProjectCurrentStatus &&
    Boolean(queueUrl) &&
    finalizationState !== null &&
    (finalizationState.status === 'pending' || finalizationState.status === 'running');
  const queueInfo =
    shouldIncludeQueue && (finalizationState?.status === 'pending' || finalizationState?.status === 'running')
      ? await buildFinalizationQueueInfo({
          ...omitUndefinedProperties({ queueUrl: queueUrl }),
          state: finalizationState,
        })
      : null;

  const progress = canProjectCurrentStatus
    ? deriveFinalizationProgress({
        state: finalizationState,
        ...omitUndefinedProperties({ estimatedDurationMs: queueInfo?.estimatedDurationMs }),
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
