/**
 * Enhanced input validator for zkVM v2
 * Requirements from final_design.md §1.2 and §2.4
 */

import type { ZkVMInput, VoteWithProof } from './types';
import { computeCommitment } from './types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidationOptions {
  /**
   * Optional election config hasher for validating electionConfigHash.
   * Provide when you can compute the expected hash from the original config.
   */
  computeElectionConfigHash?: (input: ZkVMInput) => string;
}

// Constants
const MAX_TREE_SIZE = 1_000_000; // Practical limit for tree size
const MAX_FUTURE_TIMESTAMP_MS = 60 * 60 * 1000; // 1 hour in milliseconds
const MIN_CHOICE = 0; // Minimum valid choice value (A)
const MAX_CHOICE = 4; // Maximum valid choice value (E)

/**
 * Enhanced validation for ZkVMInput with comprehensive checks
 * Implements requirements from final_design.md
 */
export function validateZkVMInputEnhanced(input: ZkVMInput, options?: ValidationOptions): ValidationResult {
  const errors: string[] = [];

  // Validate top-level fields
  validateElectionId(input.electionId, errors);
  validateSTHParameters(input.logId, input.timestamp, errors);
  validateTreeSize(input.treeSize, errors);
  validateBulletinRoot(input.bulletinRoot, errors);
  validateElectionConfigHash(input.electionConfigHash, errors);
  validateElectionConfigConsistency(input, options, errors);

  // Validate each vote
  validateVotes(input, errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate election ID format
 */
function validateElectionId(electionId: string, errors: string[]): void {
  if (!validateUUIDv4(electionId)) {
    errors.push('Invalid electionId: must be UUID v4');
  }
}

/**
 * Validate STH (Signed Tree Head) parameters
 */
function validateSTHParameters(logId: string, timestamp: number, errors: string[]): void {
  if (!validateHex32Bytes(logId)) {
    errors.push('Invalid logId: must be 32 bytes hex');
  }

  if (timestamp <= 0) {
    errors.push('Invalid timestamp: must be positive Unix timestamp');
  } else if (timestamp > Date.now() + MAX_FUTURE_TIMESTAMP_MS) {
    errors.push('Invalid timestamp: too far in the future');
  }
}

/**
 * Validate tree size bounds
 */
function validateTreeSize(treeSize: number, errors: string[]): void {
  if (treeSize <= 0) {
    errors.push('Invalid treeSize: must be positive');
  } else if (treeSize > MAX_TREE_SIZE) {
    errors.push(`Invalid treeSize: exceeds maximum (${MAX_TREE_SIZE})`);
  }
}

/**
 * Validate bulletin root format
 */
function validateBulletinRoot(bulletinRoot: string, errors: string[]): void {
  if (!validateHex32Bytes(bulletinRoot)) {
    errors.push('Invalid bulletinRoot: must be 32 bytes hex');
  }
}

/**
 * Validate election config hash format
 */
function validateElectionConfigHash(hash: string, errors: string[]): void {
  if (!validateHex32Bytes(hash)) {
    errors.push('Invalid electionConfigHash: must be 32 bytes hex');
  }
}

function validateElectionConfigConsistency(input: ZkVMInput, options: ValidationOptions | undefined, errors: string[]) {
  if (!options?.computeElectionConfigHash) {
    return;
  }

  try {
    const expectedHash = options.computeElectionConfigHash(input);
    if (expectedHash.toLowerCase() !== input.electionConfigHash.toLowerCase()) {
      errors.push('totalExpected does not match electionConfigHash');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    errors.push(`Unable to validate electionConfigHash: ${message}`);
  }
}

/**
 * Validate all votes in the input
 */
function validateVotes(input: ZkVMInput, errors: string[]): void {
  const seenIndices = new Set<number>();
  const expectedDepth = calculateMerkleDepth(input.treeSize);

  input.votes.forEach((vote, i) => {
    validateSingleVote(vote, i, input, seenIndices, expectedDepth, errors);
  });
}

/**
 * Validate a single vote
 */
function validateSingleVote(
  vote: VoteWithProof,
  voteIndex: number,
  input: ZkVMInput,
  seenIndices: Set<number>,
  expectedDepth: number,
  errors: string[],
): void {
  // Validate choice boundaries
  if (vote.choice < MIN_CHOICE || vote.choice > MAX_CHOICE) {
    errors.push(`Invalid choice at vote ${voteIndex}: must be ${MIN_CHOICE}-${MAX_CHOICE}`);
  }

  // Validate vote index
  if (vote.index >= input.treeSize) {
    errors.push(`Invalid index at vote ${voteIndex}: must be < treeSize`);
  }

  // Check for duplicate indices
  if (seenIndices.has(vote.index)) {
    errors.push(`Duplicate vote index: ${vote.index}`);
  } else {
    seenIndices.add(vote.index);
  }

  // Validate random value
  if (!validateHex32Bytes(vote.random)) {
    errors.push(`Invalid random at vote ${voteIndex}: must be 32 bytes hex`);
  }

  // Validate commitment
  validateCommitment(vote, voteIndex, input.electionId, errors);

  // Validate merkle path
  validateMerklePath(vote.merklePath, voteIndex, expectedDepth, errors);
}

/**
 * Validate vote commitment
 */
function validateCommitment(vote: VoteWithProof, voteIndex: number, electionId: string, errors: string[]): void {
  if (!validateHex32Bytes(vote.commitment)) {
    errors.push(`Invalid commitment format at vote ${voteIndex}`);
    return;
  }

  let computedCommitment: string;
  try {
    computedCommitment = computeCommitment(electionId, vote.choice, vote.random);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    errors.push(`Invalid commitment at vote ${voteIndex}: ${message}`);
    return;
  }

  if (vote.commitment.toLowerCase() !== computedCommitment.toLowerCase()) {
    // Commitment mismatch could be due to wrong electionId, choice, or random
    errors.push(`Invalid commitment at vote ${voteIndex}: does not match computed value`);
  }
}

/**
 * Validate merkle path for a vote
 */
function validateMerklePath(merklePath: string[], voteIndex: number, expectedDepth: number, errors: string[]): void {
  if (merklePath.length !== expectedDepth) {
    errors.push(`Invalid merkle path at vote ${voteIndex}: expected depth ${expectedDepth}, got ${merklePath.length}`);
  }

  merklePath.forEach((node, nodeIndex) => {
    if (!validateHex32Bytes(node)) {
      errors.push(`Invalid merkle path node at vote ${voteIndex}, node ${nodeIndex}`);
    }
  });
}

/**
 * Validate UUID v4 format
 */
function validateUUIDv4(uuid: string): boolean {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(uuid);
}

/**
 * Validate 32 bytes hex string (with or without 0x prefix)
 */
function validateHex32Bytes(hex: string): boolean {
  const cleanHex = hex.replace(/^0x/i, '');
  const hexRegex = /^[0-9a-f]{64}$/i;
  return hexRegex.test(cleanHex);
}

/**
 * Calculate required merkle tree depth for given number of leaves
 */
function calculateMerkleDepth(treeSize: number): number {
  if (treeSize <= 1) return 0;
  return Math.ceil(Math.log2(treeSize));
}
