import type { PublicVerificationReport, PublicVerificationResult } from '@stark-ballot/verification/public-result';

declare function acceptPublicVerificationReport(report: PublicVerificationReport): void;
declare function acceptPublicVerificationResult(result: PublicVerificationResult): void;

const reportCommon = {
  verifier_version: '1.0.0',
  verified_at: '2026-01-01T00:00:00Z',
  duration_ms: 1,
  expected_image_id: `0x${'11'.repeat(32)}`,
} as const;

acceptPublicVerificationResult({ status: 'not_run' });
acceptPublicVerificationResult({
  status: 'success',
  report: {
    ...reportCommon,
    status: 'success',
    dev_mode_receipt: false,
    receipt_image_id: reportCommon.expected_image_id,
  },
});
acceptPublicVerificationReport({
  ...reportCommon,
  status: 'failed',
  dev_mode_receipt: false,
  receipt_image_id: null,
  errors: ['Verification failed'],
});

// @ts-expect-error Nonterminal results cannot carry terminal reports.
acceptPublicVerificationResult({ status: 'running', report: { status: 'success', dev_mode_receipt: false } });

// @ts-expect-error The result status and report status are one discriminator.
acceptPublicVerificationResult({ status: 'success', report: { status: 'failed', errors: ['Verification failed'] } });

// @ts-expect-error Public reports are terminal and cannot claim a queued state.
acceptPublicVerificationReport({ status: 'not_run' });

// @ts-expect-error A successful report cannot carry development receipt evidence.
acceptPublicVerificationReport({ status: 'success', dev_mode_receipt: true });

// @ts-expect-error A successful report cannot carry failure text.
acceptPublicVerificationReport({ status: 'success', errors: ['Verification failed'] });
