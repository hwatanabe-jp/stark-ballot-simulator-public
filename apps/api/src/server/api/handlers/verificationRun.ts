import type { ApiContext } from '../context';
import type { SessionData } from '@stark-ballot/domain/types/server';
import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';
import type {
  AwsPersistedFinalizationResult,
  AwsPersistedVerificationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import type { VerificationResult, VerificationStatus } from '@stark-ballot/verification/shared/types';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';
import { resolveExpectedImageId } from '@stark-ballot/verification/image-id';
import { loadPublicImageIdMapping } from '@stark-ballot/node-adapters/image-id-mapping';
import { invokeVerificationWorker } from '../adapters/verificationWorkerClient';
import { publishVerificationWorkMessage } from '@stark-ballot/aws-adapters/sqs/publishVerificationWorkMessage';
import { enforceFinalizeRateLimit, recordFinalizeRateLimit } from '../middleware/rateLimit';
import { parseVerificationRunRequest } from '../middleware/validation';
import { validateSessionWithCapability } from '../middleware/session';
import { VerificationRunResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { respondWithSchema } from '../utils/responseSchema';
import { resolveTrustedLocalBundleReference } from '../adapters/trustedLocalBundleReference';
import { isSupportedJournalMethodVersion } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '../utils/currentArtifactAdmission';
import { logger } from '@stark-ballot/diagnostics/logger';
import {
  resolveBundleKeyIdentity,
  resolveReportKeyIdentity,
} from '@stark-ballot/aws-adapters/finalize/finalizationLocatorAuthority';
import { parseAwsFinalizationRuntimeState } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const ESTIMATED_VERIFICATION_DURATION_MS = 4000;
const VERIFIER_INVOCATION_FAILURE_DETAILS = 'Verifier runner invocation failed';

type VerificationBundleReference =
  | {
      mode: 's3_bundle';
      executionId: string;
      bundleKey: string;
      bundlePath: string;
      reportPath: string;
    }
  | {
      mode: 'local_bundle';
      executionId: string;
      bundlePath: string;
      reportPath: string;
    };

function resolveBundleReferences(
  sessionId: string,
  finalizationResult: AwsPersistedFinalizationResult,
  finalizationState?: SessionData['finalizationState'],
): VerificationBundleReference | null {
  const executionId = finalizationResult.verificationExecutionId;
  if (!executionId) {
    return null;
  }

  const runtimeState = parseAwsFinalizationRuntimeState(finalizationState);
  const fallbackBundleKey =
    runtimeState?.status === 'succeeded' && runtimeState.executionId === executionId
      ? runtimeState.bundleMetadata?.s3BundleKey
      : undefined;
  const fallbackIdentity = fallbackBundleKey ? resolveBundleKeyIdentity(fallbackBundleKey) : null;
  const bundleKey =
    finalizationResult.s3BundleKey ??
    (fallbackIdentity?.sessionId === sessionId && fallbackIdentity.executionId === executionId
      ? fallbackBundleKey
      : undefined);
  if (bundleKey) {
    return {
      mode: 's3_bundle',
      executionId,
      bundleKey,
      bundlePath: bundleKey,
      reportPath: buildReportKey(bundleKey),
    };
  }

  const localBundle = resolveTrustedLocalBundleReference(sessionId, finalizationResult, {
    targetAwsRuntime: process.env['TARGET_AWS_RUNTIME'] === '1',
    ...omitUndefinedProperties({ verifierWorkDir: process.env['VERIFIER_WORK_DIR'] }),
  });
  if (!localBundle) {
    return null;
  }

  return {
    mode: 'local_bundle',
    executionId: localBundle.executionId,
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

function assertVerificationWorkerResponseScope(
  response: {
    sessionId: string;
    executionId: string;
    s3?: {
      bundleKey?: string;
      reportKey?: string;
    };
  },
  expected: {
    sessionId: string;
    executionId: string;
  },
): void {
  if (response.sessionId !== expected.sessionId || response.executionId !== expected.executionId) {
    throw new Error('verification-worker response identity does not match requested verification run');
  }

  if (response.s3?.bundleKey) {
    const bundleIdentity = resolveBundleKeyIdentity(response.s3.bundleKey);
    if (bundleIdentity?.sessionId !== expected.sessionId || bundleIdentity.executionId !== expected.executionId) {
      throw new Error('verification-worker response bundle locator does not match requested verification run');
    }
  }

  if (response.s3?.reportKey) {
    const reportIdentity = resolveReportKeyIdentity(response.s3.reportKey);
    if (reportIdentity?.sessionId !== expected.sessionId || reportIdentity.executionId !== expected.executionId) {
      throw new Error('verification-worker response report locator does not match requested verification run');
    }
  }
}

function asPersistedVerificationResult(value: unknown): AwsPersistedVerificationResult | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const status = (value as { status?: unknown }).status;
  return status === 'success' ||
    status === 'failed' ||
    status === 'dev_mode' ||
    status === 'not_run' ||
    status === 'running'
    ? (value as AwsPersistedVerificationResult)
    : undefined;
}

function isDynamoConditionalWriteConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'ConditionalCheckFailedException' || error.message.includes('ConditionalCheckFailedException');
}

function isSameExecutionRunning(session: SessionData | null, executionId: string): boolean {
  if (!session) {
    return false;
  }
  const finalizedRead = resolveSupportedFinalizedRead(session);
  if (finalizedRead.artifactState || !finalizedRead.finalizationResult) {
    return false;
  }
  const verificationResult = asPersistedVerificationResult(finalizedRead.finalizationResult.verificationResult);
  return (
    finalizedRead.finalizationResult.verificationExecutionId === executionId &&
    verificationResult?.status === 'running' &&
    verificationResult.executionId === executionId
  );
}

function hasQueuedVerificationWork(verificationResult: AwsPersistedVerificationResult | undefined): boolean {
  return typeof verificationResult?.verificationWorkQueuedAt === 'string';
}

function resolveVerificationMethodVersion(finalizationResult: FinalizationResultAuthority): number | undefined {
  const journalVersion = finalizationResult.journal.methodVersion;
  if (isSupportedJournalMethodVersion(journalVersion)) {
    return journalVersion;
  }

  return undefined;
}

function shouldPersistCanonicalRepair(
  original: SessionData['finalizationResult'],
  canonical: AwsPersistedFinalizationResult,
): boolean {
  return JSON.stringify(original) !== JSON.stringify(canonical);
}

export async function runVerificationHandler({ request, store, clientIp }: ApiContext): Promise<Response> {
  const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
  if (sessionResult instanceof Response) {
    return sessionResult;
  }
  const { session, sessionId } = sessionResult;

  if (!session.finalized) {
    return errorResponse(ErrorCode.SESSION_NOT_FINALIZED);
  }

  const finalizedRead = resolveSupportedFinalizedRead(session);
  if (finalizedRead.artifactState) {
    return buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState);
  }

  const rateLimitContext = await enforceFinalizeRateLimit(clientIp);
  if (rateLimitContext instanceof Response) {
    return rateLimitContext;
  }
  const { clientIp: resolvedClientIp, rateLimiter, shouldRecord } = rateLimitContext;
  const parsedBody = await parseVerificationRunRequest(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  const finalizationResult = finalizedRead.finalizationResult;
  if (!finalizationResult) {
    return buildUnsupportedFinalizedArtifactResponse('corrupt_or_unreadable');
  }
  const needsCanonicalRepair = shouldPersistCanonicalRepair(session.finalizationResult, finalizationResult);
  const resolvedExecutionId = finalizationResult.verificationExecutionId ?? 'unknown';
  const currentVerificationResult = asPersistedVerificationResult(finalizationResult.verificationResult);
  const currentStatus = currentVerificationResult?.status;
  if (shouldSkipVerification(currentStatus)) {
    if (needsCanonicalRepair) {
      await store.repairFinalizationResult(sessionId);
    }
    return respondWithSchema(VerificationRunResponseSchema, {
      data: {
        verificationStatus: currentStatus,
        verificationExecutionId: resolvedExecutionId,
        estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
        idempotent: true,
      },
    });
  }

  const bundleReference = resolveBundleReferences(sessionId, finalizationResult, session.finalizationState);
  if (!bundleReference) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: 'Authoritative verification bundle locator missing',
    });
  }

  const methodVersion = resolveVerificationMethodVersion(finalizationResult);
  if (methodVersion === undefined) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: 'Unsupported or missing journal method version',
    });
  }
  let expectedImageId: string;
  try {
    expectedImageId = await resolveExpectedImageId(methodVersion, {
      ...omitUndefinedProperties({ explicitImageId: process.env['EXPECTED_IMAGE_ID'] }),
      ...omitUndefinedProperties({
        legacyExpectedImageIdPoc: process.env['EXPECTED_IMAGEID_POC'],
        variant: process.env['EXPECTED_IMAGE_ID_VARIANT'],
      }),
      loadImageIdMapping: loadPublicImageIdMapping,
    });
  } catch (error) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: error instanceof Error ? error.message : 'Failed to resolve expected ImageID',
    });
  }

  const { executionId, bundlePath, reportPath } = bundleReference;

  if (currentStatus === 'running') {
    if (needsCanonicalRepair) {
      await store.repairFinalizationResult(sessionId);
    }
    if (
      process.env['TARGET_AWS_RUNTIME'] === '1' &&
      bundleReference.mode === 's3_bundle' &&
      !hasQueuedVerificationWork(currentVerificationResult)
    ) {
      const queuedAt = Date.now();
      try {
        await publishVerificationWorkMessage({
          sessionId,
          executionId,
          queuedAt,
          bundleKey: bundleReference.bundleKey,
          expectedImageId,
        });
      } catch (error) {
        logger.error(
          '[VerificationRun] Failed to repair pending verification queue work',
          {
            sessionId,
            executionId,
          },
          error,
        );
        return errorResponse(ErrorCode.INTERNAL_ERROR, {
          details: 'Verifier queue enqueue failed',
        });
      }
      try {
        await store.markVerificationRunning(sessionId, {
          executionId,
          verificationWorkQueuedAt: new Date(queuedAt).toISOString(),
          ...(currentVerificationResult?.report ? { report: currentVerificationResult.report } : {}),
        });
      } catch (error) {
        logger.warn(
          '[VerificationRun] Verification work was queued but queued marker persistence failed',
          {
            sessionId,
            executionId,
          },
          error,
        );
      }
    }
    return respondWithSchema(VerificationRunResponseSchema, {
      data: {
        verificationStatus: 'running',
        verificationExecutionId: resolvedExecutionId,
        estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
        idempotent: true,
      },
    });
  }

  try {
    await store.markVerificationRunning(sessionId, {
      executionId,
      ...(currentVerificationResult?.report ? { report: currentVerificationResult.report } : {}),
    });
  } catch (error) {
    if (
      isDynamoConditionalWriteConflict(error) &&
      isSameExecutionRunning(await store.getSession(sessionId), executionId)
    ) {
      return respondWithSchema(VerificationRunResponseSchema, {
        data: {
          verificationStatus: 'running',
          verificationExecutionId: executionId,
          estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
          idempotent: true,
        },
      });
    }
    logger.error(
      '[VerificationRun] Failed to mark verification running',
      {
        sessionId,
        executionId,
      },
      error,
    );
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: 'Verifier state update failed',
    });
  }

  if (process.env['TARGET_AWS_RUNTIME'] === '1' && bundleReference.mode === 's3_bundle') {
    const queuedAt = Date.now();
    try {
      await publishVerificationWorkMessage({
        sessionId,
        executionId,
        queuedAt,
        bundleKey: bundleReference.bundleKey,
        expectedImageId,
      });
    } catch (error) {
      await store.rollbackVerificationResult(sessionId, { executionId });
      logger.error(
        '[VerificationRun] Failed to enqueue verification work',
        {
          sessionId,
          executionId,
        },
        error,
      );
      return errorResponse(ErrorCode.INTERNAL_ERROR, {
        details: 'Verifier queue enqueue failed',
      });
    }
    try {
      await store.markVerificationRunning(sessionId, {
        executionId,
        verificationWorkQueuedAt: new Date(queuedAt).toISOString(),
        ...(currentVerificationResult?.report ? { report: currentVerificationResult.report } : {}),
      });
    } catch (error) {
      logger.warn(
        '[VerificationRun] Verification work was queued but queued marker persistence failed',
        {
          sessionId,
          executionId,
        },
        error,
      );
    }

    await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);
    return respondWithSchema(VerificationRunResponseSchema, {
      data: {
        verificationStatus: 'running',
        verificationExecutionId: executionId,
        estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
        idempotent: false,
      },
    });
  }

  let completedVerificationResult: VerificationResult;
  try {
    if (bundleReference.mode === 's3_bundle') {
      const lambdaResponse = await invokeVerificationWorker({
        mode: 's3_bundle',
        sessionId,
        executionId,
        bundleKey: bundleReference.bundleKey,
        expectedImageId,
      });

      if (lambdaResponse.status !== 'success') {
        logger.error('[VerificationRun] Verifier runner returned an error response', {
          sessionId,
          executionId,
          runnerMessage: lambdaResponse.message,
          runnerDetails: lambdaResponse.details,
        });
        throw new Error(VERIFIER_INVOCATION_FAILURE_DETAILS);
      }
      assertVerificationWorkerResponseScope(lambdaResponse, { sessionId, executionId });

      const allowedStatuses = new Set<VerificationStatus>(['success', 'failed', 'dev_mode', 'not_run', 'running']);
      const verifierStatus = allowedStatuses.has(lambdaResponse.verifierStatus as VerificationStatus)
        ? (lambdaResponse.verifierStatus as VerificationStatus)
        : 'failed';

      await store.recordAwsVerificationDeliveryMetadata(sessionId, executionId, {
        s3BundleKey: lambdaResponse.s3?.bundleKey ?? bundleReference.bundleKey,
        ...(lambdaResponse.s3?.reportKey ? { s3ReportKey: lambdaResponse.s3.reportKey } : {}),
        ...omitUndefinedProperties({ s3UploadedAt: lambdaResponse.s3?.uploadedAt ?? finalizationResult.s3UploadedAt }),
      });
      completedVerificationResult = {
        status: verifierStatus,
        report: lambdaResponse.verificationReport,
      };
    } else {
      const invocation = await invokeVerifierService({
        bundlePath,
        expectedImageId,
        reportPath,
      });

      completedVerificationResult = {
        status: invocation.status,
        report: invocation.report,
      };
    }
  } catch (error) {
    await store.rollbackVerificationResult(sessionId, { executionId });
    logger.error(
      '[VerificationRun] Verifier invocation failed',
      {
        sessionId,
        executionId,
        bundleMode: bundleReference.mode,
      },
      error,
    );
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: VERIFIER_INVOCATION_FAILURE_DETAILS,
    });
  }

  await store.completeVerificationResult(sessionId, {
    executionId,
    verificationResult: completedVerificationResult,
  });

  await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);

  return respondWithSchema(VerificationRunResponseSchema, {
    data: {
      verificationStatus: completedVerificationResult.status,
      verificationExecutionId: executionId,
      estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
      idempotent: false,
    },
  });
}
