import type { FinalizationStateUpdatePayload } from '@stark-ballot/application/finalize/finalization-state-update';
import { parseFinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-storage';
import {
  PROVER_FAILURE_CATEGORY_VALUES,
  type FinalizationFailureCategory,
  type ProverFailureCategory,
} from '@stark-ballot/application/finalize/finalization-types';
import { parseRequiredAwsFinalizationBundleMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationMetadataAdmission';
import type { AwsFinalizationBundleMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { getStringProperty, isRecord } from '@stark-ballot/validation/unknown-value-guards';

const FINALIZATION_ERROR_KEYS = new Set(['code', 'message', 'category', 'details']);
const FINALIZATION_FAILURES = {
  PROVER_TASK_FAILED: {
    code: 'PROVER_TASK_FAILED',
    message: 'Target prover task failed',
    category: 'prover_execution',
  },
  PROVER_IMAGE_SIGNATURE_FAILED: {
    code: 'PROVER_IMAGE_SIGNATURE_FAILED',
    message: 'Target prover image signature verification failed',
    category: 'image_signature',
  },
  PROVER_CAPACITY_WAIT_TIMEOUT: {
    code: 'PROVER_CAPACITY_WAIT_TIMEOUT',
    message: 'Timed out waiting for target prover capacity',
    category: 'capacity',
  },
  FINALIZATION_BUNDLE_KEY_MISSING: {
    code: 'FINALIZATION_BUNDLE_KEY_MISSING',
    message: 'Target finalization succeeded without a durable bundle key',
    category: 'artifact',
  },
  FINALIZATION_BUNDLE_RESTORE_FAILED: {
    code: 'FINALIZATION_BUNDLE_RESTORE_FAILED',
    message: 'Target finalization bundle could not be restored',
    category: 'artifact',
  },
  FINALIZATION_FAILED: {
    code: 'FINALIZATION_FAILED',
    message: 'Finalization failed',
    category: 'unknown',
  },
} as const satisfies Record<
  string,
  { readonly code: string; readonly message: string; readonly category: FinalizationFailureCategory }
>;
type AwsFinalizationFailure = {
  readonly code: keyof typeof FINALIZATION_FAILURES;
  readonly message: string;
  readonly category: FinalizationFailureCategory;
};
const PROVER_FAILURE_CATEGORIES = new Set<string>(PROVER_FAILURE_CATEGORY_VALUES);
const STATE_UPDATE_COMMON_KEYS = ['sessionId', 'finalizationId', 'status', 'queuedAtMs', 'stepFunctionsArn'] as const;
const RUNNING_UPDATE_KEYS = new Set([...STATE_UPDATE_COMMON_KEYS, 'startedAtMs']);
const SUCCEEDED_UPDATE_KEYS = new Set([
  ...STATE_UPDATE_COMMON_KEYS,
  'startedAtMs',
  'completedAtMs',
  'bundleMetadata',
  'finalizationResult',
]);
const FAILED_UPDATE_KEYS = new Set([...STATE_UPDATE_COMMON_KEYS, 'startedAtMs', 'failedAtMs', 'error']);
const TIMED_OUT_UPDATE_KEYS = new Set([...STATE_UPDATE_COMMON_KEYS, 'startedAtMs', 'timeoutAtMs']);

export interface AwsFinalizationStateUpdateRuntimeMetadata {
  stepFunctionsArn?: string;
  bundleMetadata?: AwsFinalizationBundleMetadata;
}

type WithAwsRuntimeMetadata<TPayload> = TPayload & {
  runtimeMetadata?: AwsFinalizationStateUpdateRuntimeMetadata;
};

export type AwsFinalizationStateUpdatePayload =
  | WithAwsRuntimeMetadata<Extract<FinalizationStateUpdatePayload, { status: 'RUNNING' | 'SUCCEEDED' | 'TIMED_OUT' }>>
  | WithAwsRuntimeMetadata<
      Omit<Extract<FinalizationStateUpdatePayload, { status: 'FAILED' }>, 'error'> & {
        error: AwsFinalizationFailure;
      }
    >;

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFinalizationFailureCode(value: string): value is keyof typeof FINALIZATION_FAILURES {
  return hasOwn(FINALIZATION_FAILURES, value);
}

function parseFinalizationError(value: unknown): AwsFinalizationFailure | undefined {
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

  if (!isFinalizationFailureCode(code)) {
    return undefined;
  }

  const failure = { ...FINALIZATION_FAILURES[code] };
  const category = getStringProperty(value, 'category');
  if (code === 'PROVER_TASK_FAILED' && category && PROVER_FAILURE_CATEGORIES.has(category)) {
    return { ...failure, category: category as ProverFailureCategory };
  }
  return failure;
}

export function toApplicationFinalizationStateUpdatePayload(
  payload: AwsFinalizationStateUpdatePayload,
): FinalizationStateUpdatePayload {
  const common = {
    sessionId: payload.sessionId,
    finalizationId: payload.finalizationId,
    queuedAtMs: payload.queuedAtMs,
  };
  switch (payload.status) {
    case 'RUNNING':
      return { ...common, status: payload.status, startedAtMs: payload.startedAtMs };
    case 'SUCCEEDED':
      return {
        ...common,
        status: payload.status,
        startedAtMs: payload.startedAtMs,
        completedAtMs: payload.completedAtMs,
        finalizationResult: payload.finalizationResult,
      };
    case 'FAILED':
      return {
        ...common,
        status: payload.status,
        ...(payload.startedAtMs !== undefined ? { startedAtMs: payload.startedAtMs } : {}),
        failedAtMs: payload.failedAtMs,
        error: payload.error,
      };
    case 'TIMED_OUT':
      return {
        ...common,
        status: payload.status,
        ...(payload.startedAtMs !== undefined ? { startedAtMs: payload.startedAtMs } : {}),
        timeoutAtMs: payload.timeoutAtMs,
      };
  }
}

export function parseFinalizationStateUpdatePayload(value: unknown): AwsFinalizationStateUpdatePayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sessionId = getStringProperty(value, 'sessionId');
  const finalizationId = getStringProperty(value, 'finalizationId');
  const stepFunctionsArn = getStringProperty(value, 'stepFunctionsArn');
  const status = getStringProperty(value, 'status');
  const queuedAtMs = value['queuedAtMs'];
  const startedAtMs = value['startedAtMs'];
  const completedAtMs = value['completedAtMs'];
  const failedAtMs = value['failedAtMs'];
  const timeoutAtMs = value['timeoutAtMs'];

  if (
    !sessionId ||
    !finalizationId ||
    (status !== 'RUNNING' && status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'TIMED_OUT') ||
    !isSafeVerifierSegment(sessionId) ||
    !isSafeVerifierSegment(finalizationId) ||
    !isNonNegativeInteger(queuedAtMs) ||
    (hasOwn(value, 'stepFunctionsArn') && typeof stepFunctionsArn !== 'string')
  ) {
    return undefined;
  }

  const allowedKeys =
    status === 'RUNNING'
      ? RUNNING_UPDATE_KEYS
      : status === 'SUCCEEDED'
        ? SUCCEEDED_UPDATE_KEYS
        : status === 'FAILED'
          ? FAILED_UPDATE_KEYS
          : TIMED_OUT_UPDATE_KEYS;
  if (!hasOnlyAllowedKeys(value, allowedKeys)) {
    return undefined;
  }

  const common = {
    sessionId,
    finalizationId,
    queuedAtMs,
  };
  const runtimeMetadata: AwsFinalizationStateUpdateRuntimeMetadata = {
    ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
  };

  if (hasOwn(value, 'bundleMetadata')) {
    const bundleMetadata = parseRequiredAwsFinalizationBundleMetadata(value['bundleMetadata']);
    if (!bundleMetadata) {
      return undefined;
    }
    if (Object.keys(bundleMetadata).length > 0) {
      runtimeMetadata.bundleMetadata = { ...bundleMetadata };
    }
  }

  if (status === 'RUNNING') {
    if (!isNonNegativeInteger(startedAtMs) || startedAtMs < queuedAtMs) {
      return undefined;
    }
    return {
      ...common,
      status,
      startedAtMs,
      ...(Object.keys(runtimeMetadata).length > 0 ? { runtimeMetadata } : {}),
    };
  }

  if (status === 'SUCCEEDED') {
    if (
      !isNonNegativeInteger(startedAtMs) ||
      startedAtMs < queuedAtMs ||
      !isNonNegativeInteger(completedAtMs) ||
      completedAtMs < startedAtMs
    ) {
      return undefined;
    }
    const finalizationResult = parseFinalizationResultAuthority(value['finalizationResult']);
    if (!finalizationResult) {
      return undefined;
    }
    return {
      ...common,
      status,
      startedAtMs,
      completedAtMs,
      finalizationResult,
      ...(Object.keys(runtimeMetadata).length > 0 ? { runtimeMetadata } : {}),
    };
  }

  if (status === 'FAILED') {
    const error = parseFinalizationError(value['error']);
    if (
      !error ||
      !isNonNegativeInteger(failedAtMs) ||
      failedAtMs < queuedAtMs ||
      (startedAtMs !== undefined &&
        (!isNonNegativeInteger(startedAtMs) || startedAtMs < queuedAtMs || failedAtMs < startedAtMs))
    ) {
      return undefined;
    }
    return {
      ...common,
      status,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      failedAtMs,
      error,
      ...(Object.keys(runtimeMetadata).length > 0 ? { runtimeMetadata } : {}),
    };
  }

  if (
    !isNonNegativeInteger(timeoutAtMs) ||
    timeoutAtMs < queuedAtMs ||
    (startedAtMs !== undefined &&
      (!isNonNegativeInteger(startedAtMs) || startedAtMs < queuedAtMs || timeoutAtMs < startedAtMs))
  ) {
    return undefined;
  }
  return {
    ...common,
    status,
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    timeoutAtMs,
    ...(Object.keys(runtimeMetadata).length > 0 ? { runtimeMetadata } : {}),
  };
}
