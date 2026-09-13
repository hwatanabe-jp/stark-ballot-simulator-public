import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';
import { describe, expect, it } from 'vitest';
import {
  isCapabilityLossErrorCode,
  isFailClosedFinalizationErrorCode,
  isSessionUnavailableErrorCode,
} from './apiErrorGuards';
import { ApiError, ErrorCode, getErrorMessage } from './apiErrors';

const ERROR_MESSAGE_CHARACTERIZATION = [
  [ErrorCode.SESSION_NOT_FOUND, 'セッションが見つかりません'],
  [ErrorCode.SESSION_EXPIRED, 'セッションがタイムアウトしました'],
  [ErrorCode.SESSION_LIMIT_EXCEEDED, '現在混雑しています。しばらくしてからお試しください'],
  [ErrorCode.INVALID_REQUEST, '無効なリクエストです'],
  [ErrorCode.PAYLOAD_TOO_LARGE, 'リクエストサイズが上限を超えています'],
  [ErrorCode.INVALID_IMAGE_ID, 'zkVMイメージIDが一致しません'],
  [ErrorCode.INVALID_SIZE, '無効なサイズです'],
  [ErrorCode.INVALID_BITMAP_PROOF_REQUEST, '無効なビットマップ証明リクエストです'],
  [ErrorCode.INVALID_OFFSET, '無効なオフセットです'],
  [ErrorCode.INVALID_LIMIT, '無効な取得件数です'],
  [ErrorCode.INTERNAL_ERROR, '内部エラーが発生しました'],
  [ErrorCode.GLOBAL_LIMIT_EXCEEDED, 'システムが混雑しています。しばらくしてからお試しください'],
  [ErrorCode.CAPTCHA_FAILED, 'セキュリティチェックに失敗しました'],
  [ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED, 'zkVM実行は24時間に50回までです。翌日以降にお試しください'],
  [ErrorCode.SESSION_CAPABILITY_REQUIRED, 'セッション認可トークンが必要です'],
  [ErrorCode.SESSION_CAPABILITY_INVALID, '無効なセッション認可トークンです'],
  [ErrorCode.SESSION_CAPABILITY_EXPIRED, 'セッション認可トークンの有効期限が切れています'],
  [ErrorCode.SAME_ORIGIN_REQUIRED, '同一オリジンからのリクエストが必要です'],
  [ErrorCode.INVALID_FINALIZATION_ARTIFACT, '確定済み成果物が無効です'],
  [ErrorCode.INVALID_BUNDLE_REFERENCE, '無効な検証バンドル参照です'],
  [ErrorCode.BUNDLE_NOT_FOUND, '検証バンドルが見つかりません'],
  [ErrorCode.BUNDLE_DOWNLOAD_FAILED, '検証バンドルを読み込めませんでした'],
  [ErrorCode.BUNDLE_REQUIRES_RANGE_DOWNLOAD, '検証バンドルは範囲指定ダウンロードが必要です'],
  [ErrorCode.INVALID_RANGE, '無効な範囲指定です'],
  [ErrorCode.REPORT_NOT_FOUND, '検証レポートが見つかりません'],
  [ErrorCode.REPORT_DOWNLOAD_FAILED, '検証レポートを読み込めませんでした'],
  [ErrorCode.REPORT_DOWNLOAD_TOO_LARGE, '検証レポートが認証済みダウンロード上限を超えています'],
  [ErrorCode.ASYNC_FINALIZATION_DISABLED, '非同期集計は無効です'],
  [ErrorCode.CANCELLATION_UNSUPPORTED, 'キャンセルはサポートされていません'],
  [ErrorCode.FINALIZATION_NOT_CANCELLABLE, '現在の状態では集計をキャンセルできません'],
  [ErrorCode.VERIFICATION_OBSERVATION_CONFLICT, '現在の検証結果と観測内容が一致しません'],
  [ErrorCode.INVALID_VOTE_CHOICE, '無効な投票選択です'],
  [ErrorCode.ALREADY_VOTED, 'すでに投票済みです'],
  [ErrorCode.SESSION_FINALIZED, 'セッションは終了しています'],
  [ErrorCode.INVALID_COMMITMENT, '無効なコミットメントです'],
  [ErrorCode.SESSION_ALREADY_FINALIZED, 'セッションはすでに確定されています'],
  [ErrorCode.USER_NOT_VOTED, 'ユーザーの投票が完了していません'],
  [ErrorCode.VOTING_NOT_COMPLETE, '投票がまだ完了していません'],
  [ErrorCode.INVALID_SCENARIO, '無効なシナリオです'],
  [ErrorCode.INVALID_SCENARIO_COMBINATION, '無効なシナリオの組み合わせです'],
  [ErrorCode.SESSION_NOT_FINALIZED, 'セッションがまだ確定されていません'],
  [ErrorCode.INVALID_VOTE_ID, '無効な投票IDです'],
  [ErrorCode.VOTE_NOT_FOUND, '投票が見つかりません'],
  [ErrorCode.DUPLICATE_VOTE, '重複投票が検出されました'],
  [ErrorCode.VERIFICATION_FAILED, '検証に失敗しました'],
  [ErrorCode.CT_PROOF_UNAVAILABLE, 'CT証明を利用できません'],
] as const satisfies readonly (readonly [ErrorCode, string])[];

const REQUEST_ID = 'api-errors-test-request';

describe('ApiError', () => {
  it('should create an ApiError instance', () => {
    const error = new ApiError(ErrorCode.SESSION_NOT_FOUND, 404);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('セッションが見つかりません');
  });

  it('should create error with custom message', () => {
    const customMessage = 'Custom error message';
    const error = new ApiError(ErrorCode.INTERNAL_ERROR, 500, customMessage);

    expect(error.message).toBe(customMessage);
  });

  it('should include details when provided', () => {
    const details = { details: 'vote rejected' };
    const error = new ApiError(ErrorCode.INVALID_REQUEST, 400, undefined, details);

    expect(error.details).toEqual(details);
  });

  it('serializes the status separately from the canonical public payload', () => {
    const error = new ApiError(ErrorCode.SESSION_EXPIRED, 401);
    const result = error.toResult(REQUEST_ID);

    expect(result).toEqual({
      status: 401,
      payload: {
        error: {
          code: ErrorCode.SESSION_EXPIRED,
          message: 'セッションがタイムアウトしました',
        },
        meta: { requestId: REQUEST_ID },
      },
    });
  });

  it('includes only tagged public details in the payload', () => {
    const details = { retryAfter: 300 };
    const error = new ApiError(ErrorCode.SESSION_LIMIT_EXCEEDED, 503, undefined, details);
    const result = error.toResult(REQUEST_ID);

    expect(result).toEqual({
      status: 503,
      payload: {
        error: {
          code: ErrorCode.SESSION_LIMIT_EXCEEDED,
          message: '現在混雑しています。しばらくしてからお試しください',
          details: {
            kind: 'rateLimit',
            retryAfterSeconds: 300,
          },
        },
        meta: { requestId: REQUEST_ID },
      },
    });
  });

  it('serializes only allowlisted public detail fields', () => {
    const error = new ApiError(ErrorCode.INVALID_REQUEST, 400, undefined, {
      message: 'Invalid JSON payload',
      details: 'Validation failed',
      issues: {
        formErrors: [],
        fieldErrors: {
          vote: ['Expected string'],
        },
      },
      reason: 'client_ip_missing',
      retryAfter: 30,
      limitBytes: 1024,
      receivedBytes: 2048,
    });

    expect(error.toResult(REQUEST_ID)).toEqual({
      status: 400,
      payload: {
        error: {
          code: ErrorCode.INVALID_REQUEST,
          message: 'Invalid JSON payload',
          details: {
            kind: 'validation',
            issues: {
              formErrors: [],
              fieldErrors: {
                vote: ['Expected string'],
              },
            },
          },
        },
        meta: { requestId: REQUEST_ID },
      },
    });
  });

  it('drops raw verification reports and emits only verification-state diagnostics', () => {
    const details: Record<string, unknown> = {
      status: 'failed',
      finalizationId: 'mock-finalization-001',
      errorCodes: ['VERIFY_FAILED', '', 'VERIFY_FAILED'],
      verificationReport: {
        status: 'failed',
        errors: ['leaked internal verifier path', 'ImageID mismatch', ''],
      },
    };
    const error = new ApiError(ErrorCode.VERIFICATION_FAILED, 400, undefined, details);
    const result = error.toResult(REQUEST_ID);

    expect(StandardErrorResponseSchema.safeParse(result.payload).success).toBe(true);
    expect(result.payload.error.details).toEqual({
      kind: 'verificationState',
      status: 'failed',
      finalizationId: 'mock-finalization-001',
      errorCodes: ['VERIFY_FAILED'],
    });
    expect(result.payload).not.toHaveProperty('verificationReport');
  });

  it('drops negative retryAfter values from public error payloads', () => {
    const error = new ApiError(ErrorCode.GLOBAL_LIMIT_EXCEEDED, 503, undefined, {
      retryAfter: -1,
    });
    const result = error.toResult(REQUEST_ID);

    expect(StandardErrorResponseSchema.safeParse(result.payload).success).toBe(true);
    expect(result.payload.error).not.toHaveProperty('details');
  });
});

describe('getErrorMessage', () => {
  it('preserves the complete public error code and Japanese message catalog', () => {
    const characterizedCodes = ERROR_MESSAGE_CHARACTERIZATION.map(([code]) => code);

    expect(characterizedCodes).toHaveLength(Object.values(ErrorCode).length);
    expect(new Set(characterizedCodes)).toEqual(new Set(Object.values(ErrorCode)));
    for (const [code, message] of ERROR_MESSAGE_CHARACTERIZATION) {
      expect(getErrorMessage(code)).toBe(message);
    }
  });
});

describe('API error code guard characterization', () => {
  const capabilityLossCodes = new Set<ErrorCode>([
    ErrorCode.SESSION_CAPABILITY_REQUIRED,
    ErrorCode.SESSION_CAPABILITY_INVALID,
    ErrorCode.SESSION_CAPABILITY_EXPIRED,
  ]);
  const sessionUnavailableCodes = new Set<ErrorCode>([ErrorCode.SESSION_NOT_FOUND, ...capabilityLossCodes]);
  const failClosedFinalizationCodes = new Set<ErrorCode>([ErrorCode.INVALID_FINALIZATION_ARTIFACT]);

  it('preserves membership across every public error code', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(isCapabilityLossErrorCode(code)).toBe(capabilityLossCodes.has(code));
      expect(isSessionUnavailableErrorCode(code)).toBe(sessionUnavailableCodes.has(code));
      expect(isFailClosedFinalizationErrorCode(code)).toBe(failClosedFinalizationCodes.has(code));
    }
  });

  it.each([undefined, null, '', 'UNKNOWN_ERROR_CODE', 0, {}, []])(
    'rejects non-member value %j from every error-code guard',
    (value) => {
      expect(isCapabilityLossErrorCode(value)).toBe(false);
      expect(isSessionUnavailableErrorCode(value)).toBe(false);
      expect(isFailClosedFinalizationErrorCode(value)).toBe(false);
    },
  );
});
