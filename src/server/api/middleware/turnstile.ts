import { extractTurnstileToken, validateTurnstileToken } from '@/lib/security/turnstile';
import { ApiError } from '@/lib/errors/apiErrors';
import { logger } from '@/lib/utils/logger';

/**
 * Input for Turnstile validation helper.
 */
export interface TurnstileValidationOptions {
  payload: unknown;
  explicitToken?: string;
  clientIp?: string | null;
  expectedAction?: string;
}

/**
 * Validate Turnstile token extracted from request payload.
 */
export async function requireTurnstileToken(options: TurnstileValidationOptions): Promise<void> {
  const token = options.explicitToken ?? extractTurnstileToken(options.payload);
  try {
    await validateTurnstileToken({
      token,
      remoteIp: options.clientIp ?? undefined,
      expectedAction: options.expectedAction,
    });
  } catch (error) {
    const errorCode = error instanceof ApiError ? error.code : 'UNKNOWN';
    const errorDetails = error instanceof ApiError ? error.details : undefined;
    const errorCodes =
      errorDetails && typeof errorDetails === 'object' && Array.isArray(errorDetails.errorCodes)
        ? (errorDetails.errorCodes as string[])
        : undefined;
    logger.warn('turnstile validation failed', {
      event: 'turnstile_failed',
      turnstile: {
        status: 'failed',
        error_code: errorCodes?.[0] ?? errorCode,
      },
    });
    throw error;
  }
}
