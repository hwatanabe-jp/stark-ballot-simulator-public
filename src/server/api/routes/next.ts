import type { NextRequest } from 'next/server';
import { createNextApiHandler, type NextApiParams } from '@/server/http/nextApiHandler';
import type { ApiHandler } from '@/server/api/context';
import { toApiContext } from '@/server/http/adapters/next';

/**
 * Bind a framework-agnostic handler to a Next.js Route Handler.
 */
export function createNextRoute<TParams extends NextApiParams>(
  handler: ApiHandler<TParams>,
): (request: NextRequest, context?: { params: TParams | Promise<TParams> }) => Promise<Response> {
  return createNextApiHandler(async ({ request, store, params }) => {
    const context = await toApiContext({ request, store, params });
    return handler(context);
  });
}
