import { describe, expect, it } from 'vitest';
import type { FinalizeSyncPayload } from '@stark-ballot/application/finalize/finalization-types';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  projectFinalizationResultForPublicResponse,
  projectFinalizeSyncPayloadForResponse,
} from './finalizationResultProjection';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

describe('projectFinalizationResultForPublicResponse', () => {
  it('derives the public authority and presentation partitions from the canonical journal only', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingSlots: 1,
      invalidPresentedSlots: 2,
    });
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    authority.artifacts.bitmap = {
      availability: 'available',
      proofSource: 'real',
      data: {
        includedBitmap: [true, false],
        includedBitmapRoot: journal.includedBitmapRoot,
        treeSize: journal.treeSize,
        finalizedAtMs: 1730000000000,
      },
    };

    const projected = projectFinalizationResultForPublicResponse(authority);

    expect(projected.authority.imageId).toBe(authority.imageId);
    expect(projected.authority.journal).toEqual(journal);
    expect(projected.presentation).toMatchObject({
      bulletinRoot: journal.bulletinRoot,
      verifiedTally: journal.verifiedTally,
      missingSlots: journal.missingSlots,
      invalidPresentedSlots: journal.invalidPresentedSlots,
      rejectedRecords: journal.rejectedRecords,
      totalExpected: journal.totalExpected,
      treeSize: journal.treeSize,
      excludedSlots: journal.excludedSlots,
      sthDigest: journal.sthDigest,
      seenBitmapRoot: journal.seenBitmapRoot,
      includedBitmapRoot: journal.includedBitmapRoot,
      inputCommitment: journal.inputCommitment,
      seenIndicesCount: journal.seenIndicesCount,
    });
    expect(projected.voterEvidence.state).toBe('verification-gated');
    expect(projected.artifactAvailability.includedBitmap).toBe('unavailable');
    expect(projected).not.toHaveProperty('receiptRaw');
    expect(projected).not.toHaveProperty('bitmapData');
  });

  it('declares bitmap availability only from admitted durable sidecar evidence', () => {
    const journal = createTestJournal({ totalExpected: 1, validVotes: 1 });
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    const bitmapData = {
      sessionId: asSessionId('session-1'),
      finalizationId: asFinalizationId('finalization-1'),
      includedBitmap: [true],
      includedBitmapRoot: journal.includedBitmapRoot,
      treeSize: journal.treeSize,
      finalizedAtMs: 1_730_000_000_000,
    };

    const projected = projectFinalizationResultForPublicResponse(authority, undefined, { bitmapData });

    expect(projected.artifactAvailability).toMatchObject({
      includedBitmap: 'available',
      seenBitmap: 'unavailable',
    });
  });

  it('serializes separate verification result authority without server-only paths', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    const verificationResult = {
      status: 'success' as const,
      failureCategory: 'none' as const,
      report: {
        status: 'success' as const,
        verifier_version: '1.0.0',
        verified_at: '2026-01-01T00:00:00.000Z',
        duration_ms: 1234,
        expected_image_id: authority.imageId,
        receipt_image_id: authority.imageId,
        dev_mode_receipt: false as const,
      },
    };

    const projected = projectFinalizationResultForPublicResponse(authority, undefined, {
      verificationResult,
    });
    const projectedVerificationReport = projected.presentation.verificationReport;

    expect(projected.presentation.verificationStatus).toBe('success');
    expect(projected.presentation).not.toHaveProperty('finalizationId');
    expect(projected.presentation).not.toHaveProperty('bundleUrl');
    expect(projected.presentation).not.toHaveProperty('reportUrl');
    expect(projected.presentation).not.toHaveProperty('bundlePath');
    expect(projected.presentation).not.toHaveProperty('reportPath');
    expect(projected.presentation).not.toHaveProperty('bundleArchivePath');
    expect(projected.presentation).not.toHaveProperty('failureCategory');
    expect(projectedVerificationReport).toMatchObject({
      status: 'success',
      verifier_version: '1.0.0',
      verified_at: '2026-01-01T00:00:00.000Z',
      duration_ms: 1234,
      expected_image_id: authority.imageId,
      receipt_image_id: authority.imageId,
      dev_mode_receipt: false,
    });
    expect(projectedVerificationReport).not.toHaveProperty('bundle_path');
    expect(projectedVerificationReport).not.toHaveProperty('receipt_path');
  });

  it('projects only allowlisted receipt metadata into the public response', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    authority.artifacts.receipt = {
      availability: 'available',
      receipt: {
        imageId: authority.imageId,
        seal: 'seal',
        journal: 'receipt-journal',
        metadata: {
          isFake: true,
          verifier_parameters: [1, 2, 3],
          verifierPath: '/tmp/private-verifier/receipt.json',
        },
      },
    };

    const projected = projectFinalizationResultForPublicResponse(authority);

    expect(projected.authority.receipt?.metadata).toEqual({ isFake: true });
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
    const projected = projectFinalizationResultForPublicResponse(authority, undefined, {
      verificationResult: {
        status: 'dev_mode',
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

    expect(projected.presentation.verificationStatus).toBe('failed');
    expect(projected.presentation).not.toHaveProperty('finalizationId');
  });

  it('projects sync verification execution authority outside the pure verification result', () => {
    const journal = createTestJournal();
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    });
    const verificationResult = {
      status: 'success',
      report: {
        status: 'success',
        verifier_version: '1.0.0',
        verified_at: '2026-01-01T00:00:00.000Z',
        duration_ms: 1234,
        expected_image_id: authority.imageId,
        receipt_image_id: authority.imageId,
        dev_mode_receipt: false,
      },
    } satisfies FinalizeSyncPayload['verificationResult'];

    const projected = projectFinalizeSyncPayloadForResponse({
      sessionId: asSessionId('session-1'),
      finalizationId: asFinalizationId('exec-sync-1'),
      state: {
        status: 'succeeded',
        finalizationId: asFinalizationId('exec-sync-1'),
        queuedAtMs: 1730000000000,
        startedAtMs: 1730000001000,
        completedAtMs: 1730000002000,
      },
      finalizationResult: authority,
      verificationResult,
      bitmapDisposition: {
        availability: 'available',
        data: {
          includedBitmap: [true],
          includedBitmapRoot: journal.includedBitmapRoot,
          treeSize: journal.treeSize,
          finalizedAtMs: 1730000002000,
        },
      },
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

    expect(projected.finalizationId).toBe('exec-sync-1');
    expect(projected.status).toBe('succeeded');
    expect(projected.runtimeDiagnostics).toEqual({ asyncMode: 'disabled' });
    if (projected.status !== 'succeeded') {
      throw new Error('Expected synchronous finalization projection to succeed');
    }
    expect(projected.result.voterEvidence.state).toBe('available');
    expect(projected.result.artifactAvailability.includedBitmap).toBe('available');
  });
});
