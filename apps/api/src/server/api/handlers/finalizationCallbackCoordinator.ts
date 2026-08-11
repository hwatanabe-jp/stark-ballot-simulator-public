import type { FinalizationStateUpdateApplyResult } from '@stark-ballot/application/finalize/finalization-state-update';
import { applyAwsFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/applyFinalizationStateUpdate';
import { isAwsFinalizationRuntimeTransitionStore } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import type { AwsFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import { emitCanonicalEvent, type FinalizationUpdateOutcome } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { ApiContextStore } from '../context';

export interface FinalizationCallbackCoordinatorResult {
  status: number;
  body: Record<string, unknown>;
}

function emitAppliedCallbackOutcome(
  outcome: FinalizationUpdateOutcome,
  payload: AwsFinalizationStateUpdatePayload,
): void {
  emitCanonicalEvent({
    event: 'finalization_update_received',
    transport: 'http_callback',
    auth_result: 'passed',
    outcome_code: outcome,
    session_id_hash: hashSessionIdForLogging(payload.sessionId),
    finalization_id: payload.finalizationId,
  });
}

export async function coordinateFinalizationCallback(input: {
  payload: AwsFinalizationStateUpdatePayload;
  store: ApiContextStore;
}): Promise<FinalizationCallbackCoordinatorResult> {
  const { payload, store } = input;
  let result: FinalizationStateUpdateApplyResult;

  try {
    if (!isAwsFinalizationRuntimeTransitionStore(store)) {
      emitAppliedCallbackOutcome('transition_store_unavailable', payload);
      return { status: 501, body: { error: 'Runtime finalization handler unavailable' } };
    }
    result = await applyAwsFinalizationStateUpdatePayload({ payload, store });
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message === 'Success handler unavailable' ||
        error.message === 'Failure handler unavailable' ||
        error.message === 'Timeout handler unavailable'
      ) {
        emitAppliedCallbackOutcome('handler_unavailable', payload);
        return { status: 501, body: { error: error.message } };
      }
      if (error.message === 'Canonical finalization result required') {
        emitAppliedCallbackOutcome('canonical_result_missing', payload);
        return { status: 500, body: { error: error.message } };
      }
    }
    emitAppliedCallbackOutcome('application_failed', payload);
    throw error;
  }

  emitAppliedCallbackOutcome('applied', payload);
  return {
    status: 200,
    body: {
      sessionId: result.sessionId,
      state: result.state,
    },
  };
}
