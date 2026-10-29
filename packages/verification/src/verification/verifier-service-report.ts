import { s, type Infer } from '@stark-ballot/validation/schema';
import { documentOpenApiRefinement } from '@stark-ballot/validation/schema-openapi';

export type VerifierServiceExitCode = 0 | 2 | 3;

const IMAGE_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isRfc3339Timestamp(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  return (
    isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    hasValidTimestampOffset(match)
  );
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const daysByMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysByMonth[month - 1];
  return maximumDay !== undefined && day >= 1 && day <= maximumDay;
}

function hasValidTimestampOffset(match: RegExpExecArray): boolean {
  if (match[7] === 'Z') return true;
  const offsetHour = Number(match[8]);
  const offsetMinute = Number(match[9]);
  return Number.isInteger(offsetHour) && offsetHour <= 23 && Number.isInteger(offsetMinute) && offsetMinute <= 59;
}

function isBasenameOnlyPath(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\u0000') &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

export const verifierReportImageIdSchema = s.string().regex(IMAGE_ID_PATTERN, 'Expected a normalized ImageID');
export const verifierReportTimestampSchema = documentOpenApiRefinement(
  s.string().refine(isRfc3339Timestamp, { message: 'Expected an RFC3339 timestamp' }),
  'The timestamp uses uppercase T/Z, at most nine fractional digits, a calendar-valid date-time, and a bounded UTC offset.',
  {
    format: 'date-time',
    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$',
  },
);
export const verifierReportDurationMsSchema = s
  .number()
  .int('Expected an integer duration_ms')
  .nonnegative('Expected a non-negative duration_ms')
  .max(Number.MAX_SAFE_INTEGER, 'Expected duration_ms within the JavaScript safe-integer range');
const basenamePathSchema = documentOpenApiRefinement(
  s.string().refine(isBasenameOnlyPath, { message: 'Expected a basename-only path' }),
  'The value is a non-dot basename without path separators, NUL, CR, or LF.',
);
const errorsSchema = s.array(s.string().min(1, 'Expected a nonempty verifier error')).min(1);

const commonReportShape = {
  verifier_version: s.string().min(1),
  verified_at: verifierReportTimestampSchema,
  duration_ms: verifierReportDurationMsSchema,
  expected_image_id: verifierReportImageIdSchema,
} as const;

const commonWireShape = {
  ...commonReportShape,
  bundle_path: basenamePathSchema,
  receipt_path: basenamePathSchema,
} as const;

const successReceiptShape = { receipt_image_id: verifierReportImageIdSchema, dev_mode_receipt: s.literal(false) };
const devModeReceiptShape = {
  receipt_image_id: verifierReportImageIdSchema.nullable(),
  dev_mode_receipt: s.literal(true),
  errors: errorsSchema.optional(),
};
const failedReceiptShape = {
  receipt_image_id: verifierReportImageIdSchema.nullable(),
  dev_mode_receipt: s.boolean(),
  errors: errorsSchema,
};

type ReportImageIds = { receipt_image_id: string | null; expected_image_id: string };
type ReportRefinementContext = { addIssue(issue: { message: string }): void };
function requireSuccessfulReceiptImageId(report: ReportImageIds, context: ReportRefinementContext): void {
  if (report.receipt_image_id !== report.expected_image_id)
    context.addIssue({ message: 'Successful report receipt ImageID must match the expected ImageID' });
}
function requireDevelopmentReceiptImageId(report: ReportImageIds, context: ReportRefinementContext): void {
  if (report.receipt_image_id !== null && report.receipt_image_id !== report.expected_image_id)
    context.addIssue({ message: 'Dev-mode report receipt ImageID must match the expected ImageID when present' });
}

const verifierServiceSuccessWireReportSchema = documentOpenApiRefinement(
  s
    .object({
      status: s.literal('success'),
      ...commonWireShape,
      ...successReceiptShape,
    })
    .strict()
    .superRefine(requireSuccessfulReceiptImageId),
  'A successful report has a receipt_image_id equal to expected_image_id.',
);

const verifierServiceDevModeWireReportSchema = documentOpenApiRefinement(
  s
    .object({
      status: s.literal('dev_mode'),
      ...commonWireShape,
      ...devModeReceiptShape,
    })
    .strict()
    .superRefine(requireDevelopmentReceiptImageId),
  'When present, a dev-mode receipt_image_id equals expected_image_id.',
);

const verifierServiceFailedWireReportSchema = s
  .object({
    status: s.literal('failed'),
    ...commonWireShape,
    ...failedReceiptShape,
  })
  .strict();

export const verifierServiceWireReportSchema = s.union([
  verifierServiceSuccessWireReportSchema,
  verifierServiceDevModeWireReportSchema,
  verifierServiceFailedWireReportSchema,
]);

const verifierServiceSuccessReportSchema = documentOpenApiRefinement(
  s
    .object({
      status: s.literal('success'),
      ...commonReportShape,
      ...successReceiptShape,
    })
    .strict()
    .superRefine(requireSuccessfulReceiptImageId),
  'A successful report has a receipt_image_id equal to expected_image_id.',
);

const verifierServiceDevModeReportSchema = documentOpenApiRefinement(
  s
    .object({
      status: s.literal('dev_mode'),
      ...commonReportShape,
      ...devModeReceiptShape,
    })
    .strict()
    .superRefine(requireDevelopmentReceiptImageId),
  'When present, a dev-mode receipt_image_id equals expected_image_id.',
);

const verifierServiceFailedReportSchema = s
  .object({
    status: s.literal('failed'),
    ...commonReportShape,
    ...failedReceiptShape,
  })
  .strict();

const verifierServiceReportSchema = s.union([
  verifierServiceSuccessReportSchema,
  verifierServiceDevModeReportSchema,
  verifierServiceFailedReportSchema,
]);

export type VerifierServiceSuccessWireReport = Infer<typeof verifierServiceSuccessWireReportSchema> & {
  errors?: never;
};
export type VerifierServiceDevModeWireReport = Omit<Infer<typeof verifierServiceDevModeWireReportSchema>, 'errors'> & {
  errors?: string[];
};
export type VerifierServiceFailedWireReport = Infer<typeof verifierServiceFailedWireReportSchema>;
export type VerifierServiceWireReport =
  | VerifierServiceSuccessWireReport
  | VerifierServiceDevModeWireReport
  | VerifierServiceFailedWireReport;

export type VerifierServiceSuccessReport = Infer<typeof verifierServiceSuccessReportSchema> & { errors?: never };
export type VerifierServiceDevModeReport = Omit<Infer<typeof verifierServiceDevModeReportSchema>, 'errors'> & {
  errors?: string[];
};
export type VerifierServiceFailedReport = Infer<typeof verifierServiceFailedReportSchema>;
export type VerifierServiceReport =
  | VerifierServiceSuccessReport
  | VerifierServiceDevModeReport
  | VerifierServiceFailedReport;

export type VerifierServiceProtocolResult =
  | {
      exitCode: 0;
      status: 'success';
      wireReport: VerifierServiceSuccessWireReport;
      report: VerifierServiceSuccessReport;
    }
  | {
      exitCode: 2;
      status: 'dev_mode';
      wireReport: VerifierServiceDevModeWireReport;
      report: VerifierServiceDevModeReport;
    }
  | {
      exitCode: 3;
      status: 'failed';
      wireReport: VerifierServiceFailedWireReport;
      report: VerifierServiceFailedReport;
    };

export function parseVerifierServiceWireReport(input: unknown): VerifierServiceWireReport {
  return verifierServiceWireReportSchema.parse(input) as VerifierServiceWireReport;
}

export function parseVerifierServiceReport(input: unknown): VerifierServiceReport {
  return verifierServiceReportSchema.parse(input) as VerifierServiceReport;
}

export function projectVerifierReportMetadata(report: VerifierServiceReport) {
  return {
    verifier_version: report.verifier_version,
    verified_at: report.verified_at,
    duration_ms: report.duration_ms,
    expected_image_id: report.expected_image_id,
  };
}

export function projectVerifierServiceWireReport(
  report: VerifierServiceSuccessWireReport,
): VerifierServiceSuccessReport;
export function projectVerifierServiceWireReport(
  report: VerifierServiceDevModeWireReport,
): VerifierServiceDevModeReport;
export function projectVerifierServiceWireReport(report: VerifierServiceFailedWireReport): VerifierServiceFailedReport;
export function projectVerifierServiceWireReport(report: VerifierServiceWireReport): VerifierServiceReport;
export function projectVerifierServiceWireReport(report: VerifierServiceWireReport): VerifierServiceReport {
  const common = projectVerifierReportMetadata(report);

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
        ...(report.errors ? { errors: [...report.errors] } : {}),
      };
    case 'failed':
      return {
        status: 'failed',
        ...common,
        receipt_image_id: report.receipt_image_id,
        dev_mode_receipt: report.dev_mode_receipt,
        errors: [...report.errors],
      };
  }
}

export function parseVerifierServiceExitCode(input: unknown): VerifierServiceExitCode {
  if (input === 0 || input === 2 || input === 3) {
    return input;
  }
  throw new Error('verifier-service exit code is unsupported');
}

export function parseVerifierServiceProtocol(
  exitCodeInput: unknown,
  reportInput: unknown,
): VerifierServiceProtocolResult {
  const exitCode = parseVerifierServiceExitCode(exitCodeInput);
  const wireReport = parseVerifierServiceWireReport(reportInput);

  switch (exitCode) {
    case 0:
      if (wireReport.status !== 'success') {
        throw new Error('verifier-service exit code does not match report status');
      }
      return {
        exitCode,
        status: wireReport.status,
        wireReport,
        report: projectVerifierServiceWireReport(wireReport),
      };
    case 2:
      if (wireReport.status !== 'dev_mode') {
        throw new Error('verifier-service exit code does not match report status');
      }
      return {
        exitCode,
        status: wireReport.status,
        wireReport,
        report: projectVerifierServiceWireReport(wireReport),
      };
    case 3:
      if (wireReport.status !== 'failed') {
        throw new Error('verifier-service exit code does not match report status');
      }
      return {
        exitCode,
        status: wireReport.status,
        wireReport,
        report: projectVerifierServiceWireReport(wireReport),
      };
  }
}
