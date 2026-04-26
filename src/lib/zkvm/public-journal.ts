import { CURRENT_METHOD_VERSION, type CurrentZkVMJournal, type ZkVMJournal } from '@/lib/zkvm/types';

/**
 * Strip execution-only fields before persisting or publishing zkVM journal data.
 * Keep this as an explicit allowlist so private bitmap artifacts never leak via
 * future executor-only fields without an intentional review.
 */
export function toPublicZkvmJournal(journal: ZkVMJournal): CurrentZkVMJournal {
  if (journal.methodVersion !== CURRENT_METHOD_VERSION || typeof journal.seenBitmapRoot !== 'string') {
    throw new Error('Current zkVM journal is missing seenBitmapRoot');
  }

  return {
    electionId: journal.electionId,
    electionConfigHash: journal.electionConfigHash,
    bulletinRoot: journal.bulletinRoot,
    treeSize: journal.treeSize,
    totalExpected: journal.totalExpected,
    sthDigest: journal.sthDigest,
    verifiedTally: [...journal.verifiedTally],
    totalVotes: journal.totalVotes,
    validVotes: journal.validVotes,
    invalidVotes: journal.invalidVotes,
    seenIndicesCount: journal.seenIndicesCount,
    missingSlots: journal.missingSlots,
    invalidPresentedSlots: journal.invalidPresentedSlots,
    rejectedRecords: journal.rejectedRecords,
    seenBitmapRoot: journal.seenBitmapRoot,
    includedBitmapRoot: journal.includedBitmapRoot,
    excludedSlots: journal.excludedSlots,
    inputCommitment: journal.inputCommitment,
    methodVersion: CURRENT_METHOD_VERSION,
    ...(typeof journal.imageId === 'string' ? { imageId: journal.imageId } : {}),
  };
}
