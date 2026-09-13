import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import {
  type FinalizationCancelRequest,
  type FinalizationCreateRequest,
  type FinalizationResource,
} from '@stark-ballot/api-contract/schemas/finalizations';
import {
  buildPathSessionHeaders,
  requestJsonRoute,
  resolveApiClientErrorCode,
  type ApiClientRequestOptions,
  type ApiSessionIdentity,
} from './client';

export type StartFinalizationResult =
  | { status: 200; data: FinalizationResource }
  | { status: 202; data: FinalizationResource };

export async function startFinalization(
  identity: ApiSessionIdentity,
  request: FinalizationCreateRequest,
  options: ApiClientRequestOptions = {},
): Promise<StartFinalizationResult> {
  const result = await requestJsonRoute(
    API_ROUTES.createFinalization,
    {
      params: { sessionId: identity.sessionId },
      headers: buildPathSessionHeaders(identity),
      body: request,
    },
    'finalization',
    options,
  );
  return { status: result.status, data: result.body.data };
}

export async function fetchCurrentFinalization(
  identity: ApiSessionIdentity,
  options: ApiClientRequestOptions = {},
): Promise<FinalizationResource | null> {
  const result = await requestJsonRoute(
    API_ROUTES.currentFinalization,
    {
      params: { sessionId: identity.sessionId },
      headers: buildPathSessionHeaders(identity),
    },
    'current finalization',
    options,
  );
  return result.body.data;
}

export async function cancelFinalization(
  identity: ApiSessionIdentity,
  finalizationId: string,
  request: FinalizationCancelRequest = {},
  options: ApiClientRequestOptions = {},
): Promise<FinalizationResource> {
  const result = await requestJsonRoute(
    API_ROUTES.cancelFinalization,
    {
      params: {
        sessionId: identity.sessionId,
        finalizationId,
      },
      headers: buildPathSessionHeaders(identity),
      body: request,
    },
    'finalization cancellation',
    options,
  );
  return result.body.data;
}

export function resolveFinalizationStatusErrorCode(error: unknown): string | null {
  return resolveApiClientErrorCode(error);
}
