import type { BrowserSessionIdentity } from '../session/identity';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/api-contract/schemas/primitives';
import {
  buildApiRouteUrlFromInput,
  type OrdinaryJsonRoute,
  type RouteInput,
  type RouteLike,
  type RouteOutput,
} from '@stark-ballot/api-contract/routes';
import type { PathSessionCapabilityHeaders } from '@stark-ballot/api-contract/schemas/sessions';
import { resolveApiUrl } from './apiBaseUrl';
import { apiFetch } from './apiFetch';
import { readApiJson, readStandardApiErrorCode } from './responseAdmission';

export interface ApiClientRequestOptions {
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
}

export type ApiSessionIdentity = BrowserSessionIdentity;

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly responseBody: unknown;
  public readonly statusText: string;

  public constructor(message: string, status: number, responseBody: unknown, statusText = '') {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.responseBody = responseBody;
    this.statusText = statusText;
  }
}

export class ApiClientContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ApiClientContractError';
  }
}

export function resolveApiClientErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiClientError)) {
    return null;
  }
  return readStandardApiErrorCode(error.responseBody) ?? null;
}

export function buildPathSessionHeaders(identity: ApiSessionIdentity): PathSessionCapabilityHeaders {
  return {
    [SESSION_CAPABILITY_HEADER]: identity.capabilityToken,
  };
}

export function resolveWebApiUrl(path: string, baseUrl?: string): string {
  if (baseUrl) {
    return new URL(path, baseUrl).toString();
  }
  return resolveApiUrl(path);
}

function invalidResponseError(label: string, detail?: string): ApiClientContractError {
  return new ApiClientContractError(`Invalid ${label} response payload${detail ? `: ${detail}` : ''}`);
}

type JsonRouteOutput<TRoute extends RouteLike> = Extract<RouteOutput<TRoute>, { content: 'json' }>;

export type JsonRouteResult<TRoute extends RouteLike> =
  JsonRouteOutput<TRoute> extends infer TOutput
    ? TOutput extends { status: infer TStatus extends number; body: infer TBody }
      ? { status: TStatus; body: TBody }
      : never
    : never;

async function admitJsonRouteResponse<const TRoute extends RouteLike>(
  route: TRoute,
  response: Response,
  label: string,
): Promise<JsonRouteResult<TRoute>> {
  const rawBody = await readApiJson(response);
  if (!response.ok) {
    throw new ApiClientError(
      `${label} request failed with ${response.status}`,
      response.status,
      rawBody,
      response.statusText,
    );
  }

  const candidates = route.responses.filter(
    (candidate) => candidate.status === response.status && candidate.content === 'json',
  );
  if (candidates.length === 0) {
    throw new ApiClientContractError(`Undeclared response status ${response.status} for ${route.routeId}`);
  }

  let firstIssue: string | undefined;
  for (const candidate of candidates) {
    if (!('schema' in candidate)) {
      return { status: response.status, body: rawBody } as JsonRouteResult<TRoute>;
    }
    const parsed = candidate.schema.safeParse(rawBody);
    if (parsed.success) {
      return { status: response.status, body: parsed.data } as JsonRouteResult<TRoute>;
    }
    firstIssue ??= parsed.error.issues[0]?.message;
  }

  throw invalidResponseError(label, firstIssue ?? 'schema validation failed');
}

type RequestInputLocation = 'params' | 'query' | 'headers' | 'body';

interface PreparedJsonRouteRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

const REQUEST_INPUT_LOCATIONS = [
  'params',
  'query',
  'headers',
  'body',
] as const satisfies readonly RequestInputLocation[];

function isRequestInputLocation(value: string): value is RequestInputLocation {
  return REQUEST_INPUT_LOCATIONS.some((location) => location === value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestContractError(label: string, location: string, detail: string): ApiClientContractError {
  return new ApiClientContractError(`Invalid ${label} request ${location}: ${detail}`);
}

function firstSchemaIssue(result: { error: { issues: readonly { message: string }[] } }): string {
  return result.error.issues[0]?.message ?? 'schema validation failed';
}

function admitRequestLocation(
  route: OrdinaryJsonRoute,
  input: Readonly<Record<string, unknown>>,
  location: Exclude<RequestInputLocation, 'query'>,
  label: string,
): unknown {
  const schema = route.request[location];
  if (schema === undefined) {
    return undefined;
  }
  const parsed = schema.safeParse(input[location]);
  if (!parsed.success) {
    throw requestContractError(label, location, firstSchemaIssue(parsed));
  }
  return parsed.data;
}

function collectWireQuery(path: string): Readonly<Record<string, unknown>> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(path, 'https://route.invalid').searchParams) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      query[key] = [...existing, value];
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

function admitWireQuery(route: OrdinaryJsonRoute, path: string, label: string): void {
  if (route.request.query === undefined) {
    return;
  }
  const parsed = route.request.query.safeParse(collectWireQuery(path));
  if (!parsed.success) {
    throw requestContractError(label, 'query', firstSchemaIssue(parsed));
  }
}

function requireStringHeaders(value: unknown, label: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw requestContractError(label, 'headers', 'declared headers must serialize to strings');
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') {
      throw requestContractError(label, 'headers', 'declared headers must serialize to strings');
    }
    headers[name] = headerValue;
  }
  return headers;
}

function serializeRequestBody(value: unknown, label: string): string {
  try {
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      throw new Error('body is not JSON serializable');
    }
    return serialized;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'body is not JSON serializable';
    throw requestContractError(label, 'body', detail);
  }
}

function assertRequestInputLocations(
  route: OrdinaryJsonRoute,
  input: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const declaredLocations = new Set<RequestInputLocation>();
  for (const location of REQUEST_INPUT_LOCATIONS) {
    if (route.request[location] !== undefined) {
      declaredLocations.add(location);
    }
  }
  const unexpectedLocation = Object.keys(input).find(
    (key) => !isRequestInputLocation(key) || !declaredLocations.has(key),
  );
  if (unexpectedLocation !== undefined) {
    throw requestContractError(label, 'input', `unexpected location ${unexpectedLocation}`);
  }
}

function prepareJsonRouteRequest<const TRoute extends OrdinaryJsonRoute>(
  route: TRoute,
  input: RouteInput<TRoute>,
  label: string,
): PreparedJsonRouteRequest {
  if (!isRecord(input)) {
    throw requestContractError(label, 'input', 'expected an object');
  }

  assertRequestInputLocations(route, input, label);

  admitRequestLocation(route, input, 'params', label);
  const admittedHeaders = admitRequestLocation(route, input, 'headers', label);
  const admittedBody = admitRequestLocation(route, input, 'body', label);

  let path: string;
  try {
    path = buildApiRouteUrlFromInput(route, input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'route serialization failed';
    throw requestContractError(label, 'input', detail);
  }
  admitWireQuery(route, path, label);

  const headersFromInput = route.request.headers === undefined ? {} : requireStringHeaders(admittedHeaders, label);
  const hasBody = route.request.body !== undefined;
  const headers = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...headersFromInput,
  };
  return {
    path,
    headers,
    ...(hasBody ? { body: serializeRequestBody(admittedBody, label) } : {}),
  };
}

export async function requestJsonRoute<const TRoute extends OrdinaryJsonRoute>(
  route: TRoute,
  input: RouteInput<TRoute>,
  label: string,
  options: ApiClientRequestOptions = {},
): Promise<JsonRouteResult<TRoute>> {
  const request = prepareJsonRouteRequest(route, input, label);
  const response = await apiFetch(resolveWebApiUrl(request.path, options.baseUrl), {
    method: route.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return admitJsonRouteResponse(route, response, label);
}
