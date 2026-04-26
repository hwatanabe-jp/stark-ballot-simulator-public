import type { VoteChoice } from '@/shared/constants';
import { VOTE_CHOICES } from '@/shared/constants';
import type { VoteData } from '@/types/server';
import { createSHA256Commitment, choiceToNumber } from '@/lib/crypto/sha256Commitment';
import crypto from 'crypto';

/**
 * Generate a bot ID from index (0-62) to bot ID (1-63)
 */
export function generateBotId(index: number): number {
  return index + 1;
}

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
  return VOTE_CHOICES[index];
}

/**
 * Generate a complete vote data for a bot
 */
export function generateBotVote(botId: number, electionId: string): Promise<VoteData> {
  void botId;
  const vote = generateBotChoice();
  const rand = generateBotRandom();

  // Convert random hex string to Uint8Array
  const randomBytes = new Uint8Array(32);
  const randHex = rand.startsWith('0x') ? rand.slice(2) : rand;
  for (let i = 0; i < 32; i++) {
    randomBytes[i] = parseInt(randHex.slice(i * 2, i * 2 + 2), 16);
  }

  // Create SHA256 commitment
  const choice = choiceToNumber(vote);
  const commit = createSHA256Commitment(electionId, choice, randomBytes);

  return Promise.resolve({
    vote,
    rand,
    commit,
    path: [], // Will be populated when added to Merkle tree
  });
}
