import { runWithLogContext, type LogContext } from '@stark-ballot/diagnostics/requestLogContext';
import { getRequestIp } from '../api/security/turnstile';
import { hashIpForLogging } from '@stark-ballot/diagnostics/logging';
import { logger } from '@stark-ballot/diagnostics/logger';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { randomUUID } from 'node:crypto';

const MAX_CLIENT_REQUEST_ID_LENGTH = 128;
const SIMPLE_CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const TOKEN_SHAPE_PATTERN = /(?:^|\.)[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/;

export interface RequestLogOptions {
  service?: string;
  fallbackIp?: string | null;
  requestId?: string;
  routePath?: string;
}

interface RequestSummaryOptions {
  clientRequestId?: string;
}

export function resolveUntrustedClientRequestId(headers: Headers): string | undefined {
  const value = headers.get('x-request-id')?.trim();
  if (!value || value.length > MAX_CLIENT_REQUEST_ID_LENGTH || !SIMPLE_CLIENT_REQUEST_ID_PATTERN.test(value)) {
    return undefined;
  }
  if (UUID_PATTERN.test(value) || TOKEN_SHAPE_PATTERN.test(value)) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (['capability', 'session', 'token'].some((part) => normalized.includes(part))) {
    return undefined;
  }
  return value;
}

export function buildRequestLogContext(request: Request, options: RequestLogOptions = {}): LogContext {
  const requestId = options.requestId?.trim() || randomUUID();
  const clientIp = getRequestIp(request.headers, options.fallbackIp);
  const sourceIpHash = clientIp ? hashIpForLogging(clientIp) : undefined;

  return {
    requestId,
    ...omitUndefinedProperties({ service: options.service }),
    http: {
      method: request.method,
      path: options.routePath ?? '/unmatched',
      ...omitUndefinedProperties({
        source_ip_hash: sourceIpHash,
      }),
    },
  };
}

export function withTrustedRequestIdHeader(response: Response, requestId: string): Response {
  try {
    response.headers.set('x-request-id', requestId);
    return response;
  } catch {
    try {
      const headers = new Headers(response.headers);
      headers.set('x-request-id', requestId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return response;
    }
  }
}

export function logRequestSummary(response: Response, durationMs: number, options: RequestSummaryOptions = {}): void {
  const status = response.status;
  const level: 'info' | 'warn' | 'error' = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

  logger[level]('request completed', {
    event: 'http_request',
    ...omitUndefinedProperties({ client_request_id: options.clientRequestId }),
    http: {
      status,
      latency_ms: Math.round(durationMs),
    },
  });
}

export async function withRequestLogContext<T>(
  request: Request,
  handler: () => Promise<T> | T,
  options: RequestLogOptions = {},
): Promise<T> {
  const logContext = buildRequestLogContext(request, options);
  return await runWithLogContext(logContext, handler);
}
