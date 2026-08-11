import type { Context } from 'hono';
import { getConnInfo as getAwsLambdaConnInfo } from 'hono/aws-lambda';
import type { ApiHandlerContext, ApiContextStore } from '../../api/context';
import { getRequestIp } from '../../api/security/turnstile';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

/**
 * Input for converting a Hono request to an ApiContext.
 */
export interface HonoAdapterInput {
  context: Context;
  runtimeProfile: ResolvedRuntimeProfile;
  store: ApiContextStore;
  requestId: string;
  operatorGatedDevelop: boolean;
  fallbackIp?: string | null;
}

type AwsRequestContextLike = {
  requestId?: unknown;
  http?: { sourceIp?: unknown };
  identity?: { sourceIp?: unknown };
};

type AwsEnvLike = {
  requestContext?: AwsRequestContextLike;
  event?: { requestContext?: AwsRequestContextLike };
};

interface HonoEnvContextLike {
  readonly env: unknown;
}

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

export function resolveAwsSourceIp(context: Context): string | null {
  const awsConnInfoIp = tryResolveIpWithAwsConnInfo(context);
  if (awsConnInfoIp) {
    return awsConnInfoIp;
  }

  return resolveAwsRequestContextSourceIp(context);
}

export function resolveAwsRequestContextSourceIp(context: HonoEnvContextLike): string | null {
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

export function resolveAwsRequestId(context: HonoEnvContextLike): string | null {
  const env = context.env as AwsEnvLike | undefined;
  const requestContext = env?.requestContext ?? env?.event?.requestContext;
  return asNonEmptyString(requestContext?.requestId);
}

/**
 * Convert a Hono Context to a framework-agnostic ApiContext.
 */
export function toApiHandlerContext(input: HonoAdapterInput): ApiHandlerContext {
  const { context, runtimeProfile, store, requestId, operatorGatedDevelop, fallbackIp } = input;
  const request = context.req.raw;
  const effectiveFallbackIp = fallbackIp ?? resolveAwsSourceIp(context);
  const clientIp = getRequestIp(runtimeProfile, request.headers, effectiveFallbackIp);

  return {
    runtimeProfile,
    store,
    requestId,
    requestOrigin: new URL(request.url).origin,
    operatorGatedDevelop,
    ...omitUndefinedProperties({ clientIp }),
  };
}
