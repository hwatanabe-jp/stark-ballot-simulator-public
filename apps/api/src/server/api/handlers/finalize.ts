import { ErrorCode, type ErrorDetails } from '@stark-ballot/api-contract/errors/apiErrors';
import { createFinalizationRoute } from '@stark-ballot/api-contract/routes';
import type { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizeSessionInput } from '@stark-ballot/application/finalize/usecases/finalize-session';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { FinalizationDependencies } from '../../composition/finalizationDependencies';
import { errorResponse } from '../../http/response';
import type { ApiHandlerArguments, SessionAdmittedContext } from '../context';
import type { FinalizeRateLimitContext } from '../middleware/rateLimit';
import { buildFinalizationQueueInfo } from '../utils/finalizationQueueInfo';
import { projectFinalizeSyncPayloadForResponse } from '../utils/finalizationResultProjection';
import { projectFinalizationResourceForPublicResponse } from '../utils/finalizationStateProjection';
import { respondWithRoute } from '../utils/responseSchema';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

function resolveExecutorModeLabel(profile: ResolvedRuntimeProfile): string {
  if (profile.proof.executor === 'mock') {
    return '[API] Mock zkVM mode (JavaScript, ~100ms)';
  }
  if (profile.proof.evidence === 'development') {
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
type FinalizeHandlerContext = SessionAdmittedContext & {
  finalizeRateLimit: FinalizeRateLimitContext;
  finalizationDependencies: FinalizationDependencies;
};

export async function finalizeSessionHandler({
  input,
  context,
}: ApiHandlerArguments<typeof createFinalizationRoute, FinalizeHandlerContext>): Promise<Response> {
  const debugFinalize = process.env['DEBUG_FINALIZE'] === '1';
  const { session, sessionId, store, finalizeRateLimit, runtimeProfile } = context;
  const dependencies = context.finalizationDependencies;
  const { clientIp: resolvedClientIp, rateLimiter, shouldRecord } = finalizeRateLimit;
  const proofBundleService = dependencies.createProofBundleService(store);

  let expectedImageId: string;
  try {
    expectedImageId = await dependencies.resolveExpectedImageId();
  } catch (error) {
    return errorResponse(ErrorCode.INTERNAL_ERROR, {
      details: error instanceof Error ? error.message : 'Failed to resolve expected ImageID',
    });
  }

  const queueUrl =
    runtimeProfile.external.kind === 'aws' ? runtimeProfile.external.asyncRuntime.proverWorkQueueUrl : undefined;
  const publishMaxAttempts = Number(process.env['PROVER_PUBLISH_MAX_ATTEMPTS'] ?? 3);
  const finalizeInputBase = {
    sessionId,
    identity: session.identity,
    voting: session.voting,
    currentFinalization: session.finalization,
    scenarioId: input.body.scenarioId,
    expectedImageId,
    publishMaxAttempts,
    allowDevMode: runtimeProfile.proof.evidence === 'development',
    debugFinalize,
    debugFileStore: process.env['DEBUG_FILE_STORE'] === '1',
    executorModeLabel: resolveExecutorModeLabel(runtimeProfile),
    bitmapProofSource: runtimeProfile.proof.executor === 'mock' ? ('mock' as const) : ('real' as const),
  };
  const finalizeInput: FinalizeSessionInput =
    runtimeProfile.finalization.mode === 'async'
      ? {
          ...finalizeInputBase,
          finalizationMode: {
            kind: 'async',
            inputSource: runtimeProfile.artifacts.kind === 's3' ? 's3' : 'inline',
          },
        }
      : {
          ...finalizeInputBase,
          finalizationMode: { kind: 'sync' },
        };

  const usecaseResult = await dependencies.finalizeSession(finalizeInput, {
    store,
    finalizationQueue: dependencies.finalizationQueue,
    proofBundleService,
    getExecutor: dependencies.getExecutor,
    persistAsyncProverInput: dependencies.persistAsyncProverInput,
  });

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

  await dependencies.recordFinalizeRateLimit(rateLimiter, resolvedClientIp, shouldRecord);

  if (usecaseResult.value.kind === 'accepted') {
    const queue = await buildFinalizationQueueInfo({
      ...omitUndefinedProperties({ queueUrl }),
      state: usecaseResult.value.state,
    });
    const resource = projectFinalizationResourceForPublicResponse({
      state: usecaseResult.value.payload.state,
      runtimeDiagnostics: {
        asyncMode: 'enabled',
        queue,
      },
    });

    return respondWithRoute(
      createFinalizationRoute,
      {
        status: 202,
        content: 'json',
        body: { data: resource },
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  return respondWithRoute(
    createFinalizationRoute,
    {
      status: 200,
      content: 'json',
      body: {
        data: projectFinalizeSyncPayloadForResponse(usecaseResult.value.payload),
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
