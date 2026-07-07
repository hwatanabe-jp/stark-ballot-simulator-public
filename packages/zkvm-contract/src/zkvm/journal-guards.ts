import { VOTE_CHOICES } from './contract-constants';
import { CURRENT_METHOD_VERSION, UINT32_MAX, type CurrentZkVMJournal } from './types';
import { getNumberArrayProperty, getNumberProperty, getStringProperty, isRecord } from './guards';
import { isValidHexString } from './hex';

const HASH_BYTE_LENGTH = 32;
const IMAGE_ID_BYTE_LENGTH = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_JOURNAL_COUNT_KEYS = ['missingIndices', 'invalidIndices', 'countedIndices', 'excludedCount'] as const;

export function isSupportedJournalMethodVersion(value: number | undefined): value is typeof CURRENT_METHOD_VERSION {
  return typeof value === 'number' && Number.isInteger(value) && value === CURRENT_METHOD_VERSION;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasLegacyJournalCountAliases(value: unknown): boolean {
  return isRecord(value) && LEGACY_JOURNAL_COUNT_KEYS.some((key) => hasOwn(value, key));
}

export function isSupportedZkVMJournal(value: unknown): value is CurrentZkVMJournal {
  if (!isRecord(value)) {
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

  if (!verifiedTally || verifiedTally.length !== VOTE_CHOICES.length) {
    return false;
  }
  if (!verifiedTally.every(isCurrentJournalUint32)) {
    return false;
  }

  if (!isCurrentJournalPositiveUint32(treeSize)) {
    return false;
  }
  const counts = {
    totalExpected,
    totalVotes,
    validVotes,
    invalidVotes,
    seenIndicesCount,
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords,
    excludedSlots,
  };
  if (!Object.values(counts).every(isCurrentJournalUint32)) {
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
