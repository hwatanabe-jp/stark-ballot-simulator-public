/**
 * Bundle restore module
 *
 * Restores STARK proof receipts from S3-stored verification bundles.
 * Handles zip extraction and JSON parsing with proper error handling.
 */

import { downloadFromS3 } from './s3-download';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '@stark-ballot/domain/utils/guards';
import { readZipEntriesFromBuffer } from '@stark-ballot/node-adapters/zip';
import {
  parseIncludedBitmapArtifact,
  type IncludedBitmapArtifact,
} from '@stark-ballot/verification/included-bitmap-artifact';
import { parseSeenBitmapArtifact, type SeenBitmapArtifact } from '@stark-ballot/verification/seen-bitmap-artifact';
import {
  parseSupportedPublicInputArtifact,
  type SupportedPublicInputArtifact,
} from '@stark-ballot/verification/public-input';
import { admitReceiptPayload, type AdmittedReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import {
  isCloseStatement,
  isElectionManifest,
  type CloseStatement,
  type ElectionManifest,
} from '@stark-ballot/verification/public-audit-artifacts';
import { normalizeHexString } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging } from '@stark-ballot/diagnostics/logging';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const TRANSIENT_S3_ERROR_IDENTITIES = new Set([
  'AbortError',
  'BandwidthLimitExceeded',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'IDPCommunicationError',
  'InternalError',
  'InternalServerError',
  'NetworkingError',
  'PriorRequestNotComplete',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestThrottledException',
  'RequestTimeout',
  'RequestTimeoutException',
  'ServiceUnavailable',
  'SlowDown',
  'ThrottledException',
  'Throttling',
  'ThrottlingException',
  'TimeoutError',
  'TooManyRequestsException',
]);

class BundleArtifactError extends Error {}

export class TransientBundleRestoreError extends Error {
  constructor() {
    super('Receipt restoration temporarily unavailable');
    this.name = 'TransientBundleRestoreError';
  }
}

export function isTransientBundleRestoreError(error: unknown): error is TransientBundleRestoreError {
  return error instanceof TransientBundleRestoreError;
}

function isTransientS3Failure(error: unknown): boolean {
  const identities = [getStringProperty(error, 'name'), getStringProperty(error, 'code')];
  if (identities.some((identity) => identity !== undefined && TRANSIENT_S3_ERROR_IDENTITIES.has(identity))) {
    return true;
  }

  const metadata = getRecordProperty(error, '$metadata');
  const httpStatusCode = getNumberProperty(metadata, 'httpStatusCode');
  return httpStatusCode === 429 || (httpStatusCode !== undefined && httpStatusCode >= 500 && httpStatusCode <= 599);
}

function handleOptionalArtifactFailure(error: unknown, artifactName: string): void {
  if (isTransientS3Failure(error)) {
    throw error;
  }
  logger.warn(`[S3 Restore] ${artifactName} unavailable`, {
    failure_kind: 'definitive',
  });
}

/**
 * Restored receipt data structure
 */
export interface RestoredReceipt {
  receipt: unknown;
  receiptRaw: AdmittedReceiptPayload;
  journal?: unknown; // Restored from journal.json (15 MB in production mode)
  publicInputArtifact?: SupportedPublicInputArtifact;
  publicInput?: unknown;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  includedBitmapArtifact?: IncludedBitmapArtifact;
  seenBitmapArtifact?: SeenBitmapArtifact;
}

/**
 * Restore receipt from S3 verification bundle
 *
 * Downloads bundle.zip from S3, extracts receipt.json, and returns parsed receipt data.
 *
 * @param bundleKey S3 object key (e.g., "sessions/{sessionId}/{executionId}/bundle.zip")
 * @returns Restored receipt and admitted receipt payload
 * @throws TransientBundleRestoreError after the S3 client's transient retries are exhausted
 * @throws Error if the object is definitively unavailable or the bundle artifact is invalid
 */
export async function restoreReceiptFromS3(bundleKey: string): Promise<RestoredReceipt> {
  const keyPrefix = hashKeyPrefixForLogging(bundleKey);
  try {
    logger.info('[S3 Restore] Starting receipt restoration', {
      s3: {
        operation: 'restoreBundle',
        key_prefix: keyPrefix,
      },
    });

    // Step 1: Download bundle.zip from S3
    const zipBuffer = await downloadFromS3(bundleKey);

    // Step 2: Read receipt.json, journal.json, and public-input.json from the zip
    const entries = await readZipEntriesFromBuffer(zipBuffer, [
      'receipt.json',
      'journal.json',
      'public-input.json',
      'election-manifest.json',
      'close-statement.json',
    ]);
    const receiptBuffer = entries.get('receipt.json');
    if (!receiptBuffer) {
      throw new BundleArtifactError('receipt.json not found in bundle');
    }

    // Step 3: Parse receipt.json
    const receiptData: unknown = JSON.parse(receiptBuffer.toString('utf8'));
    const receiptRecord = isRecord(receiptData) ? receiptData : null;
    if (!receiptRecord) {
      throw new Error('receipt.json must contain a JSON object');
    }
    const receiptPayload = getRecordProperty(receiptRecord, 'receipt') ?? receiptRecord;

    // Step 4: Locate and parse journal.json (optional, may be large ~15 MB)
    const journalBuffer = entries.get('journal.json');
    let journalData: unknown = undefined;
    if (journalBuffer) {
      try {
        journalData = JSON.parse(journalBuffer.toString('utf8'));
        logger.info(`[S3 Restore] Journal restored successfully`);
      } catch {
        logger.warn('[S3 Restore] Failed to parse journal.json');
      }
    }

    // Step 5: Locate and parse public-input.json (optional)
    const publicInputBuffer = entries.get('public-input.json');
    let publicInputArtifact: SupportedPublicInputArtifact | undefined;
    let publicInput: unknown;
    if (publicInputBuffer) {
      const executionId = extractExecutionIdFromBundleKey(bundleKey);
      try {
        const publicInputData: unknown = JSON.parse(publicInputBuffer.toString('utf8'));
        publicInput = publicInputData;
        publicInputArtifact = parseSupportedPublicInputArtifact(publicInputData, {
          ...omitUndefinedProperties({ executionId: executionId }),
          bundleKey,
          source: 'bundle',
        });
        if (publicInputArtifact) {
          logger.info(`[S3 Restore] Public input authority restored successfully`);
        } else {
          logger.warn('[S3 Restore] public-input.json was readable but did not match the supported contract');
        }
      } catch {
        logger.warn('[S3 Restore] Failed to parse public-input.json');
      }
    }

    logger.info(`[S3 Restore] Receipt restored successfully`);

    const restored: RestoredReceipt = {
      receipt: receiptPayload,
      receiptRaw: admitReceiptPayload(receiptRecord),
      journal: journalData,
      ...omitUndefinedProperties({ publicInputArtifact: publicInputArtifact }),
    };
    if (publicInput !== undefined) {
      restored.publicInput = publicInput;
    }

    const electionManifestBuffer = entries.get('election-manifest.json');
    if (electionManifestBuffer) {
      try {
        const electionManifestData: unknown = JSON.parse(electionManifestBuffer.toString('utf8'));
        if (isElectionManifest(electionManifestData)) {
          restored.electionManifest = electionManifestData;
        } else {
          logger.warn('[S3 Restore] election-manifest.json did not match expected shape');
        }
      } catch {
        logger.warn('[S3 Restore] Failed to parse election-manifest.json');
      }
    }

    const closeStatementBuffer = entries.get('close-statement.json');
    if (closeStatementBuffer) {
      try {
        const closeStatementData: unknown = JSON.parse(closeStatementBuffer.toString('utf8'));
        if (isCloseStatement(closeStatementData)) {
          restored.closeStatement = closeStatementData;
        } else {
          logger.warn('[S3 Restore] close-statement.json did not match expected shape');
        }
      } catch {
        logger.warn('[S3 Restore] Failed to parse close-statement.json');
      }
    }

    const includedBitmapKey = deriveSiblingObjectKey(bundleKey, 'included-bitmap.json');
    if (includedBitmapKey) {
      try {
        const includedBitmapBuffer = await downloadFromS3(includedBitmapKey);
        const includedBitmapData: unknown = JSON.parse(includedBitmapBuffer.toString('utf8'));
        const includedBitmapArtifact = parseIncludedBitmapArtifact(includedBitmapData);
        if (
          includedBitmapArtifact &&
          matchesJournalBitmapRoot(includedBitmapArtifact, journalData, 'includedBitmapRoot')
        ) {
          restored.includedBitmapArtifact = includedBitmapArtifact;
        } else {
          logger.warn('[S3 Restore] included-bitmap.json failed validation or did not match journal bitmap metadata');
        }
      } catch (error) {
        handleOptionalArtifactFailure(error, 'Included bitmap artifact');
      }
    }

    const seenBitmapKey = deriveSiblingObjectKey(bundleKey, 'seen-bitmap.json');
    if (seenBitmapKey) {
      try {
        const seenBitmapBuffer = await downloadFromS3(seenBitmapKey);
        const seenBitmapData: unknown = JSON.parse(seenBitmapBuffer.toString('utf8'));
        const seenBitmapArtifact = parseSeenBitmapArtifact(seenBitmapData);
        if (seenBitmapArtifact && matchesJournalBitmapRoot(seenBitmapArtifact, journalData, 'seenBitmapRoot')) {
          restored.seenBitmapArtifact = seenBitmapArtifact;
        } else {
          logger.warn('[S3 Restore] seen-bitmap.json failed validation or did not match journal bitmap metadata');
        }
      } catch (error) {
        handleOptionalArtifactFailure(error, 'Seen bitmap artifact');
      }
    }

    return restored;
  } catch (error) {
    const transient = isTransientS3Failure(error);
    logger.error('[S3 Restore] Failed to restore receipt', {
      s3: {
        operation: 'restoreBundle',
        key_prefix: keyPrefix,
      },
      failure_kind: transient ? 'transient_s3' : 'terminal',
    });
    if (transient) {
      throw new TransientBundleRestoreError();
    }
    throw new Error(
      error instanceof BundleArtifactError
        ? `Receipt restoration failed: ${error.message}`
        : 'Receipt restoration failed',
    );
  }
}

function extractExecutionIdFromBundleKey(bundleKey: string): string | undefined {
  const segments = bundleKey.split('/').filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }
  if (segments[segments.length - 1] !== 'bundle.zip') {
    return undefined;
  }
  return segments[segments.length - 2];
}

function deriveSiblingObjectKey(bundleKey: string, fileName: string): string | null {
  const segments = bundleKey.split('/').filter(Boolean);
  if (segments.length < 2 || segments[segments.length - 1] !== 'bundle.zip') {
    return null;
  }
  segments[segments.length - 1] = fileName;
  return segments.join('/');
}

function matchesJournalBitmapRoot(
  artifact: { treeSize: number; includedBitmapRoot?: string; seenBitmapRoot?: string },
  journal: unknown,
  journalKey: 'includedBitmapRoot' | 'seenBitmapRoot',
): boolean {
  if (!isRecord(journal)) {
    return false;
  }

  const journalRoot = getStringProperty(journal, journalKey);
  if (!journalRoot) {
    return false;
  }

  const artifactRoot = journalKey === 'includedBitmapRoot' ? artifact.includedBitmapRoot : artifact.seenBitmapRoot;
  if (!artifactRoot) {
    return false;
  }

  if (normalizeHexString(journalRoot) !== normalizeHexString(artifactRoot)) {
    return false;
  }

  const journalTreeSize = getNumberProperty(journal, 'treeSize');
  // Older restored journal payloads may be missing treeSize; in that case the
  // root match remains the minimum compatibility guard for the private bitmap.
  if (Number.isInteger(journalTreeSize) && journalTreeSize !== artifact.treeSize) {
    return false;
  }

  return true;
}
