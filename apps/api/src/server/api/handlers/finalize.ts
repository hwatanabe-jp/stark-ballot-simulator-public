import { ErrorCode, type ErrorDetails } from '@stark-ballot/api-contract/errors/apiErrors';
import { createFinalizationQueue } from '@stark-ballot/application/finalize/finalization-queue';
import { publishProverWorkMessage } from '@stark-ballot/aws-adapters/sqs/publishProverWorkMessage';
import { persistAsyncProverInputToS3 } from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { assertAdmissibleFinalizationArtifactPatch } from '@stark-ballot/aws-adapters/store/finalizationArtifactAdmission';
import { resolveExpectedImageId } from '@stark-ballot/verification/image-id';
import { loadPublicImageIdMapping } from '@stark-ballot/node-adapters/image-id-mapping';
import { getZkvmModeViolation, resolveZkvmMode } from '@stark-ballot/node-adapters/zkvm/zkvm-mode';
import { getDefaultExecutor } from '@stark-ballot/node-adapters/zkvm/executor-factory';
import {
  FinalizeAcceptedResponseSchema,
  FinalizeSyncResponseSchema,
} from '@stark-ballot/api-contract/validation/apiSchemas';
import { finalizeSessionUsecase } from '@stark-ballot/application/finalize/usecases/finalize-session';
import type { ApiContext } from '../context';
import { errorResponse } from '../../http/response';
import { respondWithSchema } from '../utils/responseSchema';
import { enforceFinalizeRateLimit, recordFinalizeRateLimit } from '../middleware/rateLimit';
import { validateSessionWithCapability } from '../middleware/session';
import { requireTurnstileToken } from '../middleware/turnstile';
import { parseFinalizeRequest } from '../middleware/validation';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl';
import { buildFinalizationQueueInfo } from '../utils/finalizationQueueInfo';
import { buildStatusUrl } from '../utils/finalizeUrls';
import { projectFinalizationStateForPublicResponse } from '../utils/finalizationStateProjection';
import { projectFinalizeSyncPayloadForResponse } from '../utils/finalizationResultProjection';
import { logger } from '@stark-ballot/diagnostics/logger';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import { extractTurnstileToken } from '../security/turnstile';
import { createMockVerificationReport, persistProofVerificationBundle } from '../adapters/proofBundleLocalArtifacts';
import { createApiProofBundleService } from '../adapters/proofBundleService';
import { publishVerificationBundleArtifacts } from '../adapters/verificationBundleS3Upload';
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import type { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isOperatorGatedDevelopRequest } from '../security/developOperatorGate';

const finalizationQueue = createFinalizationQueue(publishProverWorkMessage);
const proofBundleDependenciesBase = {
  persistBundle: persistProofVerificationBundle,
  invokeVerifier: invokeVerifierService,
  publishBundleArtifacts: publishVerificationBundleArtifacts,
  createMockVerificationReport,
};

function resolveExecutorModeLabel(): string {
  if (process.env['USE_MOCK_ZKVM'] === 'true') {
    return '[API] Mock zkVM mode (JavaScript, ~100ms)';
  }
  if (process.env['RISC0_DEV_MODE'] === '1') {
    return '[API] Real zkVM dev mode (Rust binary, ~40ms, Fake receipts)';
  }
  return '[API] Real zkVM production mode (Rust binary, ~366s for 64 votes, STARK proofs)';
}

function toApiErrorCode(code: ApplicationErrorCode): ErrorCode {
  return code as ErrorCode;
}

function projectApplicationErrorDetails(details: unknown): ErrorDetails | undefined {
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
    return details as ErrorDetails;
  }
  if (typeof details === 'string' && details.trim().length > 0) {
    return { details };
  }
  return undefined;
}

/**
 * Finalize a voting session and trigger verification workflows.
 */
export async function finalizeSessionHandler({ request, store, clientIp }: ApiContext): Promise<Response> {
  const debugFinalize = process.env['DEBUG_FINALIZE'] === '1';

  const rateLimitResult = await enforceFinalizeRateLimit(clientIp);
  if (rateLimitResult instanceof Response) {
    return rateLimitResult;
  }
  const { clientIp: resolvedClientIp, rateLimiter, shouldRecord } = rateLimitResult;

  const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
  if (sessionResult instanceof Response) {
    return sessionResult;
  }
  const { session, sessionId } = sessionResult;

  const parsedBody = await parseFinalizeRequest(request);
  if (parsedBody instanceof Response) {
    return parsedBody;
  }

  if (!isOperatorGatedDevelopRequest(request)) {
    await requireTurnstileToken({
      payload: parsedBody.data,
      ...omitUndefinedProperties({ explicitToken: extractTurnstileToken(parsedBody.data) }),
      clientIp: resolvedClientIp,
      expectedAction: 'finalize',
    });
  }

  const baseUrlResult = resolvePublicBaseUrl(request);
  if (!baseUrlResult.ok) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: baseUrlResult.details,
    });
  }
  const publicBaseUrl = baseUrlResult.baseUrl;
  const proofBundleService = createApiProofBundleService(
    {
      ...omitUndefinedProperties({ verifierWorkDir: process.env['VERIFIER_WORK_DIR'] }),
    },
    {
      ...proofBundleDependenciesBase,
      recordBundlePublication: ({ sessionId, executionId, ...metadata }) =>
        store.recordAwsProofBundlePublication(sessionId, executionId, metadata),
    },
  );

  let expectedImageId: string;
  try {
    // Finalize must validate against the active journal contract we are about
    // to execute, not the release pointer in imageId-mapping.json.current.
    expectedImageId = await resolveExpectedImageId(CURRENT_METHOD_VERSION, {
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

  const zkvmMode = resolveZkvmMode();
  const zkvmModeViolation = getZkvmModeViolation(zkvmMode);
  if (zkvmModeViolation) {
    logger.error('[API] Insecure zkVM mode blocked in production', {
      envUseMock: zkvmMode.envUseMock,
      useMock: zkvmMode.useMock,
      devMode: zkvmMode.devMode,
      forceDevMode: zkvmMode.forceDevMode,
    });
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: zkvmModeViolation,
    });
  }

  const asyncMode = process.env['FINALIZE_ASYNC_MODE'] === 'true';
  const queueUrl = process.env['PROVER_WORK_QUEUE_URL'];
  const publishMaxAttempts = Number(process.env['PROVER_PUBLISH_MAX_ATTEMPTS'] ?? 3);

  const usecaseResult = await finalizeSessionUsecase(
    {
      sessionId,
      session,
      scenarioId: parsedBody.data.scenarioId,
      expectedImageId,
      asyncMode,
      ...omitUndefinedProperties({ queueUrl: queueUrl }),
      publishMaxAttempts,
      allowDevMode: zkvmMode.devMode,
      debugFinalize,
      debugFileStore: process.env['DEBUG_FILE_STORE'] === '1',
      targetAwsRuntime: process.env['TARGET_AWS_RUNTIME'] === '1',
      executorModeLabel: resolveExecutorModeLabel(),
      bitmapProofSource: process.env['USE_MOCK_ZKVM'] === 'true' ? 'mock' : 'real',
    },
    {
      store,
      finalizationQueue,
      proofBundleService,
      getExecutor: getDefaultExecutor,
      persistAsyncProverInput: persistAsyncProverInputToS3,
      assertAdmissibleFinalizationArtifactPatch,
    },
  );

  if (!usecaseResult.ok) {
    if (usecaseResult.error.kind === 'invalid_image_id') {
      return errorResponse(ErrorCode.INVALID_IMAGE_ID, {
        details: 'Finalization receipt ImageID did not match the expected ImageID',
      });
    }

    return errorResponse(
      toApiErrorCode(usecaseResult.error.code),
      projectApplicationErrorDetails(usecaseResult.error.details),
    );
  }

  if (usecaseResult.value.kind === 'accepted') {
    await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);

    const queueInfo = await buildFinalizationQueueInfo({
      ...omitUndefinedProperties({ queueUrl: queueUrl }),
      state: usecaseResult.value.state,
    });

    return respondWithSchema(
      FinalizeAcceptedResponseSchema,
      {
        ...usecaseResult.value.payload,
        statusUrl: buildStatusUrl(publicBaseUrl, sessionId),
        state: projectFinalizationStateForPublicResponse(usecaseResult.value.payload.state),
        queue: queueInfo,
      },
      {
        status: 202,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);

  return respondWithSchema(FinalizeSyncResponseSchema, {
    data: projectFinalizeSyncPayloadForResponse(usecaseResult.value.payload),
  });
}
