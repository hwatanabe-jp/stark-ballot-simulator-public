import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';
import { createHash } from 'node:crypto';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import {
  VerificationResourceResponseSchema,
  VERIFICATION_OBSERVATION_CAST_CHECK_IDS,
  type VerificationObservationCastCheckId,
  type VerificationObservationCastStatus,
  type VerificationObservationRequest,
  type AvailableVerificationResource,
} from '@stark-ballot/api-contract/schemas/verification';
import type { ApiHandlerArguments, RouteBoundResponse, SessionFinalizationAdmittedContext } from '../context';
import { recordVerificationObservationRoute } from '@stark-ballot/api-contract/routes';
import { handleApiError } from '../../http/errorHandler';
import { admitRouteErrorResponse, respondWithRoute, respondWithRouteError } from '../utils/responseSchema';
import type { VerificationCheck } from '@stark-ballot/verification/checks';
import { resolveNodeSthPublicRuntimeConfig } from '@stark-ballot/runtime-config/env/nodeSthPublicRuntimeConfig';
import { getVerifyHandler } from './verify';
import { emitVerificationRunSummaryObservation } from './verificationObservability';
import { overlayLocalCastChecks, type LocalCastCheckResults } from '@stark-ballot/verification/local-cast-checks';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const TERMINAL_VERIFICATION_STATUSES = new Set(['success', 'failed', 'dev_mode']);

function conflictResponse(): RouteBoundResponse<typeof recordVerificationObservationRoute> {
  return respondWithRouteError(recordVerificationObservationRoute, {
    code: ErrorCode.VERIFICATION_OBSERVATION_CONFLICT,
    status: 409,
    message: 'Verification observation conflicts with the current finalization',
  });
}

function successResponse(
  status: 'idempotent' | 'recorded',
): RouteBoundResponse<typeof recordVerificationObservationRoute> {
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

type ObservationArguments = ApiHandlerArguments<
  typeof recordVerificationObservationRoute,
  SessionFinalizationAdmittedContext
>;
type ObservationChecks = { verifyData: AvailableVerificationResource; observedChecks: VerificationCheck[] };

function admitObservationVerificationResult(
  currentId: string,
  requestedId: string,
  result: VerificationResult | undefined,
): VerificationResult | undefined {
  if (currentId !== requestedId || !result || !TERMINAL_VERIFICATION_STATUSES.has(result.status)) return undefined;
  return result;
}

async function resolveObservationChecks(
  input: ObservationArguments['input'],
  context: SessionFinalizationAdmittedContext,
): Promise<
  | ObservationChecks
  | {
      response:
        | RouteBoundResponse<typeof recordVerificationObservationRoute>
        | Promise<RouteBoundResponse<typeof recordVerificationObservationRoute>>;
    }
> {
  const { finalizationId } = context;
  const { castChecks } = input.body;
  const verifyResponse = await getVerifyHandler({
    input: {
      params: input.params,
      headers: input.headers,
      query: {},
    },
    context,
  });
  if (!verifyResponse.ok) {
    return { response: admitRouteErrorResponse(recordVerificationObservationRoute, verifyResponse) };
  }
  const verifyPayload = VerificationResourceResponseSchema.safeParse(await verifyResponse.json());
  if (!verifyPayload.success || verifyPayload.data.data.availability !== 'available') {
    return {
      response: respondWithRouteError(recordVerificationObservationRoute, {
        code: ErrorCode.INTERNAL_ERROR,
        status: 500,
        details: { details: 'Server verification authority was unavailable' },
      }),
    };
  }
  const verifyData = verifyPayload.data.data;
  if (verifyData.finalizationId !== finalizationId) {
    return {
      response: respondWithRouteError(recordVerificationObservationRoute, {
        code: ErrorCode.INTERNAL_ERROR,
        status: 500,
        details: { details: 'Server verification authority did not match the current finalization' },
      }),
    };
  }

  const observedChecks = buildObservedVerificationChecks(
    verifyData.verification.checks.map((check) => omitUndefinedProperties(check)),
    castChecks,
  );
  if (!observedChecks) {
    return {
      response: respondWithRouteError(recordVerificationObservationRoute, {
        code: ErrorCode.INTERNAL_ERROR,
        status: 500,
        details: { details: 'Server verification check authority was incomplete' },
      }),
    };
  }

  return { verifyData, observedChecks };
}

function emitRecordedObservation(
  input: ObservationChecks & {
    sessionId: string;
    finalizationId: string;
    finalizationResult: FinalizationResultAuthority;
    verificationResult: VerificationResult;
  },
): void {
  const { sessionId, finalizationId, finalizationResult, verificationResult, verifyData, observedChecks } = input;
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

/**
 * Record the first bounded browser-local cast observation for the current
 * finalization and emit the server-derived final verdict once.
 */
export async function submitVerificationObservationHandler({
  input,
  context,
}: ApiHandlerArguments<typeof recordVerificationObservationRoute, SessionFinalizationAdmittedContext>): Promise<
  RouteBoundResponse<typeof recordVerificationObservationRoute>
> {
  try {
    const { sessionId, finalizationId, session, store } = context;
    if (session.finalization?.state.status !== 'succeeded' || !session.finalization.finalizationResult) {
      return respondWithRouteError(recordVerificationObservationRoute, {
        code: ErrorCode.SESSION_NOT_FINALIZED,
        status: 400,
      });
    }

    const finalizationResult = session.finalization.finalizationResult;
    const verificationRecord = await store.getVerificationResultRecord(sessionId, finalizationId);
    const verificationResult = admitObservationVerificationResult(
      finalizationResult.finalizationId,
      finalizationId,
      verificationRecord?.verificationResult,
    );
    if (!verificationResult) return conflictResponse();

    const observation = {
      fingerprint: buildObservationFingerprint(finalizationId, input.body),
      observedAt: Date.now(),
    };

    const resolvedChecks = await resolveObservationChecks(input, context);
    if ('response' in resolvedChecks) return resolvedChecks.response;
    const { verifyData, observedChecks } = resolvedChecks;

    const recordResult = await store.recordVerificationObservation(sessionId, finalizationId, observation);
    if (recordResult.status === 'conflict') {
      return conflictResponse();
    }

    if (recordResult.status === 'recorded') {
      emitRecordedObservation({
        sessionId,
        finalizationId,
        finalizationResult,
        verificationResult,
        verifyData,
        observedChecks,
      });
    }

    return successResponse(recordResult.status);
  } catch (error) {
    return admitRouteErrorResponse(recordVerificationObservationRoute, handleApiError(error));
  }
}
