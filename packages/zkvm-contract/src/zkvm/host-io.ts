import { Buffer } from 'buffer';
import {
  CURRENT_METHOD_VERSION,
  VERIFIED_TALLY_WIDTH,
  type CurrentZkVMJournal,
  type VerifiedTally,
  type ZkVMInput,
  type ZkVMJournal,
} from './types';
import { CURRENT_ZKVM_SEMANTIC_CONTRACT } from './semantic-contract';
import { getNumberArrayProperty, getNumberProperty, getStringProperty, isRecord } from './guards';
import { addHexPrefix, isValidHexString, normalizeHexString } from './hex';
import { toValidatedCurrentZkVMJournal, toValidatedZkVMInput } from './validated-domain';

export interface AggregatorInputJson {
  election_id: number[];
  bulletin_root: number[];
  tree_size: number;
  log_id: number[];
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  total_expected: number;
  election_config_hash: number[];
  votes: AggregatorVoteJson[];
}

export interface AggregatorVoteJson {
  commitment: number[];
  choice: number;
  random: number[];
  index: number;
  merkle_path: number[][];
}

export interface ZkVMExecutionReceipt {
  imageId?: string;
  payload: unknown;
  raw: unknown;
}

export interface ZkVMExecutionResult extends ZkVMJournal {
  receipt?: ZkVMExecutionReceipt;
  includedBitmap?: boolean[];
  seenBitmap?: boolean[];
}

const HASH_BYTE_LENGTH = 32;
const IMAGE_ID_BYTE_LENGTH = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENT_HOST_OUTPUT_KEYS = CURRENT_ZKVM_SEMANTIC_CONTRACT.hostJsonProjection.fields.map((field) => field.name);

/**
 * Convert canonical zkVM input into the JSON shape consumed by the Rust host.
 */
export function serializeZkvmAggregatorInput(input: ZkVMInput): AggregatorInputJson {
  const validated = toValidatedZkVMInput(input);

  return {
    election_id: uuidToBytes(validated.electionId),
    bulletin_root: hexToBytes(validated.bulletinRoot, 32),
    tree_size: validated.treeSize,
    log_id: hexToBytes(validated.logId, 32),
    timestamp: validated.timestamp,
    total_expected: validated.totalExpected,
    election_config_hash: hexToBytes(validated.electionConfigHash, 32),
    votes: validated.votes.map((vote) => ({
      commitment: hexToBytes(vote.commitment, 32),
      choice: vote.choice,
      random: hexToBytes(vote.random, 32),
      index: vote.index,
      merkle_path: vote.merklePath.map((node) => hexToBytes(node, 32)),
    })),
  };
}

/**
 * Admit the JSON value emitted by the Rust host before projecting the current
 * journal contract. Receipt-internal RISC Zero serde bytes are intentionally
 * outside this boundary.
 */
export function parseHostZkVMOutput(output: unknown): ZkVMExecutionResult {
  if (!isRecord(output)) {
    throw new Error('Current zkVM host output must be an object');
  }
  return parseCurrentHostExecutionResult(output);
}

export function parseCurrentHostExecutionResult(output: Record<string, unknown>): ZkVMExecutionResult {
  const actualKeys = Object.keys(output);
  const expectedKeys = new Set(CURRENT_HOST_OUTPUT_KEYS);
  if (actualKeys.length !== expectedKeys.size || actualKeys.some((key) => !expectedKeys.has(key))) {
    throw new Error('Current zkVM host output must contain the exact current fields');
  }

  const methodVersion = getRequiredNumberField(output, 'methodVersion');
  if (methodVersion !== CURRENT_METHOD_VERSION) {
    throw new Error(`Unsupported zkVM host output methodVersion: ${methodVersion}`);
  }

  const journalCandidate: CurrentZkVMJournal = {
    electionId: getRequiredUuidField(output, 'electionId'),
    electionConfigHash: getRequiredHexField(output, 'electionConfigHash', HASH_BYTE_LENGTH),
    bulletinRoot: getRequiredHexField(output, 'bulletinRoot', HASH_BYTE_LENGTH),
    treeSize: getRequiredNumberField(output, 'treeSize'),
    totalExpected: getRequiredNumberField(output, 'totalExpected'),
    sthDigest: getRequiredHexField(output, 'sthDigest', HASH_BYTE_LENGTH),
    verifiedTally: getRequiredNumberArrayField(output, 'verifiedTally', VERIFIED_TALLY_WIDTH),
    totalVotes: getRequiredNumberField(output, 'totalVotes'),
    validVotes: getRequiredNumberField(output, 'validVotes'),
    invalidVotes: getRequiredNumberField(output, 'invalidVotes'),
    seenIndicesCount: getRequiredNumberField(output, 'seenIndicesCount'),
    missingSlots: getRequiredNumberField(output, 'missingSlots'),
    invalidPresentedSlots: getRequiredNumberField(output, 'invalidPresentedSlots'),
    rejectedRecords: getRequiredNumberField(output, 'rejectedRecords'),
    seenBitmapRoot: getRequiredHexField(output, 'seenBitmapRoot', HASH_BYTE_LENGTH),
    includedBitmapRoot: getRequiredHexField(output, 'includedBitmapRoot', HASH_BYTE_LENGTH),
    excludedSlots: getRequiredNumberField(output, 'excludedSlots'),
    inputCommitment: getRequiredHexField(output, 'inputCommitment', HASH_BYTE_LENGTH),
    methodVersion: CURRENT_METHOD_VERSION,
  };

  const journal = toValidatedCurrentZkVMJournal(journalCandidate);

  const imageId = getRequiredImageIdField(output, 'imageId');

  return {
    ...journal,
    ...(imageId ? { imageId } : {}),
  };
}

function parseHexField(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (value.length === 0) {
      return undefined;
    }
    return addHexPrefix(normalizeHexString(value));
  }

  if (value instanceof Uint8Array) {
    return addHexPrefix(Buffer.from(value).toString('hex'));
  }

  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    return addHexPrefix(Buffer.from(value).toString('hex'));
  }

  return undefined;
}

function getRequiredHexField(record: Record<string, unknown>, fieldName: string, expectedBytes: number): string {
  const value = getField(record, fieldName);
  if (value === undefined) {
    throw new Error(`Current zkVM host output missing ${fieldName}`);
  }
  const parsed = parseHexField(value);
  if (!parsed || !isValidHexString(parsed, expectedBytes)) {
    throw new Error(`Current zkVM host output invalid ${fieldName}`);
  }
  return parsed;
}

function formatUuidField(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const compact = value.replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
      return undefined;
    }
    return compactToUuid(compact);
  }

  if (value instanceof Uint8Array && value.length === 16) {
    return compactToUuid(Buffer.from(value).toString('hex'));
  }

  if (Array.isArray(value) && value.length === 16 && value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    return compactToUuid(Buffer.from(value).toString('hex'));
  }

  return undefined;
}

function getRequiredUuidField(record: Record<string, unknown>, fieldName: string): string {
  const raw = getField(record, fieldName);
  if (raw === undefined) {
    throw new Error(`Current zkVM host output missing ${fieldName}`);
  }
  const value = formatUuidField(raw);
  if (!value || !UUID_PATTERN.test(value)) {
    throw new Error(`Current zkVM host output invalid ${fieldName}`);
  }
  return value;
}

function compactToUuid(compactHex: string): string {
  const hex = compactHex.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function getField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  return getStringProperty(record, key);
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
  return getNumberProperty(record, key);
}

function getRequiredNumberField(record: Record<string, unknown>, fieldName: string): number {
  const value = getNumberField(record, fieldName);
  if (value === undefined) {
    throw new Error(`Current zkVM host output missing ${fieldName}`);
  }
  return value;
}

function getNumberArrayField(record: Record<string, unknown>, key: string): number[] | undefined {
  return getNumberArrayProperty(record, key);
}

function getRequiredNumberArrayField(
  record: Record<string, unknown>,
  fieldName: string,
  expectedLength: number,
): VerifiedTally {
  const value = getNumberArrayField(record, fieldName);
  if (value === undefined) {
    throw new Error(`Current zkVM host output missing ${fieldName}`);
  }
  if (value.length !== expectedLength || !value.every((entry) => Number.isInteger(entry) && entry >= 0)) {
    throw new Error(`Current zkVM host output invalid ${fieldName}`);
  }
  const [first, second, third, fourth, fifth] = value;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    fifth === undefined
  ) {
    throw new Error(`Current zkVM host output invalid ${fieldName}`);
  }
  return [first, second, third, fourth, fifth];
}

function getRequiredImageIdField(record: Record<string, unknown>, fieldName: string): string {
  const normalized = normalizeImageId(getStringField(record, fieldName));
  if (normalized === undefined) {
    throw new Error(`Current zkVM host output missing ${fieldName}`);
  }
  if (!isValidHexString(normalized, IMAGE_ID_BYTE_LENGTH)) {
    throw new Error(`Current zkVM host output invalid ${fieldName}`);
  }
  return normalized;
}

function normalizeImageId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return addHexPrefix(normalizeHexString(value));
}

function hexToBytes(value: string, expectedBytes: number): number[] {
  const clean = normalizeHexString(value);
  if (clean.length > expectedBytes * 2) {
    throw new Error(`Hex value ${value} exceeds ${expectedBytes} bytes`);
  }
  const padded = clean.padStart(expectedBytes * 2, '0');
  return Array.from(Buffer.from(padded, 'hex'));
}

function uuidToBytes(uuid: string): number[] {
  const clean = uuid.replace(/-/g, '');
  if (clean.length !== 32) {
    throw new Error(`ElectionId must be a UUID v4 string, received ${uuid}`);
  }
  return Array.from(Buffer.from(clean, 'hex'));
}
