import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import {
  parseFinalizationResultAuthority,
  parseFinalizationState,
  parseVerificationResult,
} from '@stark-ballot/application/finalize/finalization-storage';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';

describe('parseFinalizationResultAuthority', () => {
  it('rejects a verification result that belongs in its separate lifecycle record', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });

    expect(
      parseFinalizationResultAuthority({
        ...authority,
        verificationResult: {
          status: 'not_run',
        },
      }),
    ).toBeUndefined();
  });

  it('rejects delivery envelope and local locator fields at the pure authority boundary', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });

    const parsed = parseFinalizationResultAuthority({
      ...authority,
      s3BundleKey: 'sessions/session-123/finalization-1/bundle.zip',
      verificationResult: {
        status: 'success',
        bundlePath: '/tmp/bundle',
        reportPath: '/tmp/bundle/verification.json',
        bundleArchivePath: '/tmp/bundle/bundle.zip',
        bundleUrl: 'https://app.example.com/api/sessions/session-123/finalizations/finalization-1/artifacts/bundle',
        reportUrl: 'https://app.example.com/api/sessions/session-123/finalizations/finalization-1/artifacts/report',
        s3BundleKey: 'sessions/session-123/finalization-1/bundle.zip',
        s3ReportKey: 'sessions/session-123/finalization-1/verification.json',
        s3UploadedAtMs: '2026-01-01T00:00:00.000Z',
        finalizationId: 'finalization-1',
      },
    });

    expect(parsed).toBeUndefined();
  });

  it('rejects stored journals with legacy count aliases at the parse boundary', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingSlots: 1,
        invalidPresentedSlots: 2,
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

  it('rejects unknown keys in nested persisted result records instead of normalizing them away', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });
    const marker = { compatibilityMarker: 'retired-shape' };

    const nestedShapeCases = [
      {
        ...authority,
        journal: {
          ...authority.journal,
          ...marker,
        },
      },
      {
        ...authority,
        receipt: {
          seal: 'receipt-seal',
          journal: 'receipt-journal',
          ...marker,
        },
      },
      {
        ...authority,
        receipt: {
          seal: 'receipt-seal',
          journal: {
            bytes: [1, 2, 3],
            ...marker,
          },
        },
      },
      {
        ...authority,
        receiptPublication: {
          receiptHash: 'receipt-hash',
          boardIndex: 0,
          ...marker,
        },
      },
      {
        ...authority,
        electionManifest: {
          electionId: authority.journal.electionId,
          totalExpected: authority.journal.totalExpected,
          choices: ['A', 'B', 'C', 'D', 'E'],
          version: '1',
          botCount: authority.journal.totalExpected - 1,
          merkleTreeDepth: 7,
          electionConfigHash: authority.journal.electionConfigHash,
          ...marker,
        },
      },
      {
        ...authority,
        closeStatement: {
          logId: `0x${'22'.repeat(32)}`,
          treeSize: authority.journal.treeSize,
          timestamp: 1,
          bulletinRoot: authority.journal.bulletinRoot,
          sthDigest: authority.journal.sthDigest,
          ...marker,
        },
      },
      {
        ...authority,
        bitmapData: {
          includedBitmap: [true],
          includedBitmapRoot: authority.journal.includedBitmapRoot,
          treeSize: authority.journal.treeSize,
          finalizedAtMs: 1,
          ...marker,
        },
      },
      {
        ...authority,
        tamperSummary: {
          ignoredVotes: 0,
          recountedVotes: 0,
          userRecountedTo: null,
          ...marker,
        },
      },
    ];

    for (const value of nestedShapeCases) {
      expect(parseFinalizationResultAuthority(value)).toBeUndefined();
    }
  });
});

describe('parseVerificationResult', () => {
  it.each(['none', 'verifier_crash', 'corrupt_bundle', 's3_denied', 's3_missing', 'timeout', 'unknown'] as const)(
    'round-trips the closed internal failure category %s',
    (failureCategory) => {
      expect(
        parseVerificationResult({
          status: 'failed',
          failureCategory,
        }),
      ).toEqual({
        status: 'failed',
        failureCategory,
      });
    },
  );

  it('rejects arbitrary infrastructure failure text', () => {
    expect(
      parseVerificationResult({
        status: 'failed',
        failureCategory: 'AccessDenied: s3://private-bucket/sessions/raw-session/input.json',
      }),
    ).toBeUndefined();
  });
});

describe('parseFinalizationState', () => {
  it('rejects unsupported top-level keys at the pure state boundary', () => {
    expect(
      parseFinalizationState({
        status: 'running',
        finalizationId: 'exec-1',
        queuedAtMs: 1,
        startedAtMs: 2,
        s3BundleUrl: 'https://old.example.com/bundle.zip',
      }),
    ).toBeUndefined();
  });

  it('round-trips a closed finalization failure category', () => {
    const state = {
      status: 'failed',
      finalizationId: 'exec-1',
      queuedAtMs: 1,
      failedAtMs: 2,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        category: 'prover_execution',
      },
    };

    expect(parseFinalizationState(state)).toEqual(state);
  });

  it('rejects failure categories outside the closed registry', () => {
    expect(
      parseFinalizationState({
        status: 'failed',
        finalizationId: 'exec-1',
        queuedAtMs: 1,
        failedAtMs: 2,
        error: {
          code: 'PROVER_TASK_FAILED',
          message: 'Target prover task failed',
          category: 'raw-provider-error',
        },
      }),
    ).toBeUndefined();
  });
});
