import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import type { ProgressResponse } from '@stark-ballot/api-contract/schemas/progress';
import {
  buildPathSessionHeaders,
  requestJsonRoute,
  type ApiClientRequestOptions,
  type ApiSessionIdentity,
} from './client';

export async function getProgress(
  identity: ApiSessionIdentity,
  options: ApiClientRequestOptions = {},
): Promise<ProgressResponse['data']> {
  const result = await requestJsonRoute(
    API_ROUTES.progress,
    {
      params: { sessionId: identity.sessionId },
      headers: buildPathSessionHeaders(identity),
    },
    'progress',
    options,
  );
  return result.body.data;
}
