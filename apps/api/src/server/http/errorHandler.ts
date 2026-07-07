import type { ApiError, ErrorCode, ErrorDetails } from '@stark-ballot/api-contract/errors/apiErrors';
import { handleApiErrorPayload, toApiErrorPayload } from '@stark-ballot/api-contract/errors/errorPayload';
import { logger } from '@stark-ballot/diagnostics/logger';

/**
 * Create a standardized JSON error response.
 */
export function errorResponse(error: ApiError | ErrorCode, details?: ErrorDetails): Response {
  const response = toApiErrorPayload(error, details);
  return Response.json(response, { status: response.statusCode });
}

/**
 * Handle unexpected errors and convert to a standardized JSON response.
 */
export function handleApiError(error: unknown): Response {
  logger.error('API Error:', error);
  const response = handleApiErrorPayload(error);
  return Response.json(response, { status: response.statusCode });
}
