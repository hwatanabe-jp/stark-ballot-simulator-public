import type { VerificationStepStatus } from '@/lib/knowledge';
import type { VoteReceipt } from '@/types/receipt';
import type { BulletinBoard } from '@/types/bulletin';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import { computeCommitment } from '@/lib/zkvm/types';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@/lib/utils/hex';
import { VOTE_CHOICES } from '@/shared/constants';
import type { VoteChoice } from '@/shared/constants';

export interface StageResult {
  status: VerificationStepStatus;
  error?: string;
  details?: Record<string, unknown>;
}

export interface CastIntentData {
  electionId: string;
  choice: VoteChoice;
  random: string;
}

export function evaluateCastStageStrict(receipt: VoteReceipt, intent?: CastIntentData): StageResult {
  try {
    if (!receipt.commitment || !receipt.voteId) {
      return {
        status: 'failed',
        error: 'Invalid receipt: missing commitment or voteId',
      };
    }

    if (!intent) {
      return {
        status: 'failed',
        error: 'Missing local vote data needed to reconstruct commitment.',
      };
    }

    const { electionId, choice, random } = intent;

    if (!electionId) {
      return {
        status: 'failed',
        error: 'Election ID is required to verify the commitment.',
      };
    }

    const normalizedCommitment = normalizeHexString(receipt.commitment);
    if (!normalizedCommitment) {
      return {
        status: 'failed',
        error: 'Receipt commitment is malformed.',
      };
    }

    if (!isValidHexString(random, 32)) {
      return {
        status: 'failed',
        error: 'Random value must be a 32-byte hex string.',
      };
    }

    const choiceIndex = VOTE_CHOICES.indexOf(choice);
    if (choiceIndex === -1) {
      return {
        status: 'failed',
        error: `Unknown vote choice "${choice}".`,
      };
    }

    let recomputed: string;
    try {
      recomputed = computeCommitment(electionId, choiceIndex, random);
    } catch (error) {
      return {
        status: 'failed',
        error:
          error instanceof Error
            ? `Failed to recompute commitment: ${error.message}`
            : 'Failed to recompute commitment due to invalid input.',
      };
    }

    const normalizedRecomputed = normalizeHexString(recomputed);

    if (normalizedCommitment !== normalizedRecomputed) {
      return {
        status: 'failed',
        error: 'Commitment mismatch between receipt and recomputed value.',
      };
    }

    return {
      status: 'success',
      details: {
        voteId: receipt.voteId,
        choice,
        electionId,
        commitment: addHexPrefix(normalizedCommitment),
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export function evaluateRecordedStageStrict(
  receipt: VoteReceipt,
  bulletin: BulletinBoard,
  sessionId?: string,
): StageResult {
  try {
    const normalizedReceiptCommitment = normalizeHexString(receipt.commitment);
    if (!normalizedReceiptCommitment) {
      return {
        status: 'failed',
        error: 'Receipt commitment is malformed.',
      };
    }

    const normalizedCommitments = bulletin.commitments.map((commitment) => normalizeHexString(commitment));
    if (!normalizedCommitments.includes(normalizedReceiptCommitment)) {
      return {
        status: 'failed',
        error: 'Vote commitment not found in bulletin',
      };
    }

    const normalizedReceiptRoot = normalizeHexString(receipt.bulletinRootAtCast);
    const normalizedCurrentRoot = normalizeHexString(bulletin.bulletinRoot);

    if (normalizedReceiptRoot !== normalizedCurrentRoot) {
      if (bulletin.rootHistory.length > 0) {
        const rootInHistory = bulletin.rootHistory.some(
          (snapshot) => normalizeHexString(snapshot.bulletinRoot) === normalizedReceiptRoot,
        );
        if (!rootInHistory) {
          return {
            status: 'failed',
            error: 'Root mismatch: bulletin may have been modified',
          };
        }
      } else {
        return {
          status: 'failed',
          error: 'Root mismatch: expected ' + receipt.bulletinRootAtCast,
        };
      }
    }

    if (
      !Number.isInteger(receipt.bulletinIndex) ||
      receipt.bulletinIndex < 0 ||
      receipt.bulletinIndex >= bulletin.commitments.length
    ) {
      return {
        status: 'failed',
        error: 'Invalid bulletin index',
      };
    }

    const indexedCommitment = bulletin.commitments[receipt.bulletinIndex];
    const normalizedIndexedCommitment = normalizeHexString(indexedCommitment);
    if (normalizedIndexedCommitment !== normalizedReceiptCommitment) {
      return {
        status: 'failed',
        error: 'Bulletin commitment at receipt index does not match receipt commitment',
      };
    }

    const details: Record<string, unknown> = {
      bulletinIndex: receipt.bulletinIndex,
      bulletinSize: bulletin.commitments.length,
      rootAtCast: receipt.bulletinRootAtCast,
      currentRoot: bulletin.bulletinRoot,
    };

    if (sessionId) {
      details.consistencyProofAvailable = true;
    }

    return {
      status: 'success',
      details,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export function evaluateCountedStageStrict(zkResult: ZkVMJournal & { inputBulletinRoot?: string }): StageResult {
  try {
    if (zkResult.totalVotes === 0) {
      return {
        status: 'failed',
        error: 'No votes processed by zkVM',
      };
    }

    const missingSlots = zkResult.missingSlots;
    const invalidPresentedSlots = zkResult.invalidPresentedSlots;
    const rejectedRecords = zkResult.rejectedRecords;
    const excludedSlots = zkResult.excludedSlots;
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
    if (!isValidCount(zkResult.totalExpected)) {
      invalidFields.push('totalExpected');
    }
    if (!isValidCount(zkResult.treeSize)) {
      invalidFields.push('treeSize');
    }
    if (!isValidCount(zkResult.validVotes)) {
      invalidFields.push('validVotes');
    }
    if (invalidFields.length > 0) {
      return {
        status: 'failed',
        error: `Invalid zkVM journal: ${invalidFields.join(', ')} is missing or invalid.`,
        details: {
          missingSlots,
          invalidPresentedSlots,
          validVotes: zkResult.validVotes,
          excludedSlots,
          rejectedRecords,
          severity: 'critical',
        },
      };
    }

    if (excludedSlots > 0) {
      const parts: string[] = [];
      if (missingSlots > 0) {
        parts.push(`${missingSlots} unpresented indices`);
      }
      if (invalidPresentedSlots > 0) {
        parts.push(`${invalidPresentedSlots} presented slots failed counting`);
      }
      const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
      return {
        status: 'failed',
        error:
          `Conservative exclusion signal detected: excludedSlots=${excludedSlots}${detail}. ` +
          `This is a critical failure - the tally cannot be considered complete.`,
        details: {
          missingSlots,
          invalidPresentedSlots,
          validVotes: zkResult.validVotes,
          excludedSlots,
          rejectedRecords,
          severity: 'critical',
        },
      };
    }

    if (zkResult.bulletinRoot && zkResult.inputBulletinRoot) {
      const normalizedBulletinRoot = normalizeHexString(zkResult.bulletinRoot);
      const normalizedInputRoot = normalizeHexString(zkResult.inputBulletinRoot);

      if (normalizedBulletinRoot !== normalizedInputRoot) {
        return {
          status: 'failed',
          error: 'Bulletin root mismatch in zkVM processing',
        };
      }
    }

    const tallySum = zkResult.verifiedTally.reduce((a: number, b: number) => a + b, 0);
    if (tallySum !== zkResult.validVotes) {
      return {
        status: 'failed',
        error: `Tally sum (${tallySum}) does not match valid votes (${zkResult.validVotes})`,
      };
    }

    const details: Record<string, unknown> = {
      totalVotes: zkResult.totalVotes,
      validVotes: zkResult.validVotes,
      invalidVotes: zkResult.invalidVotes,
      verifiedTally: zkResult.verifiedTally,
      missingSlots,
      invalidPresentedSlots,
      excludedSlots,
      rejectedRecords,
    };

    if (zkResult.totalExpected !== zkResult.treeSize) {
      const diff = zkResult.totalExpected - zkResult.treeSize;
      return {
        status: 'failed',
        error:
          `Expected ${zkResult.totalExpected} votes but tree has ${zkResult.treeSize}. ` +
          `${Math.abs(diff)} votes ${diff > 0 ? 'may be missing' : 'were extra'}.`,
        details: {
          ...details,
          totalExpected: zkResult.totalExpected,
          treeSize: zkResult.treeSize,
          severity: 'critical',
        },
      };
    }

    const warnings: string[] = [];

    if (rejectedRecords > 0) {
      warnings.push(`${rejectedRecords} presented records failed verification.`);
    }

    if (warnings.length > 0) {
      details.warnings = warnings;
    }

    return {
      status: 'success',
      details,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function isValidCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
