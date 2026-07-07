import type { VerificationReport, VerificationStatus } from '@stark-ballot/verification/shared/types';

export interface VerificationWorkerOptions {
  uploadToS3?: boolean;
  workDir?: string;
}

export interface VerificationWorkerS3Payload {
  mode: 's3_bundle';
  sessionId: string;
  executionId: string;
  bundleKey: string;
  expectedImageId: string;
  options?: VerificationWorkerOptions;
}

/**
 * Supported app-side verification-worker payload.
 *
 * Trusted local bundle verification stays in-process via verifier-service and is
 * intentionally not modeled as a second worker selector contract here.
 */
export type VerificationWorkerPayload = VerificationWorkerS3Payload;

export interface VerificationWorkerSuccess {
  status: 'success';
  sessionId: string;
  executionId: string;
  verifierStatus: string;
  verificationReport: VerificationReport;
  s3?: {
    bundleKey?: string;
    reportKey?: string;
    uploadedAt?: string;
  };
}

export interface VerificationWorkerError {
  status: 'error';
  message: string;
  details?: unknown;
}

export type VerificationWorkerResponse = VerificationWorkerSuccess | VerificationWorkerError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalS3(value: unknown): VerificationWorkerSuccess['s3'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('verification-worker response s3 must be an object');
  }

  const bundleKey = value['bundleKey'];
  const reportKey = value['reportKey'];
  const uploadedAt = value['uploadedAt'];

  return {
    ...(bundleKey !== undefined ? { bundleKey: parseString(bundleKey, 's3.bundleKey') } : {}),
    ...(reportKey !== undefined ? { reportKey: parseString(reportKey, 's3.reportKey') } : {}),
    ...(uploadedAt !== undefined ? { uploadedAt: parseString(uploadedAt, 's3.uploadedAt') } : {}),
  };
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`verification-worker response ${label} is required`);
  }
  return value;
}

function parseReportStatus(value: unknown): VerificationStatus {
  if (value === 'success' || value === 'failed' || value === 'dev_mode') {
    return value;
  }
  throw new Error('verification-worker response verificationReport.status is invalid');
}

function parseNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`verification-worker response verificationReport.${label} is required`);
  }
  return value;
}

function parseReceiptImageId(value: unknown): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error('verification-worker response verificationReport.receipt_image_id is invalid');
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`verification-worker response verificationReport.${label} is required`);
  }
  return value;
}

function parseOptionalErrors(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('verification-worker response verificationReport.errors must be strings');
  }
  return value.map((entry) => String(entry));
}

function rejectReportDeliveryFields(record: Record<string, unknown>): void {
  const forbiddenFields = [
    'bundle_path',
    'receipt_path',
    'executionId',
    'verificationExecutionId',
    's3BundleKey',
    's3ReportKey',
    's3UploadedAt',
    's3BundleUrl',
  ];
  for (const field of forbiddenFields) {
    if (field in record) {
      throw new Error(`verification-worker response verificationReport.${field} is not allowed`);
    }
  }
}

export function parseVerificationWorkerReport(input: unknown): VerificationReport {
  if (!isRecord(input)) {
    throw new Error('verification-worker response verificationReport must be an object');
  }
  rejectReportDeliveryFields(input);
  const errors = input['errors'] !== undefined ? parseOptionalErrors(input['errors']) : undefined;

  return {
    status: parseReportStatus(input['status']),
    verifier_version: parseString(input['verifier_version'], 'verificationReport.verifier_version'),
    verified_at: parseString(input['verified_at'], 'verificationReport.verified_at'),
    duration_ms: parseNumber(input['duration_ms'], 'duration_ms'),
    expected_image_id: parseString(input['expected_image_id'], 'verificationReport.expected_image_id'),
    receipt_image_id: parseReceiptImageId(input['receipt_image_id']),
    dev_mode_receipt: parseBoolean(input['dev_mode_receipt'], 'dev_mode_receipt'),
    ...(errors ? { errors } : {}),
  };
}

export function parseVerificationWorkerResponse(input: unknown): VerificationWorkerResponse {
  if (!isRecord(input)) {
    throw new Error('verification-worker response must be an object');
  }

  if (input['status'] === 'success') {
    const s3 = input['s3'] !== undefined ? parseOptionalS3(input['s3']) : undefined;
    return {
      status: 'success',
      sessionId: parseString(input['sessionId'], 'sessionId'),
      executionId: parseString(input['executionId'], 'executionId'),
      verifierStatus: parseString(input['verifierStatus'], 'verifierStatus'),
      verificationReport: parseVerificationWorkerReport(input['verificationReport']),
      ...(s3 ? { s3 } : {}),
    };
  }

  if (input['status'] === 'error') {
    return {
      status: 'error',
      message: parseString(input['message'], 'message'),
      ...(input['details'] !== undefined ? { details: input['details'] } : {}),
    };
  }

  throw new Error('verification-worker response status is invalid');
}
