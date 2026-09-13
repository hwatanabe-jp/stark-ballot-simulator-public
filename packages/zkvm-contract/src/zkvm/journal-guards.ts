import { VOTE_CHOICES } from './contract-constants';
import { CURRENT_METHOD_VERSION, UINT32_MAX, type CurrentZkVMJournal } from './types';
import { getNumberArrayProperty, getNumberProperty, getStringProperty, isRecord } from './guards';
import { isValidHexString, normalizeHexString } from './hex';
import { CURRENT_ZKVM_BROWSER_SEMANTIC_BINDINGS } from './semantic-contract.generated';

const HASH_BYTE_LENGTH = 32;
const IMAGE_ID_BYTE_LENGTH = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_JOURNAL_COUNT_KEYS = ['missingIndices', 'invalidIndices', 'countedIndices', 'excludedCount'] as const;
const OPTIONAL_CURRENT_JOURNAL_KEYS = new Set(['imageId']);
const CURRENT_JOURNAL_KEYS = CURRENT_ZKVM_BROWSER_SEMANTIC_BINDINGS.hostJsonProjectionFieldNames;
const CURRENT_JOURNAL_ALLOWED_KEYS: ReadonlySet<string> = new Set(CURRENT_JOURNAL_KEYS);
const CURRENT_JOURNAL_REQUIRED_KEYS = CURRENT_JOURNAL_KEYS.filter((key) => !OPTIONAL_CURRENT_JOURNAL_KEYS.has(key));

export function isSupportedJournalMethodVersion(value: number | undefined): value is typeof CURRENT_METHOD_VERSION {
  return typeof value === 'number' && Number.isInteger(value) && value === CURRENT_METHOD_VERSION;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactCurrentJournalKeys(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).every((key) => CURRENT_JOURNAL_ALLOWED_KEYS.has(key)) &&
    CURRENT_JOURNAL_REQUIRED_KEYS.every((key) => hasOwn(value, key))
  );
}

export function hasLegacyJournalCountAliases(value: unknown): boolean {
  return isRecord(value) && LEGACY_JOURNAL_COUNT_KEYS.some((key) => hasOwn(value, key));
}

export interface ZkVMVoteSlotPartitionEvidence {
  readonly verifiedTally: readonly number[] | undefined;
  readonly treeSize: number | undefined;
  readonly seenIndicesCount: number | undefined;
  readonly missingSlots: number | undefined;
  readonly invalidPresentedSlots: number | undefined;
  readonly rejectedRecords: number | undefined;
  readonly excludedSlots: number | undefined;
  readonly seenBitmapRoot: string | undefined;
  readonly includedBitmapRoot: string | undefined;
}

export interface CurrentZkVMJournalSemanticEvidence extends ZkVMVoteSlotPartitionEvidence {
  readonly totalExpected: number | undefined;
  readonly totalVotes: number | undefined;
  readonly validVotes: number | undefined;
  readonly invalidVotes: number | undefined;
}

function addSafeIntegers(left: number, right: number): number | undefined {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : undefined;
}

/** Owns the vote-slot partition shared by journal and proof projections. */
export function hasCoherentZkVMVoteSlotPartition(partition: ZkVMVoteSlotPartitionEvidence): boolean {
  if (
    !partition.verifiedTally ||
    partition.verifiedTally.length !== VOTE_CHOICES.length ||
    !partition.verifiedTally.every(isCurrentJournalUint32) ||
    !isCurrentJournalPositiveUint32(partition.treeSize) ||
    !isCurrentJournalUint32(partition.seenIndicesCount) ||
    !isCurrentJournalUint32(partition.missingSlots) ||
    !isCurrentJournalUint32(partition.invalidPresentedSlots) ||
    !isCurrentJournalUint32(partition.rejectedRecords) ||
    !isCurrentJournalUint32(partition.excludedSlots) ||
    !partition.seenBitmapRoot ||
    !partition.includedBitmapRoot
  ) {
    return false;
  }

  const tallyTotal = partition.verifiedTally.reduce((sum, count) => addSafeIntegers(sum, count) ?? Number.NaN, 0);
  return (
    Number.isSafeInteger(tallyTotal) &&
    addSafeIntegers(tallyTotal, partition.invalidPresentedSlots) === partition.seenIndicesCount &&
    addSafeIntegers(partition.seenIndicesCount, partition.missingSlots) === partition.treeSize &&
    partition.rejectedRecords >= partition.invalidPresentedSlots &&
    addSafeIntegers(partition.missingSlots, partition.invalidPresentedSlots) === partition.excludedSlots &&
    (partition.invalidPresentedSlots !== 0 ||
      normalizeHexString(partition.seenBitmapRoot) === normalizeHexString(partition.includedBitmapRoot))
  );
}

export function hasCoherentCurrentZkVMJournalSemantics(journal: CurrentZkVMJournalSemanticEvidence): boolean {
  if (
    !hasCoherentZkVMVoteSlotPartition(journal) ||
    !isCurrentJournalUint32(journal.totalExpected) ||
    !isCurrentJournalUint32(journal.totalVotes) ||
    !isCurrentJournalUint32(journal.validVotes) ||
    !isCurrentJournalUint32(journal.invalidVotes)
  ) {
    return false;
  }

  const tallyTotal = journal.verifiedTally?.reduce((sum, count) => addSafeIntegers(sum, count) ?? Number.NaN, 0);
  return (
    tallyTotal === journal.validVotes &&
    addSafeIntegers(journal.validVotes, journal.invalidVotes) === journal.totalVotes &&
    journal.rejectedRecords === journal.invalidVotes
  );
}

export function isSupportedZkVMJournal(value: unknown): value is CurrentZkVMJournal {
  if (!isRecord(value)) {
    return false;
  }
  if (!hasExactCurrentJournalKeys(value)) {
    return false;
  }
  if (hasLegacyJournalCountAliases(value)) {
    return false;
  }

  const electionId = getStringProperty(value, 'electionId');
  const electionConfigHash = getStringProperty(value, 'electionConfigHash');
  const bulletinRoot = getStringProperty(value, 'bulletinRoot');
  const sthDigest = getStringProperty(value, 'sthDigest');
  const seenBitmapRoot = getStringProperty(value, 'seenBitmapRoot');
  const includedBitmapRoot = getStringProperty(value, 'includedBitmapRoot');
  const inputCommitment = getStringProperty(value, 'inputCommitment');
  const verifiedTally = getNumberArrayProperty(value, 'verifiedTally');

  const treeSize = getNumberProperty(value, 'treeSize');
  const totalExpected = getNumberProperty(value, 'totalExpected');
  const totalVotes = getNumberProperty(value, 'totalVotes');
  const validVotes = getNumberProperty(value, 'validVotes');
  const invalidVotes = getNumberProperty(value, 'invalidVotes');
  const seenIndicesCount = getNumberProperty(value, 'seenIndicesCount');
  const missingSlots = getNumberProperty(value, 'missingSlots');
  const invalidPresentedSlots = getNumberProperty(value, 'invalidPresentedSlots');
  const rejectedRecords = getNumberProperty(value, 'rejectedRecords');
  const excludedSlots = getNumberProperty(value, 'excludedSlots');
  const methodVersion = getNumberProperty(value, 'methodVersion');
  const imageId = getStringProperty(value, 'imageId');

  if (!electionId || !UUID_PATTERN.test(electionId)) {
    return false;
  }
  if (
    !electionConfigHash ||
    !isValidHexString(electionConfigHash, HASH_BYTE_LENGTH) ||
    !bulletinRoot ||
    !isValidHexString(bulletinRoot, HASH_BYTE_LENGTH) ||
    !sthDigest ||
    !isValidHexString(sthDigest, HASH_BYTE_LENGTH) ||
    !includedBitmapRoot ||
    !isValidHexString(includedBitmapRoot, HASH_BYTE_LENGTH) ||
    !inputCommitment ||
    !isValidHexString(inputCommitment, HASH_BYTE_LENGTH)
  ) {
    return false;
  }
  if (!seenBitmapRoot || !isValidHexString(seenBitmapRoot, HASH_BYTE_LENGTH)) {
    return false;
  }
  if (imageId !== undefined && !isValidHexString(imageId, IMAGE_ID_BYTE_LENGTH)) {
    return false;
  }

  if (
    !hasCoherentCurrentZkVMJournalSemantics({
      verifiedTally,
      treeSize,
      totalExpected,
      totalVotes,
      validVotes,
      invalidVotes,
      seenIndicesCount,
      missingSlots,
      invalidPresentedSlots,
      rejectedRecords,
      excludedSlots,
      seenBitmapRoot,
      includedBitmapRoot,
    })
  ) {
    return false;
  }

  return isSupportedJournalMethodVersion(methodVersion);
}

function isCurrentJournalUint32(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX;
}

function isCurrentJournalPositiveUint32(value: number | undefined): value is number {
  return isCurrentJournalUint32(value) && value > 0;
}
