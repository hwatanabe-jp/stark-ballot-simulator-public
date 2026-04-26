import { describe, expect, it } from 'vitest';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { resolveCanonicalFinalizationPayload } from './client-finalization-result';

describe('resolveCanonicalFinalizationPayload', () => {
  it('recomputes tamperDetected from rejectedRecords when excluded slots stay zero', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
        missingIndices: 0,
        invalidIndices: 0,
        seenIndicesCount: 1,
      }),
      totalVotes: 2,
      invalidVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 1,
      excludedSlots: 0,
    };

    const result = resolveCanonicalFinalizationPayload({
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
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 1,
    });

    const result = resolveCanonicalFinalizationPayload({
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
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 1,
    });

    const unsupportedJournal = {
      ...journal,
      seenBitmapRoot: undefined,
    };
    const result = resolveCanonicalFinalizationPayload({
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
        missingIndices: 0,
        invalidIndices: 0,
        seenIndicesCount: 1,
      }),
      imageId: '0x' + 'a'.repeat(64),
    };

    const result = resolveCanonicalFinalizationPayload({
      journal,
    });

    expect(result).toBeNull();
  });

  it('rejects browser-local state when tally is missing even if journal and imageId are present', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 1,
    });

    const result = resolveCanonicalFinalizationPayload({
      imageId: '0x' + 'e'.repeat(64),
      journal,
    });

    expect(result).toBeNull();
  });

  it('rejects browser-local state when tally counts are malformed instead of rebuilding them from journal', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 1,
    });

    const result = resolveCanonicalFinalizationPayload({
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
        missingIndices: 0,
        invalidIndices: 0,
        seenIndicesCount: 1,
      }),
      imageId: '0x' + 'a'.repeat(64),
    };

    const result = resolveCanonicalFinalizationPayload({
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
        missingIndices: 0,
        invalidIndices: 0,
        seenIndicesCount: 1,
      }),
      imageId: '0x' + 'a'.repeat(64),
    };

    const result = resolveCanonicalFinalizationPayload({
      imageId: '0x' + 'b'.repeat(64),
      journal,
    });

    expect(result).toBeNull();
  });

  it('persists only the explicit browser snapshot fields', () => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
      seenIndicesCount: 1,
    });

    const result = resolveCanonicalFinalizationPayload({
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

  it('accepts legacy alias input but persists only canonical snapshot and journal fields', () => {
    const journal = {
      ...createTestJournal({
        totalExpected: 64,
        validVotes: 61,
        missingIndices: 1,
        invalidIndices: 2,
      }),
      missingIndices: 99,
      invalidIndices: 98,
      countedIndices: 0,
      excludedCount: 97,
    };

    const result = resolveCanonicalFinalizationPayload({
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

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('missingIndices');
    expect(result).not.toHaveProperty('invalidIndices');
    expect(result).not.toHaveProperty('countedIndices');
    expect(result).not.toHaveProperty('excludedCount');
    expect(result?.journal).not.toHaveProperty('missingIndices');
    expect(result?.journal).not.toHaveProperty('invalidIndices');
    expect(result?.journal).not.toHaveProperty('countedIndices');
    expect(result?.journal).not.toHaveProperty('excludedCount');
    expect(result?.missingSlots).toBe(1);
    expect(result?.invalidPresentedSlots).toBe(2);
    expect(result?.excludedSlots).toBe(3);
  });
});
