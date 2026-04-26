/**
 * Three-stage verification for E2E verifiable voting
 */

import type { VoteReceipt } from '@/types/receipt';
import type { BulletinBoard } from '@/types/bulletin';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import { validateVotingIntegrity, formatVerificationStatus } from './consistency-verifier';
import {
  evaluateCastStageStrict,
  evaluateCountedStageStrict,
  evaluateRecordedStageStrict,
  type CastIntentData,
} from '@/lib/verification/engine/stage-evaluators';

/**
 * Result of a verification stage
 */
export interface VerificationResult {
  /** Whether the verification passed */
  passed: boolean;
  /** Name of the verification stage */
  stage: 'Cast-as-Intended' | 'Recorded-as-Cast' | 'Counted-as-Recorded';
  /** Optional error message if failed */
  error?: string;
  /** Optional details */
  details?: Record<string, unknown>;
}

/**
 * Verify Cast-as-Intended
 * Ensures the vote was cast as the voter intended
 */
export function verifyCastAsIntended(receipt: VoteReceipt, intent?: CastIntentData): Promise<VerificationResult> {
  const result = evaluateCastStageStrict(receipt, intent);
  return Promise.resolve({
    passed: result.status === 'success',
    stage: 'Cast-as-Intended',
    ...(result.error ? { error: result.error } : {}),
    ...(result.details ? { details: result.details } : {}),
  });
}

/**
 * Verify Recorded-as-Cast
 * Ensures the vote was recorded correctly in the bulletin board
 *
 * Enhanced with consistency proof verification to prevent split-view attacks
 */
export function verifyRecordedAsCast(
  receipt: VoteReceipt,
  bulletin: BulletinBoard,
  sessionId?: string, // Optional: required for consistency proof verification
): Promise<VerificationResult> {
  const result = evaluateRecordedStageStrict(receipt, bulletin, sessionId);
  return Promise.resolve({
    passed: result.status === 'success',
    stage: 'Recorded-as-Cast',
    ...(result.error ? { error: result.error } : {}),
    ...(result.details ? { details: result.details } : {}),
  });
}

/**
 * Verify Counted-as-Recorded
 * Ensures the vote was counted correctly by the zkVM
 *
 * Enhanced with completeness checks per final_design.md requirements:
 * - excludedSlots > 0 MUST fail verification
 * - missingSlots / invalidPresentedSlots explain the slot-based exclusion signal
 * - totalExpected vs treeSize mismatches are warned
 */
export function verifyCountedAsRecorded(
  zkResult: ZkVMJournal & { inputBulletinRoot?: string },
): Promise<VerificationResult> {
  const result = evaluateCountedStageStrict(zkResult);
  return Promise.resolve({
    passed: result.status === 'success',
    stage: 'Counted-as-Recorded',
    ...(result.error ? { error: result.error } : {}),
    ...(result.details ? { details: result.details } : {}),
  });
}

/**
 * Comprehensive three-stage verification with consistency proof
 *
 * This function performs all three verification stages and includes
 * consistency proof verification to prevent split-view attacks.
 *
 * @param sessionId - Session identifier for API calls
 * @param receipt - User's vote receipt
 * @param bulletin - Current bulletin board state
 * @param zkResult - zkVM verification result
 * @returns Combined verification results
 */
export async function performFullVerification(
  sessionId: string,
  receipt: VoteReceipt,
  bulletin: BulletinBoard,
  zkResult: ZkVMJournal,
  intent?: CastIntentData,
): Promise<{
  allPassed: boolean;
  canShowVerified: boolean;
  stages: VerificationResult[];
  integrityResult?: Awaited<ReturnType<typeof validateVotingIntegrity>>;
  displayStatus: ReturnType<typeof formatVerificationStatus>;
}> {
  const stages: VerificationResult[] = [];

  // Stage 1: Cast-as-Intended
  const castResult = await verifyCastAsIntended(receipt, intent);
  stages.push(castResult);

  // Stage 2: Recorded-as-Cast
  const recordedResult = await verifyRecordedAsCast(receipt, bulletin, sessionId);
  stages.push(recordedResult);

  // Stage 3: Counted-as-Recorded
  const countedResult = await verifyCountedAsRecorded(zkResult);
  stages.push(countedResult);

  // Comprehensive integrity validation with consistency proof
  const integrityResult = await validateVotingIntegrity(sessionId, receipt, zkResult);

  // Determine overall status
  const allPassed = stages.every((s) => s.passed) && integrityResult.isValid;
  const canShowVerified = integrityResult.canShowVerified;

  // Format for UI display
  const displayStatus = formatVerificationStatus(integrityResult);

  return {
    allPassed,
    canShowVerified,
    stages,
    integrityResult,
    displayStatus,
  };
}
