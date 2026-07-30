import { createHash } from 'node:crypto';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { handleApiErrorPayload } from '@stark-ballot/api-contract/errors/errorPayload';
import {
  VerificationObservationResponseSchema,
  VerifyResponseSchema,
  VERIFICATION_OBSERVATION_CAST_CHECK_IDS,
  type VerificationObservationCastCheckId,
  type VerificationObservationCastStatus,
  type VerificationObservationRequest,
} from '@stark-ballot/api-contract/validation/apiSchemas';
import type { ApiContext } from '../context';
import { resolveVerificationObservationRecord } from '@stark-ballot/domain/types/verificationObservation';
import { errorResponse, jsonResponse } from '../../http/response';
import { validateSessionWithCapability } from '../middleware/session';
import { parseVerificationObservationRequest } from '../middleware/validation';
import {
  buildUnsupportedFinalizedArtifactResponse,
  resolveSupportedFinalizedRead,
} from '../utils/currentArtifactAdmission';
import { respondWithSchema } from '../utils/responseSchema';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { resolveNodeSthPublicRuntimeConfig } from '@stark-ballot/runtime-config/env/nodeSthPublicRuntimeConfig';
import { getVerifyHandler } from './verify';
import { emitVerificationRunSummaryObservation } from './verificationObservability';

const CAST_CHECK_ID_SET = new Set<VerificationCheckId>(VERIFICATION_OBSERVATION_CAST_CHECK_IDS);
const TERMINAL_VERIFICATION_STATUSES = new Set(['success', 'failed', 'dev_mode']);

function conflictResponse(): Response {
  return errorResponse(
    new ApiError(
      ErrorCode.VERIFICATION_OBSERVATION_CONFLICT,
      409,
      'Verification observation conflicts with the current finalized execution',
    ),
  );
}

function successResponse(status: 'idempotent' | 'recorded'): Response {
  return respondWithSchema(
    VerificationObservationResponseSchema,
    { data: { status } },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

function buildObservationFingerprint(request: VerificationObservationRequest): string {
  const fingerprintInput = [
    request.verificationExecutionId,
    ...VERIFICATION_OBSERVATION_CAST_CHECK_IDS.map((id) => request.castChecks[id]),
  ];
  return createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
}

export function buildObservedVerificationChecks(
  serverChecks: readonly VerificationCheck[],
  castChecks: Readonly<Record<VerificationObservationCastCheckId, VerificationObservationCastStatus>>,
): VerificationCheck[] | null {
  if (serverChecks.length !== VERIFICATION_CHECK_DEFINITIONS.length) {
    return null;
  }

  const checkById = new Map<VerificationCheckId, VerificationCheck>();
  for (const definition of VERIFICATION_CHECK_DEFINITIONS) {
    const matches = serverChecks.filter((check) => check.id === definition.id);
    if (matches.length !== 1 || !matches[0]) {
      return null;
    }
    checkById.set(definition.id, matches[0]);
  }

  return VERIFICATION_CHECK_DEFINITIONS.map((definition) => {
    const serverCheck = checkById.get(definition.id);
    if (!serverCheck) {
      throw new Error(`Missing server verification check: ${definition.id}`);
    }
    if (!CAST_CHECK_ID_SET.has(definition.id)) {
      return serverCheck;
    }
    const status = castChecks[definition.id as VerificationObservationCastCheckId];
    return {
      ...serverCheck,
      status,
    };
  });
}

/**
 * Record the first bounded browser-local cast observation for the current
 * verification execution and emit the server-derived final verdict once.
 */
export async function submitVerificationObservationHandler({ request, store }: ApiContext): Promise<Response> {
  try {
    const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
    if (sessionResult instanceof Response) {
      return sessionResult;
    }
    const { sessionId, session } = sessionResult;
    const parsedBody = await parseVerificationObservationRequest(request);
    if (parsedBody instanceof Response) {
      return parsedBody;
    }
    if (!session.finalized) {
      return errorResponse(ErrorCode.SESSION_NOT_FINALIZED);
    }

    const finalizedRead = resolveSupportedFinalizedRead(session);
    if (finalizedRead.artifactState) {
      return buildUnsupportedFinalizedArtifactResponse(finalizedRead.artifactState);
    }
    const finalizationResult = finalizedRead.finalizationResult;
    if (!finalizationResult) {
      return errorResponse(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    }

    const { verificationExecutionId, castChecks } = parsedBody.data;
    const verificationResult = finalizationResult.verificationResult;
    if (
      finalizationResult.verificationExecutionId !== verificationExecutionId ||
      !verificationResult ||
      !TERMINAL_VERIFICATION_STATUSES.has(verificationResult.status)
    ) {
      return conflictResponse();
    }

    const observation = {
      executionId: verificationExecutionId,
      fingerprint: buildObservationFingerprint(parsedBody.data),
      observedAt: Date.now(),
    };
    const existingResolution = resolveVerificationObservationRecord(
      verificationExecutionId,
      session.verificationObservation,
      observation,
    );
    if (existingResolution.status === 'conflict') {
      return conflictResponse();
    }
    if (existingResolution.status === 'idempotent') {
      return successResponse('idempotent');
    }

    const verifyResponse = await getVerifyHandler({ request, store });
    if (!verifyResponse.ok) {
      return verifyResponse;
    }
    const verifyPayload = VerifyResponseSchema.safeParse((await verifyResponse.json()) as unknown);
    if (!verifyPayload.success) {
      return errorResponse(ErrorCode.INTERNAL_ERROR, {
        details: 'Server verification authority was unavailable',
      });
    }
    const verifyData = verifyPayload.data.data;
    if (verifyData.verificationExecutionId !== verificationExecutionId || !verifyData.verificationChecks) {
      return errorResponse(ErrorCode.INTERNAL_ERROR, {
        details: 'Server verification authority did not match the current execution',
      });
    }

    const observedChecks = buildObservedVerificationChecks(verifyData.verificationChecks, castChecks);
    if (!observedChecks) {
      return errorResponse(ErrorCode.INTERNAL_ERROR, {
        details: 'Server verification check authority was incomplete',
      });
    }

    const recordResult = await store.recordVerificationObservation(sessionId, observation);
    if (recordResult.status === 'conflict') {
      return conflictResponse();
    }

    if (recordResult.status === 'recorded') {
      const sthRuntimeConfig = resolveNodeSthPublicRuntimeConfig();
      const devModeReceipt = verificationResult.devModeReceipt ?? verificationResult.report?.dev_mode_receipt;
      emitVerificationRunSummaryObservation({
        checks: observedChecks,
        summaryContext: {
          missingSlots: verifyData.missingSlots,
          invalidPresentedSlots: verifyData.invalidPresentedSlots,
          rejectedRecords: verifyData.rejectedRecords,
          excludedSlots: verifyData.excludedSlots,
          ...(typeof devModeReceipt === 'boolean' ? { devModeEvidence: devModeReceipt } : {}),
          sthSourcesConfigured: sthRuntimeConfig.sources.length > 0,
        },
        persistedScenarios: finalizationResult.scenarios,
        verificationResult,
        ...(typeof devModeReceipt === 'boolean' ? { devModeReceipt } : {}),
        sessionId,
        executionId: verificationExecutionId,
      });
    }

    return successResponse(recordResult.status);
  } catch (error) {
    const payload = handleApiErrorPayload(error);
    return jsonResponse(payload, { status: payload.statusCode });
  }
}
