import type { VoteStore } from '@/types/voteStore';
import type { HttpRequest } from '@/server/http/types';

/**
 * Route params passed to API handlers.
 */
export type ApiParams = Record<string, string | string[]>;

/**
 * Context injected into API handlers.
 */
export interface ApiContext<TParams extends ApiParams = ApiParams> {
  request: HttpRequest;
  store: VoteStore;
  params?: TParams;
  clientIp?: string;
}

/**
 * Framework-agnostic API handler signature.
 */
export type ApiHandler<TParams extends ApiParams = ApiParams> = (
  context: ApiContext<TParams>,
) => Promise<Response> | Response;
