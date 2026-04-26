import type { VoteData } from '@/types/server';
import type { VoteChoice } from '@/shared/constants';
import { VOTE_CHOICES } from '@/shared/constants';

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

export interface ScenarioResult {
  modifiedVotes: Map<number, VoteData>;
  changes: ScenarioChange[];
}

export class ScenarioProcessor {
  /**
   * Apply tamper scenarios to votes
   */
  applyScenarios(
    originalVotes: Map<number, VoteData>,
    scenarios: string[],
    userVoteIndex: number,
    options: ScenarioOptions = {},
  ): ScenarioResult {
    // Clone the votes map
    const modifiedVotes = new Map(originalVotes);
    const changes: ScenarioChange[] = [];

    for (const scenario of scenarios) {
      switch (scenario) {
        case 'S1':
          // Ignore user vote
          {
            const userVote = modifiedVotes.get(userVoteIndex);
            if (!userVote) {
              break;
            }
            modifiedVotes.delete(userVoteIndex);
            changes.push({
              scenario: 'S1',
              voteIndex: userVoteIndex,
              action: 'IGNORED',
              originalVote: userVote.vote,
            });
          }
          break;

        case 'S2':
          // Recount user vote
          {
            if (!options.targetChoice) {
              break;
            }
            const userVote = modifiedVotes.get(userVoteIndex);
            if (!userVote) {
              break;
            }
            const originalVote = userVote.vote;
            const updatedVote: VoteData = { ...userVote, vote: options.targetChoice };
            modifiedVotes.set(userVoteIndex, updatedVote);
            changes.push({
              scenario: 'S2',
              voteIndex: userVoteIndex,
              action: 'RECOUNTED',
              originalVote,
              newVote: options.targetChoice,
            });
          }
          break;

        case 'S3':
          // Ignore specific bot vote
          {
            const targetBotId = options.targetBotId;
            if (typeof targetBotId !== 'number') {
              break;
            }
            const botVote = modifiedVotes.get(targetBotId);
            if (!botVote) {
              break;
            }
            modifiedVotes.delete(targetBotId);
            changes.push({
              scenario: 'S3',
              voteIndex: targetBotId,
              action: 'IGNORED',
              originalVote: botVote.vote,
            });
          }
          break;

        case 'S4':
          // Recount bot vote
          {
            const targetBotId = options.targetBotId;
            if (typeof targetBotId !== 'number' || !options.targetChoice) {
              break;
            }
            const botVote = modifiedVotes.get(targetBotId);
            if (!botVote) {
              break;
            }
            const originalVote = botVote.vote;
            const updatedVote: VoteData = { ...botVote, vote: options.targetChoice };
            modifiedVotes.set(targetBotId, updatedVote);
            changes.push({
              scenario: 'S4',
              voteIndex: targetBotId,
              action: 'RECOUNTED',
              originalVote,
              newVote: options.targetChoice,
            });
          }
          break;

        case 'S5': {
          // Random error injection
          const random = options.random ?? Math.random;
          const voteIndices = Array.from(modifiedVotes.keys());
          if (voteIndices.length > 0) {
            // Randomly select a vote to modify
            const randomIndex = voteIndices[Math.floor(random() * voteIndices.length)];
            const randomAction = random();

            if (randomAction < 0.5) {
              // Ignore the vote
              const vote = modifiedVotes.get(randomIndex);
              if (!vote) {
                break;
              }
              modifiedVotes.delete(randomIndex);
              changes.push({
                scenario: 'S5',
                voteIndex: randomIndex,
                action: 'IGNORED',
                originalVote: vote.vote,
              });
            } else {
              // Recount the vote
              const vote = modifiedVotes.get(randomIndex);
              if (!vote) {
                break;
              }
              const originalVote = vote.vote;
              // Select a different vote choice than the original
              const availableChoices = VOTE_CHOICES.filter((c) => c !== originalVote);
              const newVote = availableChoices[Math.floor(random() * availableChoices.length)];
              const updatedVote: VoteData = { ...vote, vote: newVote };
              modifiedVotes.set(randomIndex, updatedVote);
              changes.push({
                scenario: 'S5',
                voteIndex: randomIndex,
                action: 'RECOUNTED',
                originalVote,
                newVote,
              });
            }
          }
          break;
        }
      }
    }

    return {
      modifiedVotes,
      changes,
    };
  }

  /**
   * Get tally counts from votes
   */
  getTallyCounts(votes: Map<number, VoteData>): Record<VoteChoice, number> {
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
