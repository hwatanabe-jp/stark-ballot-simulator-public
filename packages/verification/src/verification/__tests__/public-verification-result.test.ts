import { describe, expect, it } from 'vitest';
import { sanitizeVerificationReportForPublicResponse } from '@stark-ballot/verification/public-result';
import type { VerificationReport } from '@stark-ballot/verification/shared/types';

const baseReport: VerificationReport = {
  status: 'failed',
  verifier_version: 'verifier-service-test',
  verified_at: '2026-06-11T00:00:00.000Z',
  duration_ms: 100,
  expected_image_id: `0x${'1'.repeat(64)}`,
  receipt_image_id: null,
  dev_mode_receipt: false,
};

function s3ObjectUrl(hostParts: string[], objectPath: string): string {
  return `https://${hostParts.join('.')}/${objectPath}`;
}

describe('sanitizeVerificationReportForPublicResponse', () => {
  it('keeps known public verifier errors', () => {
    const report = sanitizeVerificationReportForPublicResponse({
      ...baseReport,
      errors: ['ImageID mismatch', 'Receipt does not contain ImageID'],
    });

    expect(report?.errors).toEqual(['ImageID mismatch', 'Receipt does not contain ImageID']);
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

    expect(report?.errors).toEqual(['Verification failed']);
  });
});
