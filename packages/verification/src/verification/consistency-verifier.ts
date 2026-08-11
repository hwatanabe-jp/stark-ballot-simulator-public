/**
 * Consistency proof verification module for client-side validation
 *
 * This module implements RFC 6962 consistency proof verification to ensure
 * the append-only property of the bulletin board and prevent split-view attacks.
 *
 * Critical requirements from final-design.md:
 * 1. Consistency proof must pass before showing "Verified" status
 * 2. excludedSlots > 0 must always fail closed; missing/invalid refine the explanation
 * 3. totalExpected vs treeSize mismatches must fail closed
 */

import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import { normalizeHexString } from '@stark-ballot/crypto-primitives';
import type { AdmittedConsistencyProof } from './consistency-proof-types';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';

/**
 * Result of consistency proof verification
 */
export interface ConsistencyVerificationResult {
  isValid: boolean;
  error?: string;
  details?: {
    type?: 'split-view-attack' | 'proof-invalid';
    oldRoot?: string;
    newRoot?: string;
    proofNodes?: string[];
  };
}

/**
 * Result of completeness check
 */
export interface CompletenessResult {
  isComplete: boolean;
  error?: string;
  warning?: string;
  severity?: 'critical' | 'warning' | 'info';
  details?: {
    missingSlots?: number;
    invalidPresentedSlots?: number;
    validVotes?: number;
    totalExpected?: number;
    treeSize?: number;
    excludedSlots?: number;
  };
}

export interface ConsistencyProofExpectation {
  fromTreeSize: number;
  toTreeSize: number;
  rootAtFromTreeSize: string;
  rootAtToTreeSize: string;
}

/**
 * Verify consistency proof between two bulletin board states
 *
 * This function:
 * 1. Consumes consistency proof materials admitted by the runtime boundary
 * 2. Verifies the roots match expected values
 * 3. Detects potential split-view attacks
 *
 * @param proof - Strictly admitted consistency proof materials
 * @param expectation - Receipt/journal-authenticated tree sizes and roots
 * @returns Verification result with error details if failed
 */
export function verifyConsistencyProof(
  proof: AdmittedConsistencyProof,
  expectation: ConsistencyProofExpectation,
): ConsistencyVerificationResult {
  try {
    if (proof.fromTreeSize !== expectation.fromTreeSize || proof.toTreeSize !== expectation.toTreeSize) {
      return {
        isValid: false,
        error:
          `Consistency proof tree-size range mismatch. ` +
          `Expected ${expectation.fromTreeSize} → ${expectation.toTreeSize}, ` +
          `got ${proof.fromTreeSize} → ${proof.toTreeSize}.`,
        details: {
          type: 'proof-invalid',
          oldRoot: proof.rootAtFromTreeSize,
          newRoot: proof.rootAtToTreeSize,
          proofNodes: proof.proofNodes,
        },
      };
    }

    // Normalize all roots before comparison to handle 0x prefix inconsistencies
    // Internal operations use prefix-less hex, but zkVM/API may return with 0x prefix
    const normalizedProofOldRoot = normalizeHexString(proof.rootAtFromTreeSize);
    const normalizedProofNewRoot = normalizeHexString(proof.rootAtToTreeSize);
    const normalizedExpectedOldRoot = normalizeHexString(expectation.rootAtFromTreeSize);
    const normalizedExpectedNewRoot = normalizeHexString(expectation.rootAtToTreeSize);

    // Verify roots match expected values (after normalization)
    const oldRootMatch = normalizedProofOldRoot === normalizedExpectedOldRoot;
    const newRootMatch = normalizedProofNewRoot === normalizedExpectedNewRoot;

    if (!oldRootMatch || !newRootMatch) {
      // Root mismatch indicates potential split-view attack
      return {
        isValid: false,
        error:
          `Root mismatch detected - potential split-view attack. ` +
          `Old root: expected ${normalizedExpectedOldRoot}, got ${normalizedProofOldRoot}. ` +
          `New root: expected ${normalizedExpectedNewRoot}, got ${normalizedProofNewRoot}.`,
        details: {
          type: 'split-view-attack',
          oldRoot: proof.rootAtFromTreeSize,
          newRoot: proof.rootAtToTreeSize,
          proofNodes: proof.proofNodes,
        },
      };
    }

    const ctTree = new RFC6962MerkleTree();
    const normalizedProofNodes = proof.proofNodes.map((node) => normalizeHexString(node));
    const proofIsValid = ctTree.verifyConsistencyProof(normalizedProofOldRoot, normalizedProofNewRoot, {
      oldSize: proof.fromTreeSize,
      newSize: proof.toTreeSize,
      proofNodes: normalizedProofNodes,
    });

    if (!proofIsValid) {
      return {
        isValid: false,
        error: 'Consistency proof failed cryptographic verification.',
        details: {
          type: 'proof-invalid',
          oldRoot: proof.rootAtFromTreeSize,
          newRoot: proof.rootAtToTreeSize,
          proofNodes: proof.proofNodes,
        },
      };
    }

    return {
      isValid: true,
      details: {
        oldRoot: proof.rootAtFromTreeSize,
        newRoot: proof.rootAtToTreeSize,
        proofNodes: proof.proofNodes,
      },
    };
  } catch (error) {
    return {
      isValid: false,
      error: `Consistency proof verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: {
        type: 'proof-invalid',
      },
    };
  }
}

/**
 * Check the completeness of the voting tally
 *
 * According to the current journal contract:
 * - `excludedSlots > 0` MUST be treated as a fail-closed verification failure
 * - `missingSlots` explains unpresented bulletin slots
 * - `invalidPresentedSlots` explains presented slot failures
 * - UI must show "Verification Failed" or "Incomplete Tally" in red
 * - This prevents "subset-only counted receipts" from appearing valid
 *
 * @param journal - zkVM journal containing voting statistics
 * @returns Completeness check result
 */
export function checkCompleteness(journal: ZkVMJournal): CompletenessResult {
  const missingSlots = journal.missingSlots;
  const invalidPresentedSlots = journal.invalidPresentedSlots;
  const validVotes = journal.validVotes;
  const excludedSlots = journal.excludedSlots;
  const rejectedRecords = journal.rejectedRecords;
  const result: CompletenessResult = {
    isComplete: true,
    details: {
      missingSlots,
      invalidPresentedSlots,
      validVotes,
      totalExpected: journal.totalExpected,
      treeSize: journal.treeSize,
      excludedSlots,
    },
  };

  const invalidFields: string[] = [];
  if (!isValidCount(excludedSlots)) {
    invalidFields.push('excludedSlots');
  }
  if (!isValidCount(missingSlots)) {
    invalidFields.push('missingSlots');
  }
  if (!isValidCount(invalidPresentedSlots)) {
    invalidFields.push('invalidPresentedSlots');
  }
  if (!isValidCount(journal.totalExpected)) {
    invalidFields.push('totalExpected');
  }
  if (!isValidCount(journal.treeSize)) {
    invalidFields.push('treeSize');
  }
  if (invalidFields.length > 0) {
    result.isComplete = false;
    result.error = `Invalid zkVM journal: ${invalidFields.join(', ')} is missing or invalid.`;
    result.severity = 'critical';
    return result;
  }

  if (excludedSlots > 0) {
    result.isComplete = false;
    const parts: string[] = [];
    if (missingSlots > 0) {
      parts.push(`${missingSlots} unpresented slots`);
    }
    if (invalidPresentedSlots > 0) {
      parts.push(`${invalidPresentedSlots} presented slots failed counting`);
    }
    const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
    result.error =
      `Conservative exclusion signal detected: excludedSlots=${excludedSlots}${detail}. ` +
      `This is a critical failure - the tally cannot be considered complete.`;
    result.severity = 'critical';
    return result;
  }

  // Check for totalExpected vs treeSize mismatch (silent exclusion detection)
  if (journal.totalExpected !== journal.treeSize) {
    const diff = journal.totalExpected - journal.treeSize;
    result.isComplete = false;
    result.severity = 'critical';
    result.error =
      diff > 0
        ? // Expected more votes than actually recorded.
          `Expected ${journal.totalExpected} votes but tree only has ${journal.treeSize}. ` +
          `${diff} votes may be missing or were never cast.`
        : // More votes recorded than expected.
          `Tree has ${journal.treeSize} votes but only expected ${journal.totalExpected}. ` +
          `${Math.abs(diff)} extra votes were recorded.`;
    return result;
  }

  // Check for rejected records that do not necessarily add slot-based exclusions
  if (rejectedRecords > 0) {
    const message = `${rejectedRecords} presented records failed verification.`;
    if (result.warning) {
      result.warning += ` Additionally, ${message}`;
    } else {
      result.warning = message;
    }
    result.severity = result.severity || 'warning';
  }

  return result;
}

function isValidCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
