import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import type {
  BulletinProofResponse,
  BulletinQuery,
  BulletinResponse,
  ConsistencyProofQuery,
  ConsistencyProofResponse,
  SthQuery,
  SthResponse,
} from '@stark-ballot/api-contract/schemas/bulletin';
import {
  ApiClientContractError,
  buildPathSessionHeaders,
  requestJsonRoute,
  type ApiClientRequestOptions,
  type ApiSessionIdentity,
} from './client';

export interface BulletinResult {
  data: BulletinResponse['data'];
  page?: BulletinResponse['meta']['page'];
}

export async function getBulletin(
  identity: ApiSessionIdentity,
  query: BulletinQuery = {},
  options: ApiClientRequestOptions = {},
): Promise<BulletinResult> {
  const result = await requestJsonRoute(
    API_ROUTES.sessionBulletin,
    buildApiRouteUrl(API_ROUTES.sessionBulletin, {
      params: { sessionId: identity.sessionId },
      query,
    }),
    'bulletin',
    { ...options, headers: buildPathSessionHeaders(identity) },
  );
  return {
    data: result.body.data,
    ...(result.body.meta.page ? { page: result.body.meta.page } : {}),
  };
}

export async function getBulletinVoteProof(
  identity: ApiSessionIdentity,
  voteId: string,
  options: ApiClientRequestOptions = {},
): Promise<BulletinProofResponse['data']> {
  const result = await requestJsonRoute(
    API_ROUTES.sessionVoteInclusionProof,
    buildApiRouteUrl(API_ROUTES.sessionVoteInclusionProof, {
      params: { sessionId: identity.sessionId, voteId },
    }),
    'bulletin vote proof',
    { ...options, headers: buildPathSessionHeaders(identity) },
  );
  return result.body.data;
}

export async function getBulletinConsistencyProof(
  identity: ApiSessionIdentity,
  query: ConsistencyProofQuery,
  options: ApiClientRequestOptions = {},
): Promise<ConsistencyProofResponse['data']> {
  const result = await requestJsonRoute(
    API_ROUTES.sessionBulletinConsistencyProof,
    buildApiRouteUrl(API_ROUTES.sessionBulletinConsistencyProof, {
      params: { sessionId: identity.sessionId },
      query,
    }),
    'bulletin consistency proof',
    { ...options, headers: buildPathSessionHeaders(identity) },
  );
  return result.body.data;
}

export async function getSameOriginSth(
  identity: ApiSessionIdentity,
  query: SthQuery = {},
  options: ApiClientRequestOptions = {},
): Promise<SthResponse['data']> {
  if (options.baseUrl) {
    throw new ApiClientContractError('Same-origin STH requests cannot override the API base URL');
  }
  const result = await requestJsonRoute(
    API_ROUTES.sessionBulletinSth,
    buildApiRouteUrl(API_ROUTES.sessionBulletinSth, {
      params: { sessionId: identity.sessionId },
      query,
    }),
    'STH',
    {
      ...(options.signal ? { signal: options.signal } : {}),
      headers: buildPathSessionHeaders(identity),
    },
  );
  return result.body.data;
}
