import { ApiError, ErrorCode, createErrorResponse, type ErrorDetails, type ApiErrorPayload } from './apiErrors';

/**
 * Create a standardized error payload (framework-agnostic).
 */
export function toApiErrorPayload(error: ApiError | ErrorCode, details?: ErrorDetails): ApiErrorPayload {
  return createErrorResponse(error, details);
}

/**
 * Handle unexpected errors and convert to standardized payload (framework-agnostic).
 */
export function handleApiErrorPayload(error: unknown): ApiErrorPayload {
  if (error instanceof ApiError) {
    return error.toJSON();
  }

  if (error instanceof Error) {
    if (error.message.includes('SESSION_LIMIT_EXCEEDED')) {
      return createErrorResponse(ErrorCode.SESSION_LIMIT_EXCEEDED);
    }

    if (error.message.includes('SESSION_NOT_FOUND')) {
      return createErrorResponse(ErrorCode.SESSION_NOT_FOUND);
    }
  }

  return createErrorResponse(ErrorCode.INTERNAL_ERROR);
}
