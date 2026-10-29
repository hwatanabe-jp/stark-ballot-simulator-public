import { handleApiErrorResult } from '@stark-ballot/api-contract/errors/errorPayload';
import { logger } from '@stark-ballot/diagnostics/logger';
import { resolvePublicRequestId } from './publicRequestId';

/**
 * Handle unexpected errors and convert to a standardized JSON response.
 */
export function handleApiError(error: unknown): Response {
  const result = handleApiErrorResult(error, resolvePublicRequestId());
  const boundedErrorSource = error instanceof Error ? error : new Error('Non-Error value thrown');
  const publicCode = result.payload.error.code;
  logger.error('Unhandled API error', boundedErrorSource, {
    event: 'api_error',
    public_code: publicCode,
  });
  return Response.json(result.payload, { status: result.status });
}
