import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import { reconcileAwsFinalizations } from '@stark-ballot/aws-adapters/finalize/reconcileFinalizations';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { applyAwsFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/applyFinalizationStateUpdate';
import { parseFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import {
  getNumberProperty,
  getObjectProperty,
  getStringProperty,
  isNonNullObject,
} from '@stark-ballot/validation/unknown-value-guards';
import {
  buildFinalizationResultFromS3Bundle,
  readAsyncProverFailureCategory,
  validateAsyncProverBundleKey,
} from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { isTransientBundleRestoreError } from '@stark-ballot/aws-adapters/aws/bundle-restore';
import { assertSafeVerifierSegment, isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import {
  resolveRuntimeProfile,
  type ResolvedRuntimeProfile,
  validateRuntimeProfileSelection,
} from '@stark-ballot/runtime-config/env/runtimeProfile';
import { logger } from '@stark-ballot/diagnostics/logger';
import { emitCanonicalEvent, type FinalizationUpdateOutcome } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { parseSessionId } from '@stark-ballot/domain/types/identifiers';
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import { RuntimeConfigValidationError, bootstrapLambdaRuntime } from '../runtimeBootstrap.js';

type DirectCallbackResponse = {
  status: 'success';
  sessionId: string;
  state: Awaited<ReturnType<typeof applyAwsFinalizationStateUpdatePayload>>['state'];
};

type AdmittedFinalizationUpdate = NonNullable<ReturnType<typeof parseFinalizationStateUpdatePayload>>;
type FinalizationUpdateCorrelation = Pick<AdmittedFinalizationUpdate, 'sessionId' | 'finalizationId'>;
let resolvedRuntimeProfile: ResolvedRuntimeProfile | undefined;

function emitDirectUpdateReceived(
  outcome: FinalizationUpdateOutcome,
  correlation?: FinalizationUpdateCorrelation,
): void {
  emitCanonicalEvent({
    event: 'finalization_update_received',
    transport: 'direct_writer',
    auth_result: 'not_applicable',
    outcome_code: outcome,
    ...(correlation
      ? {
          session_id_hash: hashSessionIdForLogging(correlation.sessionId),
          finalization_id: correlation.finalizationId,
        }
      : {}),
  });
}

function resolveSafeDirectUpdateCorrelation(rawEvent: unknown): FinalizationUpdateCorrelation | undefined {
  if (!isNonNullObject(rawEvent)) {
    return undefined;
  }
  const candidate = getObjectProperty(rawEvent, 'payload') ?? rawEvent;
  const sessionId = getStringProperty(candidate, 'sessionId');
  const finalizationId = getStringProperty(candidate, 'finalizationId');
  const admittedSessionId = parseSessionId(sessionId);
  const admittedFinalizationId = parseFinalizationId(finalizationId);
  if (
    !admittedSessionId ||
    !admittedFinalizationId ||
    admittedFinalizationId.length > 128 ||
    !isSafeVerifierSegment(admittedSessionId) ||
    !isSafeVerifierSegment(admittedFinalizationId)
  ) {
    return undefined;
  }
  return { sessionId: admittedSessionId, finalizationId: admittedFinalizationId };
}

function classifyDirectUpdateFailure(error: unknown): FinalizationUpdateOutcome {
  if (error instanceof Error) {
    if (
      error.message === 'Running handler unavailable' ||
      error.message === 'Success handler unavailable' ||
      error.message === 'Failure handler unavailable' ||
      error.message === 'Timeout handler unavailable'
    ) {
      return 'handler_unavailable';
    }
    if (error.message === 'Canonical finalization result required') {
      return 'canonical_result_missing';
    }
  }
  return 'application_failed';
}

function validateFinalizationWriterConfig(profile: ResolvedRuntimeProfile): void {
  if (profile.name !== 'target-aws-async') {
    throw new RuntimeConfigValidationError(
      ['RUNTIME_PROFILE'],
      undefined,
      'RUNTIME_PROFILE=target-aws-async is required for finalization writer execution',
    );
  }
}

function applyExecutionArn(
  payload: Record<string, unknown>,
  rawEvent: Record<string, unknown>,
): Record<string, unknown> {
  const executionArn = getStringProperty(rawEvent, 'executionArn');
  if (executionArn) {
    payload['stepFunctionsArn'] = executionArn;
  }
  return payload;
}

function resolveBundleS3Key(profile: ResolvedRuntimeProfile, payload: Record<string, unknown>): string | undefined {
  const sessionId = getStringProperty(payload, 'sessionId');
  const finalizationId = getStringProperty(payload, 'finalizationId');
  if (!sessionId || !finalizationId) {
    return undefined;
  }
  assertSafeVerifierSegment(sessionId, 'sessionId');
  assertSafeVerifierSegment(finalizationId, 'finalizationId');

  const directKey = getStringProperty(payload, 'bundleS3Key');
  if (directKey) {
    return validateAsyncProverBundleKey(profile, sessionId, finalizationId, directKey);
  }
  const bundleMetadata = getObjectProperty(payload, 'bundleMetadata');
  const metadataKey = bundleMetadata ? getStringProperty(bundleMetadata, 's3BundleKey') : undefined;
  if (metadataKey) {
    return validateAsyncProverBundleKey(profile, sessionId, finalizationId, metadataKey);
  }
  return undefined;
}

function resolveEpochMillis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 10_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function resolveTimestampFromProverResult(result: unknown, field: string): number | undefined {
  if (!isNonNullObject(result)) {
    return undefined;
  }
  return resolveEpochMillis(getNumberProperty(result, field) ?? getStringProperty(result, field));
}

const DIRECT_UPDATE_FIELDS: ReadonlyMap<unknown, readonly string[]> = new Map([
  ['RUNNING', ['startedAtMs']],
  ['SUCCEEDED', ['startedAtMs', 'completedAtMs', 'bundleMetadata', 'finalizationResult']],
  ['FAILED', ['startedAtMs', 'failedAtMs', 'error']],
  ['TIMED_OUT', ['startedAtMs', 'timeoutAtMs']],
]);

function presentUpdateFields(payload: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (payload[field] !== undefined) projected[field] = payload[field];
  }
  return projected;
}

function projectFinalizationStateUpdatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const common = {
    sessionId: payload['sessionId'],
    finalizationId: payload['finalizationId'],
    status: payload['status'],
    queuedAtMs: payload['queuedAtMs'],
    ...(payload['stepFunctionsArn'] !== undefined ? { stepFunctionsArn: payload['stepFunctionsArn'] } : {}),
  };
  const fields = DIRECT_UPDATE_FIELDS.get(payload['status']);
  return fields === undefined ? common : { ...common, ...presentUpdateFields(payload, fields) };
}

async function normalizeFailedEventError(
  profile: ResolvedRuntimeProfile,
  rawEvent: Record<string, unknown>,
  directPayload: Record<string, unknown>,
): Promise<void> {
  const error = getObjectProperty(rawEvent, 'error');
  if (error !== undefined) {
    const sessionId = getStringProperty(directPayload, 'sessionId');
    const finalizationId = getStringProperty(directPayload, 'finalizationId');
    const failureCode = getStringProperty(error, 'code') ?? getStringProperty(error, 'Error');
    if (failureCode) {
      const proverFailureCategory =
        failureCode === 'PROVER_TASK_FAILED' && sessionId && finalizationId
          ? await readAsyncProverFailureCategory(profile, sessionId, finalizationId)
          : undefined;
      directPayload['error'] = {
        code: failureCode,
        message: proverFailureCategory ? 'Target prover task failed' : 'Finalization failed',
        ...(proverFailureCategory ? { category: proverFailureCategory } : {}),
      };
    } else {
      delete directPayload['error'];
    }
  }
}

function missingBundleIdentityPayload(
  directPayload: Record<string, unknown>,
  completedAtMs: number | undefined,
  message: string,
): Record<string, unknown> {
  return projectFinalizationStateUpdatePayload({
    ...directPayload,
    status: 'FAILED',
    ...(completedAtMs !== undefined ? { failedAtMs: completedAtMs } : {}),
    error: { code: 'FINALIZATION_BUNDLE_KEY_MISSING', message },
  });
}

async function restoreSucceededEventBundle(
  profile: ResolvedRuntimeProfile,
  directPayload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const completedAtMs = getNumberProperty(directPayload, 'completedAtMs');
  const bundleS3Key = resolveBundleS3Key(profile, directPayload);
  if (!bundleS3Key) {
    return missingBundleIdentityPayload(
      directPayload,
      completedAtMs,
      'Target finalization succeeded without a durable bundle key',
    );
  }

  const finalizationId = getStringProperty(directPayload, 'finalizationId');
  if (!finalizationId) {
    return missingBundleIdentityPayload(
      directPayload,
      completedAtMs,
      'Target finalization succeeded without finalization identity',
    );
  }

  try {
    if (completedAtMs === undefined) {
      return projectFinalizationStateUpdatePayload(directPayload);
    }
    const s3UploadedAtMs = resolveEpochMillis(directPayload['s3UploadedAtMs']) ?? completedAtMs;
    const finalizationResult = await buildFinalizationResultFromS3Bundle({
      profile,
      bundleS3Key,
      finalizationId,
      finalizedAtMs: completedAtMs,
    });
    return projectFinalizationStateUpdatePayload({
      ...directPayload,
      completedAtMs,
      finalizationResult,
      bundleMetadata: {
        ...(isNonNullObject(directPayload['bundleMetadata']) ? directPayload['bundleMetadata'] : {}),
        s3BundleKey: bundleS3Key,
        s3UploadedAtMs,
      },
    });
  } catch (error) {
    if (isTransientBundleRestoreError(error)) {
      throw error;
    }
    return projectFinalizationStateUpdatePayload({
      ...directPayload,
      status: 'FAILED',
      failedAtMs: completedAtMs,
      error: {
        code: 'FINALIZATION_BUNDLE_RESTORE_FAILED',
        message: 'Target finalization bundle could not be restored',
      },
    });
  }
}

function applyDirectStartedAt(
  rawEvent: Record<string, unknown>,
  directPayload: Record<string, unknown>,
): number | undefined {
  const startedAtMs = getNumberProperty(rawEvent, 'startedAtMs') ?? getNumberProperty(directPayload, 'startedAtMs');
  if (startedAtMs !== undefined) {
    directPayload['startedAtMs'] = startedAtMs;
  }

  return startedAtMs;
}

function normalizeRunningEvent(
  rawEvent: Record<string, unknown>,
  directPayload: Record<string, unknown>,
  startedAtMs: number | undefined,
): Record<string, unknown> {
  const startedAtIso = getStringProperty(rawEvent, 'startedAtIso');
  const resolvedStartedAtMs = startedAtMs ?? resolveEpochMillis(startedAtIso);
  if (resolvedStartedAtMs !== undefined) {
    directPayload['startedAtMs'] = resolvedStartedAtMs;
  }
  return projectFinalizationStateUpdatePayload(directPayload);
}

function applyDirectTerminalTimestamp(
  rawEvent: Record<string, unknown>,
  directPayload: Record<string, unknown>,
  field: string,
  isoField: string,
): void {
  const timestamp = getNumberProperty(rawEvent, field);
  const timestampIso = getStringProperty(rawEvent, isoField);
  const resolvedTimestamp = timestamp ?? resolveEpochMillis(timestampIso);
  if (resolvedTimestamp !== undefined) directPayload[field] = resolvedTimestamp;
}

async function normalizeSucceededEvent(
  profile: ResolvedRuntimeProfile,
  rawEvent: Record<string, unknown>,
  directPayload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const completedAtMs =
    getNumberProperty(rawEvent, 'completedAtMs') ??
    resolveEpochMillis(getStringProperty(rawEvent, 'completedAtIso')) ??
    resolveTimestampFromProverResult(rawEvent['proverResult'] ?? directPayload['proverResult'], 'ExecutionStoppedAt') ??
    resolveTimestampFromProverResult(rawEvent['proverResult'] ?? directPayload['proverResult'], 'StoppedAt');
  if (completedAtMs !== undefined) {
    directPayload['completedAtMs'] = completedAtMs;
  }

  if (!getObjectProperty(directPayload, 'finalizationResult')) {
    return restoreSucceededEventBundle(profile, directPayload);
  }

  return projectFinalizationStateUpdatePayload(directPayload);
}

function isDirectUpdateStatus(status: string | undefined): boolean {
  return status === 'RUNNING' || status === 'SUCCEEDED' || status === 'FAILED' || status === 'TIMED_OUT';
}

async function normalizeDirectEvent(profile: ResolvedRuntimeProfile, rawEvent: unknown): Promise<unknown> {
  if (!isNonNullObject(rawEvent)) {
    return rawEvent;
  }

  const payload = getObjectProperty(rawEvent, 'payload');
  const status = getStringProperty(rawEvent, 'status');
  if (!payload || !isDirectUpdateStatus(status)) {
    return rawEvent;
  }

  const directPayload: Record<string, unknown> = {
    ...payload,
    status,
  };
  applyExecutionArn(directPayload, rawEvent);
  const startedAtMs = applyDirectStartedAt(rawEvent, directPayload);

  if (status === 'RUNNING') {
    return normalizeRunningEvent(rawEvent, directPayload, startedAtMs);
  }

  if (status === 'TIMED_OUT') {
    delete directPayload['error'];
    applyDirectTerminalTimestamp(rawEvent, directPayload, 'timeoutAtMs', 'timeoutAtIso');
  }

  if (status === 'FAILED') {
    await normalizeFailedEventError(profile, rawEvent, directPayload);
    applyDirectTerminalTimestamp(rawEvent, directPayload, 'failedAtMs', 'failedAtIso');
  }

  if (status === 'SUCCEEDED') {
    return normalizeSucceededEvent(profile, rawEvent, directPayload);
  }

  return projectFinalizationStateUpdatePayload(directPayload);
}

function admittedStartedAt(
  record: FinalizationRecord | null,
  correlation: FinalizationUpdateCorrelation,
  queuedAtMs: unknown,
): number {
  if (
    !record ||
    record.sessionId !== correlation.sessionId ||
    record.finalizationId !== correlation.finalizationId ||
    record.state.finalizationId !== correlation.finalizationId ||
    record.state.queuedAtMs !== queuedAtMs ||
    (record.state.status !== 'running' && record.state.status !== 'succeeded')
  ) {
    throw new Error('Invalid direct finalize callback event');
  }
  return record.state.startedAtMs;
}

async function bindAdmittedStartedAt(
  runtimeProfile: ResolvedRuntimeProfile,
  normalizedEvent: unknown,
): Promise<unknown> {
  if (isNonNullObject(normalizedEvent) && normalizedEvent['status'] === 'SUCCEEDED') {
    const sessionId = parseSessionId(normalizedEvent['sessionId']);
    const finalizationId = parseFinalizationId(normalizedEvent['finalizationId']);
    if (!sessionId || !finalizationId) {
      throw new Error('Invalid direct finalize callback event');
    }
    // Container admission owns the start time; the Step Functions input never receives it.
    const record = await getGlobalStore(runtimeProfile).getFinalizationRecord(sessionId, finalizationId);
    const startedAtMs = admittedStartedAt(record, { sessionId, finalizationId }, normalizedEvent['queuedAtMs']);
    return { ...normalizedEvent, startedAtMs };
  }
  return normalizedEvent;
}

async function prepareDirectCallbackEvent(runtimeProfile: ResolvedRuntimeProfile, rawEvent: unknown): Promise<unknown> {
  try {
    const normalizedEvent = await normalizeDirectEvent(runtimeProfile, rawEvent);
    return await bindAdmittedStartedAt(runtimeProfile, normalizedEvent);
  } catch (error) {
    if (isTransientBundleRestoreError(error)) {
      logger.warn('Finalization bundle restoration is temporarily unavailable', {
        event: 'finalization_bundle_restore_deferred',
        source_kind: 'step_functions',
      });
      emitDirectUpdateReceived('application_failed', resolveSafeDirectUpdateCorrelation(rawEvent));
      throw error;
    }
    logger.warn('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'step_functions',
      reason: 'payload_invalid',
    });
    emitDirectUpdateReceived('payload_invalid', resolveSafeDirectUpdateCorrelation(rawEvent));
    throw error;
  }
}

export const handler = async (rawEvent: unknown): Promise<DirectCallbackResponse | { visited: number }> => {
  const env = process.env;
  const runtimeProfile = (resolvedRuntimeProfile ??= resolveRuntimeProfile(env));
  await bootstrapLambdaRuntime({
    serviceName: 'finalization-writer',
    runtimeProfile,
    resolveRuntimeReferences: async (invalidNameCollector) => {
      await ensureAwsRuntimeConfigReferencesLoaded('finalization_writer', {
        profile: runtimeProfile,
        invalidNameCollector,
        env,
      });
    },
    validationSteps: [
      {
        validate: () => validateRuntimeProfileSelection(runtimeProfile, env),
      },
      {
        validate: () => validateTargetObservabilityEnv(runtimeProfile, env),
      },
      {
        validate: () => validateFinalizationWriterConfig(runtimeProfile),
      },
      {
        validate: () => validateEnv(runtimeProfile, env),
      },
    ],
    env,
  });

  if (runtimeProfile.name !== 'target-aws-async') {
    throw new Error('Target finalization-writer runtime profile was not resolved');
  }

  if (
    isNonNullObject(rawEvent) &&
    rawEvent['operation'] === 'reconcile-finalizations' &&
    Object.keys(rawEvent).length === 1
  ) {
    return reconcileAwsFinalizations(runtimeProfile, getGlobalStore(runtimeProfile));
  }

  const normalizedEvent = await prepareDirectCallbackEvent(runtimeProfile, rawEvent);

  let payload: ReturnType<typeof parseFinalizationStateUpdatePayload>;
  try {
    payload = parseFinalizationStateUpdatePayload(normalizedEvent);
  } catch {
    logger.warn('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'step_functions',
      reason: 'payload_invalid',
    });
    emitDirectUpdateReceived('payload_invalid', resolveSafeDirectUpdateCorrelation(normalizedEvent));
    throw new Error('Invalid direct finalize callback event');
  }
  if (!payload) {
    logger.warn('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'step_functions',
      reason: 'payload_invalid',
    });
    emitDirectUpdateReceived('payload_invalid', resolveSafeDirectUpdateCorrelation(normalizedEvent));
    throw new Error('Invalid direct finalize callback event');
  }

  try {
    const result = await applyAwsFinalizationStateUpdatePayload({
      payload,
      store: getGlobalStore(runtimeProfile),
    });

    emitDirectUpdateReceived('applied', payload);

    return {
      status: 'success',
      sessionId: result.sessionId,
      state: result.state,
    };
  } catch (error) {
    emitDirectUpdateReceived(classifyDirectUpdateFailure(error), payload);
    throw error;
  }
};
