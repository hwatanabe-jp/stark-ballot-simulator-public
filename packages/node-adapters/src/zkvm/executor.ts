/**
 * zkVM executor for privacy-preserving voting system
 * This executor uses a zkVM that has no knowledge of tamper scenarios
 */

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
import { getRecordProperty, isRecord } from '@stark-ballot/zkvm-contract/zkvm/guards';
import {
  parseIncludedBitmapArtifact,
  parseSeenBitmapArtifact,
} from '@stark-ballot/zkvm-contract/zkvm/bitmap-artifacts';
import { logger } from './logger';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { Risc0ProofProfile } from './executor-factory';
import { HostProcessError, runHostProcess } from './host-process';

export { HOST_RESPONSE_TIMEOUT_MS, shutdownHostProcesses } from './host-process';

// Paths
const HOST_BINARY = path.resolve('zkvm', 'target', 'release', 'host');
const TEMP_DIR = path.resolve('.zkvm-temp');

/**
 * Execute the zkVM to generate proof
 */
export async function executeZkVM(input: ZkVMInput, proofProfile: Risc0ProofProfile): Promise<ZkVMExecutionResult> {
  // Ensure temp directory exists
  await fs.mkdir(TEMP_DIR, { recursive: true });

  // Generate unique ID for this execution
  const executionId = crypto.randomBytes(16).toString('hex');
  const inputFile = path.join(TEMP_DIR, `input-${executionId}.json`);

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
    logger.info('[zkVM] Host execution starting');

    if (proofProfile.evidence === 'development') {
      logger.info('[zkVM] Running in DEV mode (Fake receipts, fast execution)');
    } else {
      logger.info('[zkVM] Running in PRODUCTION mode (Real STARK proofs)');
    }

    const childEnvironment = { ...process.env };
    if (proofProfile.evidence === 'development') {
      childEnvironment['RISC0_DEV_MODE'] = '1';
    } else {
      delete childEnvironment['RISC0_DEV_MODE'];
    }
    const execution = await runHostProcess(HOST_BINARY, [inputFile], {
      env: childEnvironment,
      onStage: (stage) => logger.info('zkvm execution progress', { event: 'prover_progress', prover: { stage } }),
    });
    const executionLog = {
      event: execution.outcome === 'success' ? 'prover_completed' : 'prover_failed',
      prover: {
        started_at: execution.startedAt,
        duration_ms: execution.durationMs,
        timeout_ms: execution.timeoutMs,
        result: execution.outcome === 'success' ? 'success' : 'failure',
        reason: execution.outcome,
        stage: execution.stage,
        exit_code: execution.exitCode,
        signal: execution.signal,
        error_code: execution.errorCode,
        cleanup: execution.cleanup,
        input_votes: input.votes.length,
      },
    };
    if (execution.outcome !== 'success') {
      logger.error('zkvm execution failed', executionLog);
      throw new HostProcessError(execution);
    }
    logger.info('zkvm execution completed', executionLog);

    if (execution.stderrPresent) {
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
    for (const suffix of ['', '-output', '-receipt', '-seen-bitmap', '-bitmap']) {
      try {
        await fs.unlink(inputFile.replace('.json', `${suffix}.json`));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          logger.warn('[zkVM] Temporary artifact cleanup failed', { error_code: 'artifact_cleanup_failed' });
        }
      }
    }
  }
}
