import type {
  FinalizationFailedPayload,
  FinalizationRunningPayload,
  FinalizationSucceededPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationId, FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export type AwsRuntimeTransitionMetadata = {
  stepFunctionsArn?: string;
};

export interface AwsFinalizationBundleMetadata {
  s3BundleKey?: string;
  s3UploadedAtMs?: number;
}

export interface AwsFinalizationRuntimeMetadata extends AwsRuntimeTransitionMetadata {
  bundleMetadata?: AwsFinalizationBundleMetadata;
}

export type AwsFinalizationRuntimeState = FinalizationState & AwsFinalizationRuntimeMetadata;

export type AwsSucceededTransitionMetadata = AwsFinalizationRuntimeMetadata;

export function assertNoAwsRuntimeTransitionMetadata(payload: AwsSucceededTransitionMetadata): void {
  if (payload.stepFunctionsArn !== undefined || payload.bundleMetadata !== undefined) {
    throw new Error('Pure finalization lifecycle methods do not accept AWS runtime metadata');
  }
}

export type AwsFinalizationRunningPayload = FinalizationRunningPayload & AwsRuntimeTransitionMetadata;

export type AwsFinalizationSucceededPayload = FinalizationSucceededPayload & AwsSucceededTransitionMetadata;

export type AwsFinalizationFailedPayload = FinalizationFailedPayload & AwsRuntimeTransitionMetadata;

export type AwsFinalizationTimedOutPayload = FinalizationTimedOutPayload & AwsRuntimeTransitionMetadata;

export interface AwsFinalizationRuntimeMetadataStore {
  getAwsFinalizationRuntimeMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<AwsFinalizationRuntimeMetadata | undefined>;
}

export interface AwsFinalizationRuntimeTransitionStore {
  markAwsFinalizationRunning(sessionId: SessionId, payload: AwsFinalizationRunningPayload): Promise<FinalizationState>;

  markAwsFinalizationSucceeded(
    sessionId: SessionId,
    payload: AwsFinalizationSucceededPayload,
  ): Promise<FinalizationState>;

  markAwsFinalizationFailed(sessionId: SessionId, payload: AwsFinalizationFailedPayload): Promise<FinalizationState>;

  markAwsFinalizationTimedOut(
    sessionId: SessionId,
    payload: AwsFinalizationTimedOutPayload,
  ): Promise<FinalizationState>;
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
