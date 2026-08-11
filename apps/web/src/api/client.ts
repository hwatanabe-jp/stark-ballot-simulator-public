import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/api-contract/schemas/primitives';
import type { RouteLike, RouteOutput } from '@stark-ballot/api-contract/routes';
import { resolveApiUrl } from './apiBaseUrl';
import { apiFetch } from './apiFetch';
import { readApiJson, readStandardApiErrorCode } from './responseAdmission';

export interface ApiClientRequestOptions {
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
}

export interface ApiSessionIdentity {
  readonly sessionId: string;
  readonly capabilityToken: string;
}

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

export function buildPathSessionHeaders(identity: ApiSessionIdentity): Record<string, string> {
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

export async function admitJsonRouteResponse<const TRoute extends RouteLike>(
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

interface RequestJsonOptions extends ApiClientRequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export async function requestJsonRoute<const TRoute extends RouteLike>(
  route: TRoute,
  path: string,
  label: string,
  options: RequestJsonOptions = {},
): Promise<JsonRouteResult<TRoute>> {
  const hasBody = options.body !== undefined;
  const headers = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  };
  const response = await apiFetch(resolveWebApiUrl(path, options.baseUrl), {
    method: route.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return admitJsonRouteResponse(route, response, label);
}
