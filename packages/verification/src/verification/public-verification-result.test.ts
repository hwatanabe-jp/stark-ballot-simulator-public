import { describe, expect, it } from 'vitest';
import {
  parsePublicVerificationReport,
  parsePublicVerificationResult,
  projectVerificationResultForPublicResponse,
  sanitizeVerificationReportForPublicResponse,
} from '@stark-ballot/verification/public-result';
import type { VerificationReport } from '@stark-ballot/verification/shared/types';

const baseReport = {
  status: 'failed',
  verifier_version: 'verifier-service-test',
  verified_at: '2026-06-11T00:00:00.000Z',
  duration_ms: 100,
  expected_image_id: `0x${'1'.repeat(64)}`,
  receipt_image_id: null,
  dev_mode_receipt: false,
  errors: ['Verification failed'],
} satisfies VerificationReport;

function s3ObjectUrl(hostParts: string[], objectPath: string): string {
  return `https://${hostParts.join('.')}/${objectPath}`;
}

describe('sanitizeVerificationReportForPublicResponse', () => {
  it('keeps known public verifier errors', () => {
    const report = sanitizeVerificationReportForPublicResponse({
      ...baseReport,
      errors: ['ImageID mismatch', 'Receipt does not contain ImageID'],
    });

    expect(report.errors).toEqual(['ImageID mismatch', 'Receipt does not contain ImageID']);
  });

  it('maps raw verifier text to a generic public error', () => {
    const report = sanitizeVerificationReportForPublicResponse({
      ...baseReport,
      errors: [
        'failed to read /tmp/verifier-work/input.json',
        'Error: verifier failed\n    at run (/var/task/index.js:1:1)',
        `${s3ObjectUrl(['bucket', 's3', 'amazonaws', 'com'], 'private/reports/verification.json')}?X-Amz-Signature=abc`,
      ],
    });

    expect(report.errors).toEqual(['Verification failed']);
  });
});

describe('public verification result admission', () => {
  const reportCommon = {
    verifier_version: 'verifier-service-test',
    verified_at: '2026-08-11T00:00:00Z',
    duration_ms: 12,
    expected_image_id: `0x${'a'.repeat(64)}`,
  } as const;

  it.each([
    { status: 'not_run' },
    { status: 'running' },
    {
      status: 'success',
      report: {
        status: 'success',
        ...reportCommon,
        receipt_image_id: reportCommon.expected_image_id,
        dev_mode_receipt: false,
      },
    },
    {
      status: 'dev_mode',
      report: {
        status: 'dev_mode',
        ...reportCommon,
        receipt_image_id: null,
        dev_mode_receipt: true,
      },
    },
    {
      status: 'failed',
      report: {
        status: 'failed',
        ...reportCommon,
        receipt_image_id: null,
        dev_mode_receipt: false,
        errors: ['Verification failed'],
      },
    },
  ] as const)('admits a coherent $status public result', (candidate) => {
    expect(parsePublicVerificationResult(candidate)).toEqual(candidate);
  });

  it.each([
    { status: 'success', report: { status: 'success', dev_mode_receipt: false } },
    { status: 'dev_mode', report: { status: 'dev_mode', dev_mode_receipt: true } },
    {
      status: 'failed',
      report: { status: 'failed', dev_mode_receipt: false, errors: ['Verification failed'] },
    },
  ] as const)('rejects a partial present $status report while retaining status-only results', (candidate) => {
    expect(parsePublicVerificationResult(candidate)).toBeUndefined();
  });

  it.each([
    {
      status: 'success',
      report: { status: 'failed', errors: ['Verification failed'] },
    },
    {
      status: 'not_run',
      report: { status: 'success', dev_mode_receipt: false },
    },
    {
      status: 'running',
      report: { status: 'dev_mode', dev_mode_receipt: true },
    },
    {
      status: 'dev_mode',
      report: { status: 'dev_mode', dev_mode_receipt: false },
    },
    {
      status: 'success',
      report: { status: 'success', dev_mode_receipt: false, errors: ['Verification failed'] },
    },
    {
      status: 'failed',
      report: { status: 'running' },
    },
  ] as const)('rejects an incoherent public result: %o', (candidate) => {
    expect(parsePublicVerificationResult(candidate)).toBeUndefined();
  });

  it.each([
    {
      status: 'success',
      expected_image_id: `0x${'a'.repeat(64)}`,
      receipt_image_id: `0x${'b'.repeat(64)}`,
      dev_mode_receipt: false,
    },
    {
      status: 'dev_mode',
      expected_image_id: `0x${'a'.repeat(64)}`,
      receipt_image_id: `0x${'b'.repeat(64)}`,
      dev_mode_receipt: true,
    },
    { status: 'failed', expected_image_id: 'not-an-image-id' },
    { status: 'failed', duration_ms: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'failed', verified_at: 'not-a-time' },
  ] as const)('rejects a semantically invalid public report: %o', (candidate) => {
    expect(parsePublicVerificationReport(candidate)).toBeUndefined();
  });

  it('projects an internal terminal result without losing status correlation', () => {
    expect(projectVerificationResultForPublicResponse(baseReport)).toEqual({
      status: 'failed',
      report: baseReport,
    });
  });
});
