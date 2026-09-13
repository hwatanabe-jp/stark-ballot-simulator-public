import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import { VOTE_CHOICES } from '@stark-ballot/domain/shared/constants';
import type { BotVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import crypto from 'crypto';

/**
 * Generate random value for a bot
 */
function generateBotRandom(): string {
  // Generate actual random value for each bot
  return '0x' + crypto.randomBytes(32).toString('hex');
}

/**
 * Generate random vote choice for a bot
 */
function generateBotChoice(): VoteChoice {
  // Randomly select vote choice
  const index = Math.floor(Math.random() * VOTE_CHOICES.length);
  const choice = VOTE_CHOICES[index];
  if (!choice) {
    throw new Error('No vote choices are configured');
  }
  return choice;
}

/** Generate caller-owned bot vote values; the mutation assigns identity and commitment. */
export function generateBotVote(): Promise<BotVoteCommand> {
  const vote = generateBotChoice();
  const rand = generateBotRandom();

  return Promise.resolve({
    vote,
    rand,
  });
}
