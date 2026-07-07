import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import type {
  PublicVerificationErrorMessage,
  PublicVerificationReport,
  VerificationStatus,
} from '@stark-ballot/verification/shared/types';

export { ErrorCode };

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

export function getErrorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code] || '不明なエラーが発生しました';
}

type PublicErrorArtifactState = 'unsupported_current_artifact' | 'corrupt_or_unreadable';

type FlattenedSchemaError = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
};

export type ErrorDetails = {
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
  errors?: PublicVerificationErrorMessage[];
} & Record<string, unknown>;

export type FailClosedFinalizationErrorCode =
  ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT | ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE;

export type CapabilityLossErrorCode =
  ErrorCode.SESSION_CAPABILITY_REQUIRED | ErrorCode.SESSION_CAPABILITY_INVALID | ErrorCode.SESSION_CAPABILITY_EXPIRED;

export type SessionUnavailableErrorCode = ErrorCode.SESSION_NOT_FOUND | CapabilityLossErrorCode;

export function isFailClosedFinalizationErrorCode(errorCode: unknown): errorCode is FailClosedFinalizationErrorCode {
  return (
    errorCode === ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT ||
    errorCode === ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
  );
}

export function isCapabilityLossErrorCode(errorCode: unknown): errorCode is CapabilityLossErrorCode {
  return (
    errorCode === ErrorCode.SESSION_CAPABILITY_REQUIRED ||
    errorCode === ErrorCode.SESSION_CAPABILITY_INVALID ||
    errorCode === ErrorCode.SESSION_CAPABILITY_EXPIRED
  );
}

export function isSessionUnavailableErrorCode(errorCode: unknown): errorCode is SessionUnavailableErrorCode {
  return errorCode === ErrorCode.SESSION_NOT_FOUND || isCapabilityLossErrorCode(errorCode);
}
