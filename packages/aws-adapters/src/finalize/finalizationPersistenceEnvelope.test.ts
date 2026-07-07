import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  parseAwsFinalizationRuntimeState,
  parseAwsPersistedFinalizationResult,
  mergeAwsProofBundleDeliveryMetadata,
  updateAwsFinalizationResultBundleMetadata,
  updateAwsFinalizationResultVerificationState,
  type AwsPersistedFinalizationResult,
} from './finalizationPersistenceEnvelope';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

describe('AWS finalization persistence envelope', () => {
  it('parses persisted delivery envelope fields without admitting them into pure authority', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });

    const parsed = parseAwsPersistedFinalizationResult({
      ...authority,
      ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
      s3UploadedAt: '2026-01-01T00:00:00.000Z',
      verificationExecutionId: 'exec-1',
      verificationResult: {
        status: 'success',
        ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
        s3ReportKey: 'sessions/session-123/exec-1/verification.json',
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
        executionId: 'exec-1',
      },
    });

    expect(parsed).toBeDefined();
    expect(parsed?.s3BundleKey).toBe('sessions/session-123/exec-1/bundle.zip');
    expect(parsed?.s3UploadedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed?.verificationExecutionId).toBe('exec-1');
    expect(parsed?.verificationResult).toEqual({
      status: 'success',
      ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
      s3ReportKey: 'sessions/session-123/exec-1/verification.json',
      s3UploadedAt: '2026-01-01T00:00:00.000Z',
      executionId: 'exec-1',
    });
  });

  it('rejects raw receipt payloads at the persisted finalization result boundary', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });

    expect(
      parseAwsPersistedFinalizationResult({
        ...authority,
        receiptRaw: { private: 'raw-receipt' },
      }),
    ).toBeUndefined();
  });

  it('projects separate proof-bundle delivery metadata into the AWS persisted envelope', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });
    authority.verificationResult = {
      status: 'success',
    };

    const persisted = mergeAwsProofBundleDeliveryMetadata(authority, {
      executionId: 'exec-1',
      ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
      s3ReportKey: 'sessions/session-123/exec-1/verification.json',
      s3UploadedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(Object.hasOwn(authority.verificationResult, 'executionId')).toBe(false);
    expect(Object.hasOwn(authority.verificationResult, 's3BundleKey')).toBe(false);
    expect(persisted).toMatchObject({
      verificationExecutionId: 'exec-1',
      ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
      s3UploadedAt: '2026-01-01T00:00:00.000Z',
      verificationResult: {
        status: 'success',
        executionId: 'exec-1',
        ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
        s3ReportKey: 'sessions/session-123/exec-1/verification.json',
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it.each([
    ['s3BundleKey', null],
    ['s3BundleKey', 123],
    ['s3ReportKey', null],
    ['s3ReportKey', 123],
    ['s3UploadedAt', null],
    ['s3UploadedAt', 123],
    ['executionId', null],
    ['executionId', 123],
  ])('rejects malformed nested persisted verifier locator field %s=%j', (field, value) => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });

    expect(
      parseAwsPersistedFinalizationResult({
        ...authority,
        verificationExecutionId: 'exec-1',
        verificationResult: {
          status: 'success',
          [field]: value,
        },
      }),
    ).toBeUndefined();
  });

  it.each(['bundlePath', 'reportPath', 'bundleArchivePath', 'bundleUrl', 'reportUrl', 'unexpected'])(
    'rejects unsupported nested persisted verifier locator field %s',
    (field) => {
      const authority = buildFinalizationResultFromJournal({
        journal: createTestJournal(),
        imageId: '0x' + '1'.repeat(64),
      });

      expect(
        parseAwsPersistedFinalizationResult({
          ...authority,
          verificationExecutionId: 'exec-1',
          verificationResult: {
            status: 'success',
            [field]: '/tmp/bundle.zip',
          },
        }),
      ).toBeUndefined();
    },
  );

  it('rejects legacy URL delivery fields at the persisted result boundary', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });

    expect(
      parseAwsPersistedFinalizationResult({
        ...authority,
        s3BundleUrl: 'https://old.example.com/bundle.zip',
      }),
    ).toBeUndefined();
    expect(
      parseAwsPersistedFinalizationResult({
        ...authority,
        s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeUndefined();
  });

  it('stores refreshed delivery values only on the persisted finalization envelope', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });
    const persisted: AwsPersistedFinalizationResult = {
      ...authority,
      ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-1/exec-1/bundle.zip' }),
      verificationResult: {
        status: 'running',
        ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-1/exec-1/bundle.zip' }),
        executionId: 'exec-1',
      },
    };

    const updated = updateAwsFinalizationResultBundleMetadata(persisted, {
      ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-1/exec-2/bundle.zip' }),
      s3UploadedAt: '2026-01-01T12:00:00.000Z',
    });

    expect(updated.s3BundleKey).toBe('sessions/session-1/exec-2/bundle.zip');
    expect(updated.s3UploadedAt).toBe('2026-01-01T12:00:00.000Z');
    expect(updated.verificationResult).toMatchObject({
      ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-1/exec-2/bundle.zip' }),
      s3UploadedAt: '2026-01-01T12:00:00.000Z',
    });
  });

  it('can explicitly clear verification state while staying on the authority shape', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    const authorityWithVerification = {
      ...authority,
      verificationResult: {
        status: 'failed' as const,
        executionId: 'exec-1',
      },
      verificationExecutionId: 'exec-1',
    };

    const updated = updateAwsFinalizationResultVerificationState(authorityWithVerification, {
      verificationResult: undefined,
      verificationExecutionId: undefined,
    });

    expect(updated.verificationResult).toBeUndefined();
    expect(updated.verificationExecutionId).toBeUndefined();
    expect(Object.hasOwn(updated, 'verificationResult')).toBe(false);
    expect(Object.hasOwn(updated, 'verificationExecutionId')).toBe(false);
    expect(updated.journal).toEqual(journal);
    expect(parseAwsPersistedFinalizationResult(updated)).toBeDefined();
  });

  it('removes own undefined delivery metadata when clearing persisted bundle fields', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });
    const persisted: AwsPersistedFinalizationResult = {
      ...authority,
      ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-1/exec-1/bundle.zip' }),
      s3UploadedAt: '2026-01-01T00:00:00.000Z',
      verificationExecutionId: 'exec-1',
      verificationResult: {
        status: 'running',
        executionId: 'exec-1',
        ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-1/exec-1/bundle.zip' }),
        s3ReportKey: 'sessions/session-1/exec-1/verification.json',
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
      },
    };

    const updated = updateAwsFinalizationResultVerificationState(persisted, {
      verificationResult: {
        status: 'failed',
        executionId: 'exec-1',
        s3BundleKey: undefined,
        s3ReportKey: undefined,
        s3UploadedAt: undefined,
      },
      s3BundleKey: undefined,
      s3UploadedAt: undefined,
    });

    expect(Object.hasOwn(updated, 's3BundleKey')).toBe(false);
    expect(Object.hasOwn(updated, 's3UploadedAt')).toBe(false);
    expect(updated.verificationResult).toMatchObject({
      status: 'failed',
      executionId: 'exec-1',
    });
    expect(Object.hasOwn(updated.verificationResult ?? {}, 's3BundleKey')).toBe(false);
    expect(Object.hasOwn(updated.verificationResult ?? {}, 's3ReportKey')).toBe(false);
    expect(Object.hasOwn(updated.verificationResult ?? {}, 's3UploadedAt')).toBe(false);
    expect(parseAwsPersistedFinalizationResult(updated)).toBeDefined();
  });

  it('rejects legacy URL fields in async succeeded bundle metadata', () => {
    expect(
      parseAwsFinalizationRuntimeState({
        status: 'succeeded',
        executionId: 'exec-1',
        queuedAt: 1,
        startedAt: 2,
        completedAt: 3,
        bundleMetadata: {
          ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
          s3BundleUrl: 'https://old.example.com/bundle.zip',
          s3UploadedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ).toBeUndefined();
    expect(
      parseAwsFinalizationRuntimeState({
        status: 'succeeded',
        executionId: 'exec-1',
        queuedAt: 1,
        startedAt: 2,
        completedAt: 3,
        bundleMetadata: {
          ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
          s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
          s3UploadedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ).toBeUndefined();
  });

  it('rejects unsupported top-level runtime-state fields by status variant', () => {
    const unsupportedFields = [
      { s3BundleUrl: 'https://old.example.com/bundle.zip' },
      { s3BundleExpiresAt: '2026-01-01T00:00:00.000Z' },
      { s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' },
      { verificationExecutionId: 'exec-1' },
      { unexpectedRuntimeKey: true },
    ];
    const states = [
      {
        status: 'pending',
        executionId: 'exec-1',
        queuedAt: 1,
      },
      {
        status: 'running',
        executionId: 'exec-1',
        queuedAt: 1,
        startedAt: 2,
      },
      {
        status: 'succeeded',
        executionId: 'exec-1',
        queuedAt: 1,
        startedAt: 2,
        completedAt: 3,
      },
      {
        status: 'failed',
        executionId: 'exec-1',
        queuedAt: 1,
        startedAt: 2,
        failedAt: 3,
        error: {
          code: 'FAILED',
          message: 'Proof failed',
        },
      },
      {
        status: 'timeout',
        executionId: 'exec-1',
        queuedAt: 1,
        startedAt: 2,
        timeoutAt: 3,
      },
    ] as const;

    for (const state of states) {
      for (const unsupportedField of unsupportedFields) {
        expect(parseAwsFinalizationRuntimeState({ ...state, ...unsupportedField })).toBeUndefined();
      }
    }
  });

  it('retains durable async succeeded bundle metadata keys', () => {
    const parsed = parseAwsFinalizationRuntimeState({
      status: 'succeeded',
      executionId: 'exec-1',
      queuedAt: 1,
      startedAt: 2,
      completedAt: 3,
      bundleMetadata: {
        ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(parsed).toEqual({
      status: 'succeeded',
      executionId: 'exec-1',
      queuedAt: 1,
      startedAt: 2,
      completedAt: 3,
      bundleMetadata: {
        ...omitUndefinedProperties({ s3BundleKey: 'sessions/session-123/exec-1/bundle.zip' }),
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });
});
