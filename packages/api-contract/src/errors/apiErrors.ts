/**
 * Centralized error management for API responses.
 */

import { finalizationIdSchema, requestIdSchema } from '../schemas/primitives';
import { publicErrorDetailSchema } from '../schemas/errors';
import type { FlattenedSchemaError, PublicErrorDetail, StandardErrorResponse } from '../schemas/errors';
import type { VerificationStatus } from '../schemas/verification';

export type {
  PublicVerificationErrorMessage,
  PublicVerificationReport,
  VerificationStatus,
} from '../schemas/verification';

/**
 * Error codes for API responses
 */
export enum ErrorCode {
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_LIMIT_EXCEEDED = 'SESSION_LIMIT_EXCEEDED',
  INVALID_REQUEST = 'INVALID_REQUEST',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  INVALID_IMAGE_ID = 'INVALID_IMAGE_ID',
  INVALID_SIZE = 'INVALID_SIZE',
  INVALID_BITMAP_PROOF_REQUEST = 'INVALID_BITMAP_PROOF_REQUEST',
  INVALID_OFFSET = 'INVALID_OFFSET',
  INVALID_LIMIT = 'INVALID_LIMIT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  GLOBAL_LIMIT_EXCEEDED = 'GLOBAL_LIMIT_EXCEEDED',
  CAPTCHA_FAILED = 'CAPTCHA_FAILED',
  ZKVM_RATE_LIMIT_EXCEEDED = 'ZKVM_RATE_LIMIT_EXCEEDED',
  SESSION_CAPABILITY_REQUIRED = 'SESSION_CAPABILITY_REQUIRED',
  SESSION_CAPABILITY_INVALID = 'SESSION_CAPABILITY_INVALID',
  SESSION_CAPABILITY_EXPIRED = 'SESSION_CAPABILITY_EXPIRED',
  SAME_ORIGIN_REQUIRED = 'SAME_ORIGIN_REQUIRED',
  INVALID_FINALIZATION_ARTIFACT = 'INVALID_FINALIZATION_ARTIFACT',
  INVALID_BUNDLE_REFERENCE = 'INVALID_BUNDLE_REFERENCE',
  BUNDLE_NOT_FOUND = 'BUNDLE_NOT_FOUND',
  BUNDLE_DOWNLOAD_FAILED = 'BUNDLE_DOWNLOAD_FAILED',
  BUNDLE_REQUIRES_RANGE_DOWNLOAD = 'BUNDLE_REQUIRES_RANGE_DOWNLOAD',
  INVALID_RANGE = 'INVALID_RANGE',
  REPORT_NOT_FOUND = 'REPORT_NOT_FOUND',
  REPORT_DOWNLOAD_FAILED = 'REPORT_DOWNLOAD_FAILED',
  REPORT_DOWNLOAD_TOO_LARGE = 'REPORT_DOWNLOAD_TOO_LARGE',
  ASYNC_FINALIZATION_DISABLED = 'ASYNC_FINALIZATION_DISABLED',
  CANCELLATION_UNSUPPORTED = 'CANCELLATION_UNSUPPORTED',
  FINALIZATION_NOT_CANCELLABLE = 'FINALIZATION_NOT_CANCELLABLE',
  VERIFICATION_OBSERVATION_CONFLICT = 'VERIFICATION_OBSERVATION_CONFLICT',

  // Additional error codes used in routes
  INVALID_VOTE_CHOICE = 'INVALID_VOTE_CHOICE',
  ALREADY_VOTED = 'ALREADY_VOTED',
  SESSION_FINALIZED = 'SESSION_FINALIZED',
  INVALID_COMMITMENT = 'INVALID_COMMITMENT',
  SESSION_ALREADY_FINALIZED = 'SESSION_ALREADY_FINALIZED',
  USER_NOT_VOTED = 'USER_NOT_VOTED',
  VOTING_NOT_COMPLETE = 'VOTING_NOT_COMPLETE',
  INVALID_SCENARIO = 'INVALID_SCENARIO',
  INVALID_SCENARIO_COMBINATION = 'INVALID_SCENARIO_COMBINATION',
  SESSION_NOT_FINALIZED = 'SESSION_NOT_FINALIZED',
  INVALID_VOTE_ID = 'INVALID_VOTE_ID',
  VOTE_NOT_FOUND = 'VOTE_NOT_FOUND',
  DUPLICATE_VOTE = 'DUPLICATE_VOTE',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',
  CT_PROOF_UNAVAILABLE = 'CT_PROOF_UNAVAILABLE',
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
  [ErrorCode.INVALID_IMAGE_ID]: 'zkVMイメージIDが一致しません',
  [ErrorCode.INVALID_SIZE]: '無効なサイズです',
  [ErrorCode.INVALID_BITMAP_PROOF_REQUEST]: '無効なビットマップ証明リクエストです',
  [ErrorCode.INVALID_OFFSET]: '無効なオフセットです',
  [ErrorCode.INVALID_LIMIT]: '無効な取得件数です',
  [ErrorCode.INTERNAL_ERROR]: '内部エラーが発生しました',
  [ErrorCode.GLOBAL_LIMIT_EXCEEDED]: 'システムが混雑しています。しばらくしてからお試しください',
  [ErrorCode.CAPTCHA_FAILED]: 'セキュリティチェックに失敗しました',
  [ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED]: 'zkVM実行は24時間に50回までです。翌日以降にお試しください',
  [ErrorCode.SESSION_CAPABILITY_REQUIRED]: 'セッション認可トークンが必要です',
  [ErrorCode.SESSION_CAPABILITY_INVALID]: '無効なセッション認可トークンです',
  [ErrorCode.SESSION_CAPABILITY_EXPIRED]: 'セッション認可トークンの有効期限が切れています',
  [ErrorCode.SAME_ORIGIN_REQUIRED]: '同一オリジンからのリクエストが必要です',
  [ErrorCode.INVALID_FINALIZATION_ARTIFACT]: '確定済み成果物が無効です',
  [ErrorCode.INVALID_BUNDLE_REFERENCE]: '無効な検証バンドル参照です',
  [ErrorCode.BUNDLE_NOT_FOUND]: '検証バンドルが見つかりません',
  [ErrorCode.BUNDLE_DOWNLOAD_FAILED]: '検証バンドルを読み込めませんでした',
  [ErrorCode.BUNDLE_REQUIRES_RANGE_DOWNLOAD]: '検証バンドルは範囲指定ダウンロードが必要です',
  [ErrorCode.INVALID_RANGE]: '無効な範囲指定です',
  [ErrorCode.REPORT_NOT_FOUND]: '検証レポートが見つかりません',
  [ErrorCode.REPORT_DOWNLOAD_FAILED]: '検証レポートを読み込めませんでした',
  [ErrorCode.REPORT_DOWNLOAD_TOO_LARGE]: '検証レポートが認証済みダウンロード上限を超えています',
  [ErrorCode.ASYNC_FINALIZATION_DISABLED]: '非同期集計は無効です',
  [ErrorCode.CANCELLATION_UNSUPPORTED]: 'キャンセルはサポートされていません',
  [ErrorCode.FINALIZATION_NOT_CANCELLABLE]: '現在の状態では集計をキャンセルできません',
  [ErrorCode.VERIFICATION_OBSERVATION_CONFLICT]: '現在の検証結果と観測内容が一致しません',

  // Additional messages
  [ErrorCode.INVALID_VOTE_CHOICE]: '無効な投票選択です',
  [ErrorCode.ALREADY_VOTED]: 'すでに投票済みです',
  [ErrorCode.SESSION_FINALIZED]: 'セッションは終了しています',
  [ErrorCode.INVALID_COMMITMENT]: '無効なコミットメントです',
  [ErrorCode.SESSION_ALREADY_FINALIZED]: 'セッションはすでに確定されています',
  [ErrorCode.USER_NOT_VOTED]: 'ユーザーの投票が完了していません',
  [ErrorCode.VOTING_NOT_COMPLETE]: '投票がまだ完了していません',
  [ErrorCode.INVALID_SCENARIO]: '無効なシナリオです',
  [ErrorCode.INVALID_SCENARIO_COMBINATION]: '無効なシナリオの組み合わせです',
  [ErrorCode.SESSION_NOT_FINALIZED]: 'セッションがまだ確定されていません',
  [ErrorCode.INVALID_VOTE_ID]: '無効な投票IDです',
  [ErrorCode.VOTE_NOT_FOUND]: '投票が見つかりません',
  [ErrorCode.DUPLICATE_VOTE]: '重複投票が検出されました',
  [ErrorCode.VERIFICATION_FAILED]: '検証に失敗しました',
  [ErrorCode.CT_PROOF_UNAVAILABLE]: 'CT証明を利用できません',
};

/**
 * Get error message for a given error code
 */
export function getErrorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code] || '不明なエラーが発生しました';
}

type ErrorDetailInputFields = {
  message?: string;
  details?: string | PublicErrorDetail;
  issues?: FlattenedSchemaError;
  reason?: string;
  retryAfter?: number;
  retryAfterSeconds?: number;
  limitBytes?: number;
  receivedBytes?: number;
  nextAvailableAt?: string;
  nextAvailableAtMs?: number;
  remainingExecutions?: number;
  status?: VerificationStatus;
  finalizationId?: string;
  verificationReport?: unknown;
  voteIndex?: number;
  expectedTreeSize?: number;
  actualTreeSize?: number;
  errorCodes?: string[];
};

export type ApiErrorPayload = StandardErrorResponse;

export interface ApiErrorResult {
  status: number;
  payload: ApiErrorPayload;
}

export type ErrorDetails = ErrorDetailInputFields & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function sanitizeFlattenedIssues(value: unknown): FlattenedSchemaError | undefined {
  if (!isRecord(value) || !isStringArray(value['formErrors']) || !isRecord(value['fieldErrors'])) {
    return undefined;
  }

  const fieldErrors: Record<string, string[]> = {};
  for (const [key, errors] of Object.entries(value['fieldErrors'])) {
    if (!isStringArray(errors)) {
      return undefined;
    }
    fieldErrors[key] = [...errors];
  }

  return {
    formErrors: [...value['formErrors']],
    fieldErrors,
  };
}

const VERIFICATION_STATUSES = new Set<VerificationStatus>(['success', 'failed', 'dev_mode', 'not_run', 'running']);

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === 'string' && VERIFICATION_STATUSES.has(value as VerificationStatus);
}

function sanitizeErrorCodes(value: unknown): string[] | undefined {
  if (!isStringArray(value)) {
    return undefined;
  }

  const errorCodes: string[] = [];
  for (const entry of value) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 128 || errorCodes.includes(trimmed)) {
      continue;
    }
    errorCodes.push(trimmed);
    if (errorCodes.length >= 20) {
      break;
    }
  }
  return errorCodes.length > 0 ? errorCodes : undefined;
}

function sanitizeNextAvailableAtMs(details: ErrorDetails): number | undefined {
  if (isNonNegativeInteger(details.nextAvailableAtMs)) {
    return details.nextAvailableAtMs;
  }
  if (!isNonEmptyString(details.nextAvailableAt)) {
    return undefined;
  }
  const parsed = Date.parse(details.nextAvailableAt);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function sanitizeFinalizationId(value: unknown): string | undefined {
  const parsed = finalizationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function sanitizeTaggedErrorDetail(details: ErrorDetails): PublicErrorDetail | undefined {
  const nested = publicErrorDetailSchema.safeParse(details.details);
  if (nested.success) {
    return nested.data;
  }

  const explicit = publicErrorDetailSchema.safeParse(details);
  if (explicit.success) {
    return explicit.data;
  }

  const issues = sanitizeFlattenedIssues(details.issues);
  if (issues) {
    return { kind: 'validation', issues };
  }

  if (isNonNegativeInteger(details.limitBytes)) {
    return {
      kind: 'bodyLimit',
      limitBytes: details.limitBytes,
      ...(isNonNegativeInteger(details.receivedBytes) ? { receivedBytes: details.receivedBytes } : {}),
    };
  }

  const retryAfterSeconds = isNonNegativeFiniteNumber(details.retryAfterSeconds)
    ? details.retryAfterSeconds
    : isNonNegativeFiniteNumber(details.retryAfter)
      ? details.retryAfter
      : undefined;
  const nextAvailableAtMs = sanitizeNextAvailableAtMs(details);
  const remainingExecutions = isNonNegativeInteger(details.remainingExecutions)
    ? details.remainingExecutions
    : undefined;
  if (retryAfterSeconds !== undefined || nextAvailableAtMs !== undefined || remainingExecutions !== undefined) {
    return {
      kind: 'rateLimit',
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(nextAvailableAtMs !== undefined ? { nextAvailableAtMs } : {}),
      ...(remainingExecutions !== undefined ? { remainingExecutions } : {}),
    };
  }

  if (isVerificationStatus(details.status)) {
    const finalizationId = sanitizeFinalizationId(details.finalizationId);
    const errorCodes = sanitizeErrorCodes(details.errorCodes);
    return {
      kind: 'verificationState',
      status: details.status,
      ...(finalizationId ? { finalizationId } : {}),
      ...(errorCodes ? { errorCodes } : {}),
    };
  }

  if (isNonNegativeInteger(details.voteIndex) && isNonNegativeInteger(details.expectedTreeSize)) {
    return {
      kind: 'proofRange',
      voteIndex: details.voteIndex,
      expectedTreeSize: details.expectedTreeSize,
      ...(isNonNegativeInteger(details.actualTreeSize) ? { actualTreeSize: details.actualTreeSize } : {}),
    };
  }

  return undefined;
}

function sanitizeErrorDetails(details?: ErrorDetails): { message?: string; details?: PublicErrorDetail } {
  if (!details) {
    return {};
  }

  const publicDetail = sanitizeTaggedErrorDetail(details);
  return {
    ...(isNonEmptyString(details.message) ? { message: details.message } : {}),
    ...(publicDetail ? { details: publicDetail } : {}),
  };
}

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
   * Convert the internal error into a status plus canonical public payload.
   */
  toResult(requestId: string): ApiErrorResult {
    const publicDetails = sanitizeErrorDetails(this.details);
    const parsedRequestId = requestIdSchema.safeParse(requestId);
    if (!parsedRequestId.success) {
      throw new Error('A trusted non-empty requestId is required to serialize an API error');
    }
    const payload: ApiErrorPayload = {
      error: {
        code: this.code,
        message: publicDetails.message ?? this.message,
        ...(publicDetails.details ? { details: publicDetails.details } : {}),
      },
      meta: {
        requestId: parsedRequestId.data,
      },
    };

    return {
      status: this.statusCode,
      payload,
    };
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
  [ErrorCode.INVALID_IMAGE_ID]: 400,
  [ErrorCode.INVALID_SIZE]: 400,
  [ErrorCode.INVALID_BITMAP_PROOF_REQUEST]: 400,
  [ErrorCode.INVALID_OFFSET]: 400,
  [ErrorCode.INVALID_LIMIT]: 400,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.GLOBAL_LIMIT_EXCEEDED]: 503,
  [ErrorCode.CAPTCHA_FAILED]: 403,
  [ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.SESSION_CAPABILITY_REQUIRED]: 401,
  [ErrorCode.SESSION_CAPABILITY_INVALID]: 401,
  [ErrorCode.SESSION_CAPABILITY_EXPIRED]: 401,
  [ErrorCode.SAME_ORIGIN_REQUIRED]: 403,
  [ErrorCode.INVALID_FINALIZATION_ARTIFACT]: 500,
  [ErrorCode.INVALID_BUNDLE_REFERENCE]: 400,
  [ErrorCode.BUNDLE_NOT_FOUND]: 404,
  [ErrorCode.BUNDLE_DOWNLOAD_FAILED]: 500,
  [ErrorCode.BUNDLE_REQUIRES_RANGE_DOWNLOAD]: 413,
  [ErrorCode.INVALID_RANGE]: 416,
  [ErrorCode.REPORT_NOT_FOUND]: 404,
  [ErrorCode.REPORT_DOWNLOAD_FAILED]: 500,
  [ErrorCode.REPORT_DOWNLOAD_TOO_LARGE]: 413,
  [ErrorCode.ASYNC_FINALIZATION_DISABLED]: 404,
  [ErrorCode.CANCELLATION_UNSUPPORTED]: 501,
  [ErrorCode.FINALIZATION_NOT_CANCELLABLE]: 409,
  [ErrorCode.VERIFICATION_OBSERVATION_CONFLICT]: 409,
  [ErrorCode.INVALID_VOTE_CHOICE]: 400,
  [ErrorCode.ALREADY_VOTED]: 400,
  [ErrorCode.SESSION_FINALIZED]: 400,
  [ErrorCode.INVALID_COMMITMENT]: 400,
  [ErrorCode.SESSION_ALREADY_FINALIZED]: 400,
  [ErrorCode.USER_NOT_VOTED]: 400,
  [ErrorCode.VOTING_NOT_COMPLETE]: 400,
  [ErrorCode.INVALID_SCENARIO]: 400,
  [ErrorCode.INVALID_SCENARIO_COMBINATION]: 400,
  [ErrorCode.SESSION_NOT_FINALIZED]: 400,
  [ErrorCode.INVALID_VOTE_ID]: 400,
  [ErrorCode.VOTE_NOT_FOUND]: 404,
  [ErrorCode.DUPLICATE_VOTE]: 409,
  [ErrorCode.VERIFICATION_FAILED]: 400,
  [ErrorCode.CT_PROOF_UNAVAILABLE]: 400,
};

/**
 * Build an internal HTTP status plus canonical public error payload.
 */
export function createApiErrorResult(
  error: ApiError | ErrorCode,
  requestId: string,
  details?: ErrorDetails,
): ApiErrorResult {
  if (error instanceof ApiError) {
    return error.toResult(requestId);
  }

  const statusCode = ERROR_STATUS_CODES[error] || 500;
  return new ApiError(error, statusCode, undefined, details).toResult(requestId);
}
