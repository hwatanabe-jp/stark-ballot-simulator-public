import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { errorResponse, handleApiError } from './errorHandler';
import { ApiError, ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { logger } from '@stark-ballot/diagnostics/logger';
import { runWithLogContext } from '@stark-ballot/diagnostics/requestLogContext';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';

function trustedRequest<T>(callback: () => T): T {
  return runWithLogContext({ requestId: 'trusted-error-handler-request-id' }, callback);
}

async function readCanonicalError(response: Response): Promise<ReturnType<typeof StandardErrorResponseSchema.parse>> {
  return StandardErrorResponseSchema.parse(await readJsonRecord(response, 'error response'));
}

describe('errorHandler', () => {
  let loggerErrorSpy: MockInstance<typeof logger.error>;

  beforeEach(() => {
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  describe('errorResponse', () => {
    it('should handle ApiError instance correctly', async () => {
      const apiError = new ApiError(ErrorCode.SESSION_NOT_FOUND, 404, 'Session not found');
      const response = trustedRequest(() => errorResponse(apiError));

      expect(response.status).toBe(404);
      const data = await readCanonicalError(response);
      expect(data.error.code).toBe('SESSION_NOT_FOUND');
      expect(data.error.message).toBe('Session not found');
      expect(data.meta.requestId).toBe('trusted-error-handler-request-id');
    });

    it('should handle ErrorCode enum correctly', async () => {
      const response = trustedRequest(() => errorResponse(ErrorCode.INVALID_REQUEST));

      expect(response.status).toBe(400);
      const data = await readCanonicalError(response);
      expect(data.error.code).toBe('INVALID_REQUEST');
      expect(data.error.message).toBeTruthy();
    });

    it('should handle ErrorCode with additional details', async () => {
      const details = { retryAfterSeconds: 60 };
      const response = trustedRequest(() => errorResponse(ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED, details));

      expect(response.status).toBe(429);
      const data = await readCanonicalError(response);
      expect(data.error.code).toBe('ZKVM_RATE_LIMIT_EXCEEDED');
      expect(data.error.details).toEqual({ kind: 'rateLimit', retryAfterSeconds: 60 });
    });

    it('should set correct status codes for different error types', () => {
      const testCases = [
        { code: ErrorCode.SESSION_NOT_FOUND, expectedStatus: 404 },
        { code: ErrorCode.INVALID_REQUEST, expectedStatus: 400 },
        { code: ErrorCode.INTERNAL_ERROR, expectedStatus: 500 },
        { code: ErrorCode.SESSION_LIMIT_EXCEEDED, expectedStatus: 503 },
        { code: ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED, expectedStatus: 429 },
      ];

      for (const { code, expectedStatus } of testCases) {
        const response = trustedRequest(() => errorResponse(code));
        expect(response.status).toBe(expectedStatus);
      }
    });
  });

  describe('handleApiError', () => {
    it('should handle ApiError instances', async () => {
      const apiError = new ApiError(ErrorCode.ALREADY_VOTED, 400, 'User has already voted');
      const response = trustedRequest(() => handleApiError(apiError));

      expect(response.status).toBe(400);
      const data = await readCanonicalError(response);
      expect(data.error.code).toBe('ALREADY_VOTED');
      expect(data.error.message).toBe('User has already voted');
    });

    it('should handle Error with SESSION_LIMIT_EXCEEDED message', async () => {
      const error = new Error('SESSION_LIMIT_EXCEEDED: Maximum sessions reached');
      const response = trustedRequest(() => handleApiError(error));

      expect(response.status).toBe(503);
      expect((await readCanonicalError(response)).error.code).toBe('SESSION_LIMIT_EXCEEDED');
    });

    it('should handle Error with SESSION_NOT_FOUND message', async () => {
      const error = new Error('SESSION_NOT_FOUND: Invalid session ID');
      const response = trustedRequest(() => handleApiError(error));

      expect(response.status).toBe(404);
      expect((await readCanonicalError(response)).error.code).toBe('SESSION_NOT_FOUND');
    });

    it('should handle unknown errors as INTERNAL_ERROR', async () => {
      const unknownError = { some: 'unknown', error: 'object' };
      const response = trustedRequest(() => handleApiError(unknownError));

      expect(response.status).toBe(500);
      expect((await readCanonicalError(response)).error.code).toBe('INTERNAL_ERROR');
    });

    it('should handle string errors as INTERNAL_ERROR', async () => {
      const stringError = 'Something went wrong';
      const response = trustedRequest(() => handleApiError(stringError));

      expect(response.status).toBe(500);
      expect((await readCanonicalError(response)).error.code).toBe('INTERNAL_ERROR');
    });

    it('logs a canonical api_error event through the bounded runtime logger', () => {
      const error = new Error('Test error');

      trustedRequest(() => handleApiError(error));

      expect(loggerErrorSpy).toHaveBeenCalledWith('Unhandled API error', error, {
        event: 'api_error',
        public_code: ErrorCode.INTERNAL_ERROR,
      });
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('does not pass opaque thrown values through to telemetry', () => {
      const opaqueError = {
        details: '/api/sessions/550e8400-e29b-41d4-a716-446655440000/finalizations/finalization-1/artifacts/bundle',
      };

      trustedRequest(() => handleApiError(opaqueError));

      expect(loggerErrorSpy).toHaveBeenCalledWith('Unhandled API error', expect.any(Error), {
        event: 'api_error',
        public_code: ErrorCode.INTERNAL_ERROR,
      });
      expect(loggerErrorSpy.mock.calls.flat()).not.toContain(opaqueError);
    });

    it('should handle null and undefined errors', async () => {
      const nullResponse = trustedRequest(() => handleApiError(null));
      expect(nullResponse.status).toBe(500);
      expect((await readCanonicalError(nullResponse)).error.code).toBe('INTERNAL_ERROR');

      const undefinedResponse = trustedRequest(() => handleApiError(undefined));
      expect(undefinedResponse.status).toBe(500);
      expect((await readCanonicalError(undefinedResponse)).error.code).toBe('INTERNAL_ERROR');
    });

    it('should handle errors with rate limit details', async () => {
      const details = {
        nextAvailableAt: new Date(Date.now() + 3600000).toISOString(),
        remainingExecutions: 2,
      };
      const apiError = new ApiError(ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED, 429, undefined, details);

      const response = trustedRequest(() => handleApiError(apiError));
      expect(response.status).toBe(429);

      const data = await readCanonicalError(response);
      expect(data.error.code).toBe('ZKVM_RATE_LIMIT_EXCEEDED');
      expect(data.error.details).toEqual({
        kind: 'rateLimit',
        nextAvailableAtMs: Date.parse(details.nextAvailableAt),
        remainingExecutions: details.remainingExecutions,
      });
    });
  });
});
