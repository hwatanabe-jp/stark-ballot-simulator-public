import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { errorResponse, handleApiError } from './errorHandler';
import { ApiError, ErrorCode } from './apiErrors';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getNumberProperty, getStringProperty } from '@/lib/utils/guards';

// Mock NextResponse
vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((data: unknown, options?: { status?: number }) => ({
      status: options?.status ?? 200,
      json: () => Promise.resolve(data),
      ...options,
    })),
  },
}));

describe('errorHandler', () => {
  let consoleSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    // Mock console.error to avoid noise in test output
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('errorResponse', () => {
    it('should handle ApiError instance correctly', async () => {
      // GREEN: Fixed to match ApiError constructor signature
      const apiError = new ApiError(ErrorCode.SESSION_NOT_FOUND, 404, 'Session not found');
      const response = errorResponse(apiError);

      expect(response.status).toBe(404);
      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('SESSION_NOT_FOUND');
      expect(getStringProperty(data, 'message')).toBe('Session not found');
    });

    it('should handle ErrorCode enum correctly', async () => {
      // RED: This test will fail initially
      const response = errorResponse(ErrorCode.INVALID_REQUEST);

      expect(response.status).toBe(400);
      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('INVALID_REQUEST');
      expect(getStringProperty(data, 'message')).toBeTruthy();
    });

    it('should handle ErrorCode with additional details', async () => {
      // GREEN: Fixed to match actual status code for SESSION_EXPIRED
      const details = { sessionId: 'test-123', timestamp: Date.now() };
      const response = errorResponse(ErrorCode.SESSION_EXPIRED, details);

      expect(response.status).toBe(401);
      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('SESSION_EXPIRED');
      expect(getStringProperty(data, 'sessionId')).toBe(details.sessionId);
      expect(getNumberProperty(data, 'timestamp')).toBe(details.timestamp);
    });

    it('should set correct status codes for different error types', () => {
      // GREEN: Fixed to match actual status codes from ERROR_STATUS_CODES
      const testCases = [
        { code: ErrorCode.SESSION_NOT_FOUND, expectedStatus: 404 },
        { code: ErrorCode.INVALID_REQUEST, expectedStatus: 400 },
        { code: ErrorCode.INTERNAL_ERROR, expectedStatus: 500 },
        { code: ErrorCode.SESSION_LIMIT_EXCEEDED, expectedStatus: 503 }, // Fixed: 503 not 429
        { code: ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED, expectedStatus: 429 },
      ];

      for (const { code, expectedStatus } of testCases) {
        const response = errorResponse(code);
        expect(response.status).toBe(expectedStatus);
      }
    });
  });

  describe('handleApiError', () => {
    it('should handle ApiError instances', async () => {
      // GREEN: Fixed to use correct ErrorCode and constructor
      const apiError = new ApiError(ErrorCode.ALREADY_VOTED, 400, 'User has already voted');
      const response = handleApiError(apiError);

      expect(response.status).toBe(400);
      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('ALREADY_VOTED');
      expect(getStringProperty(data, 'message')).toBe('User has already voted');
    });

    it('should handle Error with SESSION_LIMIT_EXCEEDED message', async () => {
      // GREEN: Fixed to expect correct status code
      const error = new Error('SESSION_LIMIT_EXCEEDED: Maximum sessions reached');
      const response = handleApiError(error);

      expect(response.status).toBe(503);
      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('SESSION_LIMIT_EXCEEDED');
    });

    it('should handle Error with SESSION_NOT_FOUND message', async () => {
      // RED: This test will fail initially
      const error = new Error('SESSION_NOT_FOUND: Invalid session ID');
      const response = handleApiError(error);

      expect(response.status).toBe(404);
      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('SESSION_NOT_FOUND');
    });

    it('should handle unknown errors as INTERNAL_ERROR', async () => {
      // RED: This test will fail initially
      const unknownError = { some: 'unknown', error: 'object' };
      const response = handleApiError(unknownError);

      expect(response.status).toBe(500);
      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('INTERNAL_ERROR');
    });

    it('should handle string errors as INTERNAL_ERROR', async () => {
      // RED: This test will fail initially
      const stringError = 'Something went wrong';
      const response = handleApiError(stringError);

      expect(response.status).toBe(500);
      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('INTERNAL_ERROR');
    });

    it('should log errors to console', () => {
      // REFACTOR: Use the shared consoleSpy
      const error = new Error('Test error');

      handleApiError(error);

      expect(consoleSpy).toHaveBeenCalledWith('API Error:', error);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle null and undefined errors', async () => {
      // REFACTOR: Added edge case tests
      const nullResponse = handleApiError(null);
      expect(nullResponse.status).toBe(500);
      const nullData = await readJsonRecord(nullResponse, 'error response');
      expect(getStringProperty(nullData, 'error')).toBe('INTERNAL_ERROR');

      const undefinedResponse = handleApiError(undefined);
      expect(undefinedResponse.status).toBe(500);
      const undefinedData = await readJsonRecord(undefinedResponse, 'error response');
      expect(getStringProperty(undefinedData, 'error')).toBe('INTERNAL_ERROR');
    });

    it('should handle errors with rate limit details', async () => {
      // REFACTOR: Added test for detailed error responses
      const details = {
        nextAvailableAt: Date.now() + 3600000,
        remainingExecutions: 2,
      };
      const apiError = new ApiError(ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED, 429, undefined, details);

      const response = handleApiError(apiError);
      expect(response.status).toBe(429);

      const data = await readJsonRecord(response, 'error response');
      expect(getStringProperty(data, 'error')).toBe('ZKVM_RATE_LIMIT_EXCEEDED');
      expect(getNumberProperty(data, 'nextAvailableAt')).toBe(details.nextAvailableAt);
      expect(getNumberProperty(data, 'remainingExecutions')).toBe(details.remainingExecutions);
    });
  });
});
