/**
 * Consistency proof verification module for client-side validation
 *
 * This module implements RFC 6962 consistency proof verification to ensure
 * the append-only property of the bulletin board and prevent split-view attacks.
 *
 * Critical requirements from final_design.md:
 * 1. Consistency proof must pass before showing "Verified" status
 * 2. excludedSlots > 0 must always fail closed; missing/invalid refine the explanation
 * 3. Detect and warn about totalExpected vs treeSize mismatches
 */

import type { ConsistencyProofResponse } from '@/lib/types/api/consistency-proof';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import type { VoteReceipt } from '@/types/receipt';
import { normalizeHexString } from '@/lib/utils/hex';
import { verifySthThirdParty, resolveConfiguredSthSources, resolveConfiguredSthMinMatches } from './sth-verifier';
import { RFC6962MerkleTree } from '@/lib/merkle/rfc6962-merkle-tree';
import { getNumberProperty, getStringArrayProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { getSessionAuthHeaders, getSessionData } from '@/lib/session';

/**
 * Result of consistency proof verification
 */
export interface ConsistencyVerificationResult {
  isValid: boolean;
  error?: string;
  details?: {
    type?: 'split-view-attack' | 'api-error' | 'proof-invalid';
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

/**
 * Combined voting integrity validation result
 */
export interface VotingIntegrityResult {
  isValid: boolean;
  consistencyProofValid: boolean;
  completenessValid: boolean;
  canShowVerified: boolean; // Only true if all checks pass
  error?: string;
  warnings?: string[];
  sthVerified?: boolean;
  sthConsensus?: boolean;
  sthSourcesChecked?: number;
  sthErrors?: string[];
}

export interface VotingIntegrityOptions {
  sessionAuthHeaders?: Record<string, string>;
  sthBaseUrl?: string;
}

export interface ConsistencyProofRequestOptions {
  headers?: Record<string, string>;
}

/**
 * Verify consistency proof between two bulletin board states
 *
 * This function:
 * 1. Fetches the consistency proof from the API
 * 2. Verifies the roots match expected values
 * 3. Detects potential split-view attacks
 *
 * @param sessionId - Session identifier for API authentication
 * @param oldSize - Size of the tree at the older state
 * @param newSize - Size of the tree at the newer state
 * @param expectedOldRoot - Expected root at old size (from vote receipt)
 * @param expectedNewRoot - Expected root at new size (from zkVM journal)
 * @returns Verification result with error details if failed
 */
export async function verifyConsistencyProof(
  sessionId: string,
  oldSize: number,
  newSize: number,
  expectedOldRoot: string,
  expectedNewRoot: string,
  options: ConsistencyProofRequestOptions = {},
): Promise<ConsistencyVerificationResult> {
  try {
    const fallbackHeaders =
      typeof window !== 'undefined'
        ? (() => {
            const session = getSessionData();
            return session?.sessionId === sessionId ? getSessionAuthHeaders(session) : { 'X-Session-ID': sessionId };
          })()
        : { 'X-Session-ID': sessionId };
    const headers = {
      ...fallbackHeaders,
      ...(options.headers ?? {}),
    };

    // Fetch consistency proof from API
    const response = await fetch(
      resolveApiUrl(`/api/bulletin/consistency-proof?oldSize=${oldSize}&newSize=${newSize}`),
      {
        headers,
      },
    );

    if (!response.ok) {
      return {
        isValid: false,
        error: `Failed to fetch consistency proof: ${response.status} ${response.statusText}`,
        details: {
          type: 'api-error',
        },
      };
    }

    const proofPayload: unknown = await response.json();
    if (!isConsistencyProofResponse(proofPayload)) {
      return {
        isValid: false,
        error: 'Invalid consistency proof response format',
        details: {
          type: 'api-error',
        },
      };
    }
    const proof = proofPayload;

    // Normalize all roots before comparison to handle 0x prefix inconsistencies
    // Internal operations use prefix-less hex, but zkVM/API may return with 0x prefix
    const normalizedProofOldRoot = normalizeHexString(proof.rootAtOldSize);
    const normalizedProofNewRoot = normalizeHexString(proof.rootAtNewSize);
    const normalizedExpectedOldRoot = normalizeHexString(expectedOldRoot);
    const normalizedExpectedNewRoot = normalizeHexString(expectedNewRoot);

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
          oldRoot: proof.rootAtOldSize,
          newRoot: proof.rootAtNewSize,
          proofNodes: proof.proofNodes,
        },
      };
    }

    const ctTree = new RFC6962MerkleTree();
    const proofIsValid = ctTree.verifyConsistencyProof(normalizedProofOldRoot, normalizedProofNewRoot, {
      oldSize: proof.oldSize,
      newSize: proof.newSize,
      proofNodes: proof.proofNodes,
    });

    if (!proofIsValid) {
      return {
        isValid: false,
        error: 'Consistency proof failed cryptographic verification.',
        details: {
          type: 'proof-invalid',
          oldRoot: proof.rootAtOldSize,
          newRoot: proof.rootAtNewSize,
          proofNodes: proof.proofNodes,
        },
      };
    }

    return {
      isValid: true,
      details: {
        oldRoot: proof.rootAtOldSize,
        newRoot: proof.rootAtNewSize,
        proofNodes: proof.proofNodes,
      },
    };
  } catch (error) {
    return {
      isValid: false,
      error: `Consistency proof verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: {
        type: 'api-error',
      },
    };
  }
}

function isConsistencyProofResponse(value: unknown): value is ConsistencyProofResponse {
  if (!isRecord(value)) {
    return false;
  }
  const oldSize = getNumberProperty(value, 'oldSize');
  const newSize = getNumberProperty(value, 'newSize');
  const rootAtOldSize = getStringProperty(value, 'rootAtOldSize');
  const rootAtNewSize = getStringProperty(value, 'rootAtNewSize');
  const proofNodes = getStringArrayProperty(value, 'proofNodes');
  const timestamp = getNumberProperty(value, 'timestamp');
  if (
    oldSize === undefined ||
    newSize === undefined ||
    !rootAtOldSize ||
    !rootAtNewSize ||
    !proofNodes ||
    timestamp === undefined
  ) {
    return false;
  }

  const oldSubtreeHashes = getStringArrayProperty(value, 'oldSubtreeHashes');
  if (oldSubtreeHashes === undefined && Object.prototype.hasOwnProperty.call(value, 'oldSubtreeHashes')) {
    return false;
  }
  const appendSubtreeHashes = getStringArrayProperty(value, 'appendSubtreeHashes');
  if (appendSubtreeHashes === undefined && Object.prototype.hasOwnProperty.call(value, 'appendSubtreeHashes')) {
    return false;
  }

  return true;
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
    if (diff > 0) {
      // Expected more votes than actually recorded
      result.warning =
        `Expected ${journal.totalExpected} votes but tree only has ${journal.treeSize}. ` +
        `${diff} votes may be missing or were never cast.`;
      result.severity = 'warning';
    } else {
      // More votes recorded than expected (unusual but not necessarily an error)
      result.warning =
        `Tree has ${journal.treeSize} votes but only expected ${journal.totalExpected}. ` +
        `${Math.abs(diff)} extra votes were recorded.`;
      result.severity = 'info';
    }
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

/**
 * Comprehensive voting integrity validation
 *
 * This function combines consistency proof and completeness checks to determine
 * if the voting result can be shown as "Verified" in the UI.
 *
 * According to final_design.md:
 * - MUST NOT show "Verified" unless consistency proof passes
 * - MUST NOT show "Verified" if excludedSlots > 0
 * - MUST show red warning for any verification failure
 *
 * @param sessionId - Session identifier
 * @param receipt - User's vote receipt
 * @param journal - zkVM verification journal
 * @returns Combined integrity validation result
 */
export async function validateVotingIntegrity(
  sessionId: string,
  receipt: VoteReceipt,
  journal: ZkVMJournal,
  options: VotingIntegrityOptions = {},
): Promise<VotingIntegrityResult> {
  const result: VotingIntegrityResult = {
    isValid: true,
    consistencyProofValid: true,
    completenessValid: true,
    canShowVerified: true,
    warnings: [],
  };

  // Step 1: Verify consistency proof (rootAtCast → rootAtFinalize)
  const consistencyResult = await verifyConsistencyProof(
    sessionId,
    receipt.bulletinIndex + 1, // Size when vote was cast
    journal.treeSize, // Current tree size
    receipt.bulletinRootAtCast,
    journal.bulletinRoot,
    { headers: options.sessionAuthHeaders },
  );

  result.consistencyProofValid = consistencyResult.isValid;
  if (!consistencyResult.isValid) {
    result.isValid = false;
    result.canShowVerified = false;
    result.error = `Consistency proof verification failed: ${consistencyResult.error}`;
    return result; // Critical failure, no point continuing
  }

  // Step 2: Check completeness (missingSlots and invalidPresentedSlots must be 0)
  const completenessResult = checkCompleteness(journal);

  result.completenessValid = completenessResult.isComplete;
  if (!completenessResult.isComplete) {
    result.isValid = false;
    result.canShowVerified = false;
    result.error = completenessResult.error;
    return result; // Critical failure
  }

  // Step 3: Collect any warnings
  if (completenessResult.warning) {
    result.warnings = [...(result.warnings ?? []), completenessResult.warning];
  }

  // Step 4: Third-party STH verification
  const sthSources = resolveConfiguredSthSources();
  if (sthSources.length === 0) {
    // When no independent sources are configured, treat third-party STH
    // verification as not enabled instead of a hard failure.
    result.sthSourcesChecked = 0;
  } else {
    const minMatchingSources = resolveConfiguredSthMinMatches();
    const sthVerification = await verifySthThirdParty(journal, {
      sources: sthSources,
      sessionId: sessionId,
      minMatchingSources,
      sameOriginHeaders: options.sessionAuthHeaders,
      sameOriginOrigin: options.sthBaseUrl,
    });

    result.sthVerified = sthVerification.verified;
    result.sthConsensus = sthVerification.consensus;
    result.sthSourcesChecked = sthVerification.sourcesChecked;
    if (sthVerification.errors.length > 0) {
      result.sthErrors = sthVerification.errors;
    }

    if (!sthVerification.verified) {
      result.isValid = false;
      result.canShowVerified = false;
      result.error =
        sthVerification.errors[0] ??
        'Third-party STH verification failed: insufficient consensus across configured sources.';
      if (sthVerification.errors.length > 1) {
        result.warnings = [...(result.warnings ?? []), ...sthVerification.errors.slice(1)];
      }
      return result;
    }
  }

  // Step 5: Additional integrity checks
  // Check if user's vote index is within the processed range
  if (receipt.bulletinIndex >= journal.treeSize) {
    result.isValid = false;
    result.canShowVerified = false;
    result.error = `Vote index ${receipt.bulletinIndex} is beyond tree size ${journal.treeSize}`;
    return result;
  }

  // All checks passed - can show "Verified" status
  return result;
}

/**
 * Helper function to format verification status for UI display
 *
 * @param result - Voting integrity result
 * @returns UI display configuration
 */
export function formatVerificationStatus(result: VotingIntegrityResult): {
  status: 'verified' | 'failed' | 'warning';
  color: 'green' | 'red' | 'yellow';
  message: string;
  icon: '✅' | '❌' | '⚠️';
} {
  if (result.canShowVerified) {
    return {
      status: 'verified',
      color: 'green',
      message: 'Voting integrity verified',
      icon: '✅',
    };
  }

  if (!result.isValid) {
    return {
      status: 'failed',
      color: 'red',
      message: result.error || 'Verification failed',
      icon: '❌',
    };
  }

  // Has warnings but not critical failures
  return {
    status: 'warning',
    color: 'yellow',
    message: result.warnings?.join(' ') || 'Verification completed with warnings',
    icon: '⚠️',
  };
}
