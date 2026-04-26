import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@/lib/finalize/finalization-result';
import { parseFinalizationResultAuthority, parseFinalizationState } from '@/lib/finalize/finalization-storage';
import { createTestJournal } from '@/lib/testing/test-helpers';

describe('parseFinalizationResultAuthority', () => {
  it('parses legacy delivery and local locator fields without admitting them into authority', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
      verificationExecutionId: 'exec-1',
      bundleMetadata: {
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        s3BundleUrl: 'https://old.example.com/bundle.zip',
        s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const parsed = parseFinalizationResultAuthority({
      ...authority,
      s3BundleUrl: 'https://old.example.com/bundle.zip',
      s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
      verificationResult: {
        status: 'success',
        bundlePath: '/tmp/bundle',
        reportPath: '/tmp/bundle/verification.json',
        bundleArchivePath: '/tmp/bundle/bundle.zip',
        bundleUrl: 'https://app.example.com/api/verification/bundles/session-123/exec-1',
        reportUrl: 'https://app.example.com/api/verification/bundles/session-123/exec-1/report',
        s3BundleUrl: 'https://old.example.com/bundle.zip',
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        s3ReportKey: 'sessions/session-123/exec-1/verification.json',
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
        s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
        executionId: 'exec-1',
      },
    });

    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty('s3BundleUrl');
    expect(parsed).not.toHaveProperty('s3BundleExpiresAt');
    expect(parsed?.s3BundleKey).toBe('sessions/session-123/exec-1/bundle.zip');
    expect(parsed?.verificationResult).toEqual({
      status: 'success',
      s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
      s3ReportKey: 'sessions/session-123/exec-1/verification.json',
      s3UploadedAt: '2026-01-01T00:00:00.000Z',
      executionId: 'exec-1',
    });
  });

  it('normalizes stored journals by dropping legacy count aliases at the parse boundary', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingIndices: 1,
        invalidIndices: 2,
      }),
      imageId: '0x' + '1'.repeat(64),
      verificationExecutionId: 'exec-1',
    });

    const parsed = parseFinalizationResultAuthority({
      ...authority,
      journal: {
        ...authority.journal,
        missingIndices: 99,
        invalidIndices: 98,
        countedIndices: 0,
        excludedCount: 97,
      },
    });

    expect(parsed).toBeDefined();
    expect(parsed?.journal).not.toHaveProperty('missingIndices');
    expect(parsed?.journal).not.toHaveProperty('invalidIndices');
    expect(parsed?.journal).not.toHaveProperty('countedIndices');
    expect(parsed?.journal).not.toHaveProperty('excludedCount');
    expect(parsed?.journal.missingSlots).toBe(authority.journal.missingSlots);
    expect(parsed?.journal.invalidPresentedSlots).toBe(authority.journal.invalidPresentedSlots);
    expect(parsed?.journal.validVotes).toBe(authority.journal.validVotes);
    expect(parsed?.journal.excludedSlots).toBe(authority.journal.excludedSlots);
  });
});

describe('parseFinalizationState', () => {
  it('drops delivery URLs from async succeeded bundle metadata while retaining durable keys', () => {
    const parsed = parseFinalizationState({
      status: 'succeeded',
      executionId: 'exec-1',
      queuedAt: 1,
      startedAt: 2,
      completedAt: 3,
      bundleMetadata: {
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        s3BundleUrl: 'https://old.example.com/bundle.zip',
        s3BundleExpiresAt: '2026-01-01T00:00:00.000Z',
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
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });
});
