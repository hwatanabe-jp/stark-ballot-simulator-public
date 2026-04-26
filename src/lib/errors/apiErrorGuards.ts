import { ErrorCode } from './apiErrors';

export type FailClosedFinalizationErrorCode =
  | ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT
  | ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE;

export type CapabilityLossErrorCode =
  | ErrorCode.SESSION_CAPABILITY_REQUIRED
  | ErrorCode.SESSION_CAPABILITY_INVALID
  | ErrorCode.SESSION_CAPABILITY_EXPIRED;

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
