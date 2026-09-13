import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import {
  finalizationBitmapDataCodec,
  parseFinalizationResultAuthority,
  parseFinalizationState,
  parseVerificationResult,
} from '@stark-ballot/application/finalize/finalization-storage';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';

describe('parseFinalizationResultAuthority', () => {
  it('projects the exact-current flat storage fields into closed artifact availability states', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });
    const electionManifest = buildElectionManifest(authority.journal.electionId, buildDefaultElectionConfig());
    const closeStatement = buildCloseStatement({
      logId: `0x${'2'.repeat(64)}`,
      treeSize: authority.journal.treeSize,
      timestamp: 1,
      bulletinRoot: authority.journal.bulletinRoot,
    });
    const publicInputArtifact = createTestPublicInputArtifact();
    const receipt = {
      seal: 'receipt-seal',
      journal: 'receipt-journal',
      imageId: authority.imageId,
    };
    const receiptPublication = {
      receiptHash: `0x${'3'.repeat(64)}`,
      boardIndex: 7,
      timestamp: 2,
    };
    const bitmapData = {
      includedBitmap: [true],
      includedBitmapRoot: `0x${'4'.repeat(64)}`,
      seenBitmap: [true],
      seenBitmapRoot: `0x${'5'.repeat(64)}`,
      treeSize: 1,
      finalizedAtMs: 3,
    };

    const parsed = parseFinalizationResultAuthority({
      tally: authority.tally,
      imageId: authority.imageId,
      journal: authority.journal,
      receipt,
      receiptPublication,
      publicInputArtifact,
      electionManifest,
      closeStatement,
      bitmapProofSource: 'real',
      bitmapData,
    });

    expect(parsed).toMatchObject({
      artifacts: {
        receipt: { availability: 'available', receipt },
        receiptPublication: { availability: 'available', publication: receiptPublication },
        publicAudit: {
          availability: 'available',
          publicInputArtifact,
          electionManifest,
          closeStatement,
        },
        bitmap: { availability: 'available', proofSource: 'real', data: bitmapData },
      },
    });
    expect(parsed).not.toHaveProperty('receipt');
    expect(parsed).not.toHaveProperty('receiptPublication');
    expect(parsed).not.toHaveProperty('publicInputArtifact');
    expect(parsed).not.toHaveProperty('electionManifest');
    expect(parsed).not.toHaveProperty('closeStatement');
    expect(parsed).not.toHaveProperty('bitmapProofSource');
    expect(parsed).not.toHaveProperty('bitmapData');
  });

  it('rejects partial all-or-none artifact groups from exact-current storage', () => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: '0x' + '1'.repeat(64),
    });
    const electionManifest = buildElectionManifest(authority.journal.electionId, buildDefaultElectionConfig());
    const closeStatement = buildCloseStatement({
      logId: `0x${'2'.repeat(64)}`,
      treeSize: authority.journal.treeSize,
      timestamp: 1,
      bulletinRoot: authority.journal.bulletinRoot,
    });
    const publicInputArtifact = createTestPublicInputArtifact();
    const bitmapData = {
      includedBitmap: [true],
      includedBitmapRoot: `0x${'4'.repeat(64)}`,
      treeSize: 1,
      finalizedAtMs: 3,
    };
    const base = {
      tally: authority.tally,
      imageId: authority.imageId,
      journal: authority.journal,
    };

    const partialGroups = [
      { ...base, publicInputArtifact },
      { ...base, electionManifest },
      { ...base, closeStatement },
      { ...base, publicInputArtifact, electionManifest },
      { ...base, electionManifest, closeStatement },
      { ...base, publicInputArtifact, closeStatement },
      { ...base, bitmapProofSource: 'real' },
      { ...base, bitmapData },
    ];

    for (const partial of partialGroups) {
      expect(parseFinalizationResultAuthority(partial)).toBeUndefined();
    }
  });

  it.each([
    ['seen bitmap without its root', { seenBitmap: [true] }],
    ['seen bitmap root without its bitmap', { seenBitmapRoot: `0x${'5'.repeat(64)}` }],
  ] as const)('rejects %s in the flat persisted bitmap shape', (_label, oneSidedSeenEvidence) => {
    const authority = buildFinalizationResultFromJournal({
      journal: createTestJournal(),
      imageId: `0x${'1'.repeat(64)}`,
    });
    const bitmapData = {
      includedBitmap: [true],
      includedBitmapRoot: `0x${'4'.repeat(64)}`,
      treeSize: 1,
      finalizedAtMs: 3,
      ...oneSidedSeenEvidence,
    };

    expect(finalizationBitmapDataCodec.decode(bitmapData)).toBeUndefined();
    expect(
      parseFinalizationResultAuthority({
        tally: authority.tally,
        imageId: authority.imageId,
        journal: authority.journal,
        bitmapProofSource: 'real',
        bitmapData,
      }),
    ).toBeUndefined();
  });

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
  it.each(['verifier_crash', 'corrupt_bundle', 's3_denied', 's3_missing', 'timeout', 'unknown'] as const)(
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

  it.each([
    {
      status: 'success',
      report: {
        status: 'failed',
        verifier_version: 'test',
        verified_at: '2026-08-11T00:00:00Z',
        duration_ms: 1,
        expected_image_id: `0x${'1'.repeat(64)}`,
        receipt_image_id: null,
        dev_mode_receipt: false,
        errors: ['failed'],
      },
    },
    {
      status: 'running',
      report: {
        status: 'success',
        verifier_version: 'test',
        verified_at: '2026-08-11T00:00:00Z',
        duration_ms: 1,
        expected_image_id: `0x${'1'.repeat(64)}`,
        receipt_image_id: `0x${'1'.repeat(64)}`,
        dev_mode_receipt: false,
      },
    },
    { status: 'success', failureCategory: 'timeout' },
    { status: 'failed', failureCategory: 'none' },
  ])('rejects an incoherent persisted verifier result: %o', (candidate) => {
    expect(parseVerificationResult(candidate)).toBeUndefined();
  });

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
