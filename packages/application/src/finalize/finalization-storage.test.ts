import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import {
  parseFinalizationResultAuthority,
  parseFinalizationState,
} from '@stark-ballot/application/finalize/finalization-storage';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';

describe('parseFinalizationResultAuthority', () => {
  it('rejects delivery envelope and local locator fields at the pure authority boundary', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });

    const parsed = parseFinalizationResultAuthority({
      ...authority,
      s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
      verificationResult: {
        status: 'success',
        bundlePath: '/tmp/bundle',
        reportPath: '/tmp/bundle/verification.json',
        bundleArchivePath: '/tmp/bundle/bundle.zip',
        bundleUrl: 'https://app.example.com/api/verification/bundles/session-123/exec-1',
        reportUrl: 'https://app.example.com/api/verification/bundles/session-123/exec-1/report',
        s3BundleKey: 'sessions/session-123/exec-1/bundle.zip',
        s3ReportKey: 'sessions/session-123/exec-1/verification.json',
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
        executionId: 'exec-1',
      },
    });

    expect(parsed).toBeUndefined();
  });

  it('rejects stored journals with legacy count aliases at the parse boundary', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingIndices: 1,
        invalidIndices: 2,
      }),
      imageId: '0x' + '1'.repeat(64),
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

    expect(parsed).toBeUndefined();
  });
});

describe('parseFinalizationState', () => {
  it('rejects unsupported top-level keys at the pure state boundary', () => {
    expect(
      parseFinalizationState({
        status: 'running',
        executionId: 'exec-1',
        queuedAt: 1,
        startedAt: 2,
        s3BundleUrl: 'https://old.example.com/bundle.zip',
      }),
    ).toBeUndefined();
  });
});
