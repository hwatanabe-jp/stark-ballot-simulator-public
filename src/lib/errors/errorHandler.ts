import { NextResponse } from 'next/server';
import type { ApiError, ErrorCode, ErrorDetails } from './apiErrors';
import type { ApiResponse } from '@/types';
import { handleApiErrorPayload, toApiErrorPayload } from './errorPayload';

/**
 * Create a standardized error response for Next.js route handlers.
 */
export function errorResponse(error: ApiError | ErrorCode, details?: ErrorDetails): NextResponse<ApiResponse> {
  const response = toApiErrorPayload(error, details);
  return NextResponse.json<ApiResponse>(response, { status: response.statusCode });
}

/**
 * Handle unexpected errors and convert to standardized response for Next.js.
 */
export function handleApiError(error: unknown): NextResponse<ApiResponse> {
  const response = handleApiErrorPayload(error);
  return NextResponse.json<ApiResponse>(response, { status: response.statusCode });
}
