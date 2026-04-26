import type { SessionIdentity } from '@/lib/session';
import {
  clearClientFinalizedProjection,
  clearClientSessionAuthority,
} from '@/lib/finalize/client-finalization-boundary';
import { isFailClosedFinalizationErrorCode, isSessionUnavailableErrorCode } from '@/lib/errors/apiErrorGuards';
import { getStringProperty } from '@/lib/utils/guards';

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
    this.code = options.code;
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
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function resolveVerificationClientApiError(
  options: ResolveVerificationClientApiErrorOptions,
): VerificationClientApiError {
  const errorCode = getStringProperty(options.rawBody, 'error') ?? undefined;
  const errorMessage = getStringProperty(options.rawBody, 'message') ?? undefined;
  const defaultMessage = options.responseStatusText || options.fallbackMessage;

  if (isFailClosedFinalizationErrorCode(errorCode)) {
    clearClientFinalizedProjection(options.sessionIdentity);
    return new VerificationClientApiError(errorMessage ?? errorCode, {
      code: errorCode,
      invalidation: 'clear_finalized_projection',
      responseStatus: options.responseStatus,
    });
  }

  if (isSessionUnavailableErrorCode(errorCode)) {
    clearClientSessionAuthority(options.sessionIdentity);
    return new VerificationClientApiError(options.resolveSessionErrorMessage?.() ?? errorMessage ?? errorCode, {
      code: errorCode,
      invalidation: 'clear_session_authority',
      responseStatus: options.responseStatus,
    });
  }

  return new VerificationClientApiError(errorMessage ?? errorCode ?? defaultMessage, {
    code: errorCode,
    invalidation: 'none',
    responseStatus: options.responseStatus,
  });
}

export function isVerificationClientInvalidationError(
  error: unknown,
): error is VerificationClientApiError & { invalidation: Exclude<VerificationClientInvalidation, 'none'> } {
  return error instanceof VerificationClientApiError && error.invalidation !== 'none';
}
