import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse, jsonResponse } from '../../http/response';
import { resolveAwsRequestContextSourceIp, resolveAwsRequestId, toApiContext } from '../../http/adapters/hono';
import type { ApiParams } from '../context';
import * as apiSchemas from '@stark-ballot/api-contract/validation/apiSchemas';
import { s, type SchemaTypeAny } from '@stark-ballot/validation/schema';
import { getApiRouteDefinitions, type ApiMethod, type ApiRouteDefinition, type ApiRouteMode } from './definitions';
import {
  logRequestSummary,
  resolveUntrustedClientRequestId,
  withRequestLogContext,
  withTrustedRequestIdHeader,
} from '../../http/requestLogging';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { isRetiredTargetRouteVariant } from '@stark-ballot/api-contract/api-contract/routes';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isExpectedTargetOriginVerified } from '../security/developOperatorGate';
import { handleApiError } from '../../http/errorHandler';
import { randomUUID } from 'node:crypto';

export { ORIGIN_VERIFY_HEADER } from '../security/developOperatorGate';

function retiredRouteResponse(): Response {
  return jsonResponse(
    {
      error: 'ROUTE_RETIRED',
      message: 'This API route is not available in the target public runtime.',
    },
    { status: 410 },
  );
}

function isSchema(value: unknown): value is SchemaTypeAny {
  return value instanceof s.Schema;
}

function resolveContractSchema(schemaName: string): SchemaTypeAny {
  const schema = (apiSchemas as Record<string, unknown>)[schemaName];
  if (!isSchema(schema)) {
    throw new Error(`API contract schema is not exported: ${schemaName}`);
  }
  return schema;
}

function collectQueryParams(requestUrl: string): Record<string, unknown> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(requestUrl).searchParams) {
    if (!Object.hasOwn(params, key)) {
      params[key] = value;
      continue;
    }

    const existing = params[key];
    if (Array.isArray(existing)) {
      params[key] = [...existing, value];
    } else if (existing !== undefined) {
      params[key] = [existing, value];
    } else {
      params[key] = value;
    }
  }
  return params;
}

function invalidSchemaResponse(schemaName: string, value: unknown): Response | null {
  const result = resolveContractSchema(schemaName).safeParse(value);
  if (result.success) {
    return null;
  }
  return errorResponse(ErrorCode.INVALID_REQUEST, { issues: result.error.flatten() });
}

function validateRouteRequestSchemas(route: ApiRouteDefinition, request: Request, params?: ApiParams): Response | null {
  const paramsSchema = route.requestSchemas.params;
  if (paramsSchema) {
    const paramsResult = invalidSchemaResponse(paramsSchema, params ?? {});
    if (paramsResult) {
      return paramsResult;
    }
  }

  const queryParams = collectQueryParams(request.url);
  const querySchema = route.requestSchemas.query;
  if (querySchema) {
    const queryResult = invalidSchemaResponse(querySchema, queryParams);
    if (queryResult) {
      return queryResult;
    }
  } else if (Object.keys(queryParams).length > 0) {
    return errorResponse(ErrorCode.INVALID_REQUEST, {
      issues: {
        formErrors: ['Unexpected query parameter'],
        fieldErrors: Object.fromEntries(Object.keys(queryParams).map((key) => [key, ['Unexpected query parameter']])),
      },
    });
  }

  return null;
}

function validateTargetOriginVerifyHeader(request: Request): Response | null {
  if (process.env['TARGET_AWS_RUNTIME'] !== '1') {
    return null;
  }

  const expected = process.env['EXPECTED_ORIGIN_VERIFY_HEADER']?.trim();
  if (!expected) {
    return null;
  }

  if (!isExpectedTargetOriginVerified(request)) {
    return errorResponse(ErrorCode.SAME_ORIGIN_REQUIRED, {
      details: 'Target API requests must arrive through the authorized CloudFront origin path',
    });
  }

  return null;
}

function createHonoRoute(route: ApiRouteDefinition): (context: Context) => Promise<Response> {
  return async (context) => {
    if (isRetiredTargetRouteVariant(route, context.req.url)) {
      return retiredRouteResponse();
    }

    const request = context.req.raw;

    const originVerifyResponse = validateTargetOriginVerifyHeader(request);
    if (originVerifyResponse) {
      return originVerifyResponse;
    }

    const store = getGlobalStore();
    const params = resolveParams(context);
    const apiContext = toApiContext({ context, store, ...omitUndefinedProperties({ params }) });

    const validationResponse = validateRouteRequestSchemas(route, apiContext.request, params);
    if (validationResponse) {
      return validationResponse;
    }
    return await route.handler(apiContext);
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
    app[method](route.path, createHonoRoute(route));
  }
}

/**
 * Create the Hono app for shared API route definitions.
 */
function getCorsOrigins(): string[] {
  const envOrigins = process.env['HONO_CORS_ALLOW_ORIGINS'];
  if (envOrigins) {
    return envOrigins.split(',').map((o) => o.trim());
  }
  return ['http://localhost:3000'];
}

export function createHonoApp(options: HonoAppOptions = {}): Hono {
  const { basePath = '/api', mode = 'full' } = options;
  const app = new Hono().basePath(basePath);

  app.use('*', async (context, next) => {
    const startedAt = Date.now();
    const request = context.req.raw;
    const requestId = resolveAwsRequestId(context) ?? randomUUID();
    const clientRequestId = resolveUntrustedClientRequestId(request.headers);
    const matchedRoutePath = context.req.matchedRoutes.at(-1)?.path;
    const safeRoutePath = matchedRoutePath && matchedRoutePath !== '*' ? matchedRoutePath : `${basePath}/*`;

    await withRequestLogContext(
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

  app.onError((error) => handleApiError(error));

  // CORS middleware for cross-origin requests from UI.
  app.use(
    '*',
    cors({
      origin: getCorsOrigins(),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', SESSION_ID_HEADER, SESSION_CAPABILITY_HEADER, 'Range'],
      exposeHeaders: ['Content-Range', 'Accept-Ranges', 'X-Stark-Bundle-Range-Chunk-Size', 'x-request-id'],
    }),
  );

  registerRoutes(app, mode);

  return app;
}

function resolveParams(context: Context): ApiParams | undefined {
  const params = context.req.param();
  return Object.keys(params).length > 0 ? params : undefined;
}
