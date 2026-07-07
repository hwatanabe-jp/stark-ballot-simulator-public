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
  UNSUPPORTED_CURRENT_ARTIFACT = 'UNSUPPORTED_CURRENT_ARTIFACT',
  CORRUPT_OR_UNREADABLE_FINALIZED_STATE = 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
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
  [ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT]: '現在のコントラクト世代ではサポートされていない確定済み状態です',
  [ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE]: '確定済み状態が破損しているか読み取れません',
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

type PublicErrorArtifactState = 'unsupported_current_artifact' | 'corrupt_or_unreadable';

type FlattenedSchemaError = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
};

export type VerificationStatus = 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running';
export type PublicVerificationErrorMessage =
  | 'ImageID mismatch'
  | 'Receipt does not contain ImageID'
  | 'Invalid proof'
  | 'Failed to download bundle'
  | 'Verification failed';

export interface PublicVerificationReport {
  status: VerificationStatus;
  verifier_version?: string;
  verified_at?: string;
  duration_ms?: number;
  expected_image_id?: string;
  receipt_image_id?: string | null;
  dev_mode_receipt?: boolean;
  errors?: PublicVerificationErrorMessage[];
}

const PUBLIC_VERIFICATION_ERROR_MESSAGES = new Set<PublicVerificationErrorMessage>([
  'ImageID mismatch',
  'Receipt does not contain ImageID',
  'Invalid proof',
  'Failed to download bundle',
  'Verification failed',
]);

type PublicErrorDetailFields = {
  message?: string;
  details?: string;
  issues?: FlattenedSchemaError;
  reason?: string;
  retryAfter?: number;
  limitBytes?: number;
  receivedBytes?: number;
  nextAvailableAt?: string;
  remainingExecutions?: number;
  artifactState?: PublicErrorArtifactState;
  runtimeContractGeneration?: string;
  persistedContractGeneration?: string | null;
  carriedContractGeneration?: string | null;
  status?: VerificationStatus;
  verificationExecutionId?: string;
  verificationReport?: PublicVerificationReport;
  voteIndex?: number;
  expectedTreeSize?: number;
  actualTreeSize?: number;
  errorCodes?: string[];
};

export type ApiErrorPayload = {
  error: ErrorCode;
  message: string;
  statusCode: number;
} & Omit<PublicErrorDetailFields, 'message'>;

export type ErrorDetails = PublicErrorDetailFields & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
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

function sanitizePublicVerificationErrors(value: unknown): PublicVerificationReport['errors'] | undefined {
  if (!isStringArray(value)) {
    return undefined;
  }

  const errors: NonNullable<PublicVerificationReport['errors']> = [];
  for (const entry of value) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const publicError = PUBLIC_VERIFICATION_ERROR_MESSAGES.has(trimmed as PublicVerificationErrorMessage)
      ? (trimmed as PublicVerificationErrorMessage)
      : 'Verification failed';
    if (!errors.includes(publicError)) {
      errors.push(publicError);
    }
    if (errors.length >= 20) {
      break;
    }
  }

  return errors.length > 0 ? errors : undefined;
}

function sanitizePublicVerificationReport(value: unknown): PublicVerificationReport | undefined {
  if (!isRecord(value) || !isVerificationStatus(value['status'])) {
    return undefined;
  }
  const errors = sanitizePublicVerificationErrors(value['errors']);

  return {
    status: value['status'],
    ...(isNonEmptyString(value['verifier_version']) ? { verifier_version: value['verifier_version'] } : {}),
    ...(isNonEmptyString(value['verified_at']) ? { verified_at: value['verified_at'] } : {}),
    ...(isNonNegativeInteger(value['duration_ms']) ? { duration_ms: value['duration_ms'] } : {}),
    ...(isNonEmptyString(value['expected_image_id']) ? { expected_image_id: value['expected_image_id'] } : {}),
    ...(isNonEmptyString(value['receipt_image_id']) || value['receipt_image_id'] === null
      ? { receipt_image_id: value['receipt_image_id'] }
      : {}),
    ...(typeof value['dev_mode_receipt'] === 'boolean' ? { dev_mode_receipt: value['dev_mode_receipt'] } : {}),
    ...(errors ? { errors } : {}),
  };
}

function sanitizeErrorDetails(details?: ErrorDetails): PublicErrorDetailFields {
  if (!details) {
    return {};
  }
  const issues = sanitizeFlattenedIssues(details.issues);
  const verificationReport = sanitizePublicVerificationReport(details.verificationReport);

  return {
    ...(isNonEmptyString(details.message) ? { message: details.message } : {}),
    ...(isNonEmptyString(details.details) ? { details: details.details } : {}),
    ...(issues ? { issues } : {}),
    ...(isNonEmptyString(details.reason) ? { reason: details.reason } : {}),
    ...(isNonNegativeFiniteNumber(details.retryAfter) ? { retryAfter: details.retryAfter } : {}),
    ...(isNonNegativeInteger(details.limitBytes) ? { limitBytes: details.limitBytes } : {}),
    ...(isNonNegativeInteger(details.receivedBytes) ? { receivedBytes: details.receivedBytes } : {}),
    ...(isNonEmptyString(details.nextAvailableAt) ? { nextAvailableAt: details.nextAvailableAt } : {}),
    ...(isNonNegativeInteger(details.remainingExecutions) ? { remainingExecutions: details.remainingExecutions } : {}),
    ...(details.artifactState === 'unsupported_current_artifact' || details.artifactState === 'corrupt_or_unreadable'
      ? { artifactState: details.artifactState }
      : {}),
    ...(isNonEmptyString(details.runtimeContractGeneration)
      ? { runtimeContractGeneration: details.runtimeContractGeneration }
      : {}),
    ...(isNonEmptyString(details.persistedContractGeneration) || details.persistedContractGeneration === null
      ? { persistedContractGeneration: details.persistedContractGeneration }
      : {}),
    ...(isNonEmptyString(details.carriedContractGeneration) || details.carriedContractGeneration === null
      ? { carriedContractGeneration: details.carriedContractGeneration }
      : {}),
    ...(isVerificationStatus(details.status) ? { status: details.status } : {}),
    ...(isNonEmptyString(details.verificationExecutionId)
      ? { verificationExecutionId: details.verificationExecutionId }
      : {}),
    ...(verificationReport ? { verificationReport } : {}),
    ...(isNonNegativeInteger(details.voteIndex) ? { voteIndex: details.voteIndex } : {}),
    ...(isNonNegativeInteger(details.expectedTreeSize) ? { expectedTreeSize: details.expectedTreeSize } : {}),
    ...(isNonNegativeInteger(details.actualTreeSize) ? { actualTreeSize: details.actualTreeSize } : {}),
    ...(isStringArray(details.errorCodes) ? { errorCodes: [...details.errorCodes] } : {}),
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
   * Convert error to JSON response format
   */
  toJSON(): ApiErrorPayload {
    const publicDetails = sanitizeErrorDetails(this.details);
    const { message: detailMessage, ...detailFields } = publicDetails;
    const json: ApiErrorPayload = {
      error: this.code,
      message: detailMessage ?? this.message,
      statusCode: this.statusCode,
      ...detailFields,
    };

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
  [ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT]: 500,
  [ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE]: 500,
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
