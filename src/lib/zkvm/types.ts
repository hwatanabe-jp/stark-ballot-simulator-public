/**
 * zkVM v2 type definitions following final_design.md v1.0
 * These types implement the new structure without claimedTally/tamperDetected
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { hexToBytesStrict } from '@/lib/crypto/sha256';

export const CURRENT_METHOD_VERSION = 14;
export const LEGACY_METHOD_VERSION = 12;
export const INPUT_COMMITMENT_FORMAT_VERSION = 10;

/**
 * Vote with inclusion proof for zkVM processing
 * Extends the original VoteWithOpening with bulletin board proof
 */
export interface VoteWithProof {
  /** Public commitment: SHA256("stark-ballot:commit|v1.0" || electionId || choice || random) */
  commitment: string;
  /** Private choice value (0-4 representing options A-E) - witness data */
  choice: number;
  /** Private random value as hex string (32 bytes) - witness data */
  random: string;
  /** Index in the bulletin board */
  index: number;
  /** Merkle proof path (CT-style audit path) */
  merklePath: string[];
}

/**
 * zkVM Input structure v2 following final_design.md §1.2
 * All fields are required as per specification
 */
export interface ZkVMInput {
  /** Election identifier (UUID v4) - 16 bytes */
  electionId: string;

  /** Public bulletin board root - 32 bytes hex */
  bulletinRoot: string;

  /** Tree size corresponding to bulletinRoot */
  treeSize: number;

  /** STH parameters for split-view attack prevention */
  logId: string; // 32 bytes hex - bulletin board identifier
  timestamp: number; // Unix timestamp

  /** Expected total votes (fixed N for this experiment) */
  totalExpected: number;

  /** Hash of election configuration including totalExpected */
  electionConfigHash: string; // 32 bytes hex

  /** Vote data with proofs */
  votes: VoteWithProof[];
}

/**
 * zkVM Output (Journal) structure v2 following final_design.md §1.3
 * Public output with no individual vote information
 */
export interface ZkVMJournal {
  /** Election scope identification */
  electionId: string;
  electionConfigHash: string;

  /** Bulletin board root (echo from input) */
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;

  /** STH binding for split-view attack prevention */
  sthDigest: string; // SHA256(logId || treeSize || timestamp || bulletinRoot)

  /** Verified aggregation results */
  verifiedTally: number[]; // [A, B, C, D, E]

  /** Verification statistics */
  totalVotes: number; // Total votes processed
  validVotes: number; // Successfully verified votes
  invalidVotes: number; // Failed verification
  seenIndicesCount: number; // Unique in-range indices presented at least once to the guest

  /**
   * Explicit slot/record semantics for the current journal contract.
   *
   * `missingSlots` and `invalidPresentedSlots` are slot-based counts that form
   * a tree-size partition together with `validVotes`.
   *
   * `rejectedRecords` is a record-based rejection count and may exceed
   * `invalidPresentedSlots` when duplicate or out-of-range records were
   * presented for already-counted or non-existent slots.
   */
  missingSlots: number; // Bulletin slots not presented to the guest
  invalidPresentedSlots: number; // Presented in-range slots that still failed counting
  rejectedRecords: number; // Rejected records, including duplicates and out-of-range entries

  /** Individual vote verification */
  seenBitmapRoot?: string; // Merkle root of presented-index bitmap
  includedBitmapRoot: string; // Merkle root of counted-index bitmap
  excludedSlots: number; // Slot-based exclusions = missingSlots + invalidPresentedSlots

  /** Input binding */
  inputCommitment: string; // Domain-separated hash of input
  methodVersion: number; // 14 for current journal layout

  /** Optional metadata from host execution */
  imageId?: string; // Comparison-only host metadata, not canonical proof output
}

/**
 * Current zkVM journal contract (methodVersion 14).
 * This narrows the generic journal shape for helpers that only target the
 * active journal layout and therefore always require seenBitmapRoot.
 */
export interface CurrentZkVMJournal extends ZkVMJournal {
  seenBitmapRoot: string;
  methodVersion: typeof CURRENT_METHOD_VERSION;
}

const COMMIT_DOMAIN_TAG = utf8ToBytes('stark-ballot:commit|v1.0');
const INPUT_DOMAIN_TAG = utf8ToBytes('stark-ballot:input|v1.0');

export type InputCommitmentVote = {
  index: number;
  commitment: string;
  merklePath: string[];
};

type NormalizedInputCommitmentVote = {
  index: number;
  commitmentBytes: Uint8Array;
  merklePathBytes: Uint8Array[];
};

const toUuidBytes = (uuid: string): Uint8Array => {
  return hexToBytesStrict(uuid.replace(/-/g, ''));
};

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const assertUnsignedIntegerInRange = (value: number, max: number, fieldName: string): void => {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${fieldName} must be an unsigned integer <= ${max}`);
  }
};

const uint16LE = (value: number): Uint8Array => {
  assertUnsignedIntegerInRange(value, UINT16_MAX, 'uint16 value');
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, value, true);
  return new Uint8Array(buffer);
};

const uint32LE = (value: number): Uint8Array => {
  assertUnsignedIntegerInRange(value, UINT32_MAX, 'uint32 value');
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, value, true);
  return new Uint8Array(buffer);
};

const uint64LE = (value: bigint): Uint8Array => {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, value, true);
  return new Uint8Array(buffer);
};

const compareUint8Arrays = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return left.length - right.length;
};

const compareMerklePaths = (left: Uint8Array[], right: Uint8Array[]): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const comparison = compareUint8Arrays(left[index], right[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return left.length - right.length;
};

const normalizeInputCommitmentVote = (vote: InputCommitmentVote): NormalizedInputCommitmentVote => ({
  index: vote.index,
  commitmentBytes: hexToBytesStrict(vote.commitment),
  merklePathBytes: vote.merklePath.map((node) => hexToBytesStrict(node)),
});

const toCanonicalInputCommitmentVote = (vote: NormalizedInputCommitmentVote): InputCommitmentVote => ({
  index: vote.index,
  commitment: '0x' + bytesToHex(vote.commitmentBytes),
  merklePath: vote.merklePathBytes.map((node) => '0x' + bytesToHex(node)),
});

const compareInputCommitmentVotes = (
  left: NormalizedInputCommitmentVote,
  right: NormalizedInputCommitmentVote,
): number => {
  if (left.index !== right.index) {
    return left.index - right.index;
  }

  const commitmentComparison = compareUint8Arrays(left.commitmentBytes, right.commitmentBytes);
  if (commitmentComparison !== 0) {
    return commitmentComparison;
  }

  return compareMerklePaths(left.merklePathBytes, right.merklePathBytes);
};

const concatByteArrays = (chunks: Uint8Array[]): Uint8Array => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
};

const validateInputCommitmentPublicFields = (input: {
  electionId: string;
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;
  votes: InputCommitmentVote[];
}): void => {
  const electionIdBytes = toUuidBytes(input.electionId);
  if (electionIdBytes.length !== 16) {
    throw new Error('electionId must encode exactly 16 bytes');
  }

  const bulletinRootBytes = hexToBytesStrict(input.bulletinRoot);
  if (bulletinRootBytes.length !== 32) {
    throw new Error('bulletinRoot must encode exactly 32 bytes');
  }

  assertUnsignedIntegerInRange(input.treeSize, UINT32_MAX, 'treeSize');
  assertUnsignedIntegerInRange(input.totalExpected, UINT32_MAX, 'totalExpected');
  assertUnsignedIntegerInRange(input.votes.length, UINT32_MAX, 'vote count');
};

export function canonicalizeInputCommitmentVotesForEncoding(votes: InputCommitmentVote[]): InputCommitmentVote[] {
  return votes.map(normalizeInputCommitmentVote).sort(compareInputCommitmentVotes).map(toCanonicalInputCommitmentVote);
}

export function encodeInputCommitmentPreimage(input: {
  electionId: string;
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;
  votes: InputCommitmentVote[];
}): Uint8Array {
  validateInputCommitmentPublicFields(input);

  const sortedVotes = input.votes.map(normalizeInputCommitmentVote).sort(compareInputCommitmentVotes);
  const chunks: Uint8Array[] = [
    INPUT_DOMAIN_TAG,
    uint32LE(INPUT_COMMITMENT_FORMAT_VERSION),
    toUuidBytes(input.electionId),
    hexToBytesStrict(input.bulletinRoot),
    uint32LE(input.treeSize),
    uint32LE(input.totalExpected),
    uint32LE(sortedVotes.length),
  ];

  for (const vote of sortedVotes) {
    assertUnsignedIntegerInRange(vote.index, UINT32_MAX, 'vote index');
    if (vote.commitmentBytes.length !== 32) {
      throw new Error('vote commitment must encode exactly 32 bytes');
    }
    assertUnsignedIntegerInRange(vote.merklePathBytes.length, UINT16_MAX, 'vote merklePath length');

    chunks.push(uint32LE(vote.index));
    chunks.push(uint16LE(32));
    chunks.push(vote.commitmentBytes);
    chunks.push(uint16LE(vote.merklePathBytes.length));

    for (const node of vote.merklePathBytes) {
      if (node.length !== 32) {
        throw new Error('vote merklePath node must encode exactly 32 bytes');
      }
      chunks.push(node);
    }
  }

  return concatByteArrays(chunks);
}

/**
 * Create a new election ID (UUID v4)
 */
export function createElectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Crypto API not available for UUID generation');
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // RFC 4122 version 4 UUID
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Compute vote commitment with domain separation (v1.0)
 * SHA256("stark-ballot:commit|v1.0" || electionId || choice || random)
 */
export function computeCommitment(electionId: string, choice: number, random: string): string {
  const hash = sha256.create();
  hash.update(COMMIT_DOMAIN_TAG); // Domain tag (24 bytes)
  hash.update(toUuidBytes(electionId)); // 16 bytes UUID
  hash.update(Uint8Array.of(choice)); // 1 byte
  hash.update(hexToBytesStrict(random)); // 32 bytes

  return '0x' + bytesToHex(hash.digest());
}

/**
 * Compute input commitment with canonical encoding
 * MUST apply canonical vote ordering before hashing: index first, then
 * commitment bytes, then Merkle path bytes for duplicate-index tie-breaks.
 */
export function computeInputCommitment(input: ZkVMInput): string {
  return computeInputCommitmentFromPublicInput({
    electionId: input.electionId,
    bulletinRoot: input.bulletinRoot,
    treeSize: input.treeSize,
    totalExpected: input.totalExpected,
    votes: input.votes.map((vote) => ({
      index: vote.index,
      commitment: vote.commitment,
      merklePath: vote.merklePath,
    })),
  });
}

/**
 * Compute input commitment from public (witness-free) input fields.
 * Uses the same canonical encoding as computeInputCommitment.
 */
export function computeInputCommitmentFromPublicInput(input: {
  electionId: string;
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;
  votes: InputCommitmentVote[];
}): string {
  const hash = sha256.create();
  hash.update(encodeInputCommitmentPreimage(input));
  return '0x' + bytesToHex(hash.digest());
}

/**
 * Compute STH digest for split-view attack prevention
 * SHA256(logId || treeSize || timestamp || bulletinRoot)
 */
export function computeSTHDigest(logId: string, treeSize: number, timestamp: number, bulletinRoot: string): string {
  const hash = sha256.create();

  // LogId (32 bytes)
  hash.update(hexToBytesStrict(logId));

  // TreeSize (little endian)
  hash.update(uint32LE(treeSize));

  // Timestamp (little endian)
  hash.update(uint64LE(BigInt(timestamp)));

  // BulletinRoot (32 bytes)
  hash.update(hexToBytesStrict(bulletinRoot));

  return '0x' + bytesToHex(hash.digest());
}

/**
 * Validate ZkVMInput structure
 */
export function validateZkVMInput(input: ZkVMInput): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const seenIndices = new Set<number>();

  // Validate electionId (UUID v4)
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(input.electionId)) {
    errors.push('Invalid electionId format (must be UUID v4)');
  }

  // Validate hex hashes
  const hexHashRegex = /^0x[0-9a-f]{64}$/i;
  if (!hexHashRegex.test(input.bulletinRoot)) {
    errors.push('Invalid bulletinRoot format');
  }
  if (!hexHashRegex.test(input.logId)) {
    errors.push('Invalid logId format');
  }
  if (!hexHashRegex.test(input.electionConfigHash)) {
    errors.push('Invalid electionConfigHash format');
  }

  // Validate treeSize
  if (!Number.isInteger(input.treeSize) || input.treeSize < 0) {
    errors.push('Invalid treeSize');
  }

  // Validate totalExpected
  if (!Number.isInteger(input.totalExpected) || input.totalExpected < 0) {
    errors.push('Invalid totalExpected');
  }

  // Validate each vote
  for (let i = 0; i < input.votes.length; i++) {
    const vote = input.votes[i];

    if (!hexHashRegex.test(vote.commitment)) {
      errors.push(`Invalid commitment format at vote ${i}`);
    }

    if (vote.choice < 0 || vote.choice > 4) {
      errors.push(`Invalid choice at vote ${i}: must be 0-4`);
    }

    if (!hexHashRegex.test(vote.random)) {
      errors.push(`Invalid random format at vote ${i}`);
    }

    if (!Number.isInteger(vote.index) || vote.index < 0) {
      errors.push(`Invalid index at vote ${i}`);
    } else if (seenIndices.has(vote.index)) {
      errors.push(`Duplicate vote index: ${vote.index}`);
    } else {
      seenIndices.add(vote.index);
    }

    if (!Array.isArray(vote.merklePath)) {
      errors.push(`Invalid merklePath at vote ${i}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
