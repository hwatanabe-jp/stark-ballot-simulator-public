import { runWithLogContext, type LogContext } from '@/lib/utils/requestLogContext';
import { getRequestIp } from '@/lib/security/turnstile';
import { hashIpForLogging, resolveRequestId } from '@/lib/utils/logging';
import { logger } from '@/lib/utils/logger';
import { resolveDebugLogPayloadFromRequest } from '@/server/http/debugLog';

export interface RequestLogOptions {
  service?: string;
  fallbackIp?: string | null;
}

export function buildRequestLogContext(request: Request, options: RequestLogOptions = {}): LogContext {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request.headers);
  const clientIp = getRequestIp(request.headers, options.fallbackIp);
  const sourceIpHash = clientIp ? hashIpForLogging(clientIp) : undefined;

  const hostHeader = request.headers.get('host') ?? undefined;
  const host = hostHeader ?? url.host;

  return {
    requestId,
    service: options.service,
    http: {
      method: request.method,
      path: url.pathname,
      host,
      x_forwarded_host: request.headers.get('x-forwarded-host') ?? undefined,
      referer: request.headers.get('referer') ?? request.headers.get('referrer') ?? undefined,
      source_ip_hash: sourceIpHash,
    },
  };
}

export function logRequestSummary(response: Response, durationMs: number): void {
  const status = response.status;
  const level: 'info' | 'warn' | 'error' = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

  logger[level]('request completed', {
    event: 'http_request',
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
  const payload = resolveDebugLogPayloadFromRequest(request);
  const logContext = buildRequestLogContext(request, options);
  if (payload?.level) {
    logContext.level = payload.level;
  }

  return await runWithLogContext(logContext, handler);
}
