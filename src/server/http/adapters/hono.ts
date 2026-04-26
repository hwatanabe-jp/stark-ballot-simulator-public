import type { Context } from 'hono';
import { getConnInfo as getAwsLambdaConnInfo } from 'hono/aws-lambda';
import type { ApiContext, ApiParams } from '@/server/api/context';
import type { VoteStore } from '@/types/voteStore';
import { getRequestIp } from '@/lib/security/turnstile';

/**
 * Input for converting a Hono request to an ApiContext.
 */
export interface HonoAdapterInput<TParams extends ApiParams> {
  context: Context;
  store: VoteStore;
  params?: TParams;
  fallbackIp?: string | null;
}

type AwsRequestContextLike = {
  http?: { sourceIp?: unknown };
  identity?: { sourceIp?: unknown };
};

type AwsEnvLike = {
  requestContext?: AwsRequestContextLike;
  event?: { requestContext?: AwsRequestContextLike };
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tryResolveIpWithAwsConnInfo(context: Context): string | null {
  const env = context.env as AwsEnvLike | undefined;
  if (!env?.requestContext || typeof env.requestContext !== 'object') {
    return null;
  }

  try {
    const connInfo = getAwsLambdaConnInfo(context);
    return asNonEmptyString(connInfo.remote.address);
  } catch {
    return null;
  }
}

function resolveAwsSourceIp(context: Context): string | null {
  const awsConnInfoIp = tryResolveIpWithAwsConnInfo(context);
  if (awsConnInfoIp) {
    return awsConnInfoIp;
  }

  const env = context.env as AwsEnvLike | undefined;
  const requestContext = env?.requestContext ?? env?.event?.requestContext;
  if (!requestContext) {
    return null;
  }

  const httpSourceIp = asNonEmptyString(requestContext.http?.sourceIp);
  if (httpSourceIp) {
    return httpSourceIp;
  }

  const identitySourceIp = asNonEmptyString(requestContext.identity?.sourceIp);
  if (identitySourceIp) {
    return identitySourceIp;
  }

  return null;
}

/**
 * Convert a Hono Context to a framework-agnostic ApiContext.
 */
export function toApiContext<TParams extends ApiParams>(input: HonoAdapterInput<TParams>): ApiContext<TParams> {
  const { context, store, params, fallbackIp } = input;
  const request = context.req.raw;
  const effectiveFallbackIp = fallbackIp ?? resolveAwsSourceIp(context);
  const clientIp = getRequestIp(request.headers, effectiveFallbackIp);

  return {
    request,
    store,
    params,
    clientIp,
  };
}
