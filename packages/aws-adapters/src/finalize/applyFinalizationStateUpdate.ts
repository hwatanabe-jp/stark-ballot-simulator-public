import {
  applyFinalizationStateUpdatePayload,
  type FinalizationStateUpdateApplyResult,
} from '@stark-ballot/application/finalize/finalization-state-update';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
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

export async function applyAwsFinalizationStateUpdatePayload({
  payload,
  store,
}: {
  payload: AwsFinalizationStateUpdatePayload;
  store: FinalizationLifecycleStore & AwsFinalizationRuntimeTransitionStore & Pick<VoteStore, 'getSession'>;
}): Promise<FinalizationStateUpdateApplyResult> {
  const runtimeMetadata = payload.runtimeMetadata;
  const projectedStore = {
    ...store,
    getSession: store.getSession.bind(store),
    ...(typeof store.finalizeSession === 'function' ? { finalizeSession: store.finalizeSession.bind(store) } : {}),
    ...(typeof store.markFinalizationQueued === 'function'
      ? { markFinalizationQueued: store.markFinalizationQueued.bind(store) }
      : {}),
    ...(typeof store.markFinalizationRunning === 'function'
      ? {
          markFinalizationRunning: (sessionId, runningPayload) =>
            store.markAwsFinalizationRunning(sessionId, withAwsRuntimeMetadata(runningPayload, runtimeMetadata, false)),
        }
      : {}),
    ...(typeof store.markFinalizationSucceeded === 'function'
      ? {
          markFinalizationSucceeded: (sessionId, succeededPayload) =>
            store.markAwsFinalizationSucceeded(
              sessionId,
              withAwsRuntimeMetadata(succeededPayload, runtimeMetadata, true),
            ),
        }
      : {}),
    ...(typeof store.markFinalizationFailed === 'function'
      ? {
          markFinalizationFailed: (sessionId, failedPayload) =>
            store.markAwsFinalizationFailed(sessionId, withAwsRuntimeMetadata(failedPayload, runtimeMetadata, false)),
        }
      : {}),
    ...(typeof store.markFinalizationTimedOut === 'function'
      ? {
          markFinalizationTimedOut: (sessionId, timedOutPayload) =>
            store.markAwsFinalizationTimedOut(
              sessionId,
              withAwsRuntimeMetadata(timedOutPayload, runtimeMetadata, false),
            ),
        }
      : {}),
  } as FinalizationLifecycleStore & Pick<VoteStore, 'getSession'>;

  return applyFinalizationStateUpdatePayload({
    payload: toApplicationFinalizationStateUpdatePayload(payload),
    store: projectedStore,
  });
}
