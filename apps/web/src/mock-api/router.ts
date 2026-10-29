import {
  currentFinalizationBitmapProofRoute,
  matchApiRoute,
  type HttpMethod,
  type ApiContractRouteId,
} from '@stark-ballot/api-contract/routes';
import { ErrorCode, getErrorMessage } from '@stark-ballot/api-contract/errors/apiErrors';
import { isNonNullObject } from '@stark-ballot/validation/unknown-value-guards';
import { handleMockRoute } from './handlers';

export interface MockRouteRequest {
  input: RequestInfo | URL;
  init?: RequestInit;
  url: URL;
  requestId: string;
  routeId: ApiContractRouteId;
  params: Readonly<Record<string, unknown>>;
  query: Readonly<Record<string, unknown>>;
  now: number;
}

const CONTRACT_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
let requestSequence = 0;

function createMockRequestId(now: number): string {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `mock-${now}-${requestSequence}`;
}

function toResponse(payload: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
    },
  });
}

function errorResponse(requestId: string, status: number, code: string, message: string, details?: unknown): Response {
  return toResponse(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
      meta: { requestId },
    },
    requestId,
    status,
  );
}

function invalidRequestResponse(requestId: string, issues?: unknown): Response {
  return errorResponse(
    requestId,
    400,
    ErrorCode.INVALID_REQUEST,
    getErrorMessage(ErrorCode.INVALID_REQUEST),
    issues === undefined ? undefined : { kind: 'validation', issues },
  );
}

function resolveUrl(input: RequestInfo | URL): URL {
  const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  if (typeof input === 'string') {
    return new URL(input, base);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url, base);
}

function collectQueryParams(url: URL): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = params[key];
    if (existing === undefined) {
      params[key] = value;
    } else {
      params[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
  }
  return params;
}

function matchesBitmapProofRouteShape(method: HttpMethod, pathname: string): boolean {
  if (method !== currentFinalizationBitmapProofRoute.method) {
    return false;
  }
  const candidate = pathname.startsWith('/api/') ? pathname.slice('/api'.length) : pathname === '/api' ? '/' : null;
  if (candidate === null) {
    return false;
  }
  const candidateSegments = candidate.split('/');
  const templateSegments = currentFinalizationBitmapProofRoute.path.split('/');
  return (
    templateSegments.length === candidateSegments.length &&
    templateSegments.every((segment, index) =>
      segment.startsWith(':') ? Boolean(candidateSegments[index]) : segment === candidateSegments[index],
    )
  );
}

export function routeMockRequest(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = resolveUrl(input);
  const now = Date.now();
  const requestId = createMockRequestId(now);
  const rawMethod = (
    init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
  ).toUpperCase();
  if (!CONTRACT_METHODS.has(rawMethod as HttpMethod)) {
    return errorResponse(requestId, 404, 'MOCK_NOT_FOUND', 'Mock endpoint not implemented');
  }

  const matched = matchApiRoute(rawMethod as HttpMethod, url.pathname);
  if (!matched) {
    if (matchesBitmapProofRouteShape(rawMethod as HttpMethod, url.pathname)) {
      return invalidRequestResponse(requestId);
    }
    return errorResponse(requestId, 404, 'MOCK_NOT_FOUND', 'Mock endpoint not implemented');
  }

  const rawQuery = collectQueryParams(url);
  let query: Readonly<Record<string, unknown>> = {};
  if ('query' in matched.route.request) {
    const parsed = matched.route.request.query.safeParse(rawQuery);
    if (!parsed.success) {
      return invalidRequestResponse(requestId, parsed.error.flatten());
    }
    if (!isNonNullObject(parsed.data)) {
      return invalidRequestResponse(requestId);
    }
    query = parsed.data;
  } else if (Object.keys(rawQuery).length > 0) {
    return invalidRequestResponse(requestId, {
      formErrors: ['Unexpected query parameter'],
      fieldErrors: Object.fromEntries(Object.keys(rawQuery).map((key) => [key, ['Unexpected query parameter']])),
    });
  }

  return handleMockRoute({
    input,
    ...(init ? { init } : {}),
    url,
    requestId,
    routeId: matched.route.routeId,
    params: matched.params,
    query,
    now,
  });
}
