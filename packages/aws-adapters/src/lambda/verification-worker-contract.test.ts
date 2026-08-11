import { describe, expect, it } from 'vitest';
import { parseVerificationWorkerResponse } from './verification-worker-contract';

describe('parseVerificationWorkerResponse', () => {
  const validReport = {
    status: 'success',
    verifier_version: '0.1.0',
    verified_at: '2026-06-17T00:00:00.000Z',
    duration_ms: 42,
    expected_image_id: `0x${'ab'.repeat(32)}`,
    receipt_image_id: `0x${'ab'.repeat(32)}`,
    dev_mode_receipt: false,
    errors: [],
  };

  it('admits a success response with optional S3 metadata', () => {
    expect(
      parseVerificationWorkerResponse({
        status: 'success',
        sessionId: 'session-1',
        finalizationId: 'execution-1',
        verifierStatus: 'success',
        verificationReport: validReport,
        s3: {
          bundleKey: 'sessions/session-1/execution-1/bundle.zip',
          reportKey: 'sessions/session-1/execution-1/verification.json',
          uploadedAtMs: Date.parse('2026-06-17T00:00:00.000Z'),
        },
      }),
    ).toEqual({
      status: 'success',
      sessionId: 'session-1',
      finalizationId: 'execution-1',
      verifierStatus: 'success',
      verificationReport: validReport,
      s3: {
        bundleKey: 'sessions/session-1/execution-1/bundle.zip',
        reportKey: 'sessions/session-1/execution-1/verification.json',
        uploadedAtMs: Date.parse('2026-06-17T00:00:00.000Z'),
      },
    });
  });

  it('rejects malformed success payloads fail-closed', () => {
    expect(() =>
      parseVerificationWorkerResponse({
        status: 'success',
        sessionId: 'session-1',
        finalizationId: 'execution-1',
        verificationReport: validReport,
      }),
    ).toThrow(/verifierStatus/);
  });

  it('rejects malformed nested report payloads fail-closed', () => {
    expect(() =>
      parseVerificationWorkerResponse({
        status: 'success',
        sessionId: 'session-1',
        finalizationId: 'execution-1',
        verifierStatus: 'success',
        verificationReport: { ...validReport, status: 'bogus' },
      }),
    ).toThrow(/verificationReport\.status/);

    expect(() =>
      parseVerificationWorkerResponse({
        status: 'success',
        sessionId: 'session-1',
        finalizationId: 'execution-1',
        verifierStatus: 'success',
        verificationReport: { ...validReport, verifier_version: undefined },
      }),
    ).toThrow(/verificationReport\.verifier_version/);
  });

  it('rejects delivery fields in nested report payloads fail-closed', () => {
    expect(() =>
      parseVerificationWorkerResponse({
        status: 'success',
        sessionId: 'session-1',
        finalizationId: 'execution-1',
        verifierStatus: 'success',
        verificationReport: { ...validReport, bundle_path: '/tmp/private/bundle' },
      }),
    ).toThrow(/bundle_path/);
  });

  it('rejects malformed error payloads fail-closed', () => {
    expect(() =>
      parseVerificationWorkerResponse({
        status: 'error',
        details: 'missing message',
      }),
    ).toThrow(/message/);
  });
});
