import type { SessionIdentity } from '@stark-ballot/web/session';
import {
  clearClientFinalizedProjection,
  clearClientSessionAuthority,
} from '@stark-ballot/web/finalize/client-finalization-boundary';
import { isFailClosedFinalizationErrorCode, isSessionUnavailableErrorCode } from '@stark-ballot/web/api/apiErrors';
import {
  readApiJson,
  readStandardApiErrorCode,
  readStandardApiErrorMessage,
} from '@stark-ballot/web/api/responseAdmission';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export type VerificationClientInvalidation = 'none' | 'clear_finalized_projection' | 'clear_session_authority';

export class VerificationClientApiError extends Error {
  readonly code?: string;
  readonly invalidation: VerificationClientInvalidation;
  readonly responseStatus: number;

  constructor(
    message: string,
    options: {
      code?: string;
      invalidation: VerificationClientInvalidation;
      responseStatus: number;
    },
  ) {
    super(message);
    this.name = 'VerificationClientApiError';
    if (options.code !== undefined) {
      this.code = options.code;
    }
    this.invalidation = options.invalidation;
    this.responseStatus = options.responseStatus;
  }
}

interface ResolveVerificationClientApiErrorOptions {
  rawBody: unknown;
  responseStatus: number;
  responseStatusText?: string;
  sessionIdentity?: SessionIdentity | null;
  resolveSessionErrorMessage?: () => string;
  fallbackMessage: string;
}

export async function readResponseJsonSafely(response: Pick<Response, 'json'>): Promise<unknown> {
  return readApiJson(response);
}

export function resolveVerificationClientApiError(
  options: ResolveVerificationClientApiErrorOptions,
): VerificationClientApiError {
  const errorCode = readStandardApiErrorCode(options.rawBody);
  const errorMessage = readStandardApiErrorMessage(options.rawBody);
  const defaultMessage = options.responseStatusText || options.fallbackMessage;

  if (isFailClosedFinalizationErrorCode(errorCode)) {
    clearClientFinalizedProjection(options.sessionIdentity);
    return new VerificationClientApiError(errorMessage ?? errorCode, {
      ...omitUndefinedProperties({ code: errorCode }),
      invalidation: 'clear_finalized_projection',
      responseStatus: options.responseStatus,
    });
  }

  if (isSessionUnavailableErrorCode(errorCode)) {
    clearClientSessionAuthority(options.sessionIdentity);
    return new VerificationClientApiError(options.resolveSessionErrorMessage?.() ?? errorMessage ?? errorCode, {
      ...omitUndefinedProperties({ code: errorCode }),
      invalidation: 'clear_session_authority',
      responseStatus: options.responseStatus,
    });
  }

  return new VerificationClientApiError(errorMessage ?? errorCode ?? defaultMessage, {
    ...omitUndefinedProperties({ code: errorCode }),
    invalidation: 'none',
    responseStatus: options.responseStatus,
  });
}

export function isVerificationClientInvalidationError(
  error: unknown,
): error is VerificationClientApiError & { invalidation: Exclude<VerificationClientInvalidation, 'none'> } {
  return error instanceof VerificationClientApiError && error.invalidation !== 'none';
}
