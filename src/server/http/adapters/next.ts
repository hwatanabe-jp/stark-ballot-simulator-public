import type { NextRequest } from 'next/server';
import type { ApiContext, ApiParams } from '@/server/api/context';
import type { VoteStore } from '@/types/voteStore';
import { getRequestIp } from '@/lib/security/turnstile';

/**
 * Input for converting a Next.js request to an ApiContext.
 */
export interface NextAdapterInput<TParams extends ApiParams> {
  request: NextRequest;
  store: VoteStore;
  params?: TParams | Promise<TParams>;
}

/**
 * Convert a Next.js request to a framework-agnostic ApiContext.
 */
export async function toApiContext<TParams extends ApiParams>(
  input: NextAdapterInput<TParams>,
): Promise<ApiContext<TParams>> {
  const params = await resolveParams(input.params);
  return {
    request: input.request,
    store: input.store,
    params,
    clientIp: getRequestIp(input.request.headers, resolveFallbackIp(input.request)),
  };
}

async function resolveParams<TParams>(params?: TParams | Promise<TParams>): Promise<TParams | undefined> {
  if (!params) {
    return undefined;
  }
  return await params;
}

function resolveFallbackIp(request: NextRequest): string | null {
  if (!hasRequestIp(request)) {
    return null;
  }

  const ipValue = request.ip;
  if (typeof ipValue === 'string' && ipValue.trim().length > 0) {
    return ipValue.trim();
  }

  return null;
}

function hasRequestIp(request: NextRequest): request is NextRequest & { ip?: string | null } {
  return 'ip' in request;
}
