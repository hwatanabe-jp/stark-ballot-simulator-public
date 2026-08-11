import { ApiError, ErrorCode, createApiErrorResult, type ApiErrorResult, type ErrorDetails } from './apiErrors';

/**
 * Create a canonical error result (framework-agnostic).
 */
export function toApiErrorResult(
  error: ApiError | ErrorCode,
  requestId: string,
  details?: ErrorDetails,
): ApiErrorResult {
  return createApiErrorResult(error, requestId, details);
}

/**
 * Convert an unexpected failure into a canonical error result.
 */
export function handleApiErrorResult(error: unknown, requestId: string): ApiErrorResult {
  if (error instanceof ApiError) {
    return error.toResult(requestId);
  }

  if (error instanceof Error) {
    if (error.message.includes('SESSION_LIMIT_EXCEEDED')) {
      return createApiErrorResult(ErrorCode.SESSION_LIMIT_EXCEEDED, requestId);
    }

    if (error.message.includes('SESSION_NOT_FOUND')) {
      return createApiErrorResult(ErrorCode.SESSION_NOT_FOUND, requestId);
    }
  }

  return createApiErrorResult(ErrorCode.INTERNAL_ERROR, requestId);
}
