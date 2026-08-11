import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import {
  FinalizationResourceSchema,
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
  { status: 200; data: FinalizationResource } | { status: 202; data: FinalizationResource };

export async function startFinalization(
  identity: ApiSessionIdentity,
  request: FinalizationCreateRequest,
  options: ApiClientRequestOptions = {},
): Promise<StartFinalizationResult> {
  const result = await requestJsonRoute(
    API_ROUTES.createFinalization,
    buildApiRouteUrl(API_ROUTES.createFinalization, {
      params: { sessionId: identity.sessionId },
    }),
    'finalization',
    {
      ...options,
      headers: buildPathSessionHeaders(identity),
      body: request,
    },
  );
  return { status: result.status, data: result.body.data };
}

export async function fetchCurrentFinalization(
  identity: ApiSessionIdentity,
  options: ApiClientRequestOptions = {},
): Promise<FinalizationResource | null> {
  const result = await requestJsonRoute(
    API_ROUTES.currentFinalization,
    buildApiRouteUrl(API_ROUTES.currentFinalization, {
      params: { sessionId: identity.sessionId },
    }),
    'current finalization',
    {
      ...options,
      headers: buildPathSessionHeaders(identity),
    },
  );
  return result.body.data;
}

export function parseFinalizationResource(input: unknown): FinalizationResource {
  const parsed = FinalizationResourceSchema.safeParse(input);
  if (!parsed.success) {
    const issueMessage = parsed.error.issues[0]?.message ?? 'schema validation failed';
    throw new Error(`Invalid finalization resource payload: ${issueMessage}`);
  }
  return parsed.data;
}

export async function cancelFinalization(
  identity: ApiSessionIdentity,
  finalizationId: string,
  request: FinalizationCancelRequest = {},
  options: ApiClientRequestOptions = {},
): Promise<FinalizationResource> {
  const result = await requestJsonRoute(
    API_ROUTES.cancelFinalization,
    buildApiRouteUrl(API_ROUTES.cancelFinalization, {
      params: {
        sessionId: identity.sessionId,
        finalizationId,
      },
    }),
    'finalization cancellation',
    {
      ...options,
      headers: buildPathSessionHeaders(identity),
      body: request,
    },
  );
  return result.body.data;
}

export function resolveFinalizationStatusErrorCode(error: unknown): string | null {
  return resolveApiClientErrorCode(error);
}
