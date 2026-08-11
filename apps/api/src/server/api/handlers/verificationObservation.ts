import { createHash } from 'node:crypto';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import {
  VerificationResourceResponseSchema,
  VERIFICATION_OBSERVATION_CAST_CHECK_IDS,
  type VerificationObservationCastCheckId,
  type VerificationObservationCastStatus,
  type VerificationObservationRequest,
} from '@stark-ballot/api-contract/schemas/verification';
import type { ApiHandlerArguments, SessionAdmittedContext } from '../context';
import { recordVerificationObservationRoute } from '@stark-ballot/api-contract/routes';
import { errorResponse } from '../../http/response';
import { handleApiError } from '../../http/errorHandler';
import { respondWithRoute } from '../utils/responseSchema';
import type { VerificationCheck } from '@stark-ballot/verification/checks';
import { resolveNodeSthPublicRuntimeConfig } from '@stark-ballot/runtime-config/env/nodeSthPublicRuntimeConfig';
import { getVerifyHandler } from './verify';
import { emitVerificationRunSummaryObservation } from './verificationObservability';
import { overlayLocalCastChecks, type LocalCastCheckResults } from '@stark-ballot/verification/local-cast-checks';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const TERMINAL_VERIFICATION_STATUSES = new Set(['success', 'failed', 'dev_mode']);

function conflictResponse(): Response {
  return errorResponse(
    new ApiError(
      ErrorCode.VERIFICATION_OBSERVATION_CONFLICT,
      409,
      'Verification observation conflicts with the current finalization',
    ),
  );
}

function successResponse(status: 'idempotent' | 'recorded'): Response {
  return respondWithRoute(
    recordVerificationObservationRoute,
    { status: 200, content: 'json', body: { data: { status } } },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

function buildObservationFingerprint(finalizationId: string, request: VerificationObservationRequest): string {
  const fingerprintInput = [
    finalizationId,
    ...VERIFICATION_OBSERVATION_CAST_CHECK_IDS.map((id) => request.castChecks[id]),
  ];
  return createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
}

export function buildObservedVerificationChecks(
  serverChecks: readonly VerificationCheck[],
  castChecks: Readonly<Record<VerificationObservationCastCheckId, VerificationObservationCastStatus>>,
): VerificationCheck[] | null {
  const localResults = Object.fromEntries(
    VERIFICATION_OBSERVATION_CAST_CHECK_IDS.map((id) => [id, { status: castChecks[id] }]),
  ) as LocalCastCheckResults;
  return overlayLocalCastChecks(serverChecks, localResults);
}

/**
 * Record the first bounded browser-local cast observation for the current
 * finalization and emit the server-derived final verdict once.
 */
export async function submitVerificationObservationHandler({
  input,
  context,
}: ApiHandlerArguments<typeof recordVerificationObservationRoute, SessionAdmittedContext>): Promise<Response> {
  try {
    const { sessionId, session, store } = context;
    if (session.finalization?.state.status !== 'succeeded' || !session.finalization.finalizationResult) {
      return errorResponse(ErrorCode.SESSION_NOT_FINALIZED);
    }

    const { finalizationId } = input.params;
    const { castChecks } = input.body;
    const finalizationResult = session.finalization.finalizationResult;
    const verificationRecord = await store.getVerificationResultRecord(sessionId, finalizationId);
    const verificationResult = verificationRecord?.verificationResult;
    if (
      finalizationResult.finalizationId !== finalizationId ||
      !verificationResult ||
      !TERMINAL_VERIFICATION_STATUSES.has(verificationResult.status)
    ) {
      return conflictResponse();
    }

    const observation = {
      fingerprint: buildObservationFingerprint(finalizationId, input.body),
      observedAt: Date.now(),
    };

    const verifyResponse = await getVerifyHandler({
      input: {
        params: input.params,
        headers: input.headers,
        query: {},
      },
      context,
    });
    if (!verifyResponse.ok) {
      return verifyResponse;
    }
    const verifyPayload = VerificationResourceResponseSchema.safeParse((await verifyResponse.json()) as unknown);
    if (!verifyPayload.success || verifyPayload.data.data.availability !== 'available') {
      return errorResponse(ErrorCode.INTERNAL_ERROR, {
        details: 'Server verification authority was unavailable',
      });
    }
    const verifyData = verifyPayload.data.data;
    if (verifyData.finalizationId !== finalizationId) {
      return errorResponse(ErrorCode.INTERNAL_ERROR, {
        details: 'Server verification authority did not match the current finalization',
      });
    }

    const observedChecks = buildObservedVerificationChecks(
      verifyData.verification.checks.map((check) => omitUndefinedProperties(check)),
      castChecks,
    );
    if (!observedChecks) {
      return errorResponse(ErrorCode.INTERNAL_ERROR, {
        details: 'Server verification check authority was incomplete',
      });
    }

    const recordResult = await store.recordVerificationObservation(sessionId, finalizationId, observation);
    if (recordResult.status === 'conflict') {
      return conflictResponse();
    }

    if (recordResult.status === 'recorded') {
      const sthRuntimeConfig = resolveNodeSthPublicRuntimeConfig();
      const devModeReceipt = verificationResult.report?.dev_mode_receipt;
      emitVerificationRunSummaryObservation({
        checks: observedChecks,
        summaryContext: {
          missingSlots: verifyData.proofAuthority.missingSlots,
          invalidPresentedSlots: verifyData.proofAuthority.invalidPresentedSlots,
          rejectedRecords: verifyData.proofAuthority.rejectedRecords,
          excludedSlots: verifyData.proofAuthority.excludedSlots,
          ...(typeof devModeReceipt === 'boolean' ? { devModeEvidence: devModeReceipt } : {}),
          sthSourcesConfigured: sthRuntimeConfig.sources.length > 0,
        },
        persistedScenarios: finalizationResult.scenarios,
        verificationResult,
        ...(typeof devModeReceipt === 'boolean' ? { devModeReceipt } : {}),
        sessionId,
        finalizationId,
      });
    }

    return successResponse(recordResult.status);
  } catch (error) {
    return handleApiError(error);
  }
}
