/**
 * Mock zkVM executor for fast testing
 * Implements final-design.md v1.0 specifications
 */

import { Buffer } from 'buffer';
import type { VerifiedTally, VoteWithProof, ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  CURRENT_METHOD_VERSION,
  asUnixTimestampMillis,
  computeCommitment,
  computeInputCommitment,
  computeSTHDigest,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import { logger } from './logger';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { resolveMockImageId } from './mock-image-id';
import { assertZkvmWireNumericPreflight } from '@stark-ballot/zkvm-contract/zkvm/wire-numeric-preflight';
import { validateGuestWorkBudget } from '@stark-ballot/zkvm-contract/zkvm/work-budget';

// Constants following final-design.md specifications
const MOCK_EXECUTION_TIME_MS = 100;
const MAX_CHOICE_VALUE = 4; // Choices are 0-4 (A-E)
const METHOD_VERSION = CURRENT_METHOD_VERSION; // v1.1

// Vote validation result
interface VoteValidation {
  isValid: boolean;
  reason?: string;
}

// Store the last executed bitmap for retrieval
let lastExecutedBitmap: boolean[] | null = null;

/**
 * Get the included bitmap from the last execution
 * This is only available in mock mode for testing
 * In production, the bitmap would be internal to the zkVM
 */
export function getLastExecutedBitmap(): boolean[] | null {
  return lastExecutedBitmap;
}

/**
 * Mock zkVM executor that simulates proof generation
 * Following final-design.md §2.4 Counted-as-Recorded verification
 * ~100ms execution time vs ~125s for real zkVM production mode
 */
export async function executeMockZkVM(input: ZkVMInput): Promise<ZkVMExecutionResult> {
  logger.debug('[MockZkVM] Starting mock execution');
  assertZkvmWireNumericPreflight(input);
  validateGuestWorkBudget(input);

  // Simulate processing time
  await simulateProcessingDelay();

  // Process all votes and collect statistics
  const verificationResult = verifyAndTallyVotes(input);

  // Calculate three-way split statistics (final-design.md §2.4 line 295-300)
  const statistics = calculateStatistics(
    verificationResult.seenIndicesCount,
    input.treeSize,
    verificationResult.invalidCount,
    verificationResult.validCount,
  );

  // Generate cryptographic commitments
  const includedBitmapRoot = computeIncludedBitmapRoot(verificationResult.includedBitmap);
  const seenBitmapRoot = computeIncludedBitmapRoot(verificationResult.seenBitmap);

  // Store the bitmap for retrieval (mock mode only)
  lastExecutedBitmap = verificationResult.includedBitmap;

  const sthDigest = computeSTHDigest(
    input.logId,
    input.treeSize,
    asUnixTimestampMillis(input.timestamp),
    input.bulletinRoot,
  );
  let inputCommitmentValue: string;
  try {
    inputCommitmentValue = computeInputCommitment(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('[MockZkVM] Failed to compute input commitment:', message);
    inputCommitmentValue = '0x' + '0'.repeat(64);
  }

  logger.debug('[MockZkVM] Mock execution completed');
  logger.debug(`[MockZkVM] Verified tally: [${verificationResult.verifiedTally.join(', ')}]`);
  logger.debug(
    `[MockZkVM] Valid: ${verificationResult.validCount}, Invalid: ${verificationResult.invalidCount}, Missing: ${statistics.missingSlots}`,
  );

  const imageId = await resolveMockImageId();

  // Create a mock receipt structure for verification compatibility
  const mockReceipt = {
    imageId,
    payload: {
      // Current receipt format used by verification flows
      seal: Buffer.from('mock-seal-data').toString('base64'),
      journal: Buffer.from(
        JSON.stringify({
          electionId: input.electionId,
          sthDigest,
          verifiedTally: verificationResult.verifiedTally,
          includedBitmapRoot,
        }),
      ).toString('base64'),
    },
    raw: {
      // Keep raw format for debugging
      seal: 'mock-seal-data',
      journal: {
        electionId: input.electionId,
        sthDigest,
        verifiedTally: verificationResult.verifiedTally,
        seenBitmapRoot,
        includedBitmapRoot,
      },
    },
  };

  // Return ZkVMJournal structure (final-design.md §1.3)
  const result: ZkVMExecutionResult = {
    // Election scope identification
    electionId: input.electionId,
    electionConfigHash: input.electionConfigHash,

    // Bulletin board root (echo from input)
    bulletinRoot: input.bulletinRoot,
    treeSize: input.treeSize,
    totalExpected: input.totalExpected,

    // STH binding
    sthDigest,

    // Verified aggregation results
    verifiedTally: verificationResult.verifiedTally,

    // Verification statistics
    totalVotes: input.votes.length,
    validVotes: verificationResult.validCount,
    invalidVotes: verificationResult.invalidCount,
    seenIndicesCount: verificationResult.seenIndicesCount,

    // Three-way split of exclusions
    ...statistics,

    // ImageID is comparison metadata for the active zkVM method.
    // Note: ImageID is the cryptographic hash of the zkVM ELF binary (with 0x prefix)
    // This field is used for zkVM binary integrity verification, not Merkle tree operations
    // Use the environment override or fall back to the default expected ImageID
    imageId,

    // Individual vote verification
    seenBitmapRoot,
    includedBitmapRoot,
    seenBitmap: verificationResult.seenBitmap,
    includedBitmap: verificationResult.includedBitmap,

    // Input binding
    inputCommitment: inputCommitmentValue,
    methodVersion: METHOD_VERSION,
    receipt: mockReceipt,
  };

  return result;
}

/**
 * Verify and tally all votes
 * Implements final-design.md §2.4 verification logic
 *
 * Current slot/record semantics:
 * - missingSlots: bulletin slots never seen as a unique in-range record
 * - invalidPresentedSlots: seen in-range slots that were not counted
 * - rejectedRecords: rejected records, including duplicate/out-of-range records
 */
function verifyAndTallyVotes(input: ZkVMInput) {
  const verifiedTally: VerifiedTally = [0, 0, 0, 0, 0];
  const includedBitmap = Array.from({ length: input.treeSize }, () => false);
  const seenBitmap = Array.from({ length: input.treeSize }, () => false);
  const seenIndices = new Set<number>();
  const seenCommitments = new Set<string>();
  let validCount = 0;
  let invalidCount = 0; // Counts rejected records, including duplicate/out-of-range indices

  // Process each vote (final-design.md §2.4 line 226-288)
  for (const vote of input.votes) {
    // Out-of-range records are rejected and counted as invalid, but they do
    // not contribute to seenIndicesCount because no in-range slot was seen.
    if (vote.index >= input.treeSize) {
      invalidCount++;
      continue;
    }

    // Check if this is a duplicate index
    const isDuplicateIndex = seenIndices.has(vote.index);

    // Duplicate records are rejected and counted as invalid. Only the first
    // in-range occurrence contributes to seenIndicesCount.
    if (isDuplicateIndex) {
      invalidCount++;
      continue;
    }

    // Track the index (it's within range and not duplicate)
    seenIndices.add(vote.index);
    seenBitmap[vote.index] = true;

    // Index-level duplicates are rejected here so seenIndicesCount stays tied
    // to unique in-range slots. validateVote handles per-record validation,
    // including duplicate commitments.
    const validation = validateVote(vote, input, seenCommitments);

    if (validation.isValid) {
      // Count valid vote
      verifiedTally[vote.choice] = (verifiedTally[vote.choice] ?? 0) + 1;
      includedBitmap[vote.index] = true;
      validCount++;
      seenCommitments.add(computeCommitment(input.electionId, vote.choice, vote.random));
    } else {
      // This vote was presented to VM but failed validation
      invalidCount++;
    }
  }

  return {
    verifiedTally,
    seenBitmap,
    includedBitmap,
    seenIndicesCount: seenIndices.size,
    validCount,
    invalidCount,
  };
}

/**
 * Validate a single vote
 * Note: This is only called for unique in-range indices.
 */
function validateVote(vote: VoteWithProof, input: ZkVMInput, seenCommitments: Set<string>): VoteValidation {
  // Step 2: Choice boundary check (MUST requirement)
  if (vote.choice > MAX_CHOICE_VALUE) {
    return { isValid: false, reason: 'Invalid choice value' };
  }

  // Step 3: Commitment verification with domain separation (v1.0)
  const computedCommitment = computeCommitment(input.electionId, vote.choice, vote.random);

  if (computedCommitment !== vote.commitment) {
    return { isValid: false, reason: 'Invalid commitment' };
  }

  // Step 3.5: Duplicate commitment check (v1.0)
  if (seenCommitments.has(computedCommitment)) {
    return { isValid: false, reason: 'Duplicate commitment' };
  }

  // Step 4: Merkle inclusion proof verification is intentionally omitted in mock mode.
  // Real zkVM paths verify the RFC 6962 audit path inside the Rust contract.

  return { isValid: true };
}

/**
 * Calculate three-way split statistics
 */
function calculateStatistics(seenIndicesCount: number, treeSize: number, invalidCount: number, validCount: number) {
  const missingSlots = treeSize - seenIndicesCount;
  const invalidPresentedSlots = Math.max(0, seenIndicesCount - validCount);
  const rejectedRecords = invalidCount;
  const excludedSlots = missingSlots + invalidPresentedSlots;

  return {
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords,
    excludedSlots,
  };
}

/**
 * Simulate processing delay for mock execution
 */
async function simulateProcessingDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, MOCK_EXECUTION_TIME_MS));
}
