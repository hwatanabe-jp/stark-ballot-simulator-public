import { describe, expect, it } from 'vitest';
import type { FinalizationResource } from '@stark-ballot/api-contract';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  projectFinalizationResourceToClientSnapshot,
  resolveCanonicalFinalizationPayload,
} from '@stark-ballot/web/finalize/client-finalization-result';

function resolveSnapshot(value: Record<string, unknown>) {
  return resolveCanonicalFinalizationPayload({
    finalizationId: 'finalization-1',
    ...value,
  });
}

describe('resolveCanonicalFinalizationPayload', () => {
  it('recomputes tamperDetected from rejectedRecords when excluded slots stay zero', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        seenIndicesCount: 1,
      }),
      totalVotes: 2,
      invalidVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 1,
      excludedSlots: 0,
    };

    const result = resolveSnapshot({
      tamperDetected: false,
      tally: {
        counts: { A: 1, B: 1, C: 0, D: 0, E: 0 },
        totalVotes: 2,
        tamperedCount: 0,
      },
      imageId: '0x' + 'e'.repeat(64),
      journal,
    });

    expect(result).not.toBeNull();
    expect(result?.tamperDetected).toBe(true);
    expect(result?.excludedSlots).toBe(0);
  });

  it('recomputes tamperDetected from tamperSummary when the journal is otherwise clean', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    });

    const result = resolveSnapshot({
      tamperDetected: false,
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      imageId: '0x' + 'e'.repeat(64),
      journal,
      tamperSummary: {
        ignoredVotes: 0,
        recountedVotes: 1,
        userRecountedTo: 'B',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.tamperDetected).toBe(true);
  });

  it('rejects a current-method journal when seenBitmapRoot is missing', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    });

    const unsupportedJournal = {
      ...journal,
      seenBitmapRoot: undefined,
    };
    const result = resolveSnapshot({
      tamperDetected: false,
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      imageId: '0x' + 'e'.repeat(64),
      journal: unsupportedJournal,
    });

    expect(result).toBeNull();
  });

  it('rejects browser-local state when top-level imageId is missing even if journal.imageId exists', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        seenIndicesCount: 1,
      }),
      imageId: '0x' + 'a'.repeat(64),
    };

    const result = resolveSnapshot({
      journal,
    });

    expect(result).toBeNull();
  });

  it('rejects browser-local state when tally is missing even if journal and imageId are present', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    });

    const result = resolveSnapshot({
      imageId: '0x' + 'e'.repeat(64),
      journal,
    });

    expect(result).toBeNull();
  });

  it('rejects browser-local state when tally counts are malformed instead of rebuilding them from journal', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    });

    const result = resolveSnapshot({
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      imageId: '0x' + 'e'.repeat(64),
      journal,
    });

    expect(result).toBeNull();
  });

  it('rejects browser-local state when top-level imageId is not a valid 32-byte hex string', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        seenIndicesCount: 1,
      }),
      imageId: '0x' + 'a'.repeat(64),
    };

    const result = resolveSnapshot({
      imageId: 'not-hex',
      journal,
    });

    expect(result).toBeNull();
  });

  it('rejects browser-local state when top-level imageId disagrees with journal.imageId', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        seenIndicesCount: 1,
      }),
      imageId: '0x' + 'a'.repeat(64),
    };

    const result = resolveSnapshot({
      imageId: '0x' + 'b'.repeat(64),
      journal,
    });

    expect(result).toBeNull();
  });

  it('persists only the explicit browser snapshot fields', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    });

    const result = resolveSnapshot({
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      imageId: '0x' + 'e'.repeat(64),
      journal,
      voteReceipt: {
        voteId: 'vote-1',
      },
      publicInputSummary: {
        schema: 'stark-ballot.public_input',
      },
    });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('voteReceipt');
    expect(result).not.toHaveProperty('publicInputSummary');
    expect(result?.journal).toEqual(journal);
  });

  it('rejects cached verification state whose terminal report contradicts its status', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    });

    expect(
      resolveSnapshot({
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: '0x' + 'e'.repeat(64),
        journal,
        verificationStatus: 'success',
        verificationReport: {
          status: 'failed',
          errors: ['Verification failed'],
        },
      }),
    ).toBeNull();
  });

  it('rejects legacy alias input in current journal payloads', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingSlots: 1,
        invalidPresentedSlots: 2,
      }),
      missingIndices: 99,
      invalidIndices: 98,
      countedIndices: 0,
      excludedCount: 97,
    };

    const result = resolveSnapshot({
      tally: {
        counts: { A: 61, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 61,
        tamperedCount: 0,
      },
      imageId: '0x' + 'e'.repeat(64),
      journal,
      missingIndices: 99,
      invalidIndices: 98,
      countedIndices: 0,
      excludedCount: 97,
    });

    expect(result).toBeNull();
  });

  it('requires the unified finalization identity in browser-local snapshots', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    });

    expect(
      resolveCanonicalFinalizationPayload({
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: '0x' + 'e'.repeat(64),
        journal,
      }),
    ).toBeNull();
    expect(
      resolveCanonicalFinalizationPayload({
        finalizationId: '../finalization-1',
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: '0x' + 'e'.repeat(64),
        journal,
      }),
    ).toBeNull();
  });

  it('projects a succeeded resource without leaking verification-gated voter evidence', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    });
    const hash = '0x' + 'a'.repeat(64);
    const resource: FinalizationResource = {
      finalizationId: 'finalization-1',
      queuedAtMs: 1,
      status: 'succeeded',
      startedAtMs: 2,
      completedAtMs: 3,
      runtimeDiagnostics: { asyncMode: 'disabled' },
      result: {
        authority: {
          imageId: '0x' + 'e'.repeat(64),
          journal,
        },
        presentation: {
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
            tamperedCount: 0,
          },
          tamperDetected: false,
          scenarios: [],
          verifiedTally: [
            journal.verifiedTally[0],
            journal.verifiedTally[1],
            journal.verifiedTally[2],
            journal.verifiedTally[3],
            journal.verifiedTally[4],
          ],
          bulletinRoot: journal.bulletinRoot,
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
          verificationStatus: 'not_run',
        },
        voterEvidence: {
          state: 'available',
          voteReceipt: {
            voteId: 'vote-1',
            commitment: hash,
            bulletinIndex: 0,
            bulletinRootAtCast: hash,
            castAtMs: 1,
            inputCommitment: journal.inputCommitment,
          },
          userVote: {
            voteId: 'vote-1',
            commitment: hash,
            proof: {
              leafIndex: 0,
              treeSize: 1,
              merklePath: [],
              bulletinRootAtCast: hash,
            },
          },
          receiptPublication: {
            receiptHash: hash,
            boardIndex: 0,
          },
        },
        artifactAvailability: {
          bundle: 'available',
          report: 'unavailable',
          includedBitmap: 'available',
          seenBitmap: 'available',
        },
      },
    };

    const snapshot = projectFinalizationResourceToClientSnapshot(resource);

    expect(snapshot).toMatchObject({
      finalizationId: 'finalization-1',
      bulletinRoot: journal.bulletinRoot,
      verificationStatus: 'not_run',
      receiptPublication: {
        receiptHash: hash,
        boardIndex: 0,
      },
    });
    expect(snapshot).not.toHaveProperty('voteReceipt');
    expect(snapshot).not.toHaveProperty('userVote');
  });
});
