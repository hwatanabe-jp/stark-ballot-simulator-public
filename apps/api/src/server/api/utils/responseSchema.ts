import {
  ApiError,
  ErrorCode,
  createApiErrorResult,
  type ErrorDetails,
} from '@stark-ballot/api-contract/errors/apiErrors';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';
import type { ApiRouteContract, JsonRouteResponse, RouteLike, RouteOutput } from '@stark-ballot/api-contract/routes';
import { errorResponse, jsonResponse } from '../../http/response';
import { logger } from '@stark-ballot/diagnostics/logger';
import { resolvePublicRequestId } from '../../http/publicRequestId';
import type { Infer, AnySchema } from '@stark-ballot/validation/schema';
import type { RouteBoundResponse } from '../context';
import { bindAdmittedRouteResponse } from '../routes/honoRouteAdapter';
import { admitPublicRouteErrorResponse } from './publicErrorAdmission';

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

type OutputByContent<TRoute extends RouteLike, TContent extends 'binary' | 'text'> = Extract<
  RouteOutput<TRoute>,
  { content: TContent }
>;

type BodylessStatus = 204 | 205 | 304;
type DeclaredConditionalStatus<TRoute extends RouteLike> = Extract<
  TRoute['responses'][number]['status'],
  BodylessStatus
>;

type PublicErrorRoute = ApiRouteContract;

type PublicErrorStatus<TStatus> = TStatus extends number ? TStatus : number;

type DeclaredRouteErrorPair<TRoute extends PublicErrorRoute> =
  TRoute['publicErrors']['responses'][number] extends infer TResponse
    ? TResponse extends {
        readonly code: infer TCode extends string;
        readonly status: infer TStatus;
        readonly envelope: 'standard-error-envelope';
      }
      ? { readonly code: TCode & ErrorCode; readonly status: PublicErrorStatus<TStatus> }
      : never
    : never;

interface RouteErrorFields {
  readonly code: ErrorCode;
  readonly status: number;
  readonly message?: string;
  readonly details?: ErrorDetails;
}

type RouteErrorArguments<TRoute extends PublicErrorRoute, TCode extends ErrorCode, TStatus extends number> =
  {
    readonly code: TCode;
    readonly status: TStatus;
  } extends DeclaredRouteErrorPair<NoInfer<TRoute>>
    ? readonly [init?: RouteResponseInit]
    : readonly [routeErrorMismatch: never];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaDeclaresPublicMeta(
  schema: AnySchema,
): schema is AnySchema & { shape: Readonly<Record<string, AnySchema>> } {
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

function routeAdmissionFailure<TRoute extends RouteLike>(route: TRoute, message: string): RouteBoundResponse<TRoute> {
  return bindAdmittedRouteResponse(route, errorResponse(ErrorCode.INTERNAL_ERROR, { details: message }));
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
): RouteBoundResponse<TRoute> {
  const responseContracts = route.responses.filter(
    (candidate) => candidate.status === output.status && candidate.content === output.content,
  );
  if (responseContracts.length === 0) {
    logger.error('[API] Undeclared route response', {
      routeId: route.routeId,
      status: output.status,
      content: output.content,
    });
    return routeAdmissionFailure(route, 'Undeclared route response');
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
    return routeAdmissionFailure(route, 'Invalid route response admission');
  }

  let lastError: unknown;
  for (const responseContract of jsonResponseContracts) {
    const body = schemaDeclaresPublicMeta(responseContract.schema)
      ? injectPublicMeta(output.body, resolvePublicRequestId())
      : output.body;
    const result = responseContract.schema.safeParse(body);
    if (result.success) {
      return bindAdmittedRouteResponse(route, jsonResponse(result.data, { ...init, status: output.status }));
    }
    lastError = result.error;
  }
  logger.error('[API] Response schema validation failed', lastError);
  return routeAdmissionFailure(route, 'Response schema validation failed');
}

function isDeclaredPublicError(route: PublicErrorRoute, code: string, status: number): boolean {
  return (
    route.publicErrorShape === 'standard-error-envelope' &&
    route.publicErrors.responses.some(
      (candidate) =>
        candidate.envelope === 'standard-error-envelope' &&
        candidate.code === code &&
        candidate.contentType === 'application/json' &&
        (candidate.status === status || candidate.status === 'upstream-response-status'),
    )
  );
}

/** Admit a canonical public error against the route's declared code/status pair. */
export function respondWithRouteError<
  TRoute extends PublicErrorRoute,
  const TCode extends ErrorCode,
  const TStatus extends number,
>(
  route: TRoute,
  error: RouteErrorFields & { readonly code: TCode; readonly status: TStatus },
  ...arguments_: RouteErrorArguments<TRoute, TCode, TStatus>
): RouteBoundResponse<TRoute> {
  const init = arguments_[0];
  if (!isDeclaredPublicError(route, error.code, error.status)) {
    logger.error('[API] Undeclared public route error', {
      routeId: route.routeId,
      code: error.code,
      status: error.status,
    });
    return routeAdmissionFailure(route, 'Undeclared public route error');
  }

  const result = createApiErrorResult(
    new ApiError(error.code, error.status, error.message, error.details),
    resolvePublicRequestId(),
  );
  const admitted = StandardErrorResponseSchema.safeParse(result.payload);
  if (!admitted.success) {
    logger.error('[API] Public route error schema validation failed', admitted.error);
    return routeAdmissionFailure(route, 'Public route error schema validation failed');
  }

  return bindAdmittedRouteResponse(route, jsonResponse(admitted.data, { ...init, status: result.status }));
}

/** Admit an error serialized by an adjacent middleware or application adapter. */
export async function admitRouteErrorResponse<TRoute extends PublicErrorRoute>(
  route: TRoute,
  response: Response,
): Promise<RouteBoundResponse<TRoute>> {
  if (response.status < 400) {
    logger.error('[API] Non-error response used through route error admission', {
      routeId: route.routeId,
      status: response.status,
    });
    return routeAdmissionFailure(route, 'Non-error response used through route error admission');
  }
  const admitted = await admitPublicRouteErrorResponse(route, response);
  return bindAdmittedRouteResponse(route, admitted);
}

/** Admit a declared binary response before constructing its native Response. */
export function respondWithBinaryRoute<TRoute extends RouteLike>(
  route: TRoute,
  output: OutputByContent<TRoute, 'binary'>,
  init?: RouteResponseInit,
): RouteBoundResponse<TRoute> {
  const declared = route.responses.some(
    (candidate) => candidate.status === output.status && candidate.content === 'binary',
  );
  if (!declared || !(output.body instanceof ArrayBuffer || output.body instanceof Uint8Array)) {
    logger.error('[API] Binary route response admission failed', {
      routeId: route.routeId,
      status: output.status,
    });
    return routeAdmissionFailure(route, 'Binary route response admission failed');
  }
  return bindAdmittedRouteResponse(route, new Response(output.body, { ...init, status: output.status }));
}

/** Admit a declared text response before constructing its native Response. */
export function respondWithTextRoute<TRoute extends RouteLike>(
  route: TRoute,
  output: OutputByContent<TRoute, 'text'>,
  init?: RouteResponseInit,
): RouteBoundResponse<TRoute> {
  const declared = route.responses.some(
    (candidate) => candidate.status === output.status && candidate.content === 'text',
  );
  if (!declared || typeof output.body !== 'string') {
    logger.error('[API] Text route response admission failed', {
      routeId: route.routeId,
      status: output.status,
    });
    return routeAdmissionFailure(route, 'Text route response admission failed');
  }
  return bindAdmittedRouteResponse(route, new Response(output.body, { ...init, status: output.status }));
}

/** Construct a declared bodyless conditional response (for example 304). */
export function respondWithConditionalRoute<TRoute extends RouteLike>(
  route: TRoute,
  status: DeclaredConditionalStatus<TRoute>,
  init?: RouteResponseInit,
): RouteBoundResponse<TRoute> {
  const declared = route.responses.some((candidate) => candidate.status === status);
  if (!declared || (status !== 204 && status !== 205 && status !== 304)) {
    logger.error('[API] Conditional route response admission failed', {
      routeId: route.routeId,
      status,
    });
    return routeAdmissionFailure(route, 'Conditional route response admission failed');
  }
  return bindAdmittedRouteResponse(route, new Response(null, { ...init, status }));
}
