/**
 * zkVM executor for privacy-preserving voting system
 * This executor uses a zkVM that has no knowledge of tamper scenarios
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Buffer } from 'buffer';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  parseCurrentHostExecutionResult,
  serializeZkvmAggregatorInput,
  type ZkVMExecutionResult,
} from '@stark-ballot/zkvm-contract/zkvm/host-io';
import { validateGuestWorkBudget } from '@stark-ballot/zkvm-contract/zkvm/work-budget';
import { assertZkvmWireNumericPreflight } from '@stark-ballot/zkvm-contract/zkvm/wire-numeric-preflight';
import { getRecordProperty, getStringProperty, isRecord } from '@stark-ballot/zkvm-contract/zkvm/guards';
import {
  parseIncludedBitmapArtifact,
  parseSeenBitmapArtifact,
} from '@stark-ballot/zkvm-contract/zkvm/bitmap-artifacts';
import { logger } from './logger';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { Risc0ProofProfile } from './executor-factory';

const execAsync = promisify(exec);

// Paths
const HOST_BINARY = path.resolve('zkvm', 'target', 'release', 'host');
const TEMP_DIR = path.resolve('.zkvm-temp');

// Timeout for zkVM execution (~366s for 64 votes, set to 10 minutes with buffer)
const ZKVM_TIMEOUT = 600000; // 600秒 = 10分

/**
 * Execute the zkVM to generate proof
 */
export async function executeZkVM(input: ZkVMInput, proofProfile: Risc0ProofProfile): Promise<ZkVMExecutionResult> {
  // Ensure temp directory exists
  await fs.mkdir(TEMP_DIR, { recursive: true });

  // Generate unique ID for this execution
  const executionId = crypto.randomBytes(16).toString('hex');
  const inputFile = path.join(TEMP_DIR, `input-${executionId}.json`);
  // Output files are created by the zkVM host with predictable names
  // const outputFile = path.join(TEMP_DIR, `output-${executionId}.json`)
  // const receiptFile = path.join(TEMP_DIR, `receipt-${executionId}.json`)

  try {
    assertZkvmWireNumericPreflight(input);
    validateGuestWorkBudget(input);

    // Convert input to JSON format expected by zkVM host
    const jsonInput = serializeZkvmAggregatorInput(input);
    const inputPayload = JSON.stringify(jsonInput, null, 2);
    validateGuestWorkBudget(input, { serializedInputBytes: Buffer.byteLength(inputPayload, 'utf8') });

    // Write input file
    await fs.writeFile(inputFile, inputPayload);

    // Execute zkVM host
    const command = `${HOST_BINARY} ${inputFile}`;
    logger.info('[zkVM] Host execution starting');

    if (proofProfile.evidence === 'development') {
      logger.info('[zkVM] Running in DEV mode (Fake receipts, fast execution)');
    } else {
      logger.info('[zkVM] Running in PRODUCTION mode (Real STARK proofs, ~366s for 64 votes)');
    }

    const startTime = Date.now();
    let stderr: string | undefined;
    try {
      const childEnvironment = { ...process.env };
      if (proofProfile.evidence === 'development') {
        childEnvironment['RISC0_DEV_MODE'] = '1';
      } else {
        delete childEnvironment['RISC0_DEV_MODE'];
      }

      ({ stderr } = await execAsync(command, {
        timeout: ZKVM_TIMEOUT,
        env: childEnvironment,
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
      logger.warn('[zkVM] Host stderr was present', { stderr_present: true });
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
        ...omitUndefinedProperties({ imageId: result.imageId }),
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
          error_code: 'artifact_read_failed',
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
          error_code: 'artifact_read_failed',
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
    logger.warn('[zkVM] Build warnings were present', { stderr_present: true });
  }

  logger.info('[zkVM] Build completed');
}
