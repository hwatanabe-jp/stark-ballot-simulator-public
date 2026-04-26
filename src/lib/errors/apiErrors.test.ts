import { describe, it, expect } from 'vitest';
import { ApiError, ErrorCode, getErrorMessage } from './apiErrors';

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
    const details = { userId: 123, action: 'vote' };
    const error = new ApiError(ErrorCode.INVALID_REQUEST, 400, undefined, details);

    expect(error.details).toEqual(details);
  });

  it('should serialize to JSON properly', () => {
    const error = new ApiError(ErrorCode.SESSION_EXPIRED, 401);
    const json = error.toJSON();

    expect(json).toEqual({
      error: ErrorCode.SESSION_EXPIRED,
      message: 'セッションがタイムアウトしました',
      statusCode: 401,
    });
  });

  it('should include details in JSON when present', () => {
    const details = { remainingTime: 300 };
    const error = new ApiError(ErrorCode.SESSION_LIMIT_EXCEEDED, 503, undefined, details);
    const json = error.toJSON();

    expect(json).toEqual({
      error: ErrorCode.SESSION_LIMIT_EXCEEDED,
      message: '現在混雑しています。しばらくしてからお試しください',
      statusCode: 503,
      ...details,
    });
  });
});

describe('ErrorCode', () => {
  it('should have all required error codes', () => {
    expect(ErrorCode.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
    expect(ErrorCode.SESSION_EXPIRED).toBe('SESSION_EXPIRED');
    expect(ErrorCode.SESSION_LIMIT_EXCEEDED).toBe('SESSION_LIMIT_EXCEEDED');
    expect(ErrorCode.INVALID_REQUEST).toBe('INVALID_REQUEST');
    expect(ErrorCode.INVALID_OFFSET).toBe('INVALID_OFFSET');
    expect(ErrorCode.INVALID_LIMIT).toBe('INVALID_LIMIT');
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCode.GLOBAL_LIMIT_EXCEEDED).toBe('GLOBAL_LIMIT_EXCEEDED');
    expect(ErrorCode.CAPTCHA_FAILED).toBe('CAPTCHA_FAILED');
    expect(ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED).toBe('ZKVM_RATE_LIMIT_EXCEEDED');
  });
});

describe('getErrorMessage', () => {
  it('should return correct message for each error code', () => {
    expect(getErrorMessage(ErrorCode.SESSION_NOT_FOUND)).toBe('セッションが見つかりません');
    expect(getErrorMessage(ErrorCode.SESSION_EXPIRED)).toBe('セッションがタイムアウトしました');
    expect(getErrorMessage(ErrorCode.SESSION_LIMIT_EXCEEDED)).toBe(
      '現在混雑しています。しばらくしてからお試しください',
    );
    expect(getErrorMessage(ErrorCode.INVALID_REQUEST)).toBe('無効なリクエストです');
    expect(getErrorMessage(ErrorCode.INVALID_OFFSET)).toBe('無効なオフセットです');
    expect(getErrorMessage(ErrorCode.INVALID_LIMIT)).toBe('無効な取得件数です');
    expect(getErrorMessage(ErrorCode.INTERNAL_ERROR)).toBe('内部エラーが発生しました');
    expect(getErrorMessage(ErrorCode.GLOBAL_LIMIT_EXCEEDED)).toBe(
      'システムが混雑しています。しばらくしてからお試しください',
    );
    expect(getErrorMessage(ErrorCode.CAPTCHA_FAILED)).toBe('セキュリティチェックに失敗しました');
    expect(getErrorMessage(ErrorCode.ZKVM_RATE_LIMIT_EXCEEDED)).toBe(
      'zkVM実行は24時間に50回までです。翌日以降にお試しください',
    );
  });
});
