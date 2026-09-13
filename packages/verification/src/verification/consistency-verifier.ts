/**
 * Consistency proof verification module for client-side validation
 *
 * This module implements RFC 6962 consistency proof verification to ensure
 * the append-only property of the bulletin board and prevent split-view attacks.
 *
 * Consistency proof must pass before showing "Verified" status.
 */

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
