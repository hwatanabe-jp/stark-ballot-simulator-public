import type { SuccessfulFinalizationCommitInput } from '@stark-ballot/application/finalize/finalization-store';
import {
  finalizationRecordCodec,
  type FinalizationRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import { isSuccessfulFinalizationRecord } from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import {
  assertAllowedFinalizationPayloadKeys,
  FINALIZATION_RUNNING_PAYLOAD_KEYS,
  FINALIZATION_SUCCEEDED_PAYLOAD_KEYS,
  FINALIZATION_FAILED_PAYLOAD_KEYS,
  FINALIZATION_TIMED_OUT_PAYLOAD_KEYS,
} from '@stark-ballot/application/finalize/finalization-store';
import type {
  FinalizationFailedPayload,
  FinalizationRunningPayload,
  FinalizationSucceededPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationId, FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export const AWS_RUNNING_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  ...FINALIZATION_RUNNING_PAYLOAD_KEYS,
  'stepFunctionsArn',
]);
const AWS_SUCCEEDED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  ...FINALIZATION_SUCCEEDED_PAYLOAD_KEYS,
  'stepFunctionsArn',
  'bundleMetadata',
]);
export const AWS_FAILED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  ...FINALIZATION_FAILED_PAYLOAD_KEYS,
  'stepFunctionsArn',
]);
export const AWS_TIMED_OUT_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  ...FINALIZATION_TIMED_OUT_PAYLOAD_KEYS,
  'stepFunctionsArn',
]);

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

/** AWS success cannot replace another execution or a sticky failed/timed-out terminal state. */
export function retainedStateBeforeAwsSuccess(
  current: FinalizationRecord | null,
  finalizationId: FinalizationId,
): FinalizationState | undefined {
  if (
    current &&
    (current.finalizationId !== finalizationId ||
      (current.state.status !== 'pending' &&
        current.state.status !== 'running' &&
        current.state.status !== 'succeeded'))
  ) {
    return current.state;
  }
  return undefined;
}

/** Admit AWS success evidence once; adapters retain their own metadata and write admission order. */
export function prepareAwsSuccessfulCommit(
  sessionId: SessionId,
  payload: FinalizationSucceededPayload,
  current: FinalizationRecord | null,
) {
  const finalizationResult = payload.finalizationResult;
  const bitmap =
    finalizationResult.artifacts.bitmap.availability === 'available'
      ? { availability: 'available' as const, data: finalizationResult.artifacts.bitmap.data }
      : { availability: 'unavailable' as const };
  const record = finalizationRecordCodec.admit({
    sessionId,
    finalizationId: payload.finalizationId,
    scenarioContext: payload.scenarioContext ?? current?.scenarioContext,
    state: {
      status: 'succeeded',
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      startedAtMs: payload.startedAtMs,
      completedAtMs: payload.completedAtMs,
    },
    finalizationResult: { finalizationId: payload.finalizationId, ...finalizationResult },
  });
  if (!isSuccessfulFinalizationRecord(record)) throw new Error('Invalid AWS succeeded finalization record');
  return { record, bitmap };
}

export function projectSucceededRuntimeMetadata(
  stepFunctionsArn: AwsFinalizationRuntimeMetadata['stepFunctionsArn'],
  bundleMetadata: AwsFinalizationRuntimeMetadata['bundleMetadata'],
): AwsFinalizationRuntimeMetadata | undefined {
  return stepFunctionsArn === undefined && bundleMetadata === undefined
    ? undefined
    : {
        ...(stepFunctionsArn === undefined ? {} : { stepFunctionsArn }),
        ...(bundleMetadata === undefined ? {} : { bundleMetadata }),
      };
}

export function attachAwsSuccessMetadata(
  prepared: ReturnType<typeof prepareAwsSuccessfulCommit>,
  runtimeMetadata: AwsFinalizationRuntimeMetadata | undefined,
  observability: FinalizationSucceededPayload['observability'],
): SuccessfulFinalizationCommitInput & { runtimeMetadata?: AwsFinalizationRuntimeMetadata } {
  return {
    record: prepared.record,
    bitmap: prepared.bitmap,
    ...(runtimeMetadata ? { runtimeMetadata } : {}),
    ...(observability ? { observability } : {}),
  };
}

export function prepareMappedAwsSuccessfulCommit(
  sessionId: SessionId,
  payload: FinalizationSucceededPayload,
  current: FinalizationRecord | null,
  stepFunctionsArn: AwsFinalizationRuntimeMetadata['stepFunctionsArn'],
  bundleMetadata: AwsFinalizationRuntimeMetadata['bundleMetadata'],
) {
  const prepared = prepareAwsSuccessfulCommit(sessionId, payload, current);
  const runtimeMetadata = projectSucceededRuntimeMetadata(stepFunctionsArn, bundleMetadata);
  return attachAwsSuccessMetadata(prepared, runtimeMetadata, payload.observability);
}

export function admitAwsSuccessInput(payload: AwsFinalizationSucceededPayload) {
  assertAllowedFinalizationPayloadKeys(payload, AWS_SUCCEEDED_PAYLOAD_KEYS, 'AWS succeeded finalization');
  const { stepFunctionsArn, bundleMetadata, finalizationResult, ...common } = payload;
  return { payload, stepFunctionsArn, bundleMetadata, semanticPayload: { ...common, finalizationResult } };
}

export type AdmittedAwsSuccessInput = ReturnType<typeof admitAwsSuccessInput>;
