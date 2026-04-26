/**
 * Centralized error management for API responses
 */

/**
 * Error codes for API responses
 */
export enum ErrorCode {
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_LIMIT_EXCEEDED = 'SESSION_LIMIT_EXCEEDED',
  INVALID_REQUEST = 'INVALID_REQUEST',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  INVALID_OFFSET = 'INVALID_OFFSET',
  INVALID_LIMIT = 'INVALID_LIMIT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  GLOBAL_LIMIT_EXCEEDED = 'GLOBAL_LIMIT_EXCEEDED',
  CAPTCHA_FAILED = 'CAPTCHA_FAILED',
  ZKVM_RATE_LIMIT_EXCEEDED = 'ZKVM_RATE_LIMIT_EXCEEDED',
  SESSION_CAPABILITY_REQUIRED = 'SESSION_CAPABILITY_REQUIRED',
  SESSION_CAPABILITY_INVALID = 'SESSION_CAPABILITY_INVALID',
  SESSION_CAPABILITY_EXPIRED = 'SESSION_CAPABILITY_EXPIRED',
  UNSUPPORTED_CURRENT_ARTIFACT = 'UNSUPPORTED_CURRENT_ARTIFACT',
  CORRUPT_OR_UNREADABLE_FINALIZED_STATE = 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',

  // Additional error codes used in routes
  SESSION_ID_REQUIRED = 'SESSION_ID_REQUIRED',
  INVALID_VOTE_CHOICE = 'INVALID_VOTE_CHOICE',
  ALREADY_VOTED = 'ALREADY_VOTED',
  SESSION_FINALIZED = 'SESSION_FINALIZED',
  INVALID_COMMITMENT = 'INVALID_COMMITMENT',
  SESSION_ALREADY_FINALIZED = 'SESSION_ALREADY_FINALIZED',
  USER_NOT_VOTED = 'USER_NOT_VOTED',
  VOTING_NOT_COMPLETE = 'VOTING_NOT_COMPLETE',
  INVALID_SCENARIO = 'INVALID_SCENARIO',
  INVALID_SCENARIO_COMBINATION = 'INVALID_SCENARIO_COMBINATION',
  INVALID_BOT_ID = 'INVALID_BOT_ID',
  BOT_NOT_FOUND = 'BOT_NOT_FOUND',
  SESSION_NOT_FINALIZED = 'SESSION_NOT_FINALIZED',
  BOT_DATA_NOT_FOUND = 'BOT_DATA_NOT_FOUND',
  INVALID_VOTE_ID = 'INVALID_VOTE_ID',
  VOTE_NOT_FOUND = 'VOTE_NOT_FOUND',
  DUPLICATE_VOTE = 'DUPLICATE_VOTE',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
}

/**
 * Error messages in Japanese
 */
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.SESSION_NOT_FOUND]: 'セッションが見つかりません',
  [ErrorCode.SESSION_EXPIRED]: 'セッションがタイムアウトしました',
  [ErrorCode.SESSION_LIMIT_EXCEEDED]: '現在混雑しています。しばらくしてからお試しください',
  [ErrorCode.INVALID_REQUEST]: '無効なリクエストです',
  [ErrorCode.PAYLOAD_TOO_LARGE]: 'リクエストサイズが上限を超えています',
  [ErrorCode.INVALID_OFFSET]: '無効なオフセットです',
  [ErrorCode.INVALID_LIMIT]: '無効な取得件数です',
  [ErrorCode.INTERNAL_ERROR]: '内部エラーが発生しました',
  [ErrorCode.GLOBAL_LIMIT_EXCEEDED]: 'システムが混雑しています。しばらくしてからお試しください',
  [ErrorCode.CAPTCHA_FAILED]: 'セキュリティチェックに失敗しました',
  [ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED]: 'zkVM実行は24時間に50回までです。翌日以降にお試しください',
  [ErrorCode.SESSION_CAPABILITY_REQUIRED]: 'セッション認可トークンが必要です',
  [ErrorCode.SESSION_CAPABILITY_INVALID]: '無効なセッション認可トークンです',
  [ErrorCode.SESSION_CAPABILITY_EXPIRED]: 'セッション認可トークンの有効期限が切れています',
  [ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT]: '現在のコントラクト世代ではサポートされていない確定済み状態です',
  [ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE]: '確定済み状態が破損しているか読み取れません',

  // Additional messages
  [ErrorCode.SESSION_ID_REQUIRED]: 'セッションIDが必要です',
  [ErrorCode.INVALID_VOTE_CHOICE]: '無効な投票選択です',
  [ErrorCode.ALREADY_VOTED]: 'すでに投票済みです',
  [ErrorCode.SESSION_FINALIZED]: 'セッションは終了しています',
  [ErrorCode.INVALID_COMMITMENT]: '無効なコミットメントです',
  [ErrorCode.SESSION_ALREADY_FINALIZED]: 'セッションはすでに確定されています',
  [ErrorCode.USER_NOT_VOTED]: 'ユーザーの投票が完了していません',
  [ErrorCode.VOTING_NOT_COMPLETE]: '投票がまだ完了していません',
  [ErrorCode.INVALID_SCENARIO]: '無効なシナリオです',
  [ErrorCode.INVALID_SCENARIO_COMBINATION]: '無効なシナリオの組み合わせです',
  [ErrorCode.INVALID_BOT_ID]: '無効なボットIDです',
  [ErrorCode.BOT_NOT_FOUND]: 'ボットが見つかりません',
  [ErrorCode.SESSION_NOT_FINALIZED]: 'セッションがまだ確定されていません',
  [ErrorCode.BOT_DATA_NOT_FOUND]: 'ボットデータが見つかりません',
  [ErrorCode.INVALID_VOTE_ID]: '無効な投票IDです',
  [ErrorCode.VOTE_NOT_FOUND]: '投票が見つかりません',
  [ErrorCode.DUPLICATE_VOTE]: '重複投票が検出されました',
  [ErrorCode.VERIFICATION_FAILED]: '検証に失敗しました',
};

/**
 * Get error message for a given error code
 */
export function getErrorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code] || '不明なエラーが発生しました';
}

export interface ApiErrorPayload {
  error: ErrorCode;
  message: string;
  statusCode: number;
  [key: string]: unknown;
}

export type ErrorDetails = Record<string, unknown>;

/**
 * Custom error class for API errors
 */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly statusCode: number,
    message?: string,
    public readonly details?: ErrorDetails,
  ) {
    super(message || getErrorMessage(code));
    this.name = 'ApiError';

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, ApiError);
  }

  /**
   * Convert error to JSON response format
   */
  toJSON(): ApiErrorPayload {
    const json: ApiErrorPayload = {
      error: this.code,
      message: this.message,
      statusCode: this.statusCode,
    };

    // Spread additional details if provided
    if (this.details) {
      Object.assign(json, this.details);
    }

    return json;
  }
}

/**
 * Standard HTTP status codes for common errors
 */
export const ERROR_STATUS_CODES: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.SESSION_NOT_FOUND]: 404,
  [ErrorCode.SESSION_EXPIRED]: 401,
  [ErrorCode.SESSION_LIMIT_EXCEEDED]: 503,
  [ErrorCode.INVALID_REQUEST]: 400,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.INVALID_OFFSET]: 400,
  [ErrorCode.INVALID_LIMIT]: 400,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.GLOBAL_LIMIT_EXCEEDED]: 503,
  [ErrorCode.CAPTCHA_FAILED]: 403,
  [ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.SESSION_CAPABILITY_REQUIRED]: 401,
  [ErrorCode.SESSION_CAPABILITY_INVALID]: 401,
  [ErrorCode.SESSION_CAPABILITY_EXPIRED]: 401,
  [ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT]: 500,
  [ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE]: 500,
  [ErrorCode.SESSION_ID_REQUIRED]: 400,
  [ErrorCode.INVALID_VOTE_CHOICE]: 400,
  [ErrorCode.ALREADY_VOTED]: 400,
  [ErrorCode.SESSION_FINALIZED]: 400,
  [ErrorCode.INVALID_COMMITMENT]: 400,
  [ErrorCode.SESSION_ALREADY_FINALIZED]: 400,
  [ErrorCode.USER_NOT_VOTED]: 400,
  [ErrorCode.VOTING_NOT_COMPLETE]: 400,
  [ErrorCode.INVALID_SCENARIO]: 400,
  [ErrorCode.INVALID_SCENARIO_COMBINATION]: 400,
  [ErrorCode.INVALID_BOT_ID]: 400,
  [ErrorCode.BOT_NOT_FOUND]: 404,
  [ErrorCode.SESSION_NOT_FINALIZED]: 400,
  [ErrorCode.BOT_DATA_NOT_FOUND]: 404,
  [ErrorCode.INVALID_VOTE_ID]: 400,
  [ErrorCode.VOTE_NOT_FOUND]: 404,
  [ErrorCode.DUPLICATE_VOTE]: 409,
  [ErrorCode.VERIFICATION_FAILED]: 400,
};

/**
 * Helper to create error response from ApiError or ErrorCode
 */
export function createErrorResponse(error: ApiError | ErrorCode, details?: ErrorDetails): ApiErrorPayload {
  if (error instanceof ApiError) {
    return error.toJSON();
  }

  const statusCode = ERROR_STATUS_CODES[error] || 500;
  return new ApiError(error, statusCode, undefined, details).toJSON();
}
