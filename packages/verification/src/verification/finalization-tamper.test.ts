import { describe, expect, it } from 'vitest';
import { resolveFinalizationTamperDetected, resolveScenarioTamperCount } from './finalization-tamper';

describe('resolveScenarioTamperCount', () => {
  it.each([
    ['missing', undefined, 0],
    ['zero', 0, 0],
    ['negative', -1, 0],
    ['NaN', Number.NaN, 0],
    ['positive infinity', Number.POSITIVE_INFINITY, 0],
    ['negative infinity', Number.NEGATIVE_INFINITY, 0],
    ['positive integer', 2, 2],
    ['positive fraction', 0.5, 0.5],
  ] as const)('normalizes an %s count without changing positive finite values', (_label, value, expected) => {
    const summary = value === undefined ? undefined : { ignoredVotes: value };
    expect(resolveScenarioTamperCount(summary)).toBe(expected);
  });

  it('normalizes ignored and recounted counts independently before adding them', () => {
    expect(
      resolveScenarioTamperCount({
        ignoredVotes: Number.NaN,
        recountedVotes: 3,
      }),
    ).toBe(3);
  });

  it.each([
    ['missing', undefined, 0],
    ['zero', 0, 0],
    ['negative', -1, 0],
    ['NaN', Number.NaN, 0],
    ['positive infinity', Number.POSITIVE_INFINITY, 0],
    ['negative infinity', Number.NEGATIVE_INFINITY, 0],
    ['positive integer', 2, 2],
    ['positive fraction', 0.5, 0.5],
  ] as const)('normalizes an %s recounted count without changing positive finite values', (_label, value, expected) => {
    const summary = value === undefined ? undefined : { recountedVotes: value };
    expect(resolveScenarioTamperCount(summary)).toBe(expected);
  });
});

describe('resolveFinalizationTamperDetected', () => {
  it.each([
    ['excluded slots', { excludedSlots: 1 }, true],
    ['rejected records', { rejectedRecords: 1 }, true],
    ['scenario count', { scenarioTamperCount: 1 }, true],
    ['combined positive signals', { excludedSlots: 1, rejectedRecords: 2, scenarioTamperCount: 3 }, true],
    ['zero signals', { excludedSlots: 0, rejectedRecords: 0, scenarioTamperCount: 0 }, false],
    ['negative signals', { excludedSlots: -1, rejectedRecords: -2, scenarioTamperCount: -3 }, false],
    [
      'non-finite signals',
      {
        excludedSlots: Number.NaN,
        rejectedRecords: Number.POSITIVE_INFINITY,
        scenarioTamperCount: Number.NEGATIVE_INFINITY,
      },
      false,
    ],
  ] as const)('derives the exact %s result', (_label, input, expected) => {
    expect(resolveFinalizationTamperDetected(input)).toBe(expected);
  });

  it.each([
    ['S0', 0, 0, 0, 0, false],
    ['S1', 1, 0, 1, 0, true],
    ['S2', 0, 1, 0, 0, true],
    ['S3', 1, 0, 1, 0, true],
    ['S4', 0, 1, 0, 0, true],
    ['S5', 4, 0, 4, 0, true],
  ] as const)(
    'preserves the current %s educational outcome',
    (_scenario, ignoredVotes, recountedVotes, excludedSlots, rejectedRecords, expected) => {
      const scenarioTamperCount = resolveScenarioTamperCount({ ignoredVotes, recountedVotes });
      expect(resolveFinalizationTamperDetected({ excludedSlots, rejectedRecords, scenarioTamperCount })).toBe(expected);
    },
  );
});
