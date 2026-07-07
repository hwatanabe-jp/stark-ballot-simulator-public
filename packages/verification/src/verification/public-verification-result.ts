import type {
  PublicVerificationReport,
  PublicVerificationErrorMessage,
  VerificationReport,
} from '@stark-ballot/verification/shared/types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export const PUBLIC_VERIFICATION_ERROR_MESSAGES = [
  'ImageID mismatch',
  'Receipt does not contain ImageID',
  'Invalid proof',
  'Failed to download bundle',
  'Verification failed',
] as const satisfies readonly PublicVerificationErrorMessage[];

const PUBLIC_VERIFICATION_ERROR_MESSAGE_SET = new Set<string>(PUBLIC_VERIFICATION_ERROR_MESSAGES);
const GENERIC_PUBLIC_VERIFICATION_ERROR: PublicVerificationErrorMessage = 'Verification failed';

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function isPublicVerificationErrorMessage(value: string): value is PublicVerificationErrorMessage {
  return PUBLIC_VERIFICATION_ERROR_MESSAGE_SET.has(value);
}

function sanitizeVerificationError(entry: unknown): PublicVerificationErrorMessage | undefined {
  if (typeof entry !== 'string') {
    return undefined;
  }

  const trimmed = entry.trim();
  if (!trimmed) {
    return undefined;
  }

  return isPublicVerificationErrorMessage(trimmed) ? trimmed : GENERIC_PUBLIC_VERIFICATION_ERROR;
}

export function sanitizeVerificationReportForPublicResponse(
  report?: VerificationReport,
): PublicVerificationReport | undefined {
  if (!report) {
    return undefined;
  }

  const sanitizedErrors: PublicVerificationErrorMessage[] = [];
  if (Array.isArray(report.errors)) {
    for (const entry of report.errors) {
      if (sanitizedErrors.length >= 20) {
        break;
      }
      const publicError = sanitizeVerificationError(entry);
      if (publicError && !sanitizedErrors.includes(publicError)) {
        sanitizedErrors.push(publicError);
      }
    }
  }

  return {
    status: report.status,
    ...omitUndefinedProperties({
      verifier_version: nonEmptyString(report.verifier_version),
      verified_at: nonEmptyString(report.verified_at),
      duration_ms: Number.isFinite(report.duration_ms) ? report.duration_ms : undefined,
      expected_image_id: nonEmptyString(report.expected_image_id),
      receipt_image_id: report.receipt_image_id,
      dev_mode_receipt: typeof report.dev_mode_receipt === 'boolean' ? report.dev_mode_receipt : undefined,
      errors: sanitizedErrors.length > 0 ? sanitizedErrors : undefined,
    }),
  };
}
