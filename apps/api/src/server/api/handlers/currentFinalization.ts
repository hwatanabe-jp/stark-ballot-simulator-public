import type {
  FinalizationFailedPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import { deriveFinalizationProgress } from '@stark-ballot/application/finalize/finalization-progress';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { ApiContextStore, ApiHandlerArguments, SessionAdmittedContext } from '../context';
import { respondWithRoute } from '../utils/responseSchema';
import { currentFinalizationRoute } from '@stark-ballot/api-contract/routes';
import { buildFinalizationQueueInfo } from '../utils/finalizationQueueInfo';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { emitCanonicalEvent, type FinalizationEventReason } from '@stark-ballot/diagnostics/canonicalEvents';
import {
  isAwsFinalizationRuntimeTransitionStore,
  type AwsFinalizationRuntimeMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { projectFinalizationResourceForPublicResponse } from '../utils/finalizationStateProjection';
import type {
  FinalizationDependencies,
  StepFunctionsExecutionDetails,
} from '../../composition/finalizationDependencies';
import { projectFinalizationResultForPublicResponse } from '../utils/finalizationResultProjection';
import { admitPersistedFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-bitmap-admission';

type FinalizationRuntimeReadModel = FinalizationState & AwsFinalizationRuntimeMetadata;

const PENDING_DESCRIBE_GRACE_MS = 60_000;
const DEFAULT_PENDING_DISPATCH_DEADLINE_SECONDS = 900;
const TERMINAL_EXECUTION_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']);

function projectTerminalStepFunctionsState(
  state: FinalizationRuntimeReadModel | null,
  stepFunctionsDetails: StepFunctionsExecutionDetails | null,
): FinalizationRuntimeReadModel | null {
  if (!state || state.status !== 'running' || !stepFunctionsDetails?.status) {
    return state;
  }

  const terminalAtMs = stepFunctionsDetails.stopTimeMs ?? Date.now();
  if (stepFunctionsDetails.status === 'TIMED_OUT') {
    return {
      status: 'timeout',
      finalizationId: state.finalizationId,
      queuedAtMs: state.queuedAtMs,
      startedAtMs: state.startedAtMs,
      timeoutAtMs: terminalAtMs,
      ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
    };
  }

  if (['FAILED', 'ABORTED', 'SUCCEEDED'].includes(stepFunctionsDetails.status)) {
    return {
      status: 'failed',
      finalizationId: state.finalizationId,
      queuedAtMs: state.queuedAtMs,
      startedAtMs: state.startedAtMs,
      failedAtMs: terminalAtMs,
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

function buildExecutionArn(stateMachineArn: string | undefined, finalizationId: string): string | null {
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
  return `${arnParts.slice(0, 5).join(':')}:execution:${arnParts[6]}:${finalizationId}`;
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
    startTimeMs: stepFunctionsDetails.startTimeMs ?? undefined,
    stopTimeMs: stepFunctionsDetails.stopTimeMs ?? undefined,
  });
}

function buildFailedRuntimeState(
  state: FinalizationRuntimeReadModel & { status: 'pending' | 'running' },
  failedAtMs: number,
  error: FinalizationFailedPayload['error'],
): FinalizationRuntimeReadModel {
  return {
    status: 'failed',
    finalizationId: state.finalizationId,
    queuedAtMs: state.queuedAtMs,
    ...omitUndefinedProperties({ startedAtMs: state.status === 'running' ? state.startedAtMs : undefined }),
    failedAtMs,
    error,
    ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
  };
}

async function persistFailedState(params: {
  store: ApiContextStore;
  sessionId: string;
  state: FinalizationRuntimeReadModel & { status: 'pending' | 'running' };
  failedAtMs: number;
  error: FinalizationFailedPayload['error'];
  reason: FinalizationEventReason;
}): Promise<FinalizationRuntimeReadModel | null> {
  const { store, sessionId, state, failedAtMs, error, reason } = params;
  try {
    const failedPayload: FinalizationFailedPayload = {
      finalizationId: state.finalizationId,
      queuedAtMs: state.queuedAtMs,
      ...omitUndefinedProperties({ startedAtMs: state.status === 'running' ? state.startedAtMs : undefined }),
      failedAtMs,
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
      finalization_id: state.finalizationId,
    });
    const persistedState = isAwsFinalizationRuntimeTransitionStore(store)
      ? await store.markAwsFinalizationFailed(sessionId, {
          ...failedPayload,
          ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
        })
      : (await store.markFinalizationFailed(sessionId, failedPayload)).state;
    return {
      ...persistedState,
      ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
    };
  } catch (error_) {
    logger.warn('[Status API] Failed to persist reconciled failed finalization state', error_);
    return null;
  }
}

async function persistTimedOutState(params: {
  store: ApiContextStore;
  sessionId: string;
  state: FinalizationRuntimeReadModel & { status: 'running' };
  timeoutAtMs: number;
}): Promise<FinalizationRuntimeReadModel | null> {
  const { store, sessionId, state, timeoutAtMs } = params;
  try {
    const timeoutPayload: FinalizationTimedOutPayload = {
      finalizationId: state.finalizationId,
      queuedAtMs: state.queuedAtMs,
      startedAtMs: state.startedAtMs,
      timeoutAtMs,
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
      finalization_id: state.finalizationId,
    });
    const persistedState = isAwsFinalizationRuntimeTransitionStore(store)
      ? await store.markAwsFinalizationTimedOut(sessionId, {
          ...timeoutPayload,
          ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
        })
      : (await store.markFinalizationTimedOut(sessionId, timeoutPayload)).state;
    return {
      ...persistedState,
      ...omitUndefinedProperties({ stepFunctionsArn: state.stepFunctionsArn }),
    };
  } catch (error) {
    logger.warn('[Status API] Failed to persist reconciled timeout finalization state', error);
    return null;
  }
}

async function reconcilePendingFinalizationState(params: {
  store: ApiContextStore;
  sessionId: string;
  state: FinalizationRuntimeReadModel & { status: 'pending' };
  stateMachineArn: string;
  describeFinalizationExecution: FinalizationDependencies['describeFinalizationExecution'];
}): Promise<{
  state: FinalizationRuntimeReadModel;
  stepFunctionsDetails: StepFunctionsExecutionDetails | null;
}> {
  const { store, sessionId, state, stateMachineArn, describeFinalizationExecution } = params;
  const ageMs = Date.now() - state.queuedAtMs;
  if (ageMs < PENDING_DESCRIBE_GRACE_MS) {
    return { state, stepFunctionsDetails: null };
  }

  const executionArn = buildExecutionArn(stateMachineArn, state.finalizationId);
  if (!executionArn) {
    logger.warn('[Status API] Cannot reconcile pending finalization without a valid Step Functions ARN', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalizationId: state.finalizationId,
      configuredStateMachineArn: stateMachineArn,
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

    const failedAtMs = Date.now();
    const error = {
      code: 'FINALIZATION_OUTCOME_UNRECORDED',
      message: resolveFailureMessageForExecutionStatus(executionStatus),
      details: buildExecutionStatusDetails(stepFunctionsDetails),
    };
    const persistedState = await persistFailedState({
      store,
      sessionId,
      state: { ...state, stepFunctionsArn: executionArn },
      failedAtMs,
      error,
      reason: 'FINALIZATION_OUTCOME_UNRECORDED',
    });
    return {
      state: persistedState ?? buildFailedRuntimeState({ ...state, stepFunctionsArn: executionArn }, failedAtMs, error),
      stepFunctionsDetails,
    };
  } catch (error) {
    if (!isExecutionDoesNotExistError(error)) {
      logger.error('[Status API] Failed to describe pending Step Functions execution', error);
      return { state, stepFunctionsDetails: null };
    }
    if (ageSeconds <= deadlineSeconds) {
      return { state, stepFunctionsDetails: null };
    }

    const failedAtMs = Date.now();
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
      failedAtMs,
      error: failedError,
      reason: 'FINALIZATION_DISPATCH_TIMEOUT',
    });
    return {
      state: persistedState ?? buildFailedRuntimeState(state, failedAtMs, failedError),
      stepFunctionsDetails: null,
    };
  }
}

async function reconcileRunningFinalizationState(params: {
  store: ApiContextStore;
  sessionId: string;
  state: FinalizationRuntimeReadModel & { status: 'running' };
  describeFinalizationExecution: FinalizationDependencies['describeFinalizationExecution'];
}): Promise<{
  state: FinalizationRuntimeReadModel;
  stepFunctionsDetails: StepFunctionsExecutionDetails | null;
}> {
  const { store, sessionId, state, describeFinalizationExecution } = params;
  if (!state.stepFunctionsArn) {
    return { state, stepFunctionsDetails: null };
  }

  try {
    const stepFunctionsDetails = await describeFinalizationExecution(state.stepFunctionsArn);
    const executionStatus = stepFunctionsDetails.status;
    if (!isTerminalExecutionStatus(executionStatus)) {
      return { state, stepFunctionsDetails };
    }

    const terminalAtMs = stepFunctionsDetails.stopTimeMs ?? Date.now();
    if (executionStatus === 'TIMED_OUT') {
      const persistedState = await persistTimedOutState({
        store,
        sessionId,
        state,
        timeoutAtMs: terminalAtMs,
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
      failedAtMs: terminalAtMs,
      error,
      reason: resolveFailureCodeForExecutionStatus(executionStatus),
    });
    return {
      state: persistedState ?? state,
      stepFunctionsDetails,
    };
  } catch (error) {
    logger.error('[Status API] Failed to describe Step Functions execution', error);
    return { state, stepFunctionsDetails: null };
  }
}

/**
 * Return the current finalization resource for a session.
 */
export async function getCurrentFinalizationHandler({
  context,
}: ApiHandlerArguments<
  typeof currentFinalizationRoute,
  SessionAdmittedContext & {
    finalizationDependencies: Pick<FinalizationDependencies, 'describeFinalizationExecution'>;
  }
>): Promise<Response> {
  const { sessionId, session, store, runtimeProfile } = context;
  const asyncEnabled = runtimeProfile.finalization.mode === 'async';
  const targetAsyncExternal = asyncEnabled && runtimeProfile.external.kind === 'aws' ? runtimeProfile.external : null;
  let stepFunctionsDetails: StepFunctionsExecutionDetails | null = null;

  if (!session.finalization) {
    return respondWithRoute(
      currentFinalizationRoute,
      { status: 200, content: 'json', body: { data: null } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const runtimeMetadata = await store.getAwsFinalizationRuntimeMetadata(sessionId, session.finalization.finalizationId);
  let finalizationState: FinalizationRuntimeReadModel = {
    ...session.finalization.state,
    ...runtimeMetadata,
  };
  if (targetAsyncExternal && finalizationState.status === 'pending') {
    const reconciled = await reconcilePendingFinalizationState({
      store,
      sessionId,
      state: finalizationState,
      stateMachineArn: targetAsyncExternal.asyncRuntime.proverStateMachineArn,
      describeFinalizationExecution: context.finalizationDependencies.describeFinalizationExecution,
    });
    finalizationState = reconciled.state;
    stepFunctionsDetails = reconciled.stepFunctionsDetails;
  } else if (targetAsyncExternal && finalizationState.status === 'running') {
    const reconciled = await reconcileRunningFinalizationState({
      store,
      sessionId,
      state: finalizationState,
      describeFinalizationExecution: context.finalizationDependencies.describeFinalizationExecution,
    });
    finalizationState = reconciled.state;
    stepFunctionsDetails = reconciled.stepFunctionsDetails;
  }
  finalizationState = projectTerminalStepFunctionsState(finalizationState, stepFunctionsDetails) ?? finalizationState;

  const queueUrl = targetAsyncExternal?.asyncRuntime.proverWorkQueueUrl;
  const shouldIncludeQueue =
    asyncEnabled &&
    Boolean(queueUrl) &&
    (finalizationState.status === 'pending' || finalizationState.status === 'running');
  const queue =
    shouldIncludeQueue && (finalizationState.status === 'pending' || finalizationState.status === 'running')
      ? await buildFinalizationQueueInfo({
          ...omitUndefinedProperties({ queueUrl }),
          state: finalizationState,
        })
      : null;
  const progress = deriveFinalizationProgress({
    state: finalizationState,
    ...omitUndefinedProperties({ estimatedDurationMs: queue?.estimatedDurationMs }),
  });

  let result;
  if (finalizationState.status === 'succeeded') {
    if (!session.finalization.finalizationResult) {
      throw new Error('Succeeded finalization is missing canonical result authority');
    }
    const [verificationRecord, deliveryMetadata, persistedBitmapData] = await Promise.all([
      store.getVerificationResultRecord(sessionId, finalizationState.finalizationId),
      store.getAwsVerificationDeliveryMetadata(sessionId, finalizationState.finalizationId),
      store.getBitmapData(sessionId, finalizationState.finalizationId),
    ]);
    const bitmapData = admitPersistedFinalizationBitmapData(session.finalization, persistedBitmapData);
    result = projectFinalizationResultForPublicResponse(session.finalization.finalizationResult, undefined, {
      ...omitUndefinedProperties({ verificationResult: verificationRecord?.verificationResult }),
      ...omitUndefinedProperties({ deliveryMetadata }),
      ...omitUndefinedProperties({ bitmapData: bitmapData ?? undefined }),
    });
  }

  const resource = projectFinalizationResourceForPublicResponse({
    state: finalizationState,
    runtimeDiagnostics: {
      asyncMode: asyncEnabled ? 'enabled' : 'disabled',
      ...omitUndefinedProperties({ queue, progress: progress ?? undefined }),
      ...omitUndefinedProperties({
        orchestrator: stepFunctionsDetails
          ? {
              status: stepFunctionsDetails.status,
              startTimeMs: stepFunctionsDetails.startTimeMs,
              stopTimeMs: stepFunctionsDetails.stopTimeMs,
            }
          : undefined,
      }),
    },
    ...omitUndefinedProperties({ result }),
  });

  return respondWithRoute(
    currentFinalizationRoute,
    { status: 200, content: 'json', body: { data: resource } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
