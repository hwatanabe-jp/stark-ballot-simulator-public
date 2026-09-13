import { describe, expect, it } from 'vitest';
import { hasCoherentPublicTamperScenarioProjection } from '@stark-ballot/verification/scenario-projection';

describe('public scenario projection', () => {
  it('admits only the exact scenario-one tamper projection', () => {
    const baseline = {
      scenarioId: 'S1',
      tamperDetected: true,
      tamperedCount: 1,
      proof: { excludedSlots: 1, rejectedRecords: 0, verifiedTally: [0, 2, 3, 4, 5] },
      counts: { A: 0, B: 2, C: 3, D: 4, E: 5 },
      tamperSummary: {
        ignoredVotes: 1,
        recountedVotes: 0,
        userRecountedTo: null,
        affectedBotIds: [],
      },
    } as const;

    expect(hasCoherentPublicTamperScenarioProjection(baseline)).toBe(true);
    expect(hasCoherentPublicTamperScenarioProjection({ ...baseline, tamperedCount: 999 })).toBe(false);
    expect(
      hasCoherentPublicTamperScenarioProjection({
        ...baseline,
        tamperSummary: { ...baseline.tamperSummary, ignoredVotes: 999 },
      }),
    ).toBe(false);
    expect(
      hasCoherentPublicTamperScenarioProjection({
        ...baseline,
        botVotesSummary: { total: 63, affectedBotIds: [1], source: 'scenario_simulation' },
      }),
    ).toBe(false);
  });

  it('binds scenario-five presentation to the exclusion-adjusted proof tally', () => {
    const baseline = {
      scenarioId: 'S5',
      tamperDetected: true,
      tamperedCount: 1,
      proof: { excludedSlots: 1, rejectedRecords: 0, verifiedTally: [0, 2, 3, 4, 5] },
      counts: { A: 0, B: 2, C: 3, D: 4, E: 5 },
      tamperSummary: {
        ignoredVotes: 1,
        recountedVotes: 0,
        userRecountedTo: null,
        affectedBotIds: [],
      },
    } as const;

    expect(hasCoherentPublicTamperScenarioProjection(baseline)).toBe(true);
    expect(
      hasCoherentPublicTamperScenarioProjection({
        ...baseline,
        counts: { ...baseline.counts, A: 1 },
      }),
    ).toBe(false);
  });

  it('binds bot-vote presentation fields to the scenario tamper summary', () => {
    const baseline = {
      scenarioId: 'S3',
      tamperDetected: true,
      tamperedCount: 1,
      proof: { excludedSlots: 1, rejectedRecords: 0, verifiedTally: [1, 2, 3, 4, 5] },
      counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
      tamperSummary: {
        ignoredVotes: 1,
        recountedVotes: 0,
        userRecountedTo: null,
        affectedBotIds: [1],
      },
      botVotesSummary: { total: 63, affectedBotIds: [1], source: 'scenario_simulation' },
    } as const;

    expect(hasCoherentPublicTamperScenarioProjection(baseline)).toBe(true);
    expect(
      hasCoherentPublicTamperScenarioProjection({
        ...baseline,
        botVotesSummary: { ...baseline.botVotesSummary, affectedBotIds: [2] },
      }),
    ).toBe(false);
    expect(
      hasCoherentPublicTamperScenarioProjection({
        ...baseline,
        botVotesSummary: { ...baseline.botVotesSummary, source: 'forged' },
      }),
    ).toBe(false);
  });

  it('binds claim-tamper scenarios to the exact tally delta they publish', () => {
    const baseline = {
      scenarioId: 'S2',
      tamperDetected: true,
      tamperedCount: 1,
      proof: {
        excludedSlots: 0,
        rejectedRecords: 0,
        verifiedTally: [1, 1, 1, 1, 1] as const,
      },
      counts: { A: 0, B: 2, C: 1, D: 1, E: 1 },
      tamperSummary: {
        ignoredVotes: 0,
        recountedVotes: 1,
        userRecountedTo: 'B' as const,
        affectedBotIds: [],
      },
    } as const;

    expect(hasCoherentPublicTamperScenarioProjection(baseline)).toBe(true);
    expect(
      hasCoherentPublicTamperScenarioProjection({
        ...baseline,
        tamperSummary: { ...baseline.tamperSummary, userRecountedTo: 'C' },
      }),
    ).toBe(false);
    expect(
      hasCoherentPublicTamperScenarioProjection({
        ...baseline,
        counts: { A: 0, B: 2, C: 2, D: 0, E: 1 },
      }),
    ).toBe(false);
  });
});
