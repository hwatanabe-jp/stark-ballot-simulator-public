import { ErrorCode } from './apiErrors';

export type FailClosedFinalizationErrorCode = typeof ErrorCode.INVALID_FINALIZATION_ARTIFACT;

export type CapabilityLossErrorCode =
  | typeof ErrorCode.SESSION_CAPABILITY_REQUIRED
  | typeof ErrorCode.SESSION_CAPABILITY_INVALID
  | typeof ErrorCode.SESSION_CAPABILITY_EXPIRED;

export type SessionUnavailableErrorCode = typeof ErrorCode.SESSION_NOT_FOUND | CapabilityLossErrorCode;

export function isFailClosedFinalizationErrorCode(errorCode: unknown): errorCode is FailClosedFinalizationErrorCode {
  return errorCode === ErrorCode.INVALID_FINALIZATION_ARTIFACT;
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
