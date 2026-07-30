import type {
  FinalizationExecutionId,
  FinalizationResultAuthority,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import { FinalizationFailureCategory } from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import { hydrateFinalizationResultFromJournal } from './finalization-result';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import {
  emitCanonicalEvent,
  isFinalizationEventReason,
  type FinalizationEventReason,
} from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

type FinalizationStateUpdateStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';

export interface FinalizationStateUpdatePayload {
  sessionId: string;
  executionId: FinalizationExecutionId;
  contractGeneration: string;
  status: FinalizationStateUpdateStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  timeoutAt?: number;
  error?: Extract<FinalizationState, { status: 'failed' }>['error'];
  finalizationResult?: FinalizationResultAuthority;
}

export interface FinalizationStateUpdateApplyResult {
  sessionId: string;
  state: FinalizationState;
}

function emitWriterUpdateAttempt(
  payload: FinalizationStateUpdatePayload,
  to: FinalizationState['status'],
  reason: FinalizationEventReason = 'RUNTIME_UPDATE_RECEIVED',
): void {
  emitCanonicalEvent({
    event: 'finalize_transition_attempted',
    to,
    source: 'writer_update',
    reason,
    session_id_hash: hashSessionIdForLogging(payload.sessionId),
    execution_id: payload.executionId,
  });
}

function resolveWriterUpdateFailureReason(payload: FinalizationStateUpdatePayload): FinalizationEventReason {
  const reason = payload.error?.code;
  return isFinalizationEventReason(reason) ? reason : 'RUNTIME_UPDATE_RECEIVED';
}

export async function applyFinalizationStateUpdatePayload({
  payload,
  store,
}: {
  payload: FinalizationStateUpdatePayload;
  store: FinalizationLifecycleStore & Pick<VoteStore, 'getSession'>;
}): Promise<FinalizationStateUpdateApplyResult> {
  let state: FinalizationState;

  switch (payload.status) {
    case 'RUNNING': {
      if (typeof store.markFinalizationRunning !== 'function') {
        throw new Error('Running handler unavailable');
      }
      if (payload.startedAt === undefined) {
        throw new Error('Started timestamp required');
      }

      emitWriterUpdateAttempt(payload, 'running');
      state = await store.markFinalizationRunning(payload.sessionId, {
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
        contractGeneration: payload.contractGeneration,
        startedAt: payload.startedAt,
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      });
      break;
    }

    case 'SUCCEEDED': {
      if (typeof store.markFinalizationSucceeded !== 'function') {
        throw new Error('Success handler unavailable');
      }

      const session = await store.getSession(payload.sessionId);
      const scenarioContext = session?.finalizationScenarioContext;
      const hydratedResult = hydrateFinalizationResultFromJournal(payload.finalizationResult, scenarioContext);

      if (!hydratedResult?.journal) {
        if (typeof store.markFinalizationFailed !== 'function') {
          throw new Error('Canonical finalization result required');
        }

        emitWriterUpdateAttempt(payload, 'failed', 'FINALIZATION_RESULT_INVALID');
        state = await store.markFinalizationFailed(payload.sessionId, {
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
          contractGeneration: payload.contractGeneration,
          ...omitUndefinedProperties({ startedAt: payload.startedAt ?? payload.queuedAt }),
          failedAt: Date.now(),
          error: {
            code: 'FINALIZATION_RESULT_INVALID',
            message: 'Canonical finalization result is missing proof-bound journal data',
            category: FinalizationFailureCategory.ARTIFACT,
          },
          observability: {
            source: 'writer_update',
            reason: 'FINALIZATION_RESULT_INVALID',
          },
        });
        break;
      }

      emitWriterUpdateAttempt(payload, 'succeeded');
      state = await store.markFinalizationSucceeded(payload.sessionId, {
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
        contractGeneration: payload.contractGeneration,
        ...omitUndefinedProperties({ startedAt: payload.startedAt ?? payload.queuedAt }),
        completedAt: payload.completedAt ?? Date.now(),
        finalizationResult: hydratedResult,
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      });
      break;
    }

    case 'FAILED': {
      if (typeof store.markFinalizationFailed !== 'function') {
        throw new Error('Failure handler unavailable');
      }

      const reason = resolveWriterUpdateFailureReason(payload);
      emitWriterUpdateAttempt(payload, 'failed', reason);
      state = await store.markFinalizationFailed(payload.sessionId, {
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
        contractGeneration: payload.contractGeneration,
        ...omitUndefinedProperties({ startedAt: payload.startedAt }),
        failedAt: payload.failedAt ?? Date.now(),
        error: payload.error ?? {
          code: 'FINALIZATION_FAILED',
          message: 'Finalization failed',
          category: FinalizationFailureCategory.UNKNOWN,
        },
        observability: {
          source: 'writer_update',
          reason,
        },
      });
      break;
    }

    case 'TIMED_OUT': {
      if (typeof store.markFinalizationTimedOut !== 'function') {
        throw new Error('Timeout handler unavailable');
      }

      emitWriterUpdateAttempt(payload, 'timeout');
      state = await store.markFinalizationTimedOut(payload.sessionId, {
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
        contractGeneration: payload.contractGeneration,
        ...omitUndefinedProperties({ startedAt: payload.startedAt }),
        timeoutAt: payload.timeoutAt ?? Date.now(),
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      });
      break;
    }
  }

  return {
    sessionId: payload.sessionId,
    state,
  };
}
