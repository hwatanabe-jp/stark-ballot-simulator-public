import { hasOnlyAllowedKeys, isNonNegativeInteger } from '@stark-ballot/validation/unknown-value-guards';
import type { FinalizationStateUpdatePayload } from '@stark-ballot/application/finalize/finalization-state-update';
import { admitFinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-storage';
import {
  PROVER_FAILURE_CATEGORY_VALUES,
  type FinalizationFailureCategory,
  type ProverFailureCategory,
} from '@stark-ballot/application/finalize/finalization-types';
import { parseRequiredAwsFinalizationBundleMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationMetadataAdmission';
import type { AwsFinalizationBundleMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { getStringProperty, isNonNullObject } from '@stark-ballot/validation/unknown-value-guards';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

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

function isFinalizationFailureCode(value: string): value is keyof typeof FINALIZATION_FAILURES {
  return Object.hasOwn(FINALIZATION_FAILURES, value);
}

function parseFinalizationError(value: unknown): AwsFinalizationFailure | undefined {
  if (!isNonNullObject(value)) {
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

type UpdateIdentity = Pick<
  AwsFinalizationStateUpdatePayload,
  'sessionId' | 'finalizationId' | 'queuedAtMs' | 'runtimeMetadata'
>;

const UPDATE_KEYS_BY_STATUS = {
  RUNNING: RUNNING_UPDATE_KEYS,
  SUCCEEDED: SUCCEEDED_UPDATE_KEYS,
  FAILED: FAILED_UPDATE_KEYS,
  TIMED_OUT: TIMED_OUT_UPDATE_KEYS,
} as const;

function isUpdateStatus(value: string): value is keyof typeof UPDATE_KEYS_BY_STATUS {
  return Object.hasOwn(UPDATE_KEYS_BY_STATUS, value);
}

function parseUpdateIdentity(value: Record<string, unknown>): UpdateIdentity | undefined {
  const rawSessionId = getStringProperty(value, 'sessionId');
  const finalizationId = parseFinalizationId(value['finalizationId']);
  const queuedAtMs = value['queuedAtMs'];
  if (!rawSessionId || !finalizationId || !isSafeVerifierSegment(rawSessionId) || !isNonNegativeInteger(queuedAtMs))
    return undefined;
  return { sessionId: asSessionId(rawSessionId), finalizationId, queuedAtMs };
}

function parseUpdateRuntimeMetadata(
  value: Record<string, unknown>,
): AwsFinalizationStateUpdateRuntimeMetadata | undefined {
  const stepFunctionsArn = getStringProperty(value, 'stepFunctionsArn');
  if (Object.hasOwn(value, 'stepFunctionsArn') && typeof stepFunctionsArn !== 'string') return undefined;
  const metadata: AwsFinalizationStateUpdateRuntimeMetadata = { ...(stepFunctionsArn ? { stepFunctionsArn } : {}) };
  if (Object.hasOwn(value, 'bundleMetadata')) {
    const bundleMetadata = parseRequiredAwsFinalizationBundleMetadata(value['bundleMetadata']);
    if (!bundleMetadata) return undefined;
    if (Object.keys(bundleMetadata).length > 0) metadata.bundleMetadata = { ...bundleMetadata };
  }
  return metadata;
}

export function parseFinalizationStateUpdatePayload(value: unknown): AwsFinalizationStateUpdatePayload | undefined {
  if (!isNonNullObject(value)) return undefined;
  const identity = parseUpdateIdentity(value);
  if (!identity) return undefined;
  const status = getStringProperty(value, 'status');
  if (!status || !isUpdateStatus(status)) return undefined;
  if (!hasOnlyAllowedKeys(value, UPDATE_KEYS_BY_STATUS[status])) return undefined;
  const runtimeMetadata = parseUpdateRuntimeMetadata(value);
  if (!runtimeMetadata) return undefined;
  const common = { ...identity, ...(Object.keys(runtimeMetadata).length > 0 ? { runtimeMetadata } : {}) };
  switch (status) {
    case 'RUNNING':
      return parseRunningUpdate(value, common);
    case 'SUCCEEDED':
      return parseSucceededUpdate(value, common);
    case 'FAILED':
      return parseFailedUpdate(value, common);
    case 'TIMED_OUT':
      return parseTimedOutUpdate(value, common);
  }
}

function parseRunningUpdate(
  value: Record<string, unknown>,
  common: UpdateIdentity,
): AwsFinalizationStateUpdatePayload | undefined {
  const { queuedAtMs } = common;
  const startedAtMs = value['startedAtMs'];

  if (!isNonNegativeInteger(startedAtMs) || startedAtMs < queuedAtMs) {
    return undefined;
  }
  return {
    ...common,
    status: 'RUNNING',
    startedAtMs,
  };
}

function parseSucceededUpdate(
  value: Record<string, unknown>,
  common: UpdateIdentity,
): AwsFinalizationStateUpdatePayload | undefined {
  const { queuedAtMs } = common;
  const startedAtMs = value['startedAtMs'];
  const completedAtMs = value['completedAtMs'];

  if (
    !isNonNegativeInteger(startedAtMs) ||
    startedAtMs < queuedAtMs ||
    !isNonNegativeInteger(completedAtMs) ||
    completedAtMs < startedAtMs
  ) {
    return undefined;
  }
  const finalizationResult = admitFinalizationResultAuthority(value['finalizationResult']);
  if (!finalizationResult) {
    return undefined;
  }
  return {
    ...common,
    status: 'SUCCEEDED',
    startedAtMs,
    completedAtMs,
    finalizationResult,
  };
}

function parseFailedUpdate(
  value: Record<string, unknown>,
  common: UpdateIdentity,
): AwsFinalizationStateUpdatePayload | undefined {
  const { queuedAtMs } = common;
  const startedAtMs = value['startedAtMs'];
  const failedAtMs = value['failedAtMs'];

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
    status: 'FAILED',
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    failedAtMs,
    error,
  };
}

function parseTimedOutUpdate(
  value: Record<string, unknown>,
  common: UpdateIdentity,
): AwsFinalizationStateUpdatePayload | undefined {
  const { queuedAtMs } = common;
  const startedAtMs = value['startedAtMs'];
  const timeoutAtMs = value['timeoutAtMs'];
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
    status: 'TIMED_OUT',
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    timeoutAtMs,
  };
}
