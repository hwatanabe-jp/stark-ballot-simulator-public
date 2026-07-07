export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  code?: string;
  message?: string;
  nextAvailableAt?: number | string;
  remainingExecutions?: number;
  retryAfter?: number;
}
