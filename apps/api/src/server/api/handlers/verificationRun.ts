import type { ApiHandlerArguments, RouteBoundResponse, SessionFinalizationAdmittedContext } from '../context';
import type {
  FinalizationId,
  FinalizationResultAuthority,
} from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationResultRecord } from '@stark-ballot/application/finalize/finalization-record';
import type { AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type { VerificationResult, VerificationStatus } from '@stark-ballot/verification/shared/types';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { resolveExpectedImageId } from '@stark-ballot/verification/image-id';
import { loadPublicImageIdMapping } from '@stark-ballot/node-adapters/image-id-mapping';
import { publishVerificationWorkMessage } from '@stark-ballot/aws-adapters/sqs/publishVerificationWorkMessage';
import { recordFinalizeRateLimit, type FinalizeRateLimitContext } from '../middleware/rateLimit';
import type { VerificationRunResponse } from '@stark-ballot/api-contract/schemas/verification';
import { runVerificationRoute } from '@stark-ballot/api-contract/routes';
import { respondWithRoute, respondWithRouteError } from '../utils/responseSchema';
import { resolveTrustedLocalBundleReference } from '../adapters/trustedLocalBundleReference';
import { isSupportedJournalMethodVersion } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import {
  hasConsistentFinalizationLocatorAuthority,
  resolveBundleKeyIdentity,
} from '@stark-ballot/aws-adapters/finalize/finalizationLocatorAuthority';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

const ESTIMATED_VERIFICATION_DURATION_MS = 4000;
const VERIFIER_INVOCATION_FAILURE_DETAILS = 'Verifier runner invocation failed';

function verificationRunResponse(
  body: Omit<VerificationRunResponse, 'meta'>,
): RouteBoundResponse<typeof runVerificationRoute> {
  return respondWithRoute(runVerificationRoute, {
    status: body.data.verificationStatus === 'running' ? 202 : 200,
    content: 'json',
    body,
  });
}

function verificationStatusResponse(
  verificationStatus: VerificationStatus,
  finalizationId: FinalizationId,
  idempotent: boolean,
): RouteBoundResponse<typeof runVerificationRoute> {
  return verificationRunResponse({
    data: { verificationStatus, finalizationId, estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS, idempotent },
  });
}

function internalError(details: string): RouteBoundResponse<typeof runVerificationRoute> {
  return respondWithRouteError(runVerificationRoute, {
    code: ErrorCode.INTERNAL_ERROR,
    status: 500,
    details: { details },
  });
}

type VerificationBundleReference =
  | {
      mode: 's3_bundle';
      finalizationId: FinalizationId;
      bundleKey: string;
      bundlePath: string;
      reportPath: string;
    }
  | {
      mode: 'local_bundle';
      finalizationId: FinalizationId;
      bundlePath: string;
      reportPath: string;
    };

function resolveS3BundleReference(
  sessionId: SessionId,
  finalizationId: FinalizationId,
  bundleKey: string | undefined,
): VerificationBundleReference | null {
  if (!bundleKey) {
    return null;
  }
  const identity = resolveBundleKeyIdentity(bundleKey);
  if (identity?.sessionId !== sessionId || identity.finalizationId !== finalizationId) {
    return null;
  }
  return {
    mode: 's3_bundle',
    finalizationId,
    bundleKey,
    bundlePath: bundleKey,
    reportPath: buildReportKey(bundleKey),
  };
}

function resolveBundleReferences(
  sessionId: SessionId,
  finalizationResult: FinalizationResultRecord,
  deliveryMetadata: AwsVerificationDeliveryMetadataInput | undefined,
  runtimeProfile: ResolvedRuntimeProfile,
): VerificationBundleReference | null {
  const finalizationId = finalizationResult.finalizationId;
  if (!hasConsistentFinalizationLocatorAuthority(sessionId, finalizationId, deliveryMetadata)) {
    return null;
  }

  const bundleKey = deliveryMetadata?.s3BundleKey;
  if (runtimeProfile.artifacts.kind === 's3') return resolveS3BundleReference(sessionId, finalizationId, bundleKey);
  if (bundleKey) {
    return null;
  }

  const localBundle = resolveTrustedLocalBundleReference(
    sessionId,
    {
      finalizationId,
      ...omitUndefinedProperties({ bundleKey }),
    },
    {
      runtimeProfile,
      ...omitUndefinedProperties({ verifierWorkDir: process.env['VERIFIER_WORK_DIR'] }),
    },
  );
  if (!localBundle) {
    return null;
  }

  return {
    mode: 'local_bundle',
    finalizationId,
    bundlePath: localBundle.bundlePath,
    reportPath: localBundle.reportPath,
  };
}

function buildReportKey(bundleKey: string | undefined): string {
  if (!bundleKey) {
    return '';
  }
  if (bundleKey.endsWith('bundle.zip')) {
    return bundleKey.replace(/bundle\.zip$/, 'verification.json');
  }
  return `${bundleKey}.verification.json`;
}

function shouldSkipVerification(status?: VerificationStatus): boolean {
  if (!status) {
    return false;
  }
  return status !== 'not_run' && status !== 'running';
}

function isDynamoConditionalWriteConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'ConditionalCheckFailedException' || error.message.includes('ConditionalCheckFailedException');
}

function hasQueuedVerificationWork(metadata: AwsVerificationDeliveryMetadataInput | undefined): boolean {
  return typeof metadata?.verificationWorkQueuedAtMs === 'number';
}

function resolveVerificationMethodVersion(finalizationResult: FinalizationResultAuthority): number | undefined {
  const journalVersion = finalizationResult.journal.methodVersion;
  if (isSupportedJournalMethodVersion(journalVersion)) {
    return journalVersion;
  }

  return undefined;
}

type VerificationRunContext = SessionFinalizationAdmittedContext & {
  finalizeRateLimit: FinalizeRateLimitContext;
};

/** The queue acknowledgement is authoritative; a failed marker write remains retryable. */
async function enqueueVerificationWork(
  context: VerificationRunContext,
  bundle: Extract<VerificationBundleReference, { mode: 's3_bundle' }>,
  expectedImageId: string,
  deliveryMetadata: AwsVerificationDeliveryMetadataInput | undefined,
): Promise<void> {
  const { sessionId, store, runtimeProfile } = context;
  const finalizationId = bundle.finalizationId;
  const queuedAtMs = Date.now();
  await publishVerificationWorkMessage(runtimeProfile, {
    sessionId,
    finalizationId,
    queuedAtMs,
    bundleKey: bundle.bundleKey,
    expectedImageId,
  });
  try {
    await store.recordAwsVerificationDeliveryMetadata(sessionId, finalizationId, {
      ...deliveryMetadata,
      verificationWorkQueuedAtMs: queuedAtMs,
    });
  } catch (error) {
    logger.warn(
      '[VerificationRun] Verification work was queued but queued marker persistence failed',
      { session_id_hash: hashSessionIdForLogging(sessionId), finalizationId },
      error,
    );
  }
}

type VerificationAdmission<T> = { value: T } | { response: RouteBoundResponse<typeof runVerificationRoute> };

interface VerificationExecution {
  context: VerificationRunContext;
  bundleReference: VerificationBundleReference;
  expectedImageId: string;
  deliveryMetadata: AwsVerificationDeliveryMetadataInput | undefined;
  targetAwsExternal: boolean;
}

function admitVerificationFinalization(
  context: VerificationRunContext,
): VerificationAdmission<FinalizationResultRecord> {
  const { session, finalizationId: requestedFinalizationId } = context;
  const finalizationRecord = session.finalization;
  if (finalizationRecord?.state.status !== 'succeeded' || !finalizationRecord.finalizationResult) {
    return {
      response: respondWithRouteError(runVerificationRoute, { code: ErrorCode.SESSION_NOT_FINALIZED, status: 400 }),
    };
  }
  const finalizationResult = finalizationRecord.finalizationResult;
  const finalizationId = finalizationResult.finalizationId;
  if (requestedFinalizationId !== finalizationId) {
    return {
      response: respondWithRouteError(runVerificationRoute, {
        code: ErrorCode.FINALIZATION_NOT_CURRENT,
        status: 409,
        details: { details: 'Requested finalization does not match the current finalization' },
      }),
    };
  }
  return { value: finalizationResult };
}

async function resolveVerificationImageId(
  finalizationResult: FinalizationResultAuthority,
  runtimeProfile: ResolvedRuntimeProfile,
): Promise<VerificationAdmission<string>> {
  const targetAwsExternal = runtimeProfile.external.kind === 'aws' ? runtimeProfile.external : null;
  const methodVersion = resolveVerificationMethodVersion(finalizationResult);
  if (methodVersion === undefined) {
    return { response: internalError('Unsupported or missing journal method version') };
  }
  let expectedImageId: string;
  try {
    expectedImageId = await resolveExpectedImageId(methodVersion, {
      ...omitUndefinedProperties({
        explicitImageId: targetAwsExternal?.expectedImageId ?? process.env['EXPECTED_IMAGE_ID'],
      }),
      ...omitUndefinedProperties({
        variant: process.env['EXPECTED_IMAGE_ID_VARIANT'],
      }),
      loadImageIdMapping: loadPublicImageIdMapping,
    });
  } catch (error) {
    return { response: internalError(error instanceof Error ? error.message : 'Failed to resolve expected ImageID') };
  }

  return { value: expectedImageId };
}

async function resumeVerification(
  execution: VerificationExecution,
): Promise<RouteBoundResponse<typeof runVerificationRoute>> {
  const { context, bundleReference, expectedImageId, deliveryMetadata, targetAwsExternal } = execution;
  const { sessionId } = context;
  const { finalizationId: bundleFinalizationId } = bundleReference;
  const finalizationId = bundleFinalizationId;
  if (targetAwsExternal && bundleReference.mode === 's3_bundle' && !hasQueuedVerificationWork(deliveryMetadata)) {
    try {
      await enqueueVerificationWork(context, bundleReference, expectedImageId, deliveryMetadata);
    } catch (error) {
      logger.error(
        '[VerificationRun] Failed to resume pending verification queue work',
        {
          session_id_hash: hashSessionIdForLogging(sessionId),
          finalizationId: bundleFinalizationId,
        },
        error,
      );
      return internalError('Verifier queue enqueue failed');
    }
  }
  return verificationStatusResponse('running', finalizationId, true);
}

async function markVerificationRunning(
  context: VerificationRunContext,
  bundleFinalizationId: FinalizationId,
): Promise<RouteBoundResponse<typeof runVerificationRoute> | undefined> {
  const { sessionId, store } = context;
  try {
    await store.markVerificationRunning(sessionId, bundleFinalizationId);
  } catch (error) {
    if (isDynamoConditionalWriteConflict(error)) {
      const concurrentRecord = await store.getVerificationResultRecord(sessionId, bundleFinalizationId);
      if (concurrentRecord?.verificationResult.status === 'running') {
        return verificationStatusResponse('running', bundleFinalizationId, true);
      }
    }
    logger.error(
      '[VerificationRun] Failed to mark verification running',
      {
        session_id_hash: hashSessionIdForLogging(sessionId),
        finalizationId: bundleFinalizationId,
      },
      error,
    );
    return internalError('Verifier state update failed');
  }

  return undefined;
}

async function queueNewVerification(
  context: VerificationRunContext,
  bundleReference: Extract<VerificationBundleReference, { mode: 's3_bundle' }>,
  expectedImageId: string,
  deliveryMetadata: AwsVerificationDeliveryMetadataInput | undefined,
): Promise<RouteBoundResponse<typeof runVerificationRoute>> {
  const { sessionId, store, finalizeRateLimit } = context;
  const { clientIp: resolvedClientIp, rateLimiter, shouldRecord } = finalizeRateLimit;
  const { finalizationId: bundleFinalizationId } = bundleReference;
  try {
    await enqueueVerificationWork(context, bundleReference, expectedImageId, deliveryMetadata);
  } catch (error) {
    await store.rollbackVerificationResult(sessionId, bundleFinalizationId);
    logger.error(
      '[VerificationRun] Failed to enqueue verification work',
      {
        session_id_hash: hashSessionIdForLogging(sessionId),
        finalizationId: bundleFinalizationId,
      },
      error,
    );
    return internalError('Verifier queue enqueue failed');
  }

  await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);
  return verificationStatusResponse('running', bundleFinalizationId, false);
}

async function runLocalVerification(
  context: VerificationRunContext,
  bundleReference: Extract<VerificationBundleReference, { mode: 'local_bundle' }>,
  expectedImageId: string,
): Promise<RouteBoundResponse<typeof runVerificationRoute>> {
  const { sessionId, store, finalizeRateLimit } = context;
  const { clientIp: resolvedClientIp, rateLimiter, shouldRecord } = finalizeRateLimit;
  const { finalizationId: bundleFinalizationId, bundlePath, reportPath } = bundleReference;
  let completedVerificationResult: VerificationResult;
  try {
    const invocation = await invokeVerifierService({
      bundlePath,
      expectedImageId,
      reportPath,
    });

    switch (invocation.status) {
      case 'success':
        completedVerificationResult = { status: 'success', report: invocation.report };
        break;
      case 'dev_mode':
        completedVerificationResult = { status: 'dev_mode', report: invocation.report };
        break;
      case 'failed':
        completedVerificationResult = { status: 'failed', report: invocation.report };
        break;
    }
  } catch (error) {
    await store.rollbackVerificationResult(sessionId, bundleFinalizationId);
    logger.error('[VerificationRun] Verifier invocation failed', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalizationId: bundleFinalizationId,
      bundleMode: bundleReference.mode,
      error_kind: error instanceof Error ? 'error' : 'unknown',
    });
    return internalError(VERIFIER_INVOCATION_FAILURE_DETAILS);
  }

  await store.completeVerificationResult(sessionId, bundleFinalizationId, completedVerificationResult);

  await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);

  return verificationStatusResponse(completedVerificationResult.status, bundleFinalizationId, false);
}

async function startVerification(
  execution: VerificationExecution,
): Promise<RouteBoundResponse<typeof runVerificationRoute>> {
  const { context, bundleReference, expectedImageId, deliveryMetadata, targetAwsExternal } = execution;
  const rejected = await markVerificationRunning(context, bundleReference.finalizationId);
  if (rejected) return rejected;
  if (targetAwsExternal && bundleReference.mode === 's3_bundle')
    return queueNewVerification(context, bundleReference, expectedImageId, deliveryMetadata);
  if (bundleReference.mode !== 'local_bundle') {
    await context.store.rollbackVerificationResult(context.sessionId, bundleReference.finalizationId);
    return internalError('Runtime profile does not admit synchronous S3 verification');
  }
  return runLocalVerification(context, bundleReference, expectedImageId);
}

export async function runVerificationHandler({
  context,
}: ApiHandlerArguments<typeof runVerificationRoute, VerificationRunContext>): Promise<
  RouteBoundResponse<typeof runVerificationRoute>
> {
  const admitted = admitVerificationFinalization(context);
  if ('response' in admitted) return admitted.response;
  const finalizationResult = admitted.value;
  const finalizationId = finalizationResult.finalizationId;
  const { sessionId, store, runtimeProfile } = context;
  const [verificationRecord, deliveryMetadata] = await Promise.all([
    store.getVerificationResultRecord(sessionId, finalizationId),
    store.getAwsVerificationDeliveryMetadata(sessionId, finalizationId),
  ]);
  const currentStatus = verificationRecord?.verificationResult?.status;
  if (currentStatus !== undefined && shouldSkipVerification(currentStatus)) {
    return verificationStatusResponse(currentStatus, finalizationId, true);
  }
  const bundleReference = resolveBundleReferences(sessionId, finalizationResult, deliveryMetadata, runtimeProfile);
  if (!bundleReference) return internalError('Authoritative verification bundle locator missing');
  const image = await resolveVerificationImageId(finalizationResult, runtimeProfile);
  if ('response' in image) return image.response;
  const execution = {
    context,
    bundleReference,
    expectedImageId: image.value,
    deliveryMetadata,
    targetAwsExternal: runtimeProfile.external.kind === 'aws',
  };
  return currentStatus === 'running' ? resumeVerification(execution) : startVerification(execution);
}
