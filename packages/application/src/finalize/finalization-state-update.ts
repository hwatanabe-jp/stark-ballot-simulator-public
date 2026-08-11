import type {
  FinalizationId,
  FinalizationResultAuthority,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import { FinalizationFailureCategory } from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import { hydrateFinalizationResultFromJournal } from './finalization-result';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import {
  emitCanonicalEvent,
  isFinalizationEventReason,
  type FinalizationEventReason,
} from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

type FinalizationStateUpdateCommon = {
  sessionId: string;
  finalizationId: FinalizationId;
  queuedAtMs: number;
};

export type FinalizationStateUpdatePayload =
  | (FinalizationStateUpdateCommon & {
      status: 'RUNNING';
      startedAtMs: number;
    })
  | (FinalizationStateUpdateCommon & {
      status: 'SUCCEEDED';
      startedAtMs: number;
      completedAtMs: number;
      finalizationResult: FinalizationResultAuthority;
    })
  | (FinalizationStateUpdateCommon & {
      status: 'FAILED';
      startedAtMs?: number;
      failedAtMs: number;
      error: Extract<FinalizationState, { status: 'failed' }>['error'];
    })
  | (FinalizationStateUpdateCommon & {
      status: 'TIMED_OUT';
      startedAtMs?: number;
      timeoutAtMs: number;
    });

type FinalizationStateUpdateStore = Pick<
  FinalizationLifecycleStore,
  | 'getFinalizationRecord'
  | 'markFinalizationRunning'
  | 'markFinalizationSucceeded'
  | 'markFinalizationFailed'
  | 'markFinalizationTimedOut'
>;

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
    finalization_id: payload.finalizationId,
  });
}

function resolveWriterUpdateFailureReason(
  payload: Extract<FinalizationStateUpdatePayload, { status: 'FAILED' }>,
): FinalizationEventReason {
  const reason = payload.error.code;
  return isFinalizationEventReason(reason) ? reason : 'RUNTIME_UPDATE_RECEIVED';
}

export async function applyFinalizationStateUpdatePayload({
  payload,
  store,
}: {
  payload: FinalizationStateUpdatePayload;
  store: FinalizationStateUpdateStore;
}): Promise<FinalizationStateUpdateApplyResult> {
  let state: FinalizationState;

  switch (payload.status) {
    case 'RUNNING': {
      if (typeof store.markFinalizationRunning !== 'function') {
        throw new Error('Running handler unavailable');
      }
      emitWriterUpdateAttempt(payload, 'running');
      const record = await store.markFinalizationRunning(payload.sessionId, {
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
        startedAtMs: payload.startedAtMs,
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      });
      state = record.state;
      break;
    }

    case 'SUCCEEDED': {
      if (typeof store.markFinalizationSucceeded !== 'function') {
        throw new Error('Success handler unavailable');
      }

      const currentRecord = await store.getFinalizationRecord(payload.sessionId, payload.finalizationId);
      if (!currentRecord || currentRecord.finalizationId !== payload.finalizationId) {
        throw new Error('Finalization record unavailable');
      }
      const hydratedResult = hydrateFinalizationResultFromJournal(
        payload.finalizationResult,
        currentRecord.scenarioContext,
      );

      if (!hydratedResult?.journal) {
        if (typeof store.markFinalizationFailed !== 'function') {
          throw new Error('Canonical finalization result required');
        }

        emitWriterUpdateAttempt(payload, 'failed', 'FINALIZATION_RESULT_INVALID');
        const failedRecord = await store.markFinalizationFailed(payload.sessionId, {
          finalizationId: payload.finalizationId,
          queuedAtMs: payload.queuedAtMs,
          startedAtMs: payload.startedAtMs,
          failedAtMs: payload.completedAtMs,
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
        state = failedRecord.state;
        break;
      }

      emitWriterUpdateAttempt(payload, 'succeeded');
      const succeededRecord = await store.markFinalizationSucceeded(payload.sessionId, {
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
        startedAtMs: payload.startedAtMs,
        completedAtMs: payload.completedAtMs,
        finalizationResult: hydratedResult,
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      });
      state = succeededRecord.state;
      break;
    }

    case 'FAILED': {
      if (typeof store.markFinalizationFailed !== 'function') {
        throw new Error('Failure handler unavailable');
      }

      const reason = resolveWriterUpdateFailureReason(payload);
      emitWriterUpdateAttempt(payload, 'failed', reason);
      const failedRecord = await store.markFinalizationFailed(payload.sessionId, {
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
        ...omitUndefinedProperties({ startedAtMs: payload.startedAtMs }),
        failedAtMs: payload.failedAtMs,
        error: payload.error,
        observability: {
          source: 'writer_update',
          reason,
        },
      });
      state = failedRecord.state;
      break;
    }

    case 'TIMED_OUT': {
      if (typeof store.markFinalizationTimedOut !== 'function') {
        throw new Error('Timeout handler unavailable');
      }

      emitWriterUpdateAttempt(payload, 'timeout');
      const timedOutRecord = await store.markFinalizationTimedOut(payload.sessionId, {
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
        ...omitUndefinedProperties({ startedAtMs: payload.startedAtMs }),
        timeoutAtMs: payload.timeoutAtMs,
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      });
      state = timedOutRecord.state;
      break;
    }
  }

  return {
    sessionId: payload.sessionId,
    state,
  };
}
