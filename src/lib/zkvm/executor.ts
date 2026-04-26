/**
 * zkVM executor for privacy-preserving voting system
 * This executor uses a zkVM that has no knowledge of tamper scenarios
 */

import { Buffer } from 'buffer';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { CURRENT_METHOD_VERSION, type CurrentZkVMJournal, type ZkVMInput, type ZkVMJournal } from './types';
import { isSupportedZkVMJournal } from '@/lib/zkvm/journal-guards';
import {
  getNumberArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
  isRecord,
} from '@/lib/utils/guards';
import { parseIncludedBitmapArtifact } from '@/lib/verification/included-bitmap-artifact';
import { parseSeenBitmapArtifact } from '@/lib/verification/seen-bitmap-artifact';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';

export interface AggregatorInputJson {
  election_id: number[];
  bulletin_root: number[];
  tree_size: number;
  log_id: number[];
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

const execAsync = promisify(exec);

// Paths
const HOST_BINARY = path.resolve('zkvm', 'target', 'release', 'host');
const TEMP_DIR = path.resolve('.zkvm-temp');
const HASH_BYTE_LENGTH = 32;
const IMAGE_ID_BYTE_LENGTH = 32;
const VERIFIED_TALLY_LENGTH = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Timeout for zkVM execution (~366s for 64 votes, set to 10 minutes with buffer)
const ZKVM_TIMEOUT = 600000; // 600秒 = 10分

/**
 * Execute the zkVM to generate proof
 */
export async function executeZkVM(input: ZkVMInput): Promise<ZkVMExecutionResult> {
  // Ensure temp directory exists
  await fs.mkdir(TEMP_DIR, { recursive: true });

  // Generate unique ID for this execution
  const executionId = crypto.randomBytes(16).toString('hex');
  const inputFile = path.join(TEMP_DIR, `input-${executionId}.json`);
  // Output files are created by the zkVM host with predictable names
  // const outputFile = path.join(TEMP_DIR, `output-${executionId}.json`)
  // const receiptFile = path.join(TEMP_DIR, `receipt-${executionId}.json`)

  try {
    // Convert input to JSON format expected by zkVM host
    const jsonInput = serializeZkvmAggregatorInput(input);

    // Write input file
    await fs.writeFile(inputFile, JSON.stringify(jsonInput, null, 2));

    // Execute zkVM host
    const command = `${HOST_BINARY} ${inputFile}`;
    logger.info('[zkVM] Executing:', command);

    // Log zkVM mode
    if (process.env.RISC0_DEV_MODE === '1') {
      logger.info('[zkVM] Running in DEV mode (Fake receipts, fast execution)');
    } else {
      logger.info('[zkVM] Running in PRODUCTION mode (Real STARK proofs, ~366s for 64 votes)');
    }

    const startTime = Date.now();
    let stderr: string | undefined;
    try {
      ({ stderr } = await execAsync(command, {
        timeout: ZKVM_TIMEOUT,
        env: {
          ...process.env,
          // Pass RISC0_DEV_MODE as-is from environment
        },
      }));
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error('zkvm execution failed', {
        event: 'prover_failed',
        prover: {
          duration_ms: durationMs,
          result: 'failure',
          input_votes: input.votes.length,
        },
        error: error instanceof Error ? error.message : String(error),
      });
      if (isTimeoutError(error)) {
        throw new Error('zkVM execution timeout');
      }
      throw error;
    }

    const executionTime = Date.now() - startTime;
    logger.info('zkvm execution completed', {
      event: 'prover_completed',
      prover: {
        duration_ms: executionTime,
        result: 'success',
        input_votes: input.votes.length,
      },
    });

    if (stderr) {
      logger.warn('[zkVM] stderr:', stderr);
    }

    // Read output files (zkVM creates files based on input file name)
    const outputData = await fs.readFile(inputFile.replace('.json', '-output.json'), 'utf8');
    const receiptData = await fs.readFile(inputFile.replace('.json', '-receipt.json'), 'utf8');

    // Parse output safely
    const outputRaw: unknown = JSON.parse(outputData);
    const receiptRaw: unknown = JSON.parse(receiptData);
    const output = isRecord(outputRaw) ? outputRaw : {};
    const receipt = isRecord(receiptRaw) ? receiptRaw : {};
    const result = parseCurrentHostExecutionResult(output);

    const receiptPayload = getRecordProperty(receipt, 'receipt') ?? (Object.keys(receipt).length > 0 ? receipt : null);
    if (receiptPayload) {
      result.receipt = {
        imageId: result.imageId,
        payload: receiptPayload,
        raw: receipt,
      };
    }

    try {
      const seenBitmapData = await fs.readFile(inputFile.replace('.json', '-seen-bitmap.json'), 'utf8');
      const seenBitmapPayload: unknown = JSON.parse(seenBitmapData);
      const seenBitmapArtifact = parseSeenBitmapArtifact(seenBitmapPayload);
      if (seenBitmapArtifact) {
        result.seenBitmap = [...seenBitmapArtifact.seenBitmap];
      } else {
        logger.warn('[zkVM] Ignoring invalid seen bitmap artifact');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        logger.warn('[zkVM] Failed to read seen bitmap artifact', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const bitmapData = await fs.readFile(inputFile.replace('.json', '-bitmap.json'), 'utf8');
      const bitmapPayload: unknown = JSON.parse(bitmapData);
      const bitmapArtifact = parseIncludedBitmapArtifact(bitmapPayload);
      if (bitmapArtifact) {
        result.includedBitmap = [...bitmapArtifact.includedBitmap];
      } else {
        logger.warn('[zkVM] Ignoring invalid included bitmap artifact');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        logger.warn('[zkVM] Failed to read included bitmap artifact', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('zkvm execution finished', {
      event: 'prover_result',
      prover: {
        result: 'success',
        excluded_slots: result.excludedSlots,
        input_votes: input.votes.length,
      },
      image_id: result.imageId || 'not found',
    });

    return result;
  } finally {
    // Clean up temp files
    try {
      await fs.unlink(inputFile);
      await fs.unlink(inputFile.replace('.json', '-output.json'));
      await fs.unlink(inputFile.replace('.json', '-receipt.json'));
      await fs.unlink(inputFile.replace('.json', '-seen-bitmap.json'));
      await fs.unlink(inputFile.replace('.json', '-bitmap.json'));
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Convert API input to format expected by zkVM host
 */
export function serializeZkvmAggregatorInput(input: ZkVMInput): AggregatorInputJson {
  return {
    election_id: uuidToBytes(input.electionId),
    bulletin_root: hexToBytes(input.bulletinRoot, 32),
    tree_size: input.treeSize,
    log_id: hexToBytes(input.logId, 32),
    timestamp: input.timestamp,
    total_expected: input.totalExpected,
    election_config_hash: hexToBytes(input.electionConfigHash, 32),
    votes: input.votes.map((vote) => ({
      commitment: hexToBytes(vote.commitment, 32),
      choice: vote.choice,
      random: hexToBytes(vote.random, 32),
      index: vote.index,
      merkle_path: vote.merklePath.map((node) => hexToBytes(node, 32)),
    })),
  };
}

function parseCurrentHostExecutionResult(output: Record<string, unknown>): ZkVMExecutionResult {
  const methodVersion = getRequiredNumberField(output, ['methodVersion'], 'methodVersion');
  if (methodVersion !== CURRENT_METHOD_VERSION) {
    throw new Error(`Unsupported zkVM host output methodVersion: ${methodVersion}`);
  }

  const journalCandidate: CurrentZkVMJournal = {
    electionId: getRequiredUuidField(output, ['electionId'], 'electionId'),
    electionConfigHash: getRequiredHexField(output, ['electionConfigHash'], 'electionConfigHash', HASH_BYTE_LENGTH),
    bulletinRoot: getRequiredHexField(output, ['bulletinRoot'], 'bulletinRoot', HASH_BYTE_LENGTH),
    treeSize: getRequiredNumberField(output, ['treeSize'], 'treeSize'),
    totalExpected: getRequiredNumberField(output, ['totalExpected'], 'totalExpected'),
    sthDigest: getRequiredHexField(output, ['sthDigest'], 'sthDigest', HASH_BYTE_LENGTH),
    verifiedTally: getRequiredNumberArrayField(output, ['verifiedTally'], 'verifiedTally', VERIFIED_TALLY_LENGTH),
    totalVotes: getRequiredNumberField(output, ['totalVotes'], 'totalVotes'),
    validVotes: getRequiredNumberField(output, ['validVotes'], 'validVotes'),
    invalidVotes: getRequiredNumberField(output, ['invalidVotes'], 'invalidVotes'),
    seenIndicesCount: getRequiredNumberField(output, ['seenIndicesCount'], 'seenIndicesCount'),
    missingSlots: getRequiredNumberField(output, ['missingSlots'], 'missingSlots'),
    invalidPresentedSlots: getRequiredNumberField(output, ['invalidPresentedSlots'], 'invalidPresentedSlots'),
    rejectedRecords: getRequiredNumberField(output, ['rejectedRecords'], 'rejectedRecords'),
    seenBitmapRoot: getRequiredHexField(output, ['seenBitmapRoot'], 'seenBitmapRoot', HASH_BYTE_LENGTH),
    includedBitmapRoot: getRequiredHexField(output, ['includedBitmapRoot'], 'includedBitmapRoot', HASH_BYTE_LENGTH),
    excludedSlots: getRequiredNumberField(output, ['excludedSlots'], 'excludedSlots'),
    inputCommitment: getRequiredHexField(output, ['inputCommitment'], 'inputCommitment', HASH_BYTE_LENGTH),
    methodVersion: CURRENT_METHOD_VERSION,
  };

  if (!isSupportedZkVMJournal(journalCandidate)) {
    throw new Error('zkVM host output does not satisfy the current journal contract');
  }

  const imageId = getRequiredImageIdField(output, ['imageId'], 'imageId');

  return {
    ...journalCandidate,
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

function getRequiredHexField(
  record: Record<string, unknown>,
  keys: string[],
  fieldName: string,
  expectedBytes: number,
): string {
  const value = getField(record, keys);
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

function getRequiredUuidField(record: Record<string, unknown>, keys: string[], fieldName: string): string {
  const raw = getField(record, keys);
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

function getField(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function getStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = getStringProperty(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function getNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = getNumberProperty(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function getRequiredNumberField(record: Record<string, unknown>, keys: string[], fieldName: string): number {
  const value = getNumberField(record, keys);
  if (value === undefined) {
    throw new Error(`Current zkVM host output missing ${fieldName}`);
  }
  return value;
}

function getNumberArrayField(record: Record<string, unknown>, keys: string[]): number[] | undefined {
  for (const key of keys) {
    const value = getNumberArrayProperty(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function getRequiredNumberArrayField(
  record: Record<string, unknown>,
  keys: string[],
  fieldName: string,
  expectedLength: number,
): number[] {
  const value = getNumberArrayField(record, keys);
  if (value === undefined) {
    throw new Error(`Current zkVM host output missing ${fieldName}`);
  }
  if (value.length !== expectedLength || !value.every((entry) => Number.isInteger(entry) && entry >= 0)) {
    throw new Error(`Current zkVM host output invalid ${fieldName}`);
  }
  return value;
}

function getRequiredImageIdField(record: Record<string, unknown>, keys: string[], fieldName: string): string {
  const normalized = normalizeImageId(getStringField(record, keys));
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

function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.message.toLowerCase().includes('timed out')) {
    return true;
  }
  if (!isRecord(error)) {
    return false;
  }
  const code = getStringProperty(error, 'code');
  return code === 'ETIMEDOUT';
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

/**
 * Check if zkVM binary exists
 */
export async function checkZkVMBinary(): Promise<boolean> {
  try {
    await fs.access(HOST_BINARY, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build zkVM binary if not exists
 */
export async function buildZkVM(): Promise<void> {
  logger.info('[zkVM] Building zkVM binary...');

  const zkvmDir = path.dirname(path.dirname(path.dirname(HOST_BINARY)));
  const { stderr } = await execAsync('cargo build --release', {
    cwd: zkvmDir,
  });

  if (stderr) {
    logger.warn('[zkVM] Build warnings:', stderr);
  }

  logger.info('[zkVM] Build completed');
}
