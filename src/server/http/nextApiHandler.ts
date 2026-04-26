import type { NextRequest } from 'next/server';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { handleApiError } from '@/lib/errors/errorHandler';
import type { VoteStore } from '@/types/voteStore';
import { logRequestSummary, withRequestLogContext } from '@/server/http/requestLogging';

/**
 * Route params passed by Next.js route handlers.
 */
export type NextApiParams = Record<string, string | string[]>;

/**
 * Context injected into API handlers (store + request + optional params).
 */
export interface NextApiContext<TParams extends NextApiParams = NextApiParams> {
  request: NextRequest;
  store: VoteStore;
  params?: TParams | Promise<TParams>;
}

export type NextApiHandler<TParams extends NextApiParams = NextApiParams> = (
  context: NextApiContext<TParams>,
) => Promise<Response> | Response;

/**
 * Wraps a Next.js route handler with shared store access and error handling.
 */
export function createNextApiHandler<TParams extends NextApiParams = NextApiParams>(
  handler: NextApiHandler<TParams>,
): (request: NextRequest, context?: { params: TParams | Promise<TParams> }) => Promise<Response> {
  return async (request: NextRequest, context?: { params?: TParams | Promise<TParams> }) => {
    const store = getGlobalStore();
    const startedAt = Date.now();

    return await withRequestLogContext(
      request,
      async () => {
        try {
          const response = await handler({ request, store, params: context?.params });
          logRequestSummary(response, Date.now() - startedAt);
          return response;
        } catch (error) {
          const response = handleApiError(error);
          logRequestSummary(response, Date.now() - startedAt);
          return response;
        }
      },
      { service: 'next-api' },
    );
  };
}
