import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import type { JsonRouteResponse, RouteLike } from '@stark-ballot/api-contract/routes';
import { errorResponse, jsonResponse } from '../../http/response';
import { logger } from '@stark-ballot/diagnostics/logger';
import { resolvePublicRequestId } from '../../http/publicRequestId';
import type { Infer, SchemaTypeAny } from '@stark-ballot/validation/schema';

type RouteResponseInit = Omit<ResponseInit, 'status'>;

type HandlerResponseBody<TBody> = TBody extends { meta: infer TMeta }
  ? Omit<TBody, 'meta'> & { meta?: Partial<TMeta> }
  : TBody;

type AdmittedJsonResponse<TResponse> = TResponse extends JsonRouteResponse
  ? {
      status: TResponse['status'];
      content: 'json';
      body: HandlerResponseBody<Infer<TResponse['schema']>>;
    }
  : never;

export type AdmittedRouteOutput<TRoute extends RouteLike> = TRoute extends RouteLike
  ? AdmittedJsonResponse<TRoute['responses'][number]>
  : never;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaDeclaresPublicMeta(
  schema: SchemaTypeAny,
): schema is SchemaTypeAny & { shape: Readonly<Record<string, SchemaTypeAny>> } {
  return 'shape' in schema && isRecord(schema.shape) && Object.hasOwn(schema.shape, 'meta');
}

function injectPublicMeta(body: unknown, requestId: string): unknown {
  if (!isRecord(body)) {
    return body;
  }
  const handlerMeta = body['meta'];
  if (handlerMeta !== undefined && !isRecord(handlerMeta)) {
    return body;
  }
  return {
    ...body,
    meta: {
      ...handlerMeta,
      requestId,
    },
  };
}

/**
 * Admit a success response through the route declaration before serializing it.
 *
 * Route-specific raw artifact and conditional responses remain explicit
 * `Response` construction at their handlers.
 */
export function respondWithRoute<TRoute extends RouteLike>(
  route: TRoute,
  output: AdmittedRouteOutput<TRoute>,
  init?: RouteResponseInit,
): Response {
  const responseContracts = route.responses.filter(
    (candidate) => candidate.status === output.status && candidate.content === output.content,
  );
  if (responseContracts.length === 0) {
    logger.error('[API] Undeclared route response', {
      routeId: route.routeId,
      status: output.status,
      content: output.content,
    });
    return errorResponse(ErrorCode.INTERNAL_ERROR, { details: 'Undeclared route response' });
  }

  const jsonResponseContracts = responseContracts.filter(
    (candidate) => candidate.content === 'json' && 'schema' in candidate,
  );
  if (jsonResponseContracts.length === 0) {
    logger.error('[API] Raw route response used through JSON response admission', {
      routeId: route.routeId,
      status: output.status,
      content: output.content,
    });
    return errorResponse(ErrorCode.INTERNAL_ERROR, { details: 'Invalid route response admission' });
  }

  let lastError: unknown;
  for (const responseContract of jsonResponseContracts) {
    const body = schemaDeclaresPublicMeta(responseContract.schema)
      ? injectPublicMeta(output.body, resolvePublicRequestId())
      : output.body;
    const result = responseContract.schema.safeParse(body);
    if (result.success) {
      return jsonResponse(result.data, { ...init, status: output.status });
    }
    lastError = result.error;
  }
  logger.error('[API] Response schema validation failed', lastError);
  return errorResponse(ErrorCode.INTERNAL_ERROR, { details: 'Response schema validation failed' });
}
