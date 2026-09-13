import type { VerificationReport, VerificationResult } from '@stark-ballot/verification/shared/types';
import { s, type Infer } from '@stark-ballot/validation/schema';
import { documentOpenApiRefinement } from '@stark-ballot/validation/schema-openapi';
import {
  verifierReportDurationMsSchema,
  verifierReportImageIdSchema,
  verifierReportTimestampSchema,
} from './verifier-service-report';

export const PUBLIC_VERIFICATION_ERROR_MESSAGES = [
  'ImageID mismatch',
  'Receipt does not contain ImageID',
  'Invalid proof',
  'Failed to download bundle',
  'Verification failed',
] as const;

export const publicVerificationErrorSchema = s.enum(PUBLIC_VERIFICATION_ERROR_MESSAGES);
export type PublicVerificationErrorMessage = Infer<typeof publicVerificationErrorSchema>;

const PUBLIC_VERIFICATION_ERROR_MESSAGE_SET = new Set<string>(PUBLIC_VERIFICATION_ERROR_MESSAGES);
const GENERIC_PUBLIC_VERIFICATION_ERROR: PublicVerificationErrorMessage = 'Verification failed';
const publicVerificationReportCommonShape = {
  verifier_version: s.string().min(1),
  verified_at: verifierReportTimestampSchema,
  duration_ms: verifierReportDurationMsSchema,
  expected_image_id: verifierReportImageIdSchema,
} as const;

export const publicVerificationSuccessReportSchema = documentOpenApiRefinement(
  s
    .object({
      status: s.literal('success'),
      ...publicVerificationReportCommonShape,
      receipt_image_id: verifierReportImageIdSchema,
      dev_mode_receipt: s.literal(false),
    })
    .strict()
    .superRefine((report, context) => {
      if (report.receipt_image_id !== report.expected_image_id) {
        context.addIssue({ message: 'Successful public report receipt ImageID must match the expected ImageID' });
      }
    }),
  'A successful report has a receipt_image_id equal to expected_image_id.',
);

export const publicVerificationDevModeReportSchema = documentOpenApiRefinement(
  s
    .object({
      status: s.literal('dev_mode'),
      ...publicVerificationReportCommonShape,
      receipt_image_id: verifierReportImageIdSchema.nullable(),
      dev_mode_receipt: s.literal(true),
      errors: s.array(publicVerificationErrorSchema).min(1).optional(),
    })
    .strict()
    .superRefine((report, context) => {
      if (report.receipt_image_id !== null && report.receipt_image_id !== report.expected_image_id) {
        context.addIssue({ message: 'Dev-mode public report receipt ImageID must match the expected ImageID' });
      }
    }),
  'When present, a dev-mode receipt_image_id equals expected_image_id.',
);

export const publicVerificationFailedReportSchema = s
  .object({
    status: s.literal('failed'),
    ...publicVerificationReportCommonShape,
    receipt_image_id: verifierReportImageIdSchema.nullable(),
    dev_mode_receipt: s.boolean(),
    errors: s.array(publicVerificationErrorSchema).min(1),
  })
  .strict();

export const publicVerificationReportSchema = s.union([
  publicVerificationSuccessReportSchema,
  publicVerificationDevModeReportSchema,
  publicVerificationFailedReportSchema,
]);
export type PublicVerificationSuccessReport = Infer<typeof publicVerificationSuccessReportSchema>;
export type PublicVerificationDevModeReport = Infer<typeof publicVerificationDevModeReportSchema>;
export type PublicVerificationFailedReport = Infer<typeof publicVerificationFailedReportSchema>;
export type PublicVerificationReport = Infer<typeof publicVerificationReportSchema>;

export const publicVerificationResultSchema = s.union([
  s
    .object({
      status: s.enum(['not_run', 'running'] as const),
      report: s.undefined().optional(),
    })
    .strict(),
  s.object({ status: s.literal('success'), report: publicVerificationSuccessReportSchema.optional() }).strict(),
  s.object({ status: s.literal('dev_mode'), report: publicVerificationDevModeReportSchema.optional() }).strict(),
  s.object({ status: s.literal('failed'), report: publicVerificationFailedReportSchema.optional() }).strict(),
]);
export type PublicVerificationResult = Infer<typeof publicVerificationResultSchema>;

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
  report: Extract<VerificationReport, { status: 'success' }>,
): PublicVerificationSuccessReport;
export function sanitizeVerificationReportForPublicResponse(
  report: Extract<VerificationReport, { status: 'dev_mode' }>,
): PublicVerificationDevModeReport;
export function sanitizeVerificationReportForPublicResponse(
  report: Extract<VerificationReport, { status: 'failed' }>,
): PublicVerificationFailedReport;
export function sanitizeVerificationReportForPublicResponse(report: VerificationReport): PublicVerificationReport;
export function sanitizeVerificationReportForPublicResponse(report: undefined): undefined;
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

  const common = {
    verifier_version: report.verifier_version,
    verified_at: report.verified_at,
    duration_ms: report.duration_ms,
    expected_image_id: report.expected_image_id,
  };

  switch (report.status) {
    case 'success':
      return {
        status: 'success',
        ...common,
        receipt_image_id: report.receipt_image_id,
        dev_mode_receipt: false,
      };
    case 'dev_mode':
      return {
        status: 'dev_mode',
        ...common,
        receipt_image_id: report.receipt_image_id,
        dev_mode_receipt: true,
        ...(sanitizedErrors.length > 0 ? { errors: sanitizedErrors } : {}),
      };
    case 'failed':
      return {
        status: 'failed',
        ...common,
        receipt_image_id: report.receipt_image_id,
        dev_mode_receipt: report.dev_mode_receipt,
        errors: sanitizedErrors.length > 0 ? sanitizedErrors : [GENERIC_PUBLIC_VERIFICATION_ERROR],
      };
  }
}

export function parsePublicVerificationReport(value: unknown): PublicVerificationReport | undefined {
  const result = publicVerificationReportSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function parsePublicVerificationResult(value: unknown): PublicVerificationResult | undefined {
  const result = publicVerificationResultSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function projectVerificationResultForPublicResponse(result: VerificationResult): PublicVerificationResult;
export function projectVerificationResultForPublicResponse(report: VerificationReport): PublicVerificationResult;
export function projectVerificationResultForPublicResponse(
  input: VerificationResult | VerificationReport,
): PublicVerificationResult {
  if ('verifier_version' in input) {
    switch (input.status) {
      case 'success':
        return { status: 'success', report: sanitizeVerificationReportForPublicResponse(input) };
      case 'dev_mode':
        return { status: 'dev_mode', report: sanitizeVerificationReportForPublicResponse(input) };
      case 'failed':
        return { status: 'failed', report: sanitizeVerificationReportForPublicResponse(input) };
    }
  }

  switch (input.status) {
    case 'not_run':
    case 'running':
      return { status: input.status };
    case 'success':
      return {
        status: 'success',
        ...(input.report ? { report: sanitizeVerificationReportForPublicResponse(input.report) } : {}),
      };
    case 'dev_mode':
      return {
        status: 'dev_mode',
        ...(input.report ? { report: sanitizeVerificationReportForPublicResponse(input.report) } : {}),
      };
    case 'failed':
      return {
        status: 'failed',
        ...(input.report ? { report: sanitizeVerificationReportForPublicResponse(input.report) } : {}),
      };
  }
}
