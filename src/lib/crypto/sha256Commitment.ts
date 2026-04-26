import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hexToBytesStrict } from '@/lib/crypto/sha256';
import { computeCommitment } from '@/lib/zkvm/types';

/**
 * Create a commitment using SHA256 (compatible with zkVM implementation)
 * @param electionId - UUID v4 identifying the election
 * @param choice - Vote choice (0-4 for A-E)
 * @param random - Random 32-byte value
 * @returns Hex string of the commitment
 */
export function createSHA256Commitment(electionId: string, choice: number, random: Uint8Array): string {
  if (choice < 0 || choice > 4) {
    throw new Error('Invalid choice: must be 0-4');
  }
  if (random.length !== 32) {
    throw new Error('Random must be 32 bytes');
  }

  const randomValue = `0x${bytesToHex(random)}`;
  return computeCommitment(electionId, choice, randomValue);
}

/**
 * Verify a SHA256 commitment
 * @param commitment - Hex string of the commitment
 * @param choice - Vote choice (0-4 for A-E)
 * @param random - Random 32-byte value
 * @returns True if the commitment is valid
 */
export function verifySHA256Commitment(
  electionId: string,
  commitment: string,
  choice: number,
  random: Uint8Array,
): boolean {
  try {
    const expected = createSHA256Commitment(electionId, choice, random);
    return expected.toLowerCase() === commitment.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Create SHA256 hash for Merkle tree nodes
 * @param left - Left child hash (hex string)
 * @param right - Right child hash (hex string)
 * @returns Combined hash (hex string)
 */
export function sha256MerkleNode(left: string, right: string): string {
  const hash = sha256.create();
  hash.update(hexToBytesStrict(left));
  hash.update(hexToBytesStrict(right));
  return bytesToHex(hash.digest());
}

/**
 * Convert vote choice letter to number
 * @param choice - Vote choice ('A'-'E')
 * @returns Number (0-4)
 */
export function choiceToNumber(choice: string): number {
  if (choice.length !== 1 || choice < 'A' || choice > 'E') {
    throw new Error('Invalid choice: must be A-E');
  }
  return choice.charCodeAt(0) - 'A'.charCodeAt(0);
}

/**
 * Convert number to vote choice letter
 * @param num - Number (0-4)
 * @returns Vote choice ('A'-'E')
 */
export function numberToChoice(num: number): string {
  if (num < 0 || num > 4) {
    throw new Error('Invalid number: must be 0-4');
  }
  return String.fromCharCode('A'.charCodeAt(0) + num);
}
