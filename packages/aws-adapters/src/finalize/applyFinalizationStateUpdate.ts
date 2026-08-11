import {
  applyFinalizationStateUpdatePayload,
  type FinalizationStateUpdateApplyResult,
} from '@stark-ballot/application/finalize/finalization-state-update';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import {
  toApplicationFinalizationStateUpdatePayload,
  type AwsFinalizationStateUpdatePayload,
  type AwsFinalizationStateUpdateRuntimeMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import type { AwsFinalizationRuntimeTransitionStore } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';

function withAwsRuntimeMetadata<TPayload extends object>(
  payload: TPayload,
  runtimeMetadata: AwsFinalizationStateUpdateRuntimeMetadata | undefined,
  includeBundleMetadata: boolean,
): TPayload & AwsFinalizationStateUpdateRuntimeMetadata {
  return {
    ...payload,
    ...(runtimeMetadata?.stepFunctionsArn ? { stepFunctionsArn: runtimeMetadata.stepFunctionsArn } : {}),
    ...(includeBundleMetadata && runtimeMetadata?.bundleMetadata
      ? { bundleMetadata: runtimeMetadata.bundleMetadata }
      : {}),
  };
}

async function loadAppliedFinalizationRecord(
  store: FinalizationLifecycleStore,
  sessionId: string,
  state: FinalizationState,
): Promise<FinalizationRecord> {
  const record = await store.getFinalizationRecord(sessionId, state.finalizationId);
  if (
    !record ||
    record.finalizationId !== state.finalizationId ||
    record.state.finalizationId !== state.finalizationId ||
    record.state.status !== state.status
  ) {
    throw new Error('Applied finalization record unavailable');
  }
  return record;
}

export async function applyAwsFinalizationStateUpdatePayload({
  payload,
  store,
}: {
  payload: AwsFinalizationStateUpdatePayload;
  store: FinalizationLifecycleStore & AwsFinalizationRuntimeTransitionStore;
}): Promise<FinalizationStateUpdateApplyResult> {
  const runtimeMetadata = payload.runtimeMetadata;
  const projectedStore = {
    getFinalizationRecord: store.getFinalizationRecord.bind(store),
    ...(typeof store.markFinalizationRunning === 'function'
      ? {
          markFinalizationRunning: async (sessionId, runningPayload) => {
            const state = await store.markAwsFinalizationRunning(
              sessionId,
              withAwsRuntimeMetadata(runningPayload, runtimeMetadata, false),
            );
            return loadAppliedFinalizationRecord(store, sessionId, state);
          },
        }
      : {}),
    ...(typeof store.markFinalizationSucceeded === 'function'
      ? {
          markFinalizationSucceeded: async (sessionId, succeededPayload) => {
            const state = await store.markAwsFinalizationSucceeded(
              sessionId,
              withAwsRuntimeMetadata(succeededPayload, runtimeMetadata, true),
            );
            return loadAppliedFinalizationRecord(store, sessionId, state);
          },
        }
      : {}),
    ...(typeof store.markFinalizationFailed === 'function'
      ? {
          markFinalizationFailed: async (sessionId, failedPayload) => {
            const state = await store.markAwsFinalizationFailed(
              sessionId,
              withAwsRuntimeMetadata(failedPayload, runtimeMetadata, false),
            );
            return loadAppliedFinalizationRecord(store, sessionId, state);
          },
        }
      : {}),
    ...(typeof store.markFinalizationTimedOut === 'function'
      ? {
          markFinalizationTimedOut: async (sessionId, timedOutPayload) => {
            const state = await store.markAwsFinalizationTimedOut(
              sessionId,
              withAwsRuntimeMetadata(timedOutPayload, runtimeMetadata, false),
            );
            return loadAppliedFinalizationRecord(store, sessionId, state);
          },
        }
      : {}),
  } as Pick<
    FinalizationLifecycleStore,
    | 'getFinalizationRecord'
    | 'markFinalizationRunning'
    | 'markFinalizationSucceeded'
    | 'markFinalizationFailed'
    | 'markFinalizationTimedOut'
  >;

  return applyFinalizationStateUpdatePayload({
    payload: toApplicationFinalizationStateUpdatePayload(payload),
    store: projectedStore,
  });
}
