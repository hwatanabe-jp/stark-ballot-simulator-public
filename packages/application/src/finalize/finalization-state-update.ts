import type {
  FinalizationExecutionId,
  FinalizationResultAuthority,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import { hydrateFinalizationResultFromJournal } from './finalization-result';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

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

      state = await store.markFinalizationRunning(payload.sessionId, {
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
        contractGeneration: payload.contractGeneration,
        startedAt: payload.startedAt,
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

        state = await store.markFinalizationFailed(payload.sessionId, {
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
          contractGeneration: payload.contractGeneration,
          ...omitUndefinedProperties({ startedAt: payload.startedAt ?? payload.queuedAt }),
          failedAt: Date.now(),
          error: {
            code: 'FINALIZATION_RESULT_INVALID',
            message: 'Canonical finalization result is missing proof-bound journal data',
          },
        });
        break;
      }

      state = await store.markFinalizationSucceeded(payload.sessionId, {
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
        contractGeneration: payload.contractGeneration,
        ...omitUndefinedProperties({ startedAt: payload.startedAt ?? payload.queuedAt }),
        completedAt: payload.completedAt ?? Date.now(),
        finalizationResult: hydratedResult,
      });
      break;
    }

    case 'FAILED': {
      if (typeof store.markFinalizationFailed !== 'function') {
        throw new Error('Failure handler unavailable');
      }

      state = await store.markFinalizationFailed(payload.sessionId, {
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
        contractGeneration: payload.contractGeneration,
        ...omitUndefinedProperties({ startedAt: payload.startedAt }),
        failedAt: payload.failedAt ?? Date.now(),
        error: payload.error ?? {
          code: 'UNKNOWN',
          message: 'Finalization failed',
        },
      });
      break;
    }

    case 'TIMED_OUT': {
      if (typeof store.markFinalizationTimedOut !== 'function') {
        throw new Error('Timeout handler unavailable');
      }

      state = await store.markFinalizationTimedOut(payload.sessionId, {
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
        contractGeneration: payload.contractGeneration,
        ...omitUndefinedProperties({ startedAt: payload.startedAt }),
        timeoutAt: payload.timeoutAt ?? Date.now(),
      });
      break;
    }
  }

  return {
    sessionId: payload.sessionId,
    state,
  };
}
