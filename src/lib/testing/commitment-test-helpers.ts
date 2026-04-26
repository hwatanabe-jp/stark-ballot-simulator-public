/**
 * Test helpers for domain-separated commitment generation (v1.0)
 * Provides consistent commitment generation across all test suites
 */

import crypto from 'crypto';
import { computeCommitment } from '@/lib/zkvm/types';

/**
 * Default test election ID (UUID v4)
 * This constant should be used across all tests for consistency
 */
export const DEFAULT_TEST_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Generate a unique random value for testing
 * Each call returns a different 32-byte hex string
 *
 * @returns Hex string with 0x prefix (66 chars total)
 */
export function generateTestRandom(): string {
  return '0x' + crypto.randomBytes(32).toString('hex');
}

/**
 * Create a test commitment using v1.0 domain-separated format
 * SHA256("stark-ballot:commit|v1.0" || electionId || choice || random)
 *
 * @param choice - Vote choice (0-4 for A-E)
 * @param random - Optional random value (generates unique if not provided)
 * @param electionId - Optional election ID (uses default if not provided)
 * @returns Object with commitment and random value
 */
export function createTestCommitment(
  choice: number,
  random?: string,
  electionId: string = DEFAULT_TEST_ELECTION_ID,
): { commitment: string; random: string } {
  if (choice < 0 || choice > 4) {
    throw new Error('Invalid choice: must be 0-4');
  }

  const randomValue = random ?? generateTestRandom();
  const commitment = computeCommitment(electionId, choice, randomValue);

  return { commitment, random: randomValue };
}
