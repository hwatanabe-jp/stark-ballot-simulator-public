import { describe, expect, it } from 'vitest';
import { resolveFinalizationCountDiagnostics, type FinalizeScenarioData } from '../cli-test-helpers';
import { createTestJournal } from '../test-helpers';

describe('resolveFinalizationCountDiagnostics', () => {
  it('uses journal counts before top-level or debug projections', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingSlots: 2,
      invalidPresentedSlots: 1,
      excludedSlots: 3,
    });
    const data: FinalizeScenarioData = {
      journal,
      debug: {
        missingSlots: 0,
        invalidPresentedSlots: 0,
        validVotes: 64,
        excludedSlots: 0,
      },
      missingSlots: 0,
      invalidPresentedSlots: 0,
      validVotes: 64,
      excludedSlots: 0,
    };

    expect(resolveFinalizationCountDiagnostics(data)).toEqual({
      missingSlots: 2,
      invalidPresentedSlots: 1,
      validVotes: 61,
      excludedSlots: 3,
    });
  });

  it('does not require a top-level validVotes mirror when the journal is available', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 62,
      missingSlots: 1,
      invalidPresentedSlots: 1,
      excludedSlots: 2,
    });

    expect(resolveFinalizationCountDiagnostics({ journal })).toEqual({
      missingSlots: 1,
      invalidPresentedSlots: 1,
      validVotes: 62,
      excludedSlots: 2,
    });
  });
});
