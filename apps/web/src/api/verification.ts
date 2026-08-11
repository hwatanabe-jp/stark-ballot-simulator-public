import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import {
  type VerificationObservationRequest,
  type VerificationObservationResponse,
  type VerificationResource,
  type VerificationResourceQuery,
  type VerificationRunResponse,
} from '@stark-ballot/api-contract/schemas/verification';
import {
  ApiClientContractError,
  buildPathSessionHeaders,
  requestJsonRoute,
  type ApiClientRequestOptions,
  type ApiSessionIdentity,
} from './client';

function corruptVerificationResource(finalizationId: string, message: string): VerificationResource {
  return {
    availability: 'corrupt',
    finalizationId,
    reason: 'invalid_artifact',
    message,
  };
}

export async function getVerification(
  identity: ApiSessionIdentity,
  finalizationId: string,
  query: VerificationResourceQuery = {},
  options: ApiClientRequestOptions = {},
): Promise<VerificationResource> {
  try {
    const result = await requestJsonRoute(
      API_ROUTES.verification,
      buildApiRouteUrl(API_ROUTES.verification, {
        params: { sessionId: identity.sessionId, finalizationId },
        query,
      }),
      'verification',
      {
        ...options,
        headers: buildPathSessionHeaders(identity),
      },
    );
    if (result.body.data.finalizationId !== finalizationId) {
      return corruptVerificationResource(finalizationId, 'Verification response finalization identity mismatch');
    }
    return result.body.data;
  } catch (error) {
    if (error instanceof ApiClientContractError) {
      return corruptVerificationResource(finalizationId, error.message);
    }
    throw error;
  }
}

export async function runVerification(
  identity: ApiSessionIdentity,
  finalizationId: string,
  options: ApiClientRequestOptions = {},
): Promise<VerificationRunResponse['data']> {
  const result = await requestJsonRoute(
    API_ROUTES.runVerification,
    buildApiRouteUrl(API_ROUTES.runVerification, {
      params: { sessionId: identity.sessionId, finalizationId },
    }),
    'verification run',
    {
      ...options,
      headers: buildPathSessionHeaders(identity),
      body: {},
    },
  );
  if (result.body.data.finalizationId !== finalizationId) {
    throw new ApiClientContractError('Verification run response finalization identity mismatch');
  }
  return result.body.data;
}

export async function recordVerificationObservation(
  identity: ApiSessionIdentity,
  finalizationId: string,
  request: VerificationObservationRequest,
  options: ApiClientRequestOptions = {},
): Promise<VerificationObservationResponse['data']> {
  const result = await requestJsonRoute(
    API_ROUTES.recordVerificationObservation,
    buildApiRouteUrl(API_ROUTES.recordVerificationObservation, {
      params: { sessionId: identity.sessionId, finalizationId },
    }),
    'verification observation',
    {
      ...options,
      headers: buildPathSessionHeaders(identity),
      body: request,
    },
  );
  return result.body.data;
}
