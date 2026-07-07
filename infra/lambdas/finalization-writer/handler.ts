import { isCurrentArtifactBoundaryError } from '@stark-ballot/domain/contract';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { applyAwsFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/applyFinalizationStateUpdate';
import { parseFinalizationStateUpdatePayload } from '@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '@stark-ballot/domain/utils/guards';
import {
  buildAsyncProverArtifactKeys,
  buildFinalizationResultFromS3Bundle,
  validateAsyncProverBundleKey,
} from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { assertSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

type DirectCallbackResponse = {
  status: 'success';
  sessionId: string;
  state: Awaited<ReturnType<typeof applyAwsFinalizationStateUpdatePayload>>['state'];
};

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

  const directKey = getStringProperty(payload, 'bundleS3Key') ?? getStringProperty(payload, 's3BundleKey');
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
    const timeoutAt = getNumberProperty(rawEvent, 'timeoutAt') ?? getStringProperty(rawEvent, 'timeoutAt');
    const resolvedTimeoutAt = resolveEpochMillis(timeoutAt);
    if (resolvedTimeoutAt !== undefined) {
      directPayload['timeoutAt'] = resolvedTimeoutAt;
    }
  }

  const error = getRecordProperty(rawEvent, 'error');
  if (error) {
    directPayload['error'] = {
      code: getStringProperty(error, 'code') ?? getStringProperty(error, 'Error') ?? 'FINALIZATION_FAILED',
      message: getStringProperty(error, 'message') ?? getStringProperty(error, 'Cause') ?? 'Finalization failed',
      ...(Object.keys(error).length > 0 ? { details: error } : {}),
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
      return projectFinalizationStateUpdatePayload({
        ...directPayload,
        status: 'FAILED',
        error: {
          code: 'FINALIZATION_BUNDLE_RESTORE_FAILED',
          message: 'Target finalization bundle could not be restored',
          ...(error instanceof Error ? { details: { message: error.message } } : {}),
        },
      });
    }
  }

  return projectFinalizationStateUpdatePayload(directPayload);
}

export const handler = async (rawEvent: unknown): Promise<DirectCallbackResponse> => {
  await ensureAwsRuntimeConfigReferencesLoaded('finalization_writer');
  validateEnv();

  const payload = parseFinalizationStateUpdatePayload(await normalizeDirectEvent(rawEvent));
  if (!payload) {
    throw new Error('Invalid direct finalize callback event');
  }

  try {
    const result = await applyAwsFinalizationStateUpdatePayload({
      payload,
      store: getGlobalStore(),
    });

    return {
      status: 'success',
      sessionId: result.sessionId,
      state: result.state,
    };
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      throw error;
    }

    throw error;
  }
};
