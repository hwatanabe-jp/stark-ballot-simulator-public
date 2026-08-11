import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import {
  parseFinalizationResultAuthority,
  parseVerificationResult,
} from '@stark-ballot/application/finalize/finalization-storage';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  parseAwsFinalizationBundleMetadata,
  parseAwsFinalizationRuntimeMetadata,
  parseAwsVerificationDeliveryMetadata,
  parseRequiredAwsFinalizationBundleMetadata,
} from './finalizationMetadataAdmission';

function buildAuthority() {
  return buildFinalizationResultFromJournal({
    journal: createTestJournal(),
    imageId: `0x${'1'.repeat(64)}`,
  });
}

describe('AWS finalization metadata admission', () => {
  it('admits semantic result authority and delivery metadata through separate parsers', () => {
    const authority = buildAuthority();
    const delivery = {
      s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
      s3ReportKey: 'sessions/session-123/exec-1/verification.json',
      s3UploadedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      verificationWorkQueuedAtMs: Date.parse('2026-01-01T00:00:01.000Z'),
    };

    expect(parseFinalizationResultAuthority(authority)).toEqual(authority);
    expect(parseAwsVerificationDeliveryMetadata(delivery)).toEqual(delivery);
    expect(authority).not.toHaveProperty('finalizationId');
    expect(authority).not.toHaveProperty('verificationResult');
    expect(authority).not.toHaveProperty('s3BundleKey');
  });

  it('rejects delivery and evidence fields from verification result authority', () => {
    expect(
      parseVerificationResult({
        status: 'failed',
        failureCategory: 'AccessDenied: private object key',
      }),
    ).toBeUndefined();
    expect(
      parseVerificationResult({
        status: 'success',
        devModeReceipt: false,
      }),
    ).toBeUndefined();
  });

  it('rejects raw receipt payloads at the semantic finalization boundary', () => {
    expect(
      parseFinalizationResultAuthority({
        ...buildAuthority(),
        receiptRaw: { private: 'raw-receipt' },
      }),
    ).toBeUndefined();
  });

  it('keeps proof-bundle delivery metadata outside finalization and verification authority', () => {
    const authority = buildAuthority();
    const verificationResult = { status: 'success' as const };
    const delivery = parseAwsVerificationDeliveryMetadata({
      s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
      s3ReportKey: 'sessions/session-123/exec-1/verification.json',
      s3UploadedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });

    expect(delivery).toBeDefined();
    expect(parseFinalizationResultAuthority({ ...authority, ...delivery })).toBeUndefined();
    expect(parseVerificationResult({ ...verificationResult, ...delivery })).toBeUndefined();
    expect(parseFinalizationResultAuthority(authority)).toEqual(authority);
    expect(parseVerificationResult(verificationResult)).toEqual(verificationResult);
  });

  it.each([
    ['s3BundleKey', null],
    ['s3BundleKey', 123],
    ['s3ReportKey', null],
    ['s3ReportKey', 123],
    ['s3UploadedAtMs', null],
    ['s3UploadedAtMs', 'not-a-timestamp'],
    ['verificationWorkQueuedAtMs', null],
    ['verificationWorkQueuedAtMs', 'not-a-timestamp'],
    ['finalizationId', 'exec-1'],
  ])('rejects malformed or misplaced delivery metadata field %s=%j', (field, value) => {
    expect(
      parseAwsVerificationDeliveryMetadata({
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        [field]: value,
      }),
    ).toBeUndefined();
  });

  it.each(['bundlePath', 'reportPath', 'bundleArchivePath', 'bundleUrl', 'reportUrl', 'verificationResult'])(
    'rejects unsupported delivery metadata field %s',
    (field) => {
      expect(
        parseAwsVerificationDeliveryMetadata({
          s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
          [field]: '/tmp/bundle.zip',
        }),
      ).toBeUndefined();
    },
  );

  it('rejects retired URL delivery fields', () => {
    expect(
      parseAwsVerificationDeliveryMetadata({
        s3BundleUrl: 'https://old.example.com/bundle.zip',
      }),
    ).toBeUndefined();
    expect(
      parseAwsVerificationDeliveryMetadata({
        s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeUndefined();
  });

  it('admits refreshed delivery metadata without mutating the previous record', () => {
    const previous = {
      s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
      s3UploadedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    };
    const refreshed = parseAwsVerificationDeliveryMetadata({
      ...previous,
      s3BundleKey: 'sessions/session-1/exec-2/bundle.zip',
      s3UploadedAtMs: Date.parse('2026-01-01T12:00:00.000Z'),
    });

    expect(refreshed).toEqual({
      s3BundleKey: 'sessions/session-1/exec-2/bundle.zip',
      s3UploadedAtMs: Date.parse('2026-01-01T12:00:00.000Z'),
    });
    expect(previous).toEqual({
      s3BundleKey: 'sessions/session-1/exec-1/bundle.zip',
      s3UploadedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });
  });

  it('models absent verification state as record nonexistence, not an envelope field', () => {
    const authority = buildAuthority();
    const verificationResult = parseVerificationResult({ status: 'failed' });

    expect(verificationResult).toEqual({ status: 'failed' });
    expect(authority).not.toHaveProperty('verificationResult');
    expect(parseFinalizationResultAuthority(authority)).toEqual(authority);
  });

  it('admits empty optional delivery metadata without undefined own properties', () => {
    const delivery = parseAwsVerificationDeliveryMetadata({});
    const bundle = parseAwsFinalizationBundleMetadata({});

    expect(delivery).toEqual({});
    expect(bundle).toEqual({});
    expect(Object.keys(delivery ?? {})).toEqual([]);
    expect(Object.keys(bundle ?? {})).toEqual([]);
  });

  it('rejects legacy URL fields in required async bundle metadata', () => {
    expect(
      parseRequiredAwsFinalizationBundleMetadata({
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        s3BundleUrl: 'https://old.example.com/bundle.zip',
        s3UploadedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      }),
    ).toBeUndefined();
    expect(
      parseRequiredAwsFinalizationBundleMetadata({
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
        s3UploadedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      }),
    ).toBeUndefined();
  });

  it('rejects unsupported runtime metadata fields', () => {
    const unsupportedFields = [
      { s3BundleUrl: 'https://old.example.com/bundle.zip' },
      { s3BundleExpiresAt: '2026-01-01T00:00:00.000Z' },
      { s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' },
      { executionId: 'exec-1' },
      { finalizationId: 'exec-1' },
      { unexpectedRuntimeKey: true },
    ];

    for (const unsupportedField of unsupportedFields) {
      expect(parseAwsFinalizationRuntimeMetadata(unsupportedField)).toBeUndefined();
    }
  });

  it('retains exact durable async runtime and bundle metadata', () => {
    const metadata = {
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
      bundleMetadata: {
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        s3UploadedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      },
    };

    expect(parseAwsFinalizationRuntimeMetadata(metadata)).toEqual(metadata);
    expect(parseRequiredAwsFinalizationBundleMetadata(metadata.bundleMetadata)).toEqual(metadata.bundleMetadata);
  });
});
