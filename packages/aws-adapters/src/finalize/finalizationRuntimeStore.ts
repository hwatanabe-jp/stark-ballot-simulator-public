import type { SessionData } from '@stark-ballot/domain/types/server';
import type {
  FinalizationFailedPayload,
  FinalizationRunningPayload,
  FinalizationSucceededPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type {
  AwsFinalizationLifecycleMetadata,
  AwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';

export type AwsRuntimeTransitionMetadata = {
  stepFunctionsArn?: string;
};

export type AwsSucceededTransitionMetadata = AwsRuntimeTransitionMetadata & {
  bundleMetadata?: AwsFinalizationLifecycleMetadata;
};

export function assertNoAwsRuntimeTransitionMetadata(payload: AwsSucceededTransitionMetadata): void {
  if (payload.stepFunctionsArn !== undefined || payload.bundleMetadata !== undefined) {
    throw new Error('Pure finalization lifecycle methods do not accept AWS runtime metadata');
  }
}

export type AwsFinalizationRunningPayload = FinalizationRunningPayload &
  AwsRuntimeTransitionMetadata & {
    scenarioContext?: SessionData['finalizationScenarioContext'] | null;
  };

export type AwsFinalizationSucceededPayload = Omit<FinalizationSucceededPayload, 'finalizationResult'> &
  AwsSucceededTransitionMetadata & {
    finalizationResult: FinalizationSucceededPayload['finalizationResult'] | AwsPersistedFinalizationResult;
  };

export type AwsFinalizationFailedPayload = FinalizationFailedPayload & AwsRuntimeTransitionMetadata;

export type AwsFinalizationTimedOutPayload = FinalizationTimedOutPayload & AwsRuntimeTransitionMetadata;

export interface AwsFinalizationRuntimeTransitionStore {
  markAwsFinalizationRunning(sessionId: string, payload: AwsFinalizationRunningPayload): Promise<FinalizationState>;

  markAwsFinalizationSucceeded(sessionId: string, payload: AwsFinalizationSucceededPayload): Promise<FinalizationState>;

  markAwsFinalizationFailed(sessionId: string, payload: AwsFinalizationFailedPayload): Promise<FinalizationState>;

  markAwsFinalizationTimedOut(sessionId: string, payload: AwsFinalizationTimedOutPayload): Promise<FinalizationState>;
}

function hasFunction(value: Record<string, unknown>, key: keyof AwsFinalizationRuntimeTransitionStore): boolean {
  return typeof value[key] === 'function';
}

export function isAwsFinalizationRuntimeTransitionStore(
  value: unknown,
): value is AwsFinalizationRuntimeTransitionStore {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    hasFunction(record, 'markAwsFinalizationRunning') &&
    hasFunction(record, 'markAwsFinalizationSucceeded') &&
    hasFunction(record, 'markAwsFinalizationFailed') &&
    hasFunction(record, 'markAwsFinalizationTimedOut')
  );
}
