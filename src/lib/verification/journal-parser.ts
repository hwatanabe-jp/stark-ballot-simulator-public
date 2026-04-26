/**
 * Parser for zkVM journal data containing privacy-preserving verification results
 * for the current journal layout (see `zkvm/contract-core/src/types.rs` for the
 * canonical Rust journal shape and `zkvm/methods/guest/src/main.rs` for the
 * emitted field order).
 */

import { CURRENT_METHOD_VERSION, type CurrentZkVMJournal } from '@/lib/zkvm/types';

const UINT32_BYTE_LENGTH = 4;
const HASH_BYTE_LENGTH = 32;
const UUID_BYTE_LENGTH = 16;
const CURRENT_JOURNAL_SIZE = 272;

export interface VerificationOutput extends CurrentZkVMJournal {
  tamperDetected: boolean;
}

/**
 * Parse journal bytes from zkVM receipt
 */
export function parseJournalBytes(journalBytes: number[]): VerificationOutput {
  const bytes = new Uint8Array(journalBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  if (bytes.length !== CURRENT_JOURNAL_SIZE) {
    throw new Error(`Invalid journal size: expected ${CURRENT_JOURNAL_SIZE} bytes, got ${bytes.length}`);
  }

  const readBytes = (length: number): Uint8Array => {
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };

  const readUint32 = (): number => {
    const value = view.getUint32(offset, true);
    offset += UINT32_BYTE_LENGTH;
    return value;
  };

  const electionIdBytes = readBytes(UUID_BYTE_LENGTH);
  const electionConfigHashBytes = readBytes(HASH_BYTE_LENGTH);
  const bulletinRootBytes = readBytes(HASH_BYTE_LENGTH);
  const treeSize = readUint32();
  const totalExpected = readUint32();
  const sthDigestBytes = readBytes(HASH_BYTE_LENGTH);

  const verifiedTally = Array.from({ length: 5 }, () => readUint32());

  const totalVotes = readUint32();
  const validVotes = readUint32();
  const invalidVotes = readUint32();
  const seenIndicesCount = readUint32();
  const missingSlots = readUint32();
  const invalidPresentedSlots = readUint32();
  const rejectedRecords = readUint32();

  const seenBitmapRootBytes = readBytes(HASH_BYTE_LENGTH);
  const includedBitmapRootBytes = readBytes(HASH_BYTE_LENGTH);
  const excludedSlots = readUint32();
  const inputCommitmentBytes = readBytes(HASH_BYTE_LENGTH);
  const methodVersion = readUint32();

  if (methodVersion !== CURRENT_METHOD_VERSION) {
    throw new Error(`Unsupported journal method version: ${methodVersion}`);
  }

  return {
    electionId: bytesToUuid(electionIdBytes),
    electionConfigHash: bytesToHex(electionConfigHashBytes),
    bulletinRoot: bytesToHex(bulletinRootBytes),
    treeSize,
    totalExpected,
    sthDigest: bytesToHex(sthDigestBytes),
    verifiedTally,
    totalVotes,
    validVotes,
    invalidVotes,
    seenIndicesCount,
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords,
    seenBitmapRoot: bytesToHex(seenBitmapRootBytes),
    includedBitmapRoot: bytesToHex(includedBitmapRootBytes),
    excludedSlots,
    inputCommitment: bytesToHex(inputCommitmentBytes),
    methodVersion: CURRENT_METHOD_VERSION,
    tamperDetected: excludedSlots > 0 || rejectedRecords > 0,
  };
}

/**
 * Convert vote counts to choice distribution
 */
export function formatVoteCounts(counts: number[]): Record<string, number> {
  return {
    A: counts[0],
    B: counts[1],
    C: counts[2],
    D: counts[3],
    E: counts[4],
  };
}

/**
 * Format merkle root as hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
