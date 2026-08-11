import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { applyAwsFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/applyFinalizationStateUpdate';
import { parseFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import {
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
  isRecord,
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
  if (!isRecord(rawEvent)) {
    return undefined;
  }
  const candidate = getRecordProperty(rawEvent, 'payload') ?? rawEvent;
  const sessionId = getStringProperty(candidate, 'sessionId');
  const finalizationId = getStringProperty(candidate, 'finalizationId');
  if (
    !sessionId ||
    !finalizationId ||
    finalizationId.length > 128 ||
    !isSafeVerifierSegment(sessionId) ||
    !isSafeVerifierSegment(finalizationId)
  ) {
    return undefined;
  }
  return { sessionId, finalizationId };
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
  const bundleMetadata = getRecordProperty(payload, 'bundleMetadata');
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
  if (!isRecord(result)) {
    return undefined;
  }
  return resolveEpochMillis(getNumberProperty(result, field) ?? getStringProperty(result, field));
}

function projectFinalizationStateUpdatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const common = {
    sessionId: payload['sessionId'],
    finalizationId: payload['finalizationId'],
    status: payload['status'],
    queuedAtMs: payload['queuedAtMs'],
    ...(payload['stepFunctionsArn'] !== undefined ? { stepFunctionsArn: payload['stepFunctionsArn'] } : {}),
  };
  switch (payload['status']) {
    case 'RUNNING':
      return {
        ...common,
        ...(payload['startedAtMs'] !== undefined ? { startedAtMs: payload['startedAtMs'] } : {}),
      };
    case 'SUCCEEDED':
      return {
        ...common,
        ...(payload['startedAtMs'] !== undefined ? { startedAtMs: payload['startedAtMs'] } : {}),
        ...(payload['completedAtMs'] !== undefined ? { completedAtMs: payload['completedAtMs'] } : {}),
        ...(payload['bundleMetadata'] !== undefined ? { bundleMetadata: payload['bundleMetadata'] } : {}),
        ...(payload['finalizationResult'] !== undefined ? { finalizationResult: payload['finalizationResult'] } : {}),
      };
    case 'FAILED':
      return {
        ...common,
        ...(payload['startedAtMs'] !== undefined ? { startedAtMs: payload['startedAtMs'] } : {}),
        ...(payload['failedAtMs'] !== undefined ? { failedAtMs: payload['failedAtMs'] } : {}),
        ...(payload['error'] !== undefined ? { error: payload['error'] } : {}),
      };
    case 'TIMED_OUT':
      return {
        ...common,
        ...(payload['startedAtMs'] !== undefined ? { startedAtMs: payload['startedAtMs'] } : {}),
        ...(payload['timeoutAtMs'] !== undefined ? { timeoutAtMs: payload['timeoutAtMs'] } : {}),
      };
    default:
      return common;
  }
}

function resolveStartedAtMs(rawEvent: Record<string, unknown>, payload: Record<string, unknown>): number | undefined {
  const direct = getNumberProperty(rawEvent, 'startedAtMs') ?? getNumberProperty(payload, 'startedAtMs');
  if (direct !== undefined) {
    return direct;
  }
  const markStarted = getRecordProperty(payload, 'markStarted');
  const callbackPayload = markStarted ? getRecordProperty(markStarted, 'Payload') : undefined;
  const state = callbackPayload ? getRecordProperty(callbackPayload, 'state') : undefined;
  return state ? getNumberProperty(state, 'startedAtMs') : undefined;
}

async function normalizeDirectEvent(profile: ResolvedRuntimeProfile, rawEvent: unknown): Promise<unknown> {
  if (!isRecord(rawEvent)) {
    return rawEvent;
  }

  const payload = getRecordProperty(rawEvent, 'payload');
  const status = getStringProperty(rawEvent, 'status');
  if (!payload || (status !== 'RUNNING' && status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'TIMED_OUT')) {
    return rawEvent;
  }

  const directPayload: Record<string, unknown> = {
    ...payload,
    status,
  };
  applyExecutionArn(directPayload, rawEvent);
  const startedAtMs = resolveStartedAtMs(rawEvent, directPayload);
  if (startedAtMs !== undefined) {
    directPayload['startedAtMs'] = startedAtMs;
  }

  if (status === 'RUNNING') {
    const startedAtIso = getStringProperty(rawEvent, 'startedAtIso');
    const resolvedStartedAtMs = startedAtMs ?? resolveEpochMillis(startedAtIso);
    if (resolvedStartedAtMs !== undefined) {
      directPayload['startedAtMs'] = resolvedStartedAtMs;
    }
    return projectFinalizationStateUpdatePayload(directPayload);
  }

  if (status === 'TIMED_OUT') {
    delete directPayload['error'];
    const timeoutAtMs = getNumberProperty(rawEvent, 'timeoutAtMs');
    const timeoutAtIso = getStringProperty(rawEvent, 'timeoutAtIso');
    const resolvedTimeoutAtMs = timeoutAtMs ?? resolveEpochMillis(timeoutAtIso);
    if (resolvedTimeoutAtMs !== undefined) {
      directPayload['timeoutAtMs'] = resolvedTimeoutAtMs;
    }
  }

  const error = status === 'FAILED' ? getRecordProperty(rawEvent, 'error') : undefined;
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

  if (status === 'FAILED') {
    const failedAtMs = getNumberProperty(rawEvent, 'failedAtMs');
    const failedAtIso = getStringProperty(rawEvent, 'failedAtIso');
    const resolvedFailedAtMs = failedAtMs ?? resolveEpochMillis(failedAtIso);
    if (resolvedFailedAtMs !== undefined) {
      directPayload['failedAtMs'] = resolvedFailedAtMs;
    }
  }

  if (status === 'SUCCEEDED') {
    const completedAtMs =
      getNumberProperty(rawEvent, 'completedAtMs') ??
      resolveEpochMillis(getStringProperty(rawEvent, 'completedAtIso')) ??
      resolveTimestampFromProverResult(
        rawEvent['proverResult'] ?? directPayload['proverResult'],
        'ExecutionStoppedAt',
      ) ??
      resolveTimestampFromProverResult(rawEvent['proverResult'] ?? directPayload['proverResult'], 'StoppedAt');
    if (completedAtMs !== undefined) {
      directPayload['completedAtMs'] = completedAtMs;
    }
  }

  if (status === 'SUCCEEDED' && !getRecordProperty(directPayload, 'finalizationResult')) {
    const completedAtMs = getNumberProperty(directPayload, 'completedAtMs');
    const bundleS3Key = resolveBundleS3Key(profile, directPayload);
    if (!bundleS3Key) {
      return projectFinalizationStateUpdatePayload({
        ...directPayload,
        status: 'FAILED',
        ...(completedAtMs !== undefined ? { failedAtMs: completedAtMs } : {}),
        error: {
          code: 'FINALIZATION_BUNDLE_KEY_MISSING',
          message: 'Target finalization succeeded without a durable bundle key',
        },
      });
    }

    const finalizationId = getStringProperty(directPayload, 'finalizationId');
    if (!finalizationId) {
      return projectFinalizationStateUpdatePayload({
        ...directPayload,
        status: 'FAILED',
        ...(completedAtMs !== undefined ? { failedAtMs: completedAtMs } : {}),
        error: {
          code: 'FINALIZATION_BUNDLE_KEY_MISSING',
          message: 'Target finalization succeeded without finalization identity',
        },
      });
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
          ...(isRecord(directPayload['bundleMetadata']) ? directPayload['bundleMetadata'] : {}),
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

  return projectFinalizationStateUpdatePayload(directPayload);
}

export const handler = async (rawEvent: unknown): Promise<DirectCallbackResponse> => {
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

  let normalizedEvent: unknown;
  try {
    normalizedEvent = await normalizeDirectEvent(runtimeProfile, rawEvent);
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
