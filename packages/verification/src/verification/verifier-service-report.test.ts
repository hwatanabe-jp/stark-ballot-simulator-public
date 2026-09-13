import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getOpenApiEffectMetadata } from '@stark-ballot/validation/schema-openapi';
import {
  parseVerifierServiceExitCode,
  parseVerifierServiceProtocol,
  parseVerifierServiceReport,
  parseVerifierServiceWireReport,
  projectVerifierServiceWireReport,
  verifierReportTimestampSchema,
} from '@stark-ballot/verification/verifier-service-report';

const EXPECTED_IMAGE_ID = `0x${'a'.repeat(64)}`;
const OTHER_IMAGE_ID = `0x${'b'.repeat(64)}`;

type TerminalStatus = 'success' | 'dev_mode' | 'failed';

function wireReport(status: TerminalStatus): Record<string, unknown> {
  return {
    status,
    verifier_version: '0.1.0',
    verified_at: '2026-08-11T09:10:11.123456789Z',
    duration_ms: 42,
    expected_image_id: EXPECTED_IMAGE_ID,
    receipt_image_id: EXPECTED_IMAGE_ID,
    bundle_path: 'bundle.zip',
    receipt_path: 'receipt.json',
    dev_mode_receipt: status === 'dev_mode',
    ...(status === 'failed' ? { errors: ['verification failed'] } : {}),
  };
}

describe('verifier-service wire report admission', () => {
  it.each(['success', 'dev_mode', 'failed'] as const)('admits a coherent %s report', (status) => {
    expect(parseVerifierServiceWireReport(wireReport(status))).toEqual(wireReport(status));
  });

  it('admits intentional failed reports for fake receipts', () => {
    const report = wireReport('failed');
    report['dev_mode_receipt'] = true;
    report['receipt_image_id'] = OTHER_IMAGE_ID;

    expect(parseVerifierServiceWireReport(report)).toEqual(report);
  });

  it('rejects unknown keys at the exact wire boundary', () => {
    expect(() => parseVerifierServiceWireReport({ ...wireReport('success'), private_path: '/tmp/private' })).toThrow();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid duration_ms %s', (durationMs) => {
    expect(() => parseVerifierServiceWireReport({ ...wireReport('success'), duration_ms: durationMs })).toThrow();
  });

  it('admits the JavaScript safe-integer duration boundary', () => {
    expect(
      parseVerifierServiceWireReport({ ...wireReport('success'), duration_ms: Number.MAX_SAFE_INTEGER }).duration_ms,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(['2026-08-11T09:10:11Z', '2026-08-11T09:10:11.123456789Z', '2026-08-11T18:10:11+09:00'])(
    'admits RFC3339 timestamp %s',
    (verifiedAt) => {
      expect(parseVerifierServiceWireReport({ ...wireReport('success'), verified_at: verifiedAt }).verified_at).toBe(
        verifiedAt,
      );
    },
  );

  it('documents the exact timestamp lexeme before calendar and offset refinement', () => {
    expect(getOpenApiEffectMetadata(verifierReportTimestampSchema)).toMatchObject({
      overlay: {
        format: 'date-time',
        pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$',
      },
    });
    expect(() =>
      parseVerifierServiceWireReport({
        ...wireReport('success'),
        verified_at: '2026-08-11T09:10:11.1234567890Z',
      }),
    ).toThrow();
  });

  it.each([
    'not-a-timestamp',
    '2026-02-30T09:10:11Z',
    '2026-08-11 09:10:11Z',
    '2026-08-11T24:10:11Z',
    '2026-08-11T09:10:11+24:00',
  ])('rejects non-RFC3339 timestamp %s', (verifiedAt) => {
    expect(() => parseVerifierServiceWireReport({ ...wireReport('success'), verified_at: verifiedAt })).toThrow();
  });

  it.each([EXPECTED_IMAGE_ID.slice(2), `0x${'A'.repeat(64)}`, `0x${'a'.repeat(63)}`, `0x${'g'.repeat(64)}`])(
    'rejects invalid expected ImageID %s',
    (expectedImageId) => {
      expect(() =>
        parseVerifierServiceWireReport({ ...wireReport('success'), expected_image_id: expectedImageId }),
      ).toThrow();
    },
  );

  it('rejects a malformed receipt ImageID even on a failed report', () => {
    expect(() =>
      parseVerifierServiceWireReport({ ...wireReport('failed'), receipt_image_id: '0xmalformed' }),
    ).toThrow();
  });

  it.each(['', '.', '..', '/tmp/bundle.zip', 'nested/receipt.json', String.raw`nested\receipt.json`])(
    'rejects non-basename path %s',
    (invalidPath) => {
      expect(() => parseVerifierServiceWireReport({ ...wireReport('success'), bundle_path: invalidPath })).toThrow();
      expect(() => parseVerifierServiceWireReport({ ...wireReport('success'), receipt_path: invalidPath })).toThrow();
    },
  );

  it.each([
    { label: 'success with dev receipt', status: 'success', devMode: true, receiptImageId: EXPECTED_IMAGE_ID },
    { label: 'success without receipt ImageID', status: 'success', devMode: false, receiptImageId: null },
    { label: 'success with mismatched ImageID', status: 'success', devMode: false, receiptImageId: OTHER_IMAGE_ID },
    { label: 'dev_mode without dev receipt', status: 'dev_mode', devMode: false, receiptImageId: EXPECTED_IMAGE_ID },
    { label: 'dev_mode with mismatched ImageID', status: 'dev_mode', devMode: true, receiptImageId: OTHER_IMAGE_ID },
  ] as const)('rejects incoherent $label', ({ status, devMode, receiptImageId }) => {
    expect(() =>
      parseVerifierServiceWireReport({
        ...wireReport(status),
        dev_mode_receipt: devMode,
        receipt_image_id: receiptImageId,
      }),
    ).toThrow();
  });

  it('requires nonempty errors for failed reports', () => {
    const withoutErrors = wireReport('failed');
    delete withoutErrors['errors'];

    expect(() => parseVerifierServiceWireReport(withoutErrors)).toThrow();
    expect(() => parseVerifierServiceWireReport({ ...wireReport('failed'), errors: [] })).toThrow();
    expect(() => parseVerifierServiceWireReport({ ...wireReport('failed'), errors: [''] })).toThrow();
  });

  it('rejects errors on success and admits optional nonempty dev-mode errors', () => {
    expect(() => parseVerifierServiceWireReport({ ...wireReport('success'), errors: ['unexpected'] })).toThrow();
    expect(
      parseVerifierServiceWireReport({ ...wireReport('dev_mode'), errors: ['fake receipt rejected'] }).errors,
    ).toEqual(['fake receipt rejected']);
  });

  it('projects wire-only paths out of application reports', () => {
    const wire = parseVerifierServiceWireReport(wireReport('failed'));
    const report = projectVerifierServiceWireReport(wire);

    expect(report).toEqual({
      status: 'failed',
      verifier_version: '0.1.0',
      verified_at: '2026-08-11T09:10:11.123456789Z',
      duration_ms: 42,
      expected_image_id: EXPECTED_IMAGE_ID,
      receipt_image_id: EXPECTED_IMAGE_ID,
      dev_mode_receipt: false,
      errors: ['verification failed'],
    });
    expect(report).not.toHaveProperty('bundle_path');
    expect(report).not.toHaveProperty('receipt_path');
  });

  it('admits the exact application projection and rejects unknown or wire-only keys', () => {
    const applicationReport = projectVerifierServiceWireReport(parseVerifierServiceWireReport(wireReport('success')));

    expect(parseVerifierServiceReport(applicationReport)).toEqual(applicationReport);
    expect(() => parseVerifierServiceReport({ ...applicationReport, private_path: '/tmp/private' })).toThrow();
    expect(() => parseVerifierServiceReport({ ...applicationReport, bundle_path: 'bundle.zip' })).toThrow();
  });
});

describe('verifier-service exit/status protocol', () => {
  it.each([
    { exitCode: 0, status: 'success' },
    { exitCode: 2, status: 'dev_mode' },
    { exitCode: 3, status: 'failed' },
  ] as const)('admits exit $exitCode with $status', ({ exitCode, status }) => {
    const result = parseVerifierServiceProtocol(exitCode, wireReport(status));

    expect(result.exitCode).toBe(exitCode);
    expect(result.status).toBe(status);
    expect(result.wireReport.status).toBe(status);
    expect(result.report.status).toBe(status);
  });

  it.each([
    { exitCode: 0, status: 'dev_mode' },
    { exitCode: 0, status: 'failed' },
    { exitCode: 2, status: 'success' },
    { exitCode: 2, status: 'failed' },
    { exitCode: 3, status: 'success' },
    { exitCode: 3, status: 'dev_mode' },
  ] as const)('rejects exit $exitCode with $status', ({ exitCode, status }) => {
    expect(() => parseVerifierServiceProtocol(exitCode, wireReport(status))).toThrow(/does not match/u);
  });

  it.each([1, 4, null])('rejects unsupported exit code %s', (exitCode) => {
    expect(() => parseVerifierServiceExitCode(exitCode)).toThrow(/exit code/u);
    expect(() => parseVerifierServiceProtocol(exitCode, wireReport('success'))).toThrow(/exit code/u);
  });
});

describe('Rust verifier report sentinels', () => {
  it.each([
    { fileName: 'current-verifier-report-success.json', exitCode: 0, status: 'success' },
    { fileName: 'current-verifier-report-dev-mode.json', exitCode: 2, status: 'dev_mode' },
    { fileName: 'current-verifier-report-failed.json', exitCode: 3, status: 'failed' },
  ] as const)('admits $status sentinel from unknown JSON', async ({ fileName, exitCode, status }) => {
    const serialized = await readFile(path.resolve(process.cwd(), 'verifier-service/testdata', fileName), 'utf8');
    const input: unknown = JSON.parse(serialized);

    expect(parseVerifierServiceWireReport(input).status).toBe(status);
    expect(parseVerifierServiceProtocol(exitCode, input).status).toBe(status);
  });
});
