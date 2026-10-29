import { extractTurnstileToken, validateTurnstileToken } from '../security/turnstile';
import { ApiError } from '@stark-ballot/api-contract/errors/apiErrors';
import { logger } from '@stark-ballot/diagnostics/logger';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

/** Validate the token from admitted route input with the resolved rate-limit client identity. */
export async function requireTurnstileToken(
  profile: ResolvedRuntimeProfile,
  input: { body: unknown },
  rate: { clientIp: string },
  expectedAction: 'session' | 'vote' | 'finalize',
): Promise<void> {
  const options = {
    payload: input.body,
    ...omitUndefinedProperties({ explicitToken: extractTurnstileToken(input.body) }),
    clientIp: rate.clientIp,
    expectedAction,
  };
  const token = options.explicitToken ?? extractTurnstileToken(options.payload);
  try {
    await validateTurnstileToken(profile, {
      token,
      ...omitUndefinedProperties({ remoteIp: options.clientIp ?? undefined }),
      ...omitUndefinedProperties({ expectedAction: options.expectedAction }),
    });
  } catch (error) {
    const errorCode = error instanceof ApiError ? error.code : 'UNKNOWN';
    const errorDetails = error instanceof ApiError ? error.details : undefined;
    const errorCodes =
      errorDetails && typeof errorDetails === 'object' && Array.isArray(errorDetails.errorCodes)
        ? errorDetails.errorCodes
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
