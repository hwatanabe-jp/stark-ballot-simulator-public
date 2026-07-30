import { isCurrentArtifactBoundaryError } from '@stark-ballot/domain/contract';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { applyAwsFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/applyFinalizationStateUpdate';
import { parseFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '@stark-ballot/domain/utils/guards';
import {
  buildAsyncProverArtifactKeys,
  buildFinalizationResultFromS3Bundle,
  readAsyncProverFailureCategory,
  validateAsyncProverBundleKey,
} from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { isTransientBundleRestoreError } from '@stark-ballot/aws-adapters/aws/bundle-restore';
import { assertSafeVerifierSegment, isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { logger } from '@stark-ballot/diagnostics/logger';
import { emitCanonicalEvent, type FinalizationUpdateOutcome } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { RuntimeConfigValidationError, bootstrapLambdaRuntime, type RuntimeConfigName } from '../runtimeBootstrap.js';

type DirectCallbackResponse = {
  status: 'success';
  sessionId: string;
  state: Awaited<ReturnType<typeof applyAwsFinalizationStateUpdatePayload>>['state'];
};

type AdmittedFinalizationUpdate = NonNullable<ReturnType<typeof parseFinalizationStateUpdatePayload>>;
type FinalizationUpdateCorrelation = Pick<AdmittedFinalizationUpdate, 'sessionId' | 'executionId'>;

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
          execution_id: correlation.executionId,
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
  const executionId = getStringProperty(candidate, 'executionId');
  if (
    !sessionId ||
    !executionId ||
    executionId.length > 128 ||
    !isSafeVerifierSegment(sessionId) ||
    !isSafeVerifierSegment(executionId)
  ) {
    return undefined;
  }
  return { sessionId, executionId };
}

function classifyDirectUpdateFailure(error: unknown): FinalizationUpdateOutcome {
  if (isCurrentArtifactBoundaryError(error)) {
    return 'artifact_rejected';
  }
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

function validateFinalizationWriterConfig(): void {
  const invalidNames: RuntimeConfigName[] = [];
  const requireValue = (name: RuntimeConfigName): string | undefined => {
    const value = process.env[name]?.trim();
    if (!value) invalidNames.push(name);
    return value;
  };

  if (process.env['TARGET_AWS_RUNTIME'] !== '1') invalidNames.push('TARGET_AWS_RUNTIME');
  if (process.env['USE_MOCK_STORE'] !== 'false') invalidNames.push('USE_MOCK_STORE');
  if (process.env['USE_S3'] !== 'true') invalidNames.push('USE_S3');
  const accountId = requireValue('AWS_ACCOUNT_ID');
  if (accountId && !/^[0-9]{12}$/.test(accountId)) invalidNames.push('AWS_ACCOUNT_ID');
  if (!process.env['AWS_REGION']?.trim() && !process.env['AWS_DEFAULT_REGION']?.trim()) {
    invalidNames.push('AWS_REGION');
  }
  requireValue('DYNAMODB_SESSIONS_TABLE');
  requireValue('DYNAMODB_VOTES_TABLE');
  requireValue('S3_PROOF_BUCKET');
  requireValue('S3_PROOF_PREFIX');

  if (invalidNames.length > 0) {
    throw new RuntimeConfigValidationError(
      invalidNames,
      undefined,
      'Finalization writer runtime configuration is invalid',
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

function resolveBundleS3Key(payload: Record<string, unknown>): string | undefined {
  const sessionId = getStringProperty(payload, 'sessionId');
  const executionId = getStringProperty(payload, 'executionId');
  if (!sessionId || !executionId) {
    return undefined;
  }
  assertSafeVerifierSegment(sessionId, 'sessionId');
  assertSafeVerifierSegment(executionId, 'executionId');

  const directKey = getStringProperty(payload, 'bundleS3Key');
  if (directKey) {
    return validateAsyncProverBundleKey(sessionId, executionId, directKey);
  }
  const bundleMetadata = getRecordProperty(payload, 'bundleMetadata');
  const metadataKey = bundleMetadata ? getStringProperty(bundleMetadata, 's3BundleKey') : undefined;
  if (metadataKey) {
    return validateAsyncProverBundleKey(sessionId, executionId, metadataKey);
  }
  return buildAsyncProverArtifactKeys(sessionId, executionId).bundleS3Key;
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
  return {
    sessionId: payload['sessionId'],
    executionId: payload['executionId'],
    contractGeneration: payload['contractGeneration'],
    status: payload['status'],
    queuedAt: payload['queuedAt'],
    ...(payload['startedAt'] !== undefined ? { startedAt: payload['startedAt'] } : {}),
    ...(payload['completedAt'] !== undefined ? { completedAt: payload['completedAt'] } : {}),
    ...(payload['failedAt'] !== undefined ? { failedAt: payload['failedAt'] } : {}),
    ...(payload['timeoutAt'] !== undefined ? { timeoutAt: payload['timeoutAt'] } : {}),
    ...(payload['bundleMetadata'] !== undefined ? { bundleMetadata: payload['bundleMetadata'] } : {}),
    ...(payload['error'] !== undefined ? { error: payload['error'] } : {}),
    ...(payload['finalizationResult'] !== undefined ? { finalizationResult: payload['finalizationResult'] } : {}),
    ...(payload['stepFunctionsArn'] !== undefined ? { stepFunctionsArn: payload['stepFunctionsArn'] } : {}),
  };
}

async function normalizeDirectEvent(rawEvent: unknown): Promise<unknown> {
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

  if (status === 'RUNNING') {
    const startedAt = getNumberProperty(rawEvent, 'startedAt') ?? getStringProperty(rawEvent, 'startedAt');
    const resolvedStartedAt = resolveEpochMillis(startedAt ?? directPayload['startedAt']);
    if (resolvedStartedAt !== undefined) {
      directPayload['startedAt'] = resolvedStartedAt;
    }
    return projectFinalizationStateUpdatePayload(directPayload);
  }

  if (status === 'TIMED_OUT') {
    delete directPayload['error'];
    const timeoutAt = getNumberProperty(rawEvent, 'timeoutAt') ?? getStringProperty(rawEvent, 'timeoutAt');
    const resolvedTimeoutAt = resolveEpochMillis(timeoutAt);
    if (resolvedTimeoutAt !== undefined) {
      directPayload['timeoutAt'] = resolvedTimeoutAt;
    }
  }

  const error = status === 'FAILED' ? getRecordProperty(rawEvent, 'error') : undefined;
  if (error !== undefined) {
    const sessionId = getStringProperty(directPayload, 'sessionId');
    const executionId = getStringProperty(directPayload, 'executionId');
    const failureCode = getStringProperty(error, 'code') ?? getStringProperty(error, 'Error') ?? 'FINALIZATION_FAILED';
    const proverFailureCategory =
      failureCode === 'PROVER_TASK_FAILED' && sessionId && executionId
        ? await readAsyncProverFailureCategory(sessionId, executionId)
        : undefined;
    directPayload['error'] = {
      code: failureCode,
      message: proverFailureCategory ? 'Target prover task failed' : 'Finalization failed',
      ...(proverFailureCategory ? { category: proverFailureCategory } : {}),
    };
  }

  if (status === 'SUCCEEDED' && !getRecordProperty(directPayload, 'finalizationResult')) {
    const bundleS3Key = resolveBundleS3Key(directPayload);
    if (!bundleS3Key) {
      return projectFinalizationStateUpdatePayload({
        ...directPayload,
        status: 'FAILED',
        error: {
          code: 'FINALIZATION_BUNDLE_KEY_MISSING',
          message: 'Target finalization succeeded without a durable bundle key',
        },
      });
    }

    try {
      const completedAt =
        resolveTimestampFromProverResult(
          rawEvent['proverResult'] ?? directPayload['proverResult'],
          'ExecutionStoppedAt',
        ) ??
        resolveTimestampFromProverResult(rawEvent['proverResult'] ?? directPayload['proverResult'], 'StoppedAt') ??
        Date.now();
      const s3UploadedAt = getStringProperty(directPayload, 's3UploadedAt') ?? new Date(completedAt).toISOString();
      const executionId = getStringProperty(directPayload, 'executionId');
      const finalizationResult = await buildFinalizationResultFromS3Bundle({
        bundleS3Key,
        ...omitUndefinedProperties({ verificationExecutionId: executionId }),
        s3UploadedAt,
        finalizedAt: completedAt,
      });
      return projectFinalizationStateUpdatePayload({
        ...directPayload,
        completedAt,
        finalizationResult,
        bundleMetadata: {
          ...(isRecord(directPayload['bundleMetadata']) ? directPayload['bundleMetadata'] : {}),
          s3BundleKey: bundleS3Key,
          ...(s3UploadedAt ? { s3UploadedAt } : {}),
        },
      });
    } catch (error) {
      if (isTransientBundleRestoreError(error)) {
        throw error;
      }
      return projectFinalizationStateUpdatePayload({
        ...directPayload,
        status: 'FAILED',
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
  await bootstrapLambdaRuntime({
    serviceName: 'finalization-writer',
    resolveRuntimeReferences: async (invalidNameCollector) => {
      await ensureAwsRuntimeConfigReferencesLoaded('finalization_writer', { invalidNameCollector });
    },
    validationSteps: [
      {
        validate: validateTargetObservabilityEnv,
      },
      {
        validate: validateFinalizationWriterConfig,
      },
      {
        validate: validateEnv,
      },
    ],
  });

  let normalizedEvent: unknown;
  try {
    normalizedEvent = await normalizeDirectEvent(rawEvent);
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
      store: getGlobalStore(),
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
