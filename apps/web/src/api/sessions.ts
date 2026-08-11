import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import type { SessionCreateRequest, SessionResponse } from '@stark-ballot/api-contract/schemas/sessions';
import { requestJsonRoute, type ApiClientRequestOptions } from './client';

export async function createSession(
  request: SessionCreateRequest,
  options: ApiClientRequestOptions = {},
): Promise<SessionResponse['data']> {
  const result = await requestJsonRoute(
    API_ROUTES.createSession,
    buildApiRouteUrl(API_ROUTES.createSession),
    'session create',
    { ...options, body: request },
  );
  return result.body.data;
}
