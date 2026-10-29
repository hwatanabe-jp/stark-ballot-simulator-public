import type { VoteChoice } from '@stark-ballot/domain/shared/constants';

export interface ScenarioVoteRecord {
  vote: VoteChoice;
}

export interface ScenarioOptions {
  targetChoice?: VoteChoice;
  targetBotId?: number;
  random?: () => number;
}

export interface ScenarioChange {
  scenario: string;
  voteIndex: number;
  action: 'IGNORED' | 'RECOUNTED' | 'DUPLICATED';
  originalVote?: VoteChoice;
  newVote?: VoteChoice;
}

export interface ScenarioResult<TVote extends ScenarioVoteRecord = ScenarioVoteRecord> {
  modifiedVotes: Map<number, TVote>;
  changes: ScenarioChange[];
}

export class ScenarioProcessor {
  /**
   * Apply tamper scenarios to votes
   */
  applyScenarios<TVote extends ScenarioVoteRecord>(
    originalVotes: Map<number, TVote>,
    scenarios: string[],
    userVoteIndex: number,
    options: ScenarioOptions = {},
  ): ScenarioResult<TVote> {
    // Clone the votes map
    const modifiedVotes = new Map(originalVotes);
    const changes: ScenarioChange[] = [];

    for (const scenario of scenarios) {
      applyScenarioChange({ modifiedVotes, changes }, scenario, userVoteIndex, options);
    }

    return {
      modifiedVotes,
      changes,
    };
  }

  /**
   * Get tally counts from votes
   */
  getTallyCounts(votes: ReadonlyMap<number, ScenarioVoteRecord>): Record<VoteChoice, number> {
    const counts: Record<VoteChoice, number> = {
      A: 0,
      B: 0,
      C: 0,
      D: 0,
      E: 0,
    };

    for (const vote of votes.values()) {
      counts[vote.vote]++;
    }

    return counts;
  }
}

function applyScenarioChange<TVote extends ScenarioVoteRecord>(
  result: ScenarioResult<TVote>,
  scenario: string,
  userVoteIndex: number,
  options: ScenarioOptions,
): void {
  switch (scenario) {
    case 'S1':
      ignoreScenarioVote(result, scenario, userVoteIndex);
      break;
    case 'S2':
      recountScenarioVote(result, scenario, userVoteIndex, options.targetChoice);
      break;
    case 'S3':
      if (typeof options.targetBotId === 'number') ignoreScenarioVote(result, scenario, options.targetBotId);
      break;
    case 'S4':
      if (typeof options.targetBotId === 'number')
        recountScenarioVote(result, scenario, options.targetBotId, options.targetChoice);
      break;
    case 'S5':
      ignoreRandomScenarioVote(result, options.random ?? Math.random);
      break;
  }
}

function ignoreScenarioVote<TVote extends ScenarioVoteRecord>(
  result: ScenarioResult<TVote>,
  scenario: string,
  voteIndex: number,
): void {
  const vote = result.modifiedVotes.get(voteIndex);
  if (!vote) return;
  result.modifiedVotes.delete(voteIndex);
  result.changes.push({ scenario, voteIndex, action: 'IGNORED', originalVote: vote.vote });
}

function recountScenarioVote<TVote extends ScenarioVoteRecord>(
  result: ScenarioResult<TVote>,
  scenario: string,
  voteIndex: number,
  targetChoice: VoteChoice | undefined,
): void {
  if (!targetChoice) return;
  const vote = result.modifiedVotes.get(voteIndex);
  if (!vote) return;
  const originalVote = vote.vote;
  const updatedVote: TVote = { ...vote, vote: targetChoice };
  result.modifiedVotes.set(voteIndex, updatedVote);
  result.changes.push({ scenario, voteIndex, action: 'RECOUNTED', originalVote, newVote: targetChoice });
}

function ignoreRandomScenarioVote<TVote extends ScenarioVoteRecord>(
  result: ScenarioResult<TVote>,
  random: () => number,
): void {
  const voteIndices = Array.from(result.modifiedVotes.keys());
  if (voteIndices.length === 0) return;
  const randomIndex = voteIndices[Math.floor(random() * voteIndices.length)];
  if (randomIndex === undefined) return;
  ignoreScenarioVote(result, 'S5', randomIndex);
}
