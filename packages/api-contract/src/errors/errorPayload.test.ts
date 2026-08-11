import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { handleApiErrorResult, toApiErrorResult } from './errorPayload';
import { ApiError, ErrorCode } from './apiErrors';

const REQUEST_ID = 'error-payload-test-request';

describe('errorPayload', () => {
  let consoleSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('toApiErrorResult', () => {
    it('converts an ErrorCode to a canonical result', () => {
      const result = toApiErrorResult(ErrorCode.INVALID_REQUEST, REQUEST_ID);

      expect(result.payload.error.code).toBe('INVALID_REQUEST');
      expect(result.payload.error.message).toBeTruthy();
      expect(result.payload.meta.requestId).toBe(REQUEST_ID);
      expect(result.status).toBe(400);
    });

    it('drops unstructured reasons and removed artifact-state details', () => {
      const details = { reason: 'session_expired', artifactState: 'unsupported_current_artifact' as const };
      const result = toApiErrorResult(ErrorCode.SESSION_EXPIRED, REQUEST_ID, details);

      expect(result.payload.error.code).toBe('SESSION_EXPIRED');
      expect(result.payload.error).not.toHaveProperty('details');
      expect(result.payload).not.toHaveProperty('reason');
      expect(result.status).toBe(401);
    });
  });

  describe('handleApiErrorResult', () => {
    it('converts ApiError instances', () => {
      const apiError = new ApiError(ErrorCode.SESSION_NOT_FOUND, 404, 'Session not found');
      const result = handleApiErrorResult(apiError, REQUEST_ID);

      expect(result.payload.error.code).toBe('SESSION_NOT_FOUND');
      expect(result.payload.error.message).toBe('Session not found');
      expect(result.status).toBe(404);
    });

    it('maps SESSION_LIMIT_EXCEEDED messages', () => {
      const result = handleApiErrorResult(new Error('SESSION_LIMIT_EXCEEDED: test'), REQUEST_ID);

      expect(result.payload.error.code).toBe('SESSION_LIMIT_EXCEEDED');
      expect(result.status).toBe(503);
    });
  });
});
