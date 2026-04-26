import type { ApiContext } from '@/server/api/context';
import type {
  FinalizationResultAuthority,
  SessionData,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from '@/types/server';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { errorResponse } from '@/server/http/response';
import { resolveExpectedImageId } from '@/lib/verification/expected-image-id';
import { invokeVerifierServiceRunner } from '@/lib/verification/verifier-service-runner-client';
import { enforceFinalizeRateLimit, recordFinalizeRateLimit } from '@/server/api/middleware/rateLimit';
import { parseVerificationRunRequest } from '@/server/api/middleware/validation';
import { validateSessionWithCapability } from '@/server/api/middleware/session';
import { VerificationRunResponseSchema } from '@/lib/validation/apiSchemas';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import {
  resolveTrustedLocalBundleReference,
  updateFinalizationResultVerificationState,
} from '@/lib/finalize/finalization-result';
import { isSupportedJournalMethodVersion } from '@/lib/zkvm/journal-guards';
import { invokeVerifierService } from '@/lib/verification/verifier-service-client';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

const ESTIMATED_VERIFICATION_DURATION_MS = 4000;

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
  finalizationResult: FinalizationResultAuthority,
): VerificationBundleReference | null {
  const executionId = finalizationResult.verificationExecutionId;
  if (!executionId) {
    return null;
  }

  const bundleKey = finalizationResult.s3BundleKey;
  if (bundleKey) {
    return {
      mode: 's3_bundle',
      executionId,
      bundleKey,
      bundlePath: bundleKey,
      reportPath: buildReportKey(bundleKey),
    };
  }

  const localBundle = resolveTrustedLocalBundleReference(sessionId, finalizationResult);
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

function resolveVerificationMethodVersion(finalizationResult: FinalizationResultAuthority): number | undefined {
  const journalVersion = finalizationResult.journal.methodVersion;
  if (isSupportedJournalMethodVersion(journalVersion)) {
    return journalVersion;
  }

  return undefined;
}

function shouldPersistCanonicalRepair(
  original: SessionData['finalizationResult'],
  canonical: FinalizationResultAuthority,
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
  session.finalizationResult = finalizationResult;
  const resolvedExecutionId = finalizationResult.verificationExecutionId ?? 'unknown';
  const currentStatus = finalizationResult.verificationResult?.status;
  if (shouldSkipVerification(currentStatus)) {
    if (needsCanonicalRepair) {
      await store.updateSession(sessionId, { finalizationResult });
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

  if (currentStatus === 'running') {
    if (needsCanonicalRepair) {
      await store.updateSession(sessionId, { finalizationResult });
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

  const bundleReference = resolveBundleReferences(sessionId, finalizationResult);
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
    expectedImageId = await resolveExpectedImageId(methodVersion);
  } catch (error) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: error instanceof Error ? error.message : 'Failed to resolve expected ImageID',
    });
  }

  const { executionId, bundlePath, reportPath } = bundleReference;

  const runningResult: VerificationResult = {
    status: 'running',
    report: finalizationResult.verificationResult?.report,
    s3BundleKey: bundleReference.mode === 's3_bundle' ? bundleReference.bundleKey : undefined,
    s3ReportKey: undefined,
    s3UploadedAt: bundleReference.mode === 's3_bundle' ? finalizationResult.s3UploadedAt : undefined,
    executionId,
  };

  const runningFinalizationResult = updateFinalizationResultVerificationState(finalizationResult, {
    verificationResult: runningResult,
    verificationExecutionId: executionId,
    s3BundleKey: bundleReference.mode === 's3_bundle' ? finalizationResult.s3BundleKey : undefined,
  });

  const previousVerificationResult = finalizationResult.verificationResult;
  const previousExecutionId = finalizationResult.verificationExecutionId;

  session.finalizationResult = runningFinalizationResult;
  await store.updateSession(sessionId, { finalizationResult: runningFinalizationResult });

  let completedVerificationResult: VerificationResult;
  try {
    if (bundleReference.mode === 's3_bundle') {
      const lambdaResponse = await invokeVerifierServiceRunner({
        mode: 's3_bundle',
        sessionId,
        executionId,
        bundleKey: bundleReference.bundleKey,
        expectedImageId,
      });

      if (lambdaResponse.status !== 'success') {
        throw new Error(lambdaResponse.message);
      }

      const allowedStatuses = new Set<VerificationStatus>(['success', 'failed', 'dev_mode', 'not_run', 'running']);
      const verifierStatus = allowedStatuses.has(lambdaResponse.verifierStatus as VerificationStatus)
        ? (lambdaResponse.verifierStatus as VerificationStatus)
        : 'failed';

      completedVerificationResult = {
        ...runningResult,
        status: verifierStatus,
        report: lambdaResponse.verificationReport as VerificationReport | undefined,
        s3BundleKey: lambdaResponse.s3?.bundleKey ?? runningResult.s3BundleKey,
        s3ReportKey: lambdaResponse.s3?.reportKey,
        s3UploadedAt: lambdaResponse.s3?.uploadedAt ?? runningResult.s3UploadedAt,
      };
    } else {
      const invocation = await invokeVerifierService({
        bundlePath,
        expectedImageId,
        reportPath,
      });

      completedVerificationResult = {
        ...runningResult,
        status: invocation.status,
        report: invocation.report,
        s3BundleKey: undefined,
        s3ReportKey: undefined,
        s3UploadedAt: undefined,
      };
    }
  } catch (error) {
    const rolledBack = updateFinalizationResultVerificationState(runningFinalizationResult, {
      verificationResult: previousVerificationResult,
      verificationExecutionId: previousExecutionId,
    });
    session.finalizationResult = rolledBack;
    await store.updateSession(sessionId, { finalizationResult: rolledBack });
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: error instanceof Error ? error.message : 'Verifier runner invocation failed',
    });
  }

  const updatedFinalizationResult = updateFinalizationResultVerificationState(runningFinalizationResult, {
    verificationResult: completedVerificationResult,
    verificationExecutionId: executionId,
    s3BundleKey: completedVerificationResult.s3BundleKey,
    s3UploadedAt: completedVerificationResult.s3UploadedAt,
  });

  session.finalizationResult = updatedFinalizationResult;
  await store.updateSession(sessionId, { finalizationResult: updatedFinalizationResult });

  await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);

  return respondWithSchema(VerificationRunResponseSchema, {
    data: {
      verificationStatus: updatedFinalizationResult.verificationResult?.status ?? completedVerificationResult.status,
      verificationExecutionId: executionId,
      estimatedDurationMs: ESTIMATED_VERIFICATION_DURATION_MS,
      idempotent: false,
    },
  });
}
