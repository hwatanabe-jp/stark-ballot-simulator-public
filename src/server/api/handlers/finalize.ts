import { ErrorCode } from '@/lib/errors/apiErrors';
import { createFinalizationQueue } from '@/lib/finalize/finalization-queue';
import { createProofBundleService } from '@/lib/finalize/proof-bundle-service';
import { buildVerifierUrl } from '@/lib/finalize/finalize-urls';
import { resolveExpectedImageId } from '@/lib/verification/expected-image-id';
import { getZkvmModeViolation, resolveZkvmMode } from '@/lib/zkvm/zkvm-mode';
import { getDefaultExecutor } from '@/lib/zkvm/executor-factory';
import { FinalizeAcceptedResponseSchema, FinalizeSyncResponseSchema } from '@/lib/validation/apiSchemas';
import { finalizeSessionUsecase } from '@/lib/finalize/usecases/finalize-session';
import type { ApiContext } from '@/server/api/context';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import { enforceFinalizeRateLimit, recordFinalizeRateLimit } from '@/server/api/middleware/rateLimit';
import { validateSessionWithCapability } from '@/server/api/middleware/session';
import { requireTurnstileToken } from '@/server/api/middleware/turnstile';
import { parseFinalizeRequest } from '@/server/api/middleware/validation';
import { resolvePublicBaseUrl } from '@/server/api/utils/publicBaseUrl';
import { buildFinalizationQueueInfo } from '@/server/api/utils/finalizationQueueInfo';
import { logger } from '@/lib/utils/logger';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';

const finalizationQueue = createFinalizationQueue();
const proofBundleService = createProofBundleService();

/**
 * Finalize a voting session and trigger verification workflows.
 */
export async function finalizeSessionHandler({ request, store, clientIp }: ApiContext): Promise<Response> {
  const debugFinalize = process.env.DEBUG_FINALIZE === '1';

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

  await requireTurnstileToken({
    payload: parsedBody.raw,
    explicitToken: parsedBody.data.turnstileToken,
    clientIp: resolvedClientIp,
    expectedAction: 'finalize',
  });

  const baseUrlResult = resolvePublicBaseUrl(request);
  if (!baseUrlResult.ok) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: baseUrlResult.details,
    });
  }
  const publicBaseUrl = baseUrlResult.baseUrl;

  let expectedImageId: string;
  try {
    // Finalize must validate against the active journal contract we are about
    // to execute, not the release pointer in imageId-mapping.json.current.
    expectedImageId = await resolveExpectedImageId(CURRENT_METHOD_VERSION);
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

  const asyncMode = process.env.FINALIZE_ASYNC_MODE === 'true';
  const queueUrl = process.env.PROVER_WORK_QUEUE_URL;
  const publishMaxAttempts = Number(process.env.PROVER_PUBLISH_MAX_ATTEMPTS ?? 3);

  const usecaseResult = await finalizeSessionUsecase(
    {
      sessionId,
      session,
      scenarioId: parsedBody.data.scenarioId,
      expectedImageId,
      publicBaseUrl,
      asyncMode,
      queueUrl,
      publishMaxAttempts,
      clientMeta: {
        clientIp: resolvedClientIp,
        userAgent: request.headers.get('user-agent') ?? undefined,
        traceId: request.headers.get('x-trace-id') ?? undefined,
      },
      allowDevMode: zkvmMode.devMode,
      debugFinalize,
      buildBundleUrl: buildVerifierUrl,
    },
    {
      store,
      finalizationQueue,
      proofBundleService,
      getExecutor: getDefaultExecutor,
    },
  );

  if (!usecaseResult.ok) {
    if (usecaseResult.error.kind === 'invalid_image_id') {
      return jsonResponse(
        {
          error: 'Invalid ImageID',
          details: {
            expected: usecaseResult.error.expected,
            actual: usecaseResult.error.actual,
          },
        },
        { status: 400 },
      );
    }

    return errorResponse(usecaseResult.error.code, usecaseResult.error.details);
  }

  if (usecaseResult.value.kind === 'accepted') {
    await recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);

    const queueInfo = await buildFinalizationQueueInfo({
      queueUrl,
      state: usecaseResult.value.state,
    });

    return respondWithSchema(
      FinalizeAcceptedResponseSchema,
      {
        ...usecaseResult.value.payload,
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
    data: usecaseResult.value.payload,
  });
}
