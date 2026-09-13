import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import {
  finalizationRecordCodec,
  parseFinalizationRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import type { FinalizationScenarioContext } from '@stark-ballot/application/finalize/finalization-types';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';

const sessionId = '00000000-0000-4000-8000-000000000010';
const finalizationId = 'finalization-record-1';
const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 1,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};
const finalizationResult = buildFinalizationResultFromJournal({
  journal: createTestJournal(),
  imageId: `0x${'11'.repeat(32)}`,
});
const { artifacts: _artifacts, ...persistedFinalizationResult } = finalizationResult;
void _artifacts;
const finalizationResultRecord = { finalizationId, ...persistedFinalizationResult };

function succeededRecord() {
  return {
    sessionId,
    finalizationId,
    scenarioContext,
    state: {
      status: 'succeeded',
      finalizationId,
      queuedAtMs: 100,
      startedAtMs: 101,
      completedAtMs: 102,
    },
    finalizationResult: finalizationResultRecord,
  };
}

describe('finalization record admission', () => {
  it('rejects a lifecycle state scoped to another finalization', () => {
    expect(
      parseFinalizationRecord({
        ...succeededRecord(),
        state: {
          ...succeededRecord().state,
          finalizationId: 'finalization-record-other',
        },
      }),
    ).toBeUndefined();
    expect(
      parseFinalizationRecord({
        ...succeededRecord(),
        finalizationResult: {
          ...finalizationResultRecord,
          finalizationId: 'finalization-record-other',
        },
      }),
    ).toBeUndefined();
  });

  it('rejects impossible terminal/result combinations', () => {
    const succeeded = succeededRecord();

    expect(
      parseFinalizationRecord({
        ...succeeded,
        finalizationResult: undefined,
      }),
    ).toBeUndefined();
    expect(
      parseFinalizationRecord({
        ...succeeded,
        state: {
          status: 'failed',
          finalizationId,
          queuedAtMs: 100,
          failedAtMs: 102,
          error: {
            code: 'FINALIZATION_FAILED',
            message: 'failed',
          },
        },
      }),
    ).toBeUndefined();
  });

  it('rejects unknown nested scenario keys instead of normalizing them away', () => {
    expect(
      parseFinalizationRecord({
        ...succeededRecord(),
        scenarioContext: {
          ...scenarioContext,
          compatibilityMarker: 'retired-shape',
        },
      }),
    ).toBeUndefined();
    expect(
      parseFinalizationRecord({
        ...succeededRecord(),
        scenarioContext: {
          ...scenarioContext,
          summary: {
            ...scenarioContext.summary,
            legacyCount: 0,
          },
        },
      }),
    ).toBeUndefined();
  });

  it('rejects unknown nested result keys instead of normalizing them away', () => {
    expect(
      parseFinalizationRecord({
        ...succeededRecord(),
        finalizationResult: {
          ...finalizationResultRecord,
          tally: {
            ...finalizationResultRecord.tally,
            legacyCount: 0,
          },
        },
      }),
    ).toBeUndefined();
  });

  it('round-trips one exact-current flat record through the admitted nested authority', () => {
    const persisted = succeededRecord();
    const admitted = finalizationRecordCodec.decode(persisted);

    expect(admitted).toMatchObject({
      finalizationResult: {
        artifacts: {
          publicAudit: { availability: 'unavailable' },
          receipt: { availability: 'unavailable' },
          receiptPublication: { availability: 'unavailable' },
          bitmap: { availability: 'unavailable' },
        },
      },
    });
    expect(admitted && finalizationRecordCodec.encode(admitted)).toEqual(persisted);
  });
});
