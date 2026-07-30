import type {
  FinalizationResultAuthority,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type {
  FinalizationResultPersistence,
  FinalizationStatePersistence,
} from '@stark-ballot/domain/types/finalization';
import {
  parseFinalizationResultAuthority,
  parseFinalizationScenarioContext,
  parseFinalizationState,
  parseVerificationResult,
} from '@stark-ballot/application/finalize/finalization-storage';
import type { FinalizationScenarioContext } from '@stark-ballot/domain/types/server';
import { getRecordProperty, getStringProperty, isRecord } from '@stark-ballot/domain/utils/guards';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export interface AwsVerificationDeliveryMetadata {
  executionId?: string | undefined;
  s3BundleKey?: string | undefined;
  s3ReportKey?: string | undefined;
  s3UploadedAt?: string | undefined;
  verificationWorkQueuedAt?: string | undefined;
}

export interface AwsVerificationEvidenceMetadata {
  devModeReceipt?: boolean | undefined;
}

export type AwsPersistedVerificationResult = VerificationResult &
  AwsVerificationDeliveryMetadata &
  AwsVerificationEvidenceMetadata;

export interface AwsFinalizationDeliveryMetadata {
  verificationExecutionId?: string | undefined;
  s3BundleKey?: string | undefined;
  s3UploadedAt?: string | undefined;
  verificationResult?: AwsPersistedVerificationResult | undefined;
}

export type AwsPersistedFinalizationResult = Omit<FinalizationResultAuthority, 'verificationResult'> &
  AwsFinalizationDeliveryMetadata & {
    verificationResult?: AwsPersistedVerificationResult;
  };

export interface AwsFinalizationLifecycleMetadata {
  s3BundleKey?: string | undefined;
  s3UploadedAt?: string | undefined;
}

export type AwsFinalizationRuntimeState = FinalizationState & {
  stepFunctionsArn?: string;
  bundleMetadata?: AwsFinalizationLifecycleMetadata;
};

export function admitAwsPersistedFinalizationResultBranch(
  value: AwsPersistedFinalizationResult,
): FinalizationResultPersistence {
  return value as unknown as FinalizationResultPersistence;
}

export function admitAwsPersistedFinalizationStateBranch(
  value: AwsFinalizationRuntimeState | FinalizationState,
): FinalizationStatePersistence {
  return value as unknown as FinalizationStatePersistence;
}

export interface AwsParsedFinalizationStoragePayload {
  contractGeneration: string;
  finalizationResult: AwsPersistedFinalizationResult | null;
  finalizationState: AwsFinalizationRuntimeState | null;
  finalizationScenarioContext?: FinalizationScenarioContext | null;
}

export interface AwsParsedFinalizationStorageEnvelope {
  contractGeneration: string;
  hasFinalizationResult: boolean;
  hasFinalizationState: boolean;
  hasFinalizationScenarioContext: boolean;
}

const FINALIZATION_RESULT_DELIVERY_ENVELOPE_KEYS = new Set<string>([
  's3BundleKey',
  's3UploadedAt',
  'verificationExecutionId',
]);
const VERIFICATION_RESULT_ENVELOPE_KEYS = new Set<string>([
  'status',
  'report',
  'failureCategory',
  's3BundleKey',
  's3ReportKey',
  's3UploadedAt',
  'executionId',
  'verificationWorkQueuedAt',
  'devModeReceipt',
]);
const PROOF_BUNDLE_DELIVERY_METADATA_KEYS = new Set<string>([
  'executionId',
  's3BundleKey',
  's3ReportKey',
  's3UploadedAt',
]);
const VERIFICATION_DELIVERY_KEYS = [
  's3BundleKey',
  's3ReportKey',
  's3UploadedAt',
  'executionId',
  'verificationWorkQueuedAt',
  'devModeReceipt',
] as const;
const FINALIZATION_DELIVERY_KEYS = ['s3BundleKey', 's3UploadedAt', 'verificationExecutionId'] as const;
const FINALIZATION_STATE_RUNTIME_KEYS = new Set<string>(['stepFunctionsArn', 'bundleMetadata']);
const FINALIZATION_STATE_BUNDLE_METADATA_KEYS = new Set<string>(['s3BundleKey', 's3UploadedAt']);
const FINALIZATION_AUTHORITY_STATE_KEYS_BY_STATUS: Record<FinalizationState['status'], ReadonlySet<string>> = {
  pending: new Set(['status', 'executionId', 'queuedAt']),
  running: new Set(['status', 'executionId', 'queuedAt', 'startedAt']),
  succeeded: new Set(['status', 'executionId', 'queuedAt', 'startedAt', 'completedAt']),
  failed: new Set(['status', 'executionId', 'queuedAt', 'startedAt', 'failedAt', 'error']),
  timeout: new Set(['status', 'executionId', 'queuedAt', 'startedAt', 'timeoutAt']),
};
const FINALIZATION_STORAGE_PAYLOAD_KEYS = new Set<string>([
  'contractGeneration',
  'finalizationResult',
  'finalizationState',
  'finalizationScenarioContext',
]);

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function getAllowedRuntimeStateKeys(status: string | undefined): ReadonlySet<string> | undefined {
  const authorityKeys = status
    ? FINALIZATION_AUTHORITY_STATE_KEYS_BY_STATUS[status as FinalizationState['status']]
    : undefined;
  return authorityKeys ? new Set([...authorityKeys, ...FINALIZATION_STATE_RUNTIME_KEYS]) : undefined;
}

function assignOptionalOwnProperty<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value === undefined) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function omitUndefinedOwnProperties<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  const next = { ...value };
  for (const key of keys) {
    if (hasOwn(next, String(key)) && next[key] === undefined) {
      delete next[key];
    }
  }
  return next;
}

export function parseAwsPersistedVerificationResult(value: unknown): AwsPersistedVerificationResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!hasOnlyAllowedKeys(value, VERIFICATION_RESULT_ENVELOPE_KEYS)) {
    return undefined;
  }

  const verificationResult = parseVerificationResult(value);
  if (!verificationResult) {
    return undefined;
  }

  const s3BundleKey = getStringProperty(value, 's3BundleKey');
  const s3ReportKey = getStringProperty(value, 's3ReportKey');
  const s3UploadedAt = getStringProperty(value, 's3UploadedAt');
  const executionId = getStringProperty(value, 'executionId');
  const verificationWorkQueuedAt = getStringProperty(value, 'verificationWorkQueuedAt');
  const devModeReceipt = value['devModeReceipt'];
  if (
    (hasOwn(value, 's3BundleKey') && typeof s3BundleKey !== 'string') ||
    (hasOwn(value, 's3ReportKey') && typeof s3ReportKey !== 'string') ||
    (hasOwn(value, 's3UploadedAt') && typeof s3UploadedAt !== 'string') ||
    (hasOwn(value, 'executionId') && typeof executionId !== 'string') ||
    (hasOwn(value, 'verificationWorkQueuedAt') && typeof verificationWorkQueuedAt !== 'string') ||
    (hasOwn(value, 'devModeReceipt') && typeof devModeReceipt !== 'boolean')
  ) {
    return undefined;
  }

  return {
    ...verificationResult,
    ...(s3BundleKey !== undefined ? { s3BundleKey } : {}),
    ...(s3ReportKey !== undefined ? { s3ReportKey } : {}),
    ...(s3UploadedAt !== undefined ? { s3UploadedAt } : {}),
    ...(executionId !== undefined ? { executionId } : {}),
    ...(verificationWorkQueuedAt !== undefined ? { verificationWorkQueuedAt } : {}),
    ...(typeof devModeReceipt === 'boolean' ? { devModeReceipt } : {}),
  };
}

export function normalizeAwsPersistedVerificationResult(
  verificationResult: AwsPersistedVerificationResult,
): AwsPersistedVerificationResult {
  return omitUndefinedOwnProperties(verificationResult, VERIFICATION_DELIVERY_KEYS);
}

export function parseAwsPersistedFinalizationResult(value: unknown): AwsPersistedFinalizationResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const authorityCandidate = Object.fromEntries(
    Object.entries(value).filter(([key]) => !FINALIZATION_RESULT_DELIVERY_ENVELOPE_KEYS.has(key)),
  );
  const authority = parseFinalizationResultAuthority(authorityCandidate);
  if (!authority) {
    return undefined;
  }

  const s3BundleKey = getStringProperty(value, 's3BundleKey');
  const s3UploadedAt = getStringProperty(value, 's3UploadedAt');
  const verificationExecutionId = getStringProperty(value, 'verificationExecutionId');
  const persistedVerificationResult =
    value['verificationResult'] !== undefined
      ? parseAwsPersistedVerificationResult(value['verificationResult'])
      : undefined;
  if (
    (hasOwn(value, 's3BundleKey') && typeof s3BundleKey !== 'string') ||
    (hasOwn(value, 's3UploadedAt') && typeof s3UploadedAt !== 'string') ||
    (hasOwn(value, 'verificationExecutionId') && typeof verificationExecutionId !== 'string') ||
    (value['verificationResult'] !== undefined && !persistedVerificationResult)
  ) {
    return undefined;
  }

  return normalizeAwsPersistedFinalizationResult(
    omitUndefinedProperties({
      ...authority,
      s3BundleKey: s3BundleKey ?? persistedVerificationResult?.s3BundleKey,
      s3UploadedAt: s3UploadedAt ?? persistedVerificationResult?.s3UploadedAt,
      ...(persistedVerificationResult ? { verificationResult: persistedVerificationResult } : {}),
      verificationExecutionId: verificationExecutionId ?? persistedVerificationResult?.executionId,
    }),
  );
}

export function normalizeAwsPersistedFinalizationResult(
  result: AwsPersistedFinalizationResult,
): AwsPersistedFinalizationResult {
  const next = omitUndefinedOwnProperties(result, FINALIZATION_DELIVERY_KEYS);
  if (next.verificationResult) {
    next.verificationResult = normalizeAwsPersistedVerificationResult(next.verificationResult);
  } else if (hasOwn(next, 'verificationResult')) {
    delete next.verificationResult;
  }
  return next;
}

export function updateAwsFinalizationResultBundleMetadata(
  result: FinalizationResultAuthority | AwsPersistedFinalizationResult,
  bundleMetadata: AwsFinalizationLifecycleMetadata,
): AwsPersistedFinalizationResult {
  const nextResult: AwsPersistedFinalizationResult = { ...result };

  if (hasOwn(bundleMetadata, 's3BundleKey')) {
    assignOptionalOwnProperty(nextResult, 's3BundleKey', bundleMetadata.s3BundleKey);
  }
  if (hasOwn(bundleMetadata, 's3UploadedAt')) {
    assignOptionalOwnProperty(nextResult, 's3UploadedAt', bundleMetadata.s3UploadedAt);
  }

  const verificationResult = parseAwsPersistedVerificationResult(nextResult.verificationResult);
  if (verificationResult) {
    const nextVerificationResult = { ...verificationResult };
    if (hasOwn(bundleMetadata, 's3BundleKey')) {
      assignOptionalOwnProperty(nextVerificationResult, 's3BundleKey', bundleMetadata.s3BundleKey);
    }
    if (hasOwn(bundleMetadata, 's3UploadedAt')) {
      assignOptionalOwnProperty(nextVerificationResult, 's3UploadedAt', bundleMetadata.s3UploadedAt);
    }
    nextResult.verificationResult = normalizeAwsPersistedVerificationResult(nextVerificationResult);
  }

  return normalizeAwsPersistedFinalizationResult(nextResult);
}

export function updateAwsFinalizationResultVerificationState(
  result: FinalizationResultAuthority | AwsPersistedFinalizationResult,
  update: AwsFinalizationLifecycleMetadata & {
    verificationResult?: AwsPersistedVerificationResult | undefined;
    verificationExecutionId?: string | undefined;
  },
): AwsPersistedFinalizationResult {
  const nextResult = updateAwsFinalizationResultBundleMetadata(result, update);

  if (hasOwn(update, 'verificationResult')) {
    assignOptionalOwnProperty(
      nextResult,
      'verificationResult',
      update.verificationResult ? normalizeAwsPersistedVerificationResult(update.verificationResult) : undefined,
    );
  }
  if (hasOwn(update, 'verificationExecutionId')) {
    assignOptionalOwnProperty(nextResult, 'verificationExecutionId', update.verificationExecutionId);
  }

  return normalizeAwsPersistedFinalizationResult(nextResult);
}

function parseProofBundleDeliveryMetadata(
  value: unknown,
):
  | (Required<Pick<AwsVerificationDeliveryMetadata, 'executionId'>> &
      Pick<AwsVerificationDeliveryMetadata, 's3BundleKey' | 's3ReportKey' | 's3UploadedAt'>)
  | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, PROOF_BUNDLE_DELIVERY_METADATA_KEYS)) {
    return undefined;
  }

  const executionId = getStringProperty(value, 'executionId');
  const s3BundleKey = getStringProperty(value, 's3BundleKey');
  const s3ReportKey = getStringProperty(value, 's3ReportKey');
  const s3UploadedAt = getStringProperty(value, 's3UploadedAt');
  if (
    typeof executionId !== 'string' ||
    (hasOwn(value, 's3BundleKey') && typeof s3BundleKey !== 'string') ||
    (hasOwn(value, 's3ReportKey') && typeof s3ReportKey !== 'string') ||
    (hasOwn(value, 's3UploadedAt') && typeof s3UploadedAt !== 'string')
  ) {
    return undefined;
  }

  return {
    executionId,
    ...(s3BundleKey !== undefined ? { s3BundleKey } : {}),
    ...(s3ReportKey !== undefined ? { s3ReportKey } : {}),
    ...(s3UploadedAt !== undefined ? { s3UploadedAt } : {}),
  };
}

export function mergeAwsProofBundleDeliveryMetadata(
  result: FinalizationResultAuthority | AwsPersistedFinalizationResult,
  deliveryMetadata: unknown,
): AwsPersistedFinalizationResult | undefined {
  const persisted = parseAwsPersistedFinalizationResult(result);
  if (!persisted) {
    return undefined;
  }
  if (deliveryMetadata === undefined) {
    return persisted;
  }

  const metadata = parseProofBundleDeliveryMetadata(deliveryMetadata);
  if (!metadata) {
    return undefined;
  }

  const verificationResult = persisted.verificationResult
    ? normalizeAwsPersistedVerificationResult({
        ...persisted.verificationResult,
        executionId: metadata.executionId,
        ...(metadata.s3BundleKey ? { s3BundleKey: metadata.s3BundleKey } : {}),
        ...(metadata.s3ReportKey ? { s3ReportKey: metadata.s3ReportKey } : {}),
        ...(metadata.s3UploadedAt ? { s3UploadedAt: metadata.s3UploadedAt } : {}),
      })
    : undefined;

  return normalizeAwsPersistedFinalizationResult({
    ...persisted,
    ...omitUndefinedProperties({ verificationExecutionId: metadata.executionId }),
    ...(metadata.s3BundleKey ? { s3BundleKey: metadata.s3BundleKey } : {}),
    ...(metadata.s3UploadedAt ? { s3UploadedAt: metadata.s3UploadedAt } : {}),
    ...(verificationResult ? { verificationResult } : {}),
  });
}

export function buildAwsFinalizationDeliveryMetadata(
  verificationResult: AwsPersistedVerificationResult,
): AwsFinalizationDeliveryMetadata {
  return {
    ...(verificationResult.s3BundleKey ? { s3BundleKey: verificationResult.s3BundleKey } : {}),
    ...(verificationResult.s3UploadedAt ? { s3UploadedAt: verificationResult.s3UploadedAt } : {}),
    verificationResult,
    ...omitUndefinedProperties({ verificationExecutionId: verificationResult.executionId }),
  };
}

export function resolveAwsVerificationBundleKey(
  verificationResult: AwsPersistedVerificationResult | undefined,
): string | undefined {
  return verificationResult?.s3BundleKey;
}

export function resolveAwsVerificationUploadTimestamp(
  verificationResult: AwsPersistedVerificationResult | undefined,
): string | undefined {
  return verificationResult?.s3UploadedAt;
}

function parseBundleMetadata(value: unknown): AwsFinalizationLifecycleMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!hasOnlyAllowedKeys(value, FINALIZATION_STATE_BUNDLE_METADATA_KEYS)) {
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

export function parseAwsFinalizationRuntimeState(value: unknown): AwsFinalizationRuntimeState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = getStringProperty(value, 'status');
  const allowedRuntimeKeys = getAllowedRuntimeStateKeys(status);
  if (!allowedRuntimeKeys || !hasOnlyAllowedKeys(value, allowedRuntimeKeys)) {
    return undefined;
  }

  const authorityCandidate = Object.fromEntries(
    Object.entries(value).filter(([key]) => !FINALIZATION_STATE_RUNTIME_KEYS.has(key)),
  );
  const state = parseFinalizationState(authorityCandidate);
  if (!state) {
    return undefined;
  }

  const stepFunctionsArn = getStringProperty(value, 'stepFunctionsArn');
  if (hasOwn(value, 'stepFunctionsArn') && typeof stepFunctionsArn !== 'string') {
    return undefined;
  }

  const bundleMetadata = getRecordProperty(value, 'bundleMetadata');
  if (hasOwn(value, 'bundleMetadata') && !bundleMetadata) {
    return undefined;
  }
  const parsedBundleMetadata = bundleMetadata ? parseBundleMetadata(bundleMetadata) : undefined;
  if (bundleMetadata && !parsedBundleMetadata) {
    return undefined;
  }

  return {
    ...state,
    ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    ...(parsedBundleMetadata && Object.keys(parsedBundleMetadata).length > 0
      ? { bundleMetadata: parsedBundleMetadata }
      : {}),
  };
}

export function parseAwsFinalizationStorageEnvelope(value: unknown): AwsParsedFinalizationStorageEnvelope | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!hasOnlyAllowedKeys(value, FINALIZATION_STORAGE_PAYLOAD_KEYS)) {
    return undefined;
  }

  const hasFinalizationResult = hasOwn(value, 'finalizationResult');
  const hasFinalizationState = hasOwn(value, 'finalizationState');
  const hasFinalizationScenarioContext = hasOwn(value, 'finalizationScenarioContext');
  if (!hasFinalizationResult && !hasFinalizationState && !hasFinalizationScenarioContext) {
    return undefined;
  }

  const contractGeneration = getStringProperty(value, 'contractGeneration');
  if (typeof contractGeneration !== 'string' || contractGeneration.trim().length === 0) {
    return undefined;
  }

  return {
    contractGeneration,
    hasFinalizationResult,
    hasFinalizationState,
    hasFinalizationScenarioContext,
  };
}

export function parseAwsFinalizationStoragePayload(value: unknown): AwsParsedFinalizationStoragePayload | undefined {
  const envelope = parseAwsFinalizationStorageEnvelope(value);
  if (!envelope || !isRecord(value)) {
    return undefined;
  }

  const rawResult = value['finalizationResult'];
  const rawState = value['finalizationState'];
  const rawScenarioContext = value['finalizationScenarioContext'];
  const parsedResult = rawResult == null ? null : parseAwsPersistedFinalizationResult(rawResult);
  const parsedState = rawState == null ? null : parseAwsFinalizationRuntimeState(rawState);
  const parsedScenarioContext =
    rawScenarioContext == null ? null : parseFinalizationScenarioContext(rawScenarioContext);

  if (rawResult !== null && rawResult !== undefined && !parsedResult) {
    return undefined;
  }
  if (rawState !== null && rawState !== undefined && !parsedState) {
    return undefined;
  }
  if (
    hasOwn(value, 'finalizationScenarioContext') &&
    rawScenarioContext !== null &&
    rawScenarioContext !== undefined &&
    !parsedScenarioContext
  ) {
    return undefined;
  }

  return {
    contractGeneration: envelope.contractGeneration,
    finalizationResult: rawResult == null ? null : (parsedResult ?? null),
    finalizationState: rawState == null ? null : (parsedState ?? null),
    ...(hasOwn(value, 'finalizationScenarioContext')
      ? omitUndefinedProperties({ finalizationScenarioContext: parsedScenarioContext })
      : {}),
  };
}
