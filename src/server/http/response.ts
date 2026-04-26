import type { ApiError, ErrorCode, ErrorDetails } from '@/lib/errors/apiErrors';
import { toApiErrorPayload } from '@/lib/errors/errorPayload';

/**
 * Build a JSON response with consistent headers.
 */
export function jsonResponse<T>(payload: T, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers,
  });
}

/**
 * Build a standardized error response payload.
 */
export function errorResponse(error: ApiError | ErrorCode, details?: ErrorDetails): Response {
  const payload = toApiErrorPayload(error, details);
  return jsonResponse(payload, { status: payload.statusCode });
}
