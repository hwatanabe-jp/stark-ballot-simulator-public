import type { VoteData } from '@/types/server';
import type { ScenarioTamperMode } from '@/types/scenario';
import type { VoteChoice } from '@/shared/constants';
import { VOTE_CHOICES } from '@/shared/constants';
import { ScenarioProcessor, type ScenarioResult } from '@/lib/scenarios/processor';

export interface ScenarioSummary {
  ignoredCount: number;
  recountedCount: number;
  userRecountChoice: VoteChoice | null;
}

export interface ScenarioApplicationResult {
  modifiedVotes: Map<number, VoteData>;
  scenarioResult: ScenarioResult | null;
  scenariosApplied: string[];
  summary: ScenarioSummary;
  claimedCounts: Record<VoteChoice, number>;
  claimedTotalVotes: number;
  tamperMode: ScenarioTamperMode;
}

export interface ScenarioApplicationOptions {
  votes: Map<number, VoteData>;
  userVoteIndex: number;
  scenarios?: string[];
  simulateTampering?: boolean;
  random?: () => number;
}

/**
 * Apply finalize-time tamper scenarios and return updated votes plus summary data.
 */
export function applyFinalizeScenarios(options: ScenarioApplicationOptions): ScenarioApplicationResult {
  const { votes, userVoteIndex } = options;
  if (!(votes instanceof Map)) {
    throw new Error('Votes map is required for scenario application');
  }
  if (!Number.isInteger(userVoteIndex) || userVoteIndex < 0) {
    throw new Error('userVoteIndex must be a non-negative integer');
  }

  const scenarios = options.scenarios ?? [];
  const simulateTampering = options.simulateTampering ?? false;
  const random = options.random ?? Math.random;

  const scenariosApplied = scenarios.length > 0 ? scenarios : simulateTampering ? ['S1'] : [];
  const processor = new ScenarioProcessor();

  if (scenariosApplied.length === 0) {
    const claimedCounts = processor.getTallyCounts(votes);
    const claimedTotalVotes = Object.values(claimedCounts).reduce((sum, value) => sum + value, 0);
    return {
      modifiedVotes: votes,
      scenarioResult: null,
      scenariosApplied,
      summary: {
        ignoredCount: 0,
        recountedCount: 0,
        userRecountChoice: null,
      },
      claimedCounts,
      claimedTotalVotes,
      tamperMode: 'none',
    };
  }

  let targetChoice: VoteChoice = 'B';
  let targetBotId = 1;

  const userVoteData = votes.get(userVoteIndex);

  if (scenariosApplied.includes('S2') && userVoteData) {
    const userChoice = userVoteData.vote;
    const availableChoices = VOTE_CHOICES.filter((choice) => choice !== userChoice);
    if (availableChoices.length > 0) {
      targetChoice = availableChoices[Math.floor(random() * availableChoices.length)];
    }
  }

  if (scenariosApplied.includes('S4')) {
    const botIndices = Array.from(votes.keys()).filter((index) => index !== userVoteIndex);
    if (botIndices.length > 0) {
      targetBotId = botIndices[Math.floor(random() * botIndices.length)];
      const botVote = votes.get(targetBotId);
      if (botVote) {
        const availableChoices = VOTE_CHOICES.filter((choice) => choice !== botVote.vote);
        if (availableChoices.length > 0) {
          targetChoice = availableChoices[Math.floor(random() * availableChoices.length)];
        }
      }
    }
  }

  const scenarioResult = processor.applyScenarios(votes, scenariosApplied, userVoteIndex, {
    targetChoice,
    targetBotId,
    random,
  });

  let ignoredCount = 0;
  let recountedCount = 0;
  let userRecountChoice: VoteChoice | null = null;

  for (const change of scenarioResult.changes) {
    if (change.action === 'IGNORED') {
      ignoredCount += 1;
    } else if (change.action === 'RECOUNTED') {
      recountedCount += 1;
      if (change.voteIndex === userVoteIndex && change.newVote) {
        userRecountChoice = change.newVote;
      }
    }
  }

  const claimedCounts = processor.getTallyCounts(scenarioResult.modifiedVotes);
  const claimedTotalVotes = Object.values(claimedCounts).reduce((sum, value) => sum + value, 0);
  const inputTamperScenarios = new Set(['S1', 'S3', 'S5']);
  const claimTamperScenarios = new Set(['S2', 'S4']);
  const tamperMode = scenariosApplied.some((scenario) => inputTamperScenarios.has(scenario))
    ? 'input'
    : scenariosApplied.some((scenario) => claimTamperScenarios.has(scenario))
      ? 'claim'
      : 'none';

  return {
    modifiedVotes: scenarioResult.modifiedVotes,
    scenarioResult,
    scenariosApplied,
    summary: {
      ignoredCount,
      recountedCount,
      userRecountChoice,
    },
    claimedCounts,
    claimedTotalVotes,
    tamperMode,
  };
}
