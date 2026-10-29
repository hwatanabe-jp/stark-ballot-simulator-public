import type { StoredVoteRecord } from '@stark-ballot/domain/types/sessionRecords';
import type { ScenarioTamperMode } from '@stark-ballot/domain/types/scenario';
import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import { VOTE_CHOICES } from '@stark-ballot/domain/shared/constants';
import { ScenarioProcessor, type ScenarioResult } from '@stark-ballot/domain/scenarios/processor';

export interface ScenarioSummary {
  ignoredCount: number;
  recountedCount: number;
  userRecountChoice: VoteChoice | null;
}

export interface ScenarioApplicationResult {
  modifiedVotes: Map<number, StoredVoteRecord>;
  scenarioResult: ScenarioResult<StoredVoteRecord> | null;
  scenariosApplied: string[];
  summary: ScenarioSummary;
  claimedCounts: Record<VoteChoice, number>;
  claimedTotalVotes: number;
  tamperMode: ScenarioTamperMode;
}

export interface ScenarioApplicationOptions {
  votes: Map<number, StoredVoteRecord>;
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

  const { targetChoice, targetBotId } = selectScenarioTargets(votes, userVoteIndex, scenariosApplied, random);

  const scenarioResult = processor.applyScenarios(votes, scenariosApplied, userVoteIndex, {
    targetChoice,
    targetBotId,
    random,
  });

  const summary = summarizeScenarioChanges(scenarioResult.changes, userVoteIndex);

  const claimedCounts = processor.getTallyCounts(scenarioResult.modifiedVotes);
  const claimedTotalVotes = Object.values(claimedCounts).reduce((sum, value) => sum + value, 0);
  const tamperMode = resolveScenarioTamperMode(scenariosApplied);

  return {
    modifiedVotes: scenarioResult.modifiedVotes,
    scenarioResult,
    scenariosApplied,
    summary,
    claimedCounts,
    claimedTotalVotes,
    tamperMode,
  };
}

function selectScenarioTargets(
  votes: Map<number, StoredVoteRecord>,
  userVoteIndex: number,
  scenariosApplied: string[],
  random: () => number,
) {
  let targetChoice: VoteChoice = 'B';
  const userVoteData = votes.get(userVoteIndex);
  if (scenariosApplied.includes('S2') && userVoteData)
    targetChoice = selectRecountChoice(userVoteData.vote, random, targetChoice);
  if (scenariosApplied.includes('S4')) return selectBotRecountTarget(votes, userVoteIndex, random, targetChoice);
  return { targetChoice, targetBotId: 1 };
}

function selectRecountChoice(original: VoteChoice, random: () => number, fallback: VoteChoice): VoteChoice {
  const availableChoices = VOTE_CHOICES.filter((choice) => choice !== original);
  if (availableChoices.length === 0) return fallback;
  return availableChoices[Math.floor(random() * availableChoices.length)] ?? fallback;
}

function selectBotRecountTarget(
  votes: Map<number, StoredVoteRecord>,
  userVoteIndex: number,
  random: () => number,
  targetChoice: VoteChoice,
) {
  const botIndices = Array.from(votes.keys()).filter((index) => index !== userVoteIndex);
  if (botIndices.length === 0) return { targetChoice, targetBotId: 1 };
  const targetBotId = botIndices[Math.floor(random() * botIndices.length)];
  if (targetBotId === undefined) throw new Error('No bot vote index selected');
  const botVote = votes.get(targetBotId);
  if (botVote) targetChoice = selectRecountChoice(botVote.vote, random, targetChoice);
  return { targetChoice, targetBotId };
}

function summarizeScenarioChanges(
  changes: NonNullable<ScenarioApplicationResult['scenarioResult']>['changes'],
  userVoteIndex: number,
): ScenarioSummary {
  let ignoredCount = 0;
  let recountedCount = 0;
  let userRecountChoice: VoteChoice | null = null;

  for (const change of changes) {
    if (change.action === 'IGNORED') {
      ignoredCount += 1;
    } else if (change.action === 'RECOUNTED') {
      recountedCount += 1;
      if (change.voteIndex === userVoteIndex && change.newVote) {
        userRecountChoice = change.newVote;
      }
    }
  }

  return { ignoredCount, recountedCount, userRecountChoice };
}

function resolveScenarioTamperMode(scenariosApplied: string[]): ScenarioTamperMode {
  const inputTamperScenarios = new Set(['S1', 'S3', 'S5']);
  const claimTamperScenarios = new Set(['S2', 'S4']);
  const tamperMode = scenariosApplied.some((scenario) => inputTamperScenarios.has(scenario))
    ? 'input'
    : scenariosApplied.some((scenario) => claimTamperScenarios.has(scenario))
      ? 'claim'
      : 'none';
  return tamperMode;
}
