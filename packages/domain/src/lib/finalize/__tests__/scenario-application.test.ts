import { describe, it, expect } from 'vitest';
import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import type { VoteData } from '@stark-ballot/domain/types/server';
import { applyFinalizeScenarios } from '@stark-ballot/domain/finalize/scenario-application';

const createVote = (vote: VoteChoice): VoteData => ({
  vote,
  rand: '0x' + '1'.repeat(64),
  commit: '0x' + '2'.repeat(64),
  path: [],
});

const makeVotes = (choices: VoteChoice[]): Map<number, VoteData> => {
  return new Map(choices.map((choice, index) => [index, createVote(choice)]));
};

describe('applyFinalizeScenarios', () => {
  it('returns original votes when no scenarios are provided', () => {
    const votes = makeVotes(['A', 'B', 'C']);
    const result = applyFinalizeScenarios({
      votes,
      userVoteIndex: 0,
      scenarios: [],
      simulateTampering: false,
    });

    expect(result.scenariosApplied).toEqual([]);
    expect(result.scenarioResult).toBeNull();
    expect(result.modifiedVotes).toBe(votes);
    expect(result.tamperMode).toBe('none');
    expect(result.summary.ignoredCount).toBe(0);
    expect(result.summary.recountedCount).toBe(0);
  });

  it('defaults to S1 when simulateTampering is true', () => {
    const votes = makeVotes(['A', 'B', 'C']);
    const result = applyFinalizeScenarios({
      votes,
      userVoteIndex: 0,
      simulateTampering: true,
      random: () => 0,
    });

    expect(result.scenariosApplied).toEqual(['S1']);
    expect(result.modifiedVotes.has(0)).toBe(false);
    expect(result.tamperMode).toBe('input');
    expect(result.summary.ignoredCount).toBe(1);
    expect(result.summary.recountedCount).toBe(0);
  });

  it('recounts user vote for S2 using deterministic choice', () => {
    const votes = makeVotes(['A', 'B', 'C']);
    const originalUserVote = votes.get(0);
    const result = applyFinalizeScenarios({
      votes,
      userVoteIndex: 0,
      scenarios: ['S2'],
      random: () => 0,
    });

    expect(result.modifiedVotes.get(0)?.vote).toBe('B');
    expect(result.tamperMode).toBe('claim');
    expect(result.claimedCounts.A).toBe(0);
    expect(result.claimedCounts.B).toBe(2);
    expect(result.claimedCounts.C).toBe(1);
    expect(result.summary.recountedCount).toBe(1);
    expect(result.summary.userRecountChoice).toBe('B');
    expect(votes.get(0)?.vote).toBe('A');
    expect(result.modifiedVotes.get(0)).not.toBe(originalUserVote);
  });

  it('recounts a bot vote for S4 using deterministic target selection', () => {
    const votes = makeVotes(['A', 'C', 'D']);
    const originalBotVote = votes.get(1);
    const randomValues = [0, 0];
    const result = applyFinalizeScenarios({
      votes,
      userVoteIndex: 0,
      scenarios: ['S4'],
      random: () => randomValues.shift() ?? 0,
    });

    expect(result.modifiedVotes.get(1)?.vote).toBe('A');
    expect(result.tamperMode).toBe('claim');
    expect(result.summary.recountedCount).toBe(1);
    expect(votes.get(1)?.vote).toBe('C');
    expect(result.modifiedVotes.get(1)).not.toBe(originalBotVote);
  });

  it('excludes a random vote for S5 without mutating the original vote map', () => {
    const votes = makeVotes(['A', 'B', 'C']);
    const originalVote = votes.get(1);
    const result = applyFinalizeScenarios({
      votes,
      userVoteIndex: 0,
      scenarios: ['S5'],
      random: () => 0.5,
    });

    expect(result.modifiedVotes.has(1)).toBe(false);
    expect(votes.get(1)?.vote).toBe('B');
    expect(votes.get(1)).toBe(originalVote);
    expect(result.summary.ignoredCount).toBe(1);
    expect(result.summary.recountedCount).toBe(0);
  });
});
