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
    status: 200,
    content: 'json',
    body,
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
  if (runtimeProfile.artifacts.kind === 's3') {
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

export async function runVerificationHandler({
  context,
}: ApiHandlerArguments<typeof runVerificationRoute, VerificationRunContext>): Promise<
  RouteBoundResponse<typeof runVerificationRoute>
> {
  const {
    session,
    sessionId,
    finalizationId: requestedFinalizationId,
    store,
    finalizeRateLimit: rateLimitContext,
    runtimeProfile,
  } = context;
  const { clientIp: resolvedClientIp, rateLimiter, shouldRecord } = rateLimitContext;
  const finalizationRecord = session.finalization;
  if (finalizationRecord?.state.status !== 'succeeded' || !finalizationRecord.finalizationResult) {
    return respondWithRouteError(runVerificationRoute, { code: ErrorCode.SESSION_NOT_FINALIZED, status: 400 });
  }
  const finalizationResult = finalizationRecord.finalizationResult;
  const finalizationId = finalizationResult.finalizationId;
  if (requestedFinalizationId !== finalizationId) {
    return respondWithRouteError(runVerificationRoute, {
      code: ErrorCode.INVALID_REQUEST,
      status: 400,
      details: { details: 'Requested finalization does not match the current finalization' },
    });
  }
  const [verificationRecord, deliveryMetadata] = await Promise.all([
    store.getVerificationResultRecord(sessionId, finalizationId),
    store.getAwsVerificationDeliveryMetadata(sessionId, finalizationId),
  ]);
  const currentVerificationResult = verificationRecord?.verificationResult;
  const currentStatus = currentVerificationResult?.status;
  if (currentStatus !== undefined && shouldSkipVerification(currentStatus)) {
    return verificationRunResponse({
      data: {
        verificationStatus: currentStatus,
        finalizationId,
        estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
        idempotent: true,
      },
    });
  }

  const targetAwsExternal = runtimeProfile.external.kind === 'aws' ? runtimeProfile.external : null;
  const bundleReference = resolveBundleReferences(sessionId, finalizationResult, deliveryMetadata, runtimeProfile);
  if (!bundleReference) {
    return internalError('Authoritative verification bundle locator missing');
  }

  const methodVersion = resolveVerificationMethodVersion(finalizationResult);
  if (methodVersion === undefined) {
    return internalError('Unsupported or missing journal method version');
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
    return internalError(error instanceof Error ? error.message : 'Failed to resolve expected ImageID');
  }

  const { finalizationId: bundleFinalizationId, bundlePath, reportPath } = bundleReference;

  if (currentStatus === 'running') {
    if (targetAwsExternal && bundleReference.mode === 's3_bundle' && !hasQueuedVerificationWork(deliveryMetadata)) {
      const queuedAtMs = Date.now();
      try {
        await publishVerificationWorkMessage(runtimeProfile, {
          sessionId,
          finalizationId: bundleFinalizationId,
          queuedAtMs,
          bundleKey: bundleReference.bundleKey,
          expectedImageId,
        });
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
      try {
        await store.recordAwsVerificationDeliveryMetadata(sessionId, bundleFinalizationId, {
          ...deliveryMetadata,
          verificationWorkQueuedAtMs: queuedAtMs,
        });
      } catch (error) {
        logger.warn(
          '[VerificationRun] Verification work was queued but queued marker persistence failed',
          {
            session_id_hash: hashSessionIdForLogging(sessionId),
            finalizationId: bundleFinalizationId,
          },
          error,
        );
      }
    }
    return verificationRunResponse({
      data: {
        verificationStatus: 'running',
        finalizationId,
        estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
        idempotent: true,
      },
    });
  }

  try {
    await store.markVerificationRunning(sessionId, bundleFinalizationId);
  } catch (error) {
    if (isDynamoConditionalWriteConflict(error)) {
      const concurrentRecord = await store.getVerificationResultRecord(sessionId, bundleFinalizationId);
      if (concurrentRecord?.verificationResult.status === 'running') {
        return verificationRunResponse({
          data: {
            verificationStatus: 'running',
            finalizationId: bundleFinalizationId,
            estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
            idempotent: true,
          },
        });
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

  if (targetAwsExternal && bundleReference.mode === 's3_bundle') {
    const queuedAtMs = Date.now();
    try {
      await publishVerificationWorkMessage(runtimeProfile, {
        sessionId,
        finalizationId: bundleFinalizationId,
        queuedAtMs,
        bundleKey: bundleReference.bundleKey,
        expectedImageId,
      });
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
    try {
      await store.recordAwsVerificationDeliveryMetadata(sessionId, bundleFinalizationId, {
        ...deliveryMetadata,
        verificationWorkQueuedAtMs: queuedAtMs,
      });
    } catch (error) {
      logger.warn(
        '[VerificationRun] Verification work was queued but queued marker persistence failed',
        {
          session_id_hash: hashSessionIdForLogging(sessionId),
          finalizationId: bundleFinalizationId,
        },
        error,
      );
    }

    await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);
    return verificationRunResponse({
      data: {
        verificationStatus: 'running',
        finalizationId: bundleFinalizationId,
        estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
        idempotent: false,
      },
    });
  }

  if (bundleReference.mode !== 'local_bundle') {
    await store.rollbackVerificationResult(sessionId, bundleFinalizationId);
    return internalError('Runtime profile does not admit synchronous S3 verification');
  }

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

  return verificationRunResponse({
    data: {
      verificationStatus: completedVerificationResult.status,
      finalizationId: bundleFinalizationId,
      estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
      idempotent: false,
    },
  });
}
