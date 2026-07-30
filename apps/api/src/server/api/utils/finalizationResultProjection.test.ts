import { describe, expect, it } from 'vitest';
import type { FinalizeSyncPayload } from '@stark-ballot/application/finalize/finalization-types';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  projectFinalizationResultForPublicResponse,
  projectFinalizeSyncPayloadForResponse,
} from './finalizationResultProjection';

describe('projectFinalizationResultForPublicResponse', () => {
  it('reconstructs public compatibility aliases from the canonical journal only', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    authority.bitmapData = {
      includedBitmap: [true, false],
      includedBitmapRoot: journal.includedBitmapRoot,
      treeSize: journal.treeSize,
      finalizedAt: 1730000000000,
    };

    const projected = projectFinalizationResultForPublicResponse(authority);

    expect(projected.bulletinRoot).toBe(journal.bulletinRoot);
    expect(projected.verifiedTally).toEqual(journal.verifiedTally);
    expect(projected.missingSlots).toBe(journal.missingSlots);
    expect(projected.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(projected.rejectedRecords).toBe(journal.rejectedRecords);
    expect(projected.journal.validVotes).toBe(journal.validVotes);
    expect(projected.totalExpected).toBe(journal.totalExpected);
    expect(projected.treeSize).toBe(journal.treeSize);
    expect(projected.excludedSlots).toBe(journal.excludedSlots);
    expect(projected.sthDigest).toBe(journal.sthDigest);
    expect(projected.seenBitmapRoot).toBe(journal.seenBitmapRoot);
    expect(projected.includedBitmapRoot).toBe(journal.includedBitmapRoot);
    expect(projected.inputCommitment).toBe(journal.inputCommitment);
    expect(projected.seenIndicesCount).toBe(journal.seenIndicesCount);
    expect(projected.imageId).toBe(authority.imageId);
    expect(projected.journal).toEqual(journal);
    expect('receiptRaw' in projected).toBe(false);
    expect('bitmapData' in projected).toBe(false);
  });

  it('serializes verification result without server-only paths', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    const verificationResult = {
      status: 'success' as const,
      failureCategory: 'none' as const,
      executionId: 'exec-1',
      report: {
        status: 'success' as const,
        verifier_version: '1.0.0',
        verified_at: '2026-01-01T00:00:00.000Z',
        duration_ms: 1234,
        expected_image_id: authority.imageId,
        receipt_image_id: authority.imageId,
        dev_mode_receipt: false,
        errors: [],
      },
    };

    const projected = projectFinalizationResultForPublicResponse({ ...authority, verificationResult });
    const projectedVerificationResult = projected.verificationResult;

    expect(projectedVerificationResult).toMatchObject({
      status: 'success',
      executionId: 'exec-1',
    });
    expect(projectedVerificationResult).not.toHaveProperty('bundleUrl');
    expect(projectedVerificationResult).not.toHaveProperty('reportUrl');
    expect(projectedVerificationResult).not.toHaveProperty('bundlePath');
    expect(projectedVerificationResult).not.toHaveProperty('reportPath');
    expect(projectedVerificationResult).not.toHaveProperty('bundleArchivePath');
    expect(projectedVerificationResult).not.toHaveProperty('failureCategory');
    expect(projectedVerificationResult?.report).toMatchObject({
      status: 'success',
      verifier_version: '1.0.0',
      verified_at: '2026-01-01T00:00:00.000Z',
      duration_ms: 1234,
      expected_image_id: authority.imageId,
      receipt_image_id: authority.imageId,
      dev_mode_receipt: false,
    });
    expect(projectedVerificationResult?.report).not.toHaveProperty('bundle_path');
    expect(projectedVerificationResult?.report).not.toHaveProperty('receipt_path');
  });

  it('projects claim-tampered verifier success as fail-closed public status', () => {
    const journal = createTestJournal({
      validVotes: 1,
    });
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
      scenarioContext: {
        scenarios: ['S2'],
        tamperMode: 'claim',
        claimedCounts: { A: 0, B: 1, C: 0, D: 0, E: 0 },
        claimedTotalVotes: 1,
        summary: {
          ignoredCount: 0,
          recountedCount: 1,
          userRecountChoice: 'B',
        },
      },
    });
    const projected = projectFinalizationResultForPublicResponse({
      ...authority,
      verificationResult: {
        status: 'dev_mode',
        executionId: 'exec-1',
        report: {
          status: 'dev_mode',
          verifier_version: '1.0.0',
          verified_at: '2026-01-01T00:00:00.000Z',
          duration_ms: 1234,
          expected_image_id: authority.imageId,
          receipt_image_id: authority.imageId,
          dev_mode_receipt: true,
          errors: [],
        },
      },
    });

    expect(projected.verificationResult).toMatchObject({
      status: 'failed',
      executionId: 'exec-1',
    });
  });

  it('projects sync verification execution authority outside the pure verification result', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    authority.verificationResult = {
      status: 'success',
      report: {
        status: 'success',
        verifier_version: '1.0.0',
        verified_at: '2026-01-01T00:00:00.000Z',
        duration_ms: 1234,
        expected_image_id: authority.imageId,
        receipt_image_id: authority.imageId,
        dev_mode_receipt: false,
        errors: [],
      },
    };

    const projected = projectFinalizeSyncPayloadForResponse({
      sessionId: 'session-1',
      verificationExecutionId: 'exec-sync-1',
      finalizationResult: authority,
      bulletinRoot: journal.bulletinRoot,
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + '2'.repeat(64),
        bulletinIndex: 0,
        bulletinRootAtCast: journal.bulletinRoot,
        timestamp: 1730000000000,
        inputCommitment: journal.inputCommitment,
      },
      receipt: {
        seal: 'seal',
        journal: 'receipt-journal',
        imageId: authority.imageId,
      },
      receiptJournal: 'receipt-journal',
      userVote: {
        commitment: '0x' + '2'.repeat(64),
        voteId: 'vote-1',
        proof: {
          leafIndex: 0,
          merklePath: [],
          treeSize: journal.treeSize,
          bulletinRootAtCast: journal.bulletinRoot,
        },
      },
      inputCommitment: journal.inputCommitment,
    } satisfies FinalizeSyncPayload);

    expect(projected.verificationExecutionId).toBe('exec-sync-1');
  });
});
