import { TS_SAFE_UINT64_MAX, UINT32_MAX, UINT8_MAX, type VoteWithProof, type ZkVMInput } from './types';

function assertRustWireNumber(value: number, fieldName: string, max: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} must be finite`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${fieldName} must be a JavaScript safe integer`);
  }
  if (value < 0) {
    throw new Error(`${fieldName} must be non-negative`);
  }
  if (value > max) {
    throw new Error(`${fieldName} exceeds Rust wire maximum ${max}`);
  }
}

function assertVoteWireNumbers(vote: VoteWithProof, votePosition: number): void {
  assertRustWireNumber(vote.choice, `votes[${votePosition}].choice`, UINT8_MAX);
  assertRustWireNumber(vote.index, `votes[${votePosition}].index`, UINT32_MAX);
}

/**
 * Validate only numeric values that must fit the Rust JSON wire schema.
 *
 * This deliberately does not reject guest-level record outcomes such as
 * choices outside the ballot range, duplicate indices, commitment mismatches,
 * or indices outside treeSize when they still fit the Rust wire type.
 */
export function assertZkvmWireNumericPreflight(input: ZkVMInput): void {
  assertRustWireNumber(input.treeSize, 'treeSize', UINT32_MAX);
  assertRustWireNumber(input.totalExpected, 'totalExpected', UINT32_MAX);
  assertRustWireNumber(input.timestamp, 'timestamp', TS_SAFE_UINT64_MAX);
  if (input.timestamp === 0) {
    throw new Error('timestamp must be positive Unix timestamp milliseconds');
  }

  input.votes.forEach(assertVoteWireNumbers);
}
