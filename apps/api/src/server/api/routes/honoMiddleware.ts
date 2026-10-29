import { randomUUID } from 'node:crypto';
import { cors } from 'hono/cors';
import { matchedRoutes } from 'hono/route';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { resolveAwsRequestContextSourceIp, resolveAwsRequestId } from '../../http/adapters/hono';
import { handleApiError } from '../../http/errorHandler';
import {
  logRequestSummary,
  resolveUntrustedClientRequestId,
  withRequestLogContext,
  withTrustedRequestIdHeader,
} from '../../http/requestLogging';
import type { ApiHonoApp } from './honoRegistration';

function getCorsOrigins(): string[] {
  const envOrigins = process.env['HONO_CORS_ALLOW_ORIGINS'];
  return envOrigins ? envOrigins.split(',').map((origin) => origin.trim()) : ['http://localhost:3000'];
}

export function registerRequestMiddleware(
  app: ApiHonoApp,
  runtimeProfile: ResolvedRuntimeProfile,
  basePath: string,
): void {
  app.use('*', async (context, next) => {
    const startedAt = Date.now();
    const request = context.req.raw;
    const requestId = resolveAwsRequestId(context) ?? randomUUID();
    context.set('trustedRequestId', requestId);
    const clientRequestId = resolveUntrustedClientRequestId(request.headers);
    // Hono 4.13's helper accepts a Context whose public declaration erases the environment generics.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const matchedRoutePath = matchedRoutes(context).at(-1)?.path;
    const safeRoutePath = matchedRoutePath && matchedRoutePath !== '*' ? matchedRoutePath : `${basePath}/*`;

    await withRequestLogContext(
      runtimeProfile,
      request,
      async () => {
        try {
          await next();
        } catch (error) {
          context.res = handleApiError(error);
        }
        context.res = withTrustedRequestIdHeader(context.res, requestId);
        logRequestSummary(context.res, Date.now() - startedAt, omitUndefinedProperties({ clientRequestId }));
      },
      {
        service: 'public-api',
        fallbackIp: resolveAwsRequestContextSourceIp(context),
        routePath: safeRoutePath,
        requestId,
      },
    );
  });
}
export function registerPublicCors(app: ApiHonoApp): void {
  app.use(
    '*',
    cors({
      origin: getCorsOrigins(),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', SESSION_CAPABILITY_HEADER, 'Range', 'If-None-Match'],
      exposeHeaders: [
        'Content-Range',
        'Accept-Ranges',
        'ETag',
        'X-Amz-Version-Id',
        'X-Stark-Bundle-Range-Chunk-Size',
        'x-request-id',
      ],
    }),
  );
}
