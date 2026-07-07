import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { handleApiErrorPayload, toApiErrorPayload } from './errorPayload';
import { ApiError, ErrorCode } from './apiErrors';

describe('errorPayload', () => {
  let consoleSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('toApiErrorPayload', () => {
    it('should convert ErrorCode to ApiErrorPayload', () => {
      const payload = toApiErrorPayload(ErrorCode.INVALID_REQUEST);

      expect(payload.error).toBe('INVALID_REQUEST');
      expect(payload.message).toBeTruthy();
      expect(payload.statusCode).toBe(400);
    });

    it('should include additional details when provided', () => {
      const details = { reason: 'session_expired' };
      const payload = toApiErrorPayload(ErrorCode.SESSION_EXPIRED, details);

      expect(payload.error).toBe('SESSION_EXPIRED');
      expect(payload.reason).toBe('session_expired');
      expect(payload.statusCode).toBe(401);
    });
  });

  describe('handleApiErrorPayload', () => {
    it('should convert ApiError instances', () => {
      const apiError = new ApiError(ErrorCode.SESSION_NOT_FOUND, 404, 'Session not found');
      const payload = handleApiErrorPayload(apiError);

      expect(payload.error).toBe('SESSION_NOT_FOUND');
      expect(payload.message).toBe('Session not found');
      expect(payload.statusCode).toBe(404);
    });

    it('should map SESSION_LIMIT_EXCEEDED messages', () => {
      const payload = handleApiErrorPayload(new Error('SESSION_LIMIT_EXCEEDED: test'));

      expect(payload.error).toBe('SESSION_LIMIT_EXCEEDED');
      expect(payload.statusCode).toBe(503);
    });
  });
});
