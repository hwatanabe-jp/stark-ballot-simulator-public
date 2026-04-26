/**
 * Converters for zkVM structures
 * Provides utility functions for v2 structures
 */

import type { ZkVMInput, VoteWithProof } from './types';
import { computeSTHDigest } from './types';
import { createHash } from 'crypto';

/**
 * Generate election config hash including totalExpected
 */
export function generateElectionConfigHash(config: { totalExpected: number } & Record<string, unknown>): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(config));
  return '0x' + hash.digest('hex');
}

/**
 * Generate STH (Signed Tree Head) for bulletin board
 */
export function generateSTH(logId: string, treeSize: number, timestamp: number, bulletinRoot: string): string {
  return computeSTHDigest(logId, treeSize, timestamp, bulletinRoot);
}

/**
 * Create default vote with proof
 */
export function createDefaultVote(choice: number, random: string, index: number, commitment?: string): VoteWithProof {
  const finalCommitment =
    commitment ||
    '0x' +
      createHash('sha256')
        .update(Buffer.from([choice]))
        .update(Buffer.from(random.replace(/^0x/, ''), 'hex'))
        .digest('hex');

  return {
    commitment: finalCommitment,
    choice,
    random,
    index,
    merklePath: [],
  };
}

/**
 * Validate zkVM input structure
 */
export function validateInput(input: ZkVMInput): boolean {
  // Check required fields
  if (input.electionId.length === 0 || input.bulletinRoot.length === 0) {
    return false;
  }

  // Check vote array
  if (!Array.isArray(input.votes)) {
    return false;
  }

  // Check each vote
  for (const vote of input.votes) {
    if (vote.choice < 0 || vote.choice > 4) {
      return false;
    }
    if (!vote.commitment || !vote.random) {
      return false;
    }
    if (typeof vote.index !== 'number') {
      return false;
    }
  }

  return true;
}
