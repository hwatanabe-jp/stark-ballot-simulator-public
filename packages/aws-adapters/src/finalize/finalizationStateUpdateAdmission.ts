import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationStateUpdatePayload } from '@stark-ballot/application/finalize/finalization-state-update';
import {
  parseAwsPersistedFinalizationResult,
  type AwsFinalizationLifecycleMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { getStringProperty, isRecord } from '@stark-ballot/domain/utils/guards';

const BUNDLE_METADATA_KEYS = new Set(['s3BundleKey', 's3UploadedAt']);
const FINALIZATION_ERROR_KEYS = new Set(['code', 'message', 'details']);
const STATE_UPDATE_REQUEST_KEYS = new Set([
  'sessionId',
  'executionId',
  'contractGeneration',
  'status',
  'queuedAt',
  'startedAt',
  'completedAt',
  'failedAt',
  'timeoutAt',
  'bundleMetadata',
  'error',
  'finalizationResult',
  'stepFunctionsArn',
]);

export interface AwsFinalizationStateUpdateRuntimeMetadata {
  stepFunctionsArn?: string;
  bundleMetadata?: AwsFinalizationLifecycleMetadata;
}

export type AwsFinalizationStateUpdatePayload = FinalizationStateUpdatePayload & {
  runtimeMetadata?: AwsFinalizationStateUpdateRuntimeMetadata;
};

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseBundleMetadata(value: unknown): AwsFinalizationLifecycleMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!hasOnlyAllowedKeys(value, BUNDLE_METADATA_KEYS)) {
    return undefined;
  }

  const s3BundleKey = getStringProperty(value, 's3BundleKey');
  const s3UploadedAt = getStringProperty(value, 's3UploadedAt');
  if (
    (hasOwn(value, 's3BundleKey') && typeof s3BundleKey !== 'string') ||
    (hasOwn(value, 's3UploadedAt') && typeof s3UploadedAt !== 'string')
  ) {
    return undefined;
  }

  return {
    ...(s3BundleKey ? { s3BundleKey } : {}),
    ...(s3UploadedAt ? { s3UploadedAt } : {}),
  };
}

function parseFinalizationError(value: unknown): Extract<FinalizationState, { status: 'failed' }>['error'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!hasOnlyAllowedKeys(value, FINALIZATION_ERROR_KEYS)) {
    return undefined;
  }

  const code = getStringProperty(value, 'code');
  const message = getStringProperty(value, 'message');
  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }

  return {
    code,
    message,
    ...(hasOwn(value, 'details') ? { details: value['details'] } : {}),
  };
}

export function toApplicationFinalizationStateUpdatePayload(
  payload: AwsFinalizationStateUpdatePayload,
): FinalizationStateUpdatePayload {
  return {
    sessionId: payload.sessionId,
    executionId: payload.executionId,
    contractGeneration: payload.contractGeneration,
    status: payload.status,
    queuedAt: payload.queuedAt,
    ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
    ...(payload.completedAt !== undefined ? { completedAt: payload.completedAt } : {}),
    ...(payload.failedAt !== undefined ? { failedAt: payload.failedAt } : {}),
    ...(payload.timeoutAt !== undefined ? { timeoutAt: payload.timeoutAt } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    ...(payload.finalizationResult !== undefined ? { finalizationResult: payload.finalizationResult } : {}),
  };
}

export function parseFinalizationStateUpdatePayload(value: unknown): AwsFinalizationStateUpdatePayload | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, STATE_UPDATE_REQUEST_KEYS)) {
    return undefined;
  }

  const sessionId = getStringProperty(value, 'sessionId');
  const executionId = getStringProperty(value, 'executionId');
  const contractGeneration = getStringProperty(value, 'contractGeneration');
  const stepFunctionsArn = getStringProperty(value, 'stepFunctionsArn');
  const status = getStringProperty(value, 'status');
  const queuedAt = value['queuedAt'];
  const startedAt = value['startedAt'];
  const completedAt = value['completedAt'];
  const failedAt = value['failedAt'];
  const timeoutAt = value['timeoutAt'];

  if (
    !sessionId ||
    !executionId ||
    !contractGeneration ||
    (status !== 'RUNNING' && status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'TIMED_OUT') ||
    !isSafeVerifierSegment(sessionId) ||
    !isSafeVerifierSegment(executionId) ||
    !isNonNegativeInteger(queuedAt) ||
    (status === 'RUNNING' && !isNonNegativeInteger(startedAt)) ||
    (hasOwn(value, 'startedAt') && !isNonNegativeInteger(startedAt)) ||
    (status === 'RUNNING' && isNonNegativeInteger(startedAt) && startedAt < queuedAt) ||
    (hasOwn(value, 'completedAt') && !isNonNegativeInteger(completedAt)) ||
    (hasOwn(value, 'failedAt') && !isNonNegativeInteger(failedAt)) ||
    (hasOwn(value, 'timeoutAt') && !isNonNegativeInteger(timeoutAt)) ||
    (hasOwn(value, 'stepFunctionsArn') && typeof stepFunctionsArn !== 'string')
  ) {
    return undefined;
  }

  const parsed: FinalizationStateUpdatePayload = {
    sessionId,
    executionId,
    contractGeneration,
    status,
    queuedAt,
    ...(startedAt !== undefined ? { startedAt: startedAt as number } : {}),
    ...(completedAt !== undefined ? { completedAt: completedAt as number } : {}),
    ...(failedAt !== undefined ? { failedAt: failedAt as number } : {}),
    ...(timeoutAt !== undefined ? { timeoutAt: timeoutAt as number } : {}),
  };
  const runtimeMetadata: AwsFinalizationStateUpdateRuntimeMetadata = {
    ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
  };

  if (hasOwn(value, 'bundleMetadata')) {
    const bundleMetadata = parseBundleMetadata(value['bundleMetadata']);
    if (!bundleMetadata) {
      return undefined;
    }
    if (Object.keys(bundleMetadata).length > 0) {
      runtimeMetadata.bundleMetadata = { ...bundleMetadata };
    }
  }

  if (hasOwn(value, 'error')) {
    const error = parseFinalizationError(value['error']);
    if (!error) {
      return undefined;
    }
    parsed.error = error;
  }

  if (status === 'SUCCEEDED' || hasOwn(value, 'finalizationResult')) {
    const finalizationResult = parseAwsPersistedFinalizationResult(value['finalizationResult']);
    if (!finalizationResult) {
      return undefined;
    }
    parsed.finalizationResult = finalizationResult;
  }

  return {
    ...parsed,
    ...(Object.keys(runtimeMetadata).length > 0 ? { runtimeMetadata } : {}),
  };
}
