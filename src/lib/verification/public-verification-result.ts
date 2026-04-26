import type {
  PublicVerificationReport,
  PublicVerificationResult,
  VerificationReport,
  VerificationResult,
} from '@/types/server';

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function sanitizeVerificationReportForPublicResponse(
  report?: VerificationReport,
): PublicVerificationReport | undefined {
  if (!report) {
    return undefined;
  }

  const sanitizedErrors = Array.isArray(report.errors)
    ? report.errors.filter((entry): entry is string => typeof entry === 'string').slice(0, 20)
    : undefined;

  return {
    status: report.status,
    verifier_version: nonEmptyString(report.verifier_version),
    verified_at: nonEmptyString(report.verified_at),
    duration_ms: Number.isFinite(report.duration_ms) ? report.duration_ms : undefined,
    expected_image_id: nonEmptyString(report.expected_image_id),
    receipt_image_id: report.receipt_image_id,
    dev_mode_receipt: typeof report.dev_mode_receipt === 'boolean' ? report.dev_mode_receipt : undefined,
    errors: sanitizedErrors && sanitizedErrors.length > 0 ? sanitizedErrors : undefined,
  };
}

export function projectVerificationResultForPublicResponse(
  result?: VerificationResult,
): PublicVerificationResult | undefined {
  if (!result) {
    return undefined;
  }

  return {
    status: result.status,
    report: sanitizeVerificationReportForPublicResponse(result.report),
    executionId: nonEmptyString(result.executionId),
  };
}
