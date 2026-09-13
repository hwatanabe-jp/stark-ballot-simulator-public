import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import type { VoteRequest, VoteResponse } from '@stark-ballot/api-contract/schemas/votes';
import {
  buildPathSessionHeaders,
  requestJsonRoute,
  type ApiClientRequestOptions,
  type ApiSessionIdentity,
} from './client';

export async function submitVote(
  identity: ApiSessionIdentity,
  request: VoteRequest,
  options: ApiClientRequestOptions = {},
): Promise<VoteResponse['data']> {
  const result = await requestJsonRoute(
    API_ROUTES.submitVote,
    {
      params: { sessionId: identity.sessionId },
      headers: buildPathSessionHeaders(identity),
      body: request,
    },
    'vote',
    options,
  );
  return result.body.data;
}
