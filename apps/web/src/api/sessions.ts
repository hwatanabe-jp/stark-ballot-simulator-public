import { admitSessionIdentity, type BrowserSessionIdentity } from '../session/identity';
import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import type { SessionCreateRequest, SessionResponse } from '@stark-ballot/api-contract/schemas/sessions';
import { requestJsonRoute, type ApiClientRequestOptions } from './client';

export async function createSession(
  request: SessionCreateRequest,
  options: ApiClientRequestOptions = {},
): Promise<SessionResponse['data'] & BrowserSessionIdentity> {
  const result = await requestJsonRoute(API_ROUTES.createSession, { body: request }, 'session create', options);
  return { ...result.body.data, ...admitSessionIdentity(result.body.data) };
}
