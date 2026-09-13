/**
 * Vote ID Generation and Validation
 *
 * Implements UUID v4 generation for unique vote tracking.
 * Provides cryptographically secure vote identifiers that are:
 * - Unpredictable: Cannot guess other vote IDs
 * - Unique: Extremely low collision probability
 * - Verifiable: Can validate their format
 */

import { randomUUID } from 'crypto';

export { isValidVoteId } from '@stark-ballot/domain/vote/voteIdValidation';

/**
 * Generate a new UUID v4 vote identifier
 *
 * Uses crypto.randomUUID() which provides:
 * - Cryptographically secure randomness
 * - Standards-compliant UUID v4 format
 *
 * @returns A new UUID v4 string
 */
export function generateVoteId(): string {
  try {
    return randomUUID();
  } catch (error) {
    // This should rarely happen in modern Node.js environments
    throw new Error(`Failed to generate vote ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
