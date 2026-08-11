import type { ApiError, ErrorCode, ErrorDetails } from '@stark-ballot/api-contract/errors/apiErrors';
import { toApiErrorResult } from '@stark-ballot/api-contract/errors/errorPayload';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { resolvePublicRequestId } from './publicRequestId';

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
    ...omitUndefinedProperties({ statusText: init?.statusText }),
    ...omitUndefinedProperties({ headers: headers }),
  });
}

/**
 * Build a standardized error response payload.
 */
export function errorResponse(
  error: ApiError | ErrorCode,
  details?: ErrorDetails,
  init?: { headers?: HeadersInit },
): Response {
  const result = toApiErrorResult(error, resolvePublicRequestId(), details);
  return jsonResponse(result.payload, {
    status: result.status,
    ...omitUndefinedProperties({ headers: init?.headers }),
  });
}
