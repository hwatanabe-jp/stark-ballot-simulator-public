import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { handleApiErrorPayload } from '@/lib/errors/errorPayload';
import { jsonResponse } from '@/server/http/response';
import { toApiContext } from '@/server/http/adapters/hono';
import type { ApiHandler, ApiParams } from '@/server/api/context';
import { getApiRouteDefinitions, type ApiMethod, type ApiRouteMode } from '@/server/api/routes/registry';
import { logRequestSummary, withRequestLogContext } from '@/server/http/requestLogging';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@/lib/session/capability';

function createHonoRoute(handler: ApiHandler<ApiParams>): (context: Context) => Promise<Response> {
  return async (context) => {
    const store = getGlobalStore();
    const params = resolveParams(context);
    const apiContext = toApiContext({ context, store, params });
    const startedAt = Date.now();

    return await withRequestLogContext(
      apiContext.request,
      async () => {
        try {
          const response = await handler(apiContext);
          logRequestSummary(response, Date.now() - startedAt);
          return response;
        } catch (error) {
          const payload = handleApiErrorPayload(error);
          const response = jsonResponse(payload, { status: payload.statusCode });
          logRequestSummary(response, Date.now() - startedAt);
          return response;
        }
      },
      { service: 'hono-api', fallbackIp: apiContext.clientIp ?? null },
    );
  };
}

/**
 * Options for creating a Hono app with shared API handlers.
 */
export interface HonoAppOptions {
  /** Base path for the Hono app (defaults to `/api`). */
  basePath?: string;
  /** Route set to register (defaults to `full`). */
  mode?: ApiRouteMode;
}

function registerRoutes(app: Hono, mode: ApiRouteMode): void {
  const routes = getApiRouteDefinitions(mode);
  for (const route of routes) {
    const method = route.method.toLowerCase() as Lowercase<ApiMethod>;
    app[method](route.path, createHonoRoute(route.handler));
  }
}

/**
 * Create a Hono app that mirrors the Next.js API routes.
 */
function getCorsOrigins(): string[] {
  const envOrigins = process.env.HONO_CORS_ALLOW_ORIGINS;
  if (envOrigins) {
    return envOrigins.split(',').map((o) => o.trim());
  }
  return ['http://localhost:3000'];
}

export function createHonoApp(options: HonoAppOptions = {}): Hono {
  const { basePath = '/api', mode = 'full' } = options;
  const app = new Hono().basePath(basePath);

  // CORS middleware for cross-origin requests from UI.
  app.use(
    '*',
    cors({
      origin: getCorsOrigins(),
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-Turnstile-Token',
        'X-Debug-Log',
        SESSION_ID_HEADER,
        SESSION_CAPABILITY_HEADER,
      ],
    }),
  );

  registerRoutes(app, mode);

  return app;
}

function resolveParams(context: Context): ApiParams | undefined {
  const params = context.req.param();
  return Object.keys(params).length > 0 ? params : undefined;
}
