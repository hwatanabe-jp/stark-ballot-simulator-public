import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('@stark-ballot/node-adapters/verifier-service-client', () => ({
  invokeVerifierService: vi.fn(),
}));

vi.mock('@stark-ballot/verification/image-id', () => ({
  resolveExpectedImageId: vi.fn().mockResolvedValue('0xresolved-image-id'),
}));

import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import { resolveExpectedImageId } from '@stark-ballot/verification/image-id';
import { CLITestHelpers } from '../cli-test-helpers';

const helpers = new CLITestHelpers('http://localhost:3000');
const MOCK_PROOF_PROFILE = { executor: 'mock', evidence: 'mock' } as const;
const DEVELOPMENT_PROOF_PROFILE = { executor: 'risc0', evidence: 'development' } as const;
const PRODUCTION_PROOF_PROFILE = { executor: 'risc0', evidence: 'production' } as const;

const modernReceipt = JSON.stringify({
  seal: Buffer.from('seal').toString('base64'),
  journal: Buffer.from('journal').toString('base64'),
});

const legacyCompositeReceiptObject = {
  inner: {
    Composite: {
      segments: [
        {
          seal: Array.from({ length: 16 }, (_, i) => (i + 1) >>> 0),
          journalDigest: [1, 2, 3],
        },
      ],
    },
  },
  journal: { bytes: Array.from({ length: 32 }, (_, i) => (i * 7) % 256) },
};

const legacyCompositeReceipt = JSON.stringify(legacyCompositeReceiptObject);

type ConsoleSpy =
  MockInstance<typeof console.log> | MockInstance<typeof console.warn> | MockInstance<typeof console.error>;

function expectSingleConsoleCall(spy: ConsoleSpy, ...expectedArgs: unknown[]): void {
  expect(spy.mock.calls).toEqual([expectedArgs]);
  spy.mockClear();
}

describe('CLITestHelpers.verifySTARK', () => {
  let consoleLogSpy: MockInstance<typeof console.log>;
  let consoleWarnSpy: MockInstance<typeof console.warn>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env['EXPECTED_IMAGE_ID'];
    delete process.env['EXPECTED_IMAGEID_POC'];
    vi.mocked(resolveExpectedImageId).mockResolvedValue('0xresolved-image-id');
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  describe('verificationStatus-based verification (restored from deleted test)', () => {
    it('returns true when verificationStatus is success', async () => {
      const result = await helpers.verifySTARK(modernReceipt, {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        imageId: '0xreal',
        verificationStatus: 'success',
      });

      expect(result).toBe(true);
      expect(invokeVerifierService).not.toHaveBeenCalled();
    });

    it('returns false when verificationStatus is failed', async () => {
      const result = await helpers.verifySTARK(modernReceipt, {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        imageId: '0xreal',
        verificationStatus: 'failed',
      });

      expect(result).toBe(false);
      expect(invokeVerifierService).not.toHaveBeenCalled();
    });

    it('returns false when verificationStatus is dev_mode without allowance', async () => {
      const result = await helpers.verifySTARK(modernReceipt, {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        imageId: '0xreal',
        verificationStatus: 'dev_mode',
      });

      expect(result).toBe(false);
      expect(invokeVerifierService).not.toHaveBeenCalled();
      expectSingleConsoleCall(consoleWarnSpy, '[STARK Verifier] Dev mode receipt detected by verifier-service');
    });

    it('returns true when verificationStatus is dev_mode for a development proof profile', async () => {
      const result = await helpers.verifySTARK(modernReceipt, {
        proofProfile: DEVELOPMENT_PROOF_PROFILE,
        imageId: '0xreal',
        verificationStatus: 'dev_mode',
      });

      expect(result).toBe(true);
      expect(invokeVerifierService).not.toHaveBeenCalled();
      expectSingleConsoleCall(
        consoleWarnSpy,
        '[STARK Verifier] Dev mode receipt detected by verifier-service (accepted)',
      );
    });

    it('falls back to structural checks when verification status is absent', async () => {
      const result = await helpers.verifySTARK(modernReceipt, { proofProfile: MOCK_PROOF_PROFILE });

      expect(result).toBe(true);
      expect(invokeVerifierService).not.toHaveBeenCalled();
    });
  });

  describe('verifier-service integration', () => {
    it('invokes verifier-service when bundle path provided', async () => {
      vi.mocked(invokeVerifierService).mockResolvedValue({
        status: 'success',
        bundlePath: '/tmp/bundle.zip',
        reportPath: '/tmp/report.json',
        report: {
          status: 'success',
          verifier_version: '1.0.0',
          verified_at: new Date().toISOString(),
          duration_ms: 12,
          expected_image_id: '0xexplicit',
          receipt_image_id: '0xexplicit',
          dev_mode_receipt: false,
        },
      });

      const result = await helpers.verifySTARK('receipt', {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        imageId: '0xexplicit',
        verificationBundlePath: '/tmp/bundle.zip',
      });

      expect(result).toBe(true);
      expect(invokeVerifierService).toHaveBeenCalledTimes(1);
      expect(invokeVerifierService).toHaveBeenCalledWith(
        expect.objectContaining({
          bundlePath: '/tmp/bundle.zip',
          expectedImageId: '0xexplicit',
        }),
      );
    });

    it('resolves expected ImageID when not provided', async () => {
      vi.mocked(invokeVerifierService).mockResolvedValue({
        status: 'success',
        bundlePath: '/tmp/bundle.zip',
        reportPath: '/tmp/report.json',
        report: {
          status: 'success',
          verifier_version: '1.0.0',
          verified_at: new Date().toISOString(),
          duration_ms: 12,
          expected_image_id: '0xresolved-image-id',
          receipt_image_id: '0xresolved-image-id',
          dev_mode_receipt: false,
        },
      });

      const result = await helpers.verifySTARK('receipt', {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        verificationBundlePath: '/tmp/bundle.zip',
      });

      expect(result).toBe(true);
      expect(resolveExpectedImageId).toHaveBeenCalledTimes(1);
      expect(invokeVerifierService).toHaveBeenCalledWith(
        expect.objectContaining({ expectedImageId: '0xresolved-image-id' }),
      );
    });

    it('returns false when verifier-service reports failure', async () => {
      vi.mocked(invokeVerifierService).mockResolvedValue({
        status: 'failed',
        bundlePath: '/tmp/bundle.zip',
        reportPath: '/tmp/report.json',
        report: {
          status: 'failed',
          verifier_version: '1.0.0',
          verified_at: new Date().toISOString(),
          duration_ms: 12,
          expected_image_id: '0xresolved-image-id',
          receipt_image_id: '0xresolved-image-id',
          dev_mode_receipt: false,
          errors: ['Invalid proof'],
        },
      });

      const result = await helpers.verifySTARK('receipt', {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        verificationBundlePath: '/tmp/bundle.zip',
      });

      expect(result).toBe(false);
      expectSingleConsoleCall(consoleErrorSpy, '[STARK Verifier] verifier-service reported failed');
    });

    it('treats dev mode status as failure for a production proof profile', async () => {
      vi.mocked(invokeVerifierService).mockResolvedValue({
        status: 'dev_mode',
        bundlePath: '/tmp/bundle.zip',
        reportPath: '/tmp/report.json',
        report: {
          status: 'dev_mode',
          verifier_version: '1.0.0',
          verified_at: new Date().toISOString(),
          duration_ms: 12,
          expected_image_id: '0xresolved-image-id',
          receipt_image_id: null,
          dev_mode_receipt: true,
        },
      });

      const result = await helpers.verifySTARK('receipt', {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        verificationBundlePath: '/tmp/bundle.zip',
      });

      expect(result).toBe(false);
      expectSingleConsoleCall(consoleWarnSpy, '[STARK Verifier] verifier-service reported dev mode receipt');
    });

    it('accepts dev mode status for a development proof profile', async () => {
      vi.mocked(invokeVerifierService).mockResolvedValue({
        status: 'dev_mode',
        bundlePath: '/tmp/bundle.zip',
        reportPath: '/tmp/report.json',
        report: {
          status: 'dev_mode',
          verifier_version: '1.0.0',
          verified_at: new Date().toISOString(),
          duration_ms: 12,
          expected_image_id: '0xresolved-image-id',
          receipt_image_id: null,
          dev_mode_receipt: true,
        },
      });

      const result = await helpers.verifySTARK('receipt', {
        proofProfile: DEVELOPMENT_PROOF_PROFILE,
        verificationBundlePath: '/tmp/bundle.zip',
      });

      expect(result).toBe(true);
      expectSingleConsoleCall(consoleWarnSpy, '[STARK Verifier] verifier-service reported dev mode receipt (accepted)');
    });

    it('handles verifier-service invocation errors gracefully', async () => {
      vi.mocked(invokeVerifierService).mockRejectedValue(new Error('verifier-service binary not found'));

      const result = await helpers.verifySTARK('receipt', {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        verificationBundlePath: '/tmp/bundle.zip',
      });

      expect(result).toBe(false);
      expectSingleConsoleCall(
        consoleErrorSpy,
        '[STARK Verifier] verifier-service invocation failed: verifier-service binary not found',
      );
    });
  });

  describe('fallback behavior', () => {
    it('skips verifier-service in mock mode', async () => {
      const result = await helpers.verifySTARK(JSON.stringify({ mock: true }), {
        proofProfile: MOCK_PROOF_PROFILE,
      });

      expect(result).toBe(true);
      expect(invokeVerifierService).not.toHaveBeenCalled();
      expectSingleConsoleCall(consoleLogSpy, '[STARK Verifier] Mock receipt detected');
    });

    it('uses provided verificationStatus when bundle path missing', async () => {
      const result = await helpers.verifySTARK('receipt', {
        proofProfile: PRODUCTION_PROOF_PROFILE,
        verificationStatus: 'failed',
      });

      expect(result).toBe(false);
      expect(invokeVerifierService).not.toHaveBeenCalled();
    });

    it('falls back to structural checks when both bundlePath and status are absent', async () => {
      const result = await helpers.verifySTARK(modernReceipt, {
        proofProfile: PRODUCTION_PROOF_PROFILE,
      });

      expect(result).toBe(true);
      expect(invokeVerifierService).not.toHaveBeenCalled();
    });
  });

  describe('legacy receipt handling', () => {
    it('classifies legacy composite receipts as unsupported', () => {
      const description = helpers.describeReceipt(legacyCompositeReceiptObject);

      expect(description.kind).toBe('unknown');
    });

    it('fails structural verification for legacy composite receipts', async () => {
      const result = await helpers.verifySTARK(legacyCompositeReceipt, {
        proofProfile: PRODUCTION_PROOF_PROFILE,
      });

      expect(result).toBe(false);
      expectSingleConsoleCall(consoleErrorSpy, '[STARK Verifier] Unknown receipt format');
    });
  });
});
