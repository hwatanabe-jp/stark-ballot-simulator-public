/**
 * Bundle restore module
 *
 * Restores STARK proof receipts from S3-stored verification bundles.
 * Handles zip extraction and JSON parsing with proper error handling.
 */

import { downloadFromS3 } from './s3-download';
import {
  getNumberProperty,
  getObjectProperty,
  getStringProperty,
  isNonNullObject,
} from '@stark-ballot/validation/unknown-value-guards';
import { readZipEntriesFromBuffer } from '@stark-ballot/node-adapters/zip';
import {
  parseIncludedBitmapArtifact,
  type IncludedBitmapArtifact,
  parseSeenBitmapArtifact,
  type SeenBitmapArtifact,
} from '@stark-ballot/zkvm-contract/zkvm/bitmap-artifacts';
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
import { normalizeHexString } from '@stark-ballot/crypto-primitives';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging } from '@stark-ballot/diagnostics/logging';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

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

  const metadata = getObjectProperty(error, '$metadata');
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

function restoreJournal(buffer: Buffer | undefined): unknown {
  let journalData: unknown = undefined;
  if (buffer) {
    try {
      journalData = JSON.parse(buffer.toString('utf8'));
      logger.info(`[S3 Restore] Journal restored successfully`);
    } catch {
      logger.warn('[S3 Restore] Failed to parse journal.json');
    }
  }

  return journalData;
}

function restorePublicInput(buffer: Buffer | undefined, bundleKey: string) {
  let publicInputArtifact: SupportedPublicInputArtifact | undefined;
  let publicInput: unknown;
  if (buffer) {
    const finalizationId = extractFinalizationIdFromBundleKey(bundleKey);
    try {
      const publicInputData: unknown = JSON.parse(buffer.toString('utf8'));
      publicInput = publicInputData;
      publicInputArtifact = parseSupportedPublicInputArtifact(publicInputData, {
        ...omitUndefinedProperties({ finalizationId }),
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

  return { publicInputArtifact, publicInput };
}

function restoreAuditArtifact<T>(
  buffer: Buffer | undefined,
  fileName: string,
  admit: (value: unknown) => value is T,
): T | undefined {
  if (!buffer) return undefined;
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    if (admit(value)) return value;
    logger.warn(`[S3 Restore] ${fileName} did not match expected shape`);
  } catch {
    logger.warn(`[S3 Restore] Failed to parse ${fileName}`);
  }
  return undefined;
}

async function restorePrivateBitmap<
  T extends { treeSize: number; includedBitmapRoot?: string; seenBitmapRoot?: string },
>(
  profile: ResolvedRuntimeProfile,
  bundleKey: string,
  journal: unknown,
  artifact: {
    fileName: string;
    label: string;
    journalKey: 'includedBitmapRoot' | 'seenBitmapRoot';
    parse: (value: unknown) => T | null | undefined;
  },
): Promise<T | undefined> {
  const key = deriveSiblingObjectKey(bundleKey, artifact.fileName);
  if (!key) return undefined;
  try {
    const buffer = await downloadFromS3(profile, key);
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    const parsed = artifact.parse(value);
    if (parsed && matchesJournalBitmapRoot(parsed, journal, artifact.journalKey)) return parsed;
    logger.warn(`[S3 Restore] ${artifact.fileName} failed validation or did not match journal bitmap metadata`);
  } catch (error) {
    handleOptionalArtifactFailure(error, artifact.label);
  }
  return undefined;
}

function restoreBundleReceipt(entries: ReadonlyMap<string, Buffer>, bundleKey: string): RestoredReceipt {
  const receiptBuffer = entries.get('receipt.json');
  if (!receiptBuffer) {
    throw new BundleArtifactError('receipt.json not found in bundle');
  }

  // Step 3: Parse receipt.json
  const receiptData: unknown = JSON.parse(receiptBuffer.toString('utf8'));
  const receiptRecord = isNonNullObject(receiptData) ? receiptData : null;
  if (!receiptRecord) {
    throw new Error('receipt.json must contain a JSON object');
  }
  const receiptPayload = getObjectProperty(receiptRecord, 'receipt') ?? receiptRecord;

  const journalData = restoreJournal(entries.get('journal.json'));
  const { publicInputArtifact, publicInput } = restorePublicInput(entries.get('public-input.json'), bundleKey);

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

  const electionManifest = restoreAuditArtifact(
    entries.get('election-manifest.json'),
    'election-manifest.json',
    isElectionManifest,
  );
  if (electionManifest !== undefined) restored.electionManifest = electionManifest;
  const closeStatement = restoreAuditArtifact(
    entries.get('close-statement.json'),
    'close-statement.json',
    isCloseStatement,
  );
  if (closeStatement !== undefined) restored.closeStatement = closeStatement;

  return restored;
}

/**
 * Restore receipt from S3 verification bundle
 *
 * Downloads bundle.zip from S3, extracts receipt.json, and returns parsed receipt data.
 *
 * @param bundleKey S3 object key (e.g., "sessions/{sessionId}/{finalizationId}/bundle.zip")
 * @returns Restored receipt and admitted receipt payload
 * @throws TransientBundleRestoreError after the S3 client's transient retries are exhausted
 * @throws Error if the object is definitively unavailable or the bundle artifact is invalid
 */
export async function restoreReceiptFromS3(
  profile: ResolvedRuntimeProfile,
  bundleKey: string,
): Promise<RestoredReceipt> {
  const keyPrefix = hashKeyPrefixForLogging(bundleKey);
  try {
    logger.info('[S3 Restore] Starting receipt restoration', {
      s3: {
        operation: 'restoreBundle',
        key_prefix: keyPrefix,
      },
    });

    // Step 1: Download bundle.zip from S3
    const zipBuffer = await downloadFromS3(profile, bundleKey);

    // Step 2: Read receipt.json, journal.json, and public-input.json from the zip
    const entries = await readZipEntriesFromBuffer(zipBuffer, [
      'receipt.json',
      'journal.json',
      'public-input.json',
      'election-manifest.json',
      'close-statement.json',
    ]);
    const restored = restoreBundleReceipt(entries, bundleKey);
    const includedBitmapArtifact = await restorePrivateBitmap(profile, bundleKey, restored.journal, {
      fileName: 'included-bitmap.json',
      label: 'Included bitmap artifact',
      journalKey: 'includedBitmapRoot',
      parse: parseIncludedBitmapArtifact,
    });
    if (includedBitmapArtifact !== undefined) restored.includedBitmapArtifact = includedBitmapArtifact;
    const seenBitmapArtifact = await restorePrivateBitmap(profile, bundleKey, restored.journal, {
      fileName: 'seen-bitmap.json',
      label: 'Seen bitmap artifact',
      journalKey: 'seenBitmapRoot',
      parse: parseSeenBitmapArtifact,
    });
    if (seenBitmapArtifact !== undefined) restored.seenBitmapArtifact = seenBitmapArtifact;

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

function extractFinalizationIdFromBundleKey(bundleKey: string): string | undefined {
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
  if (!isNonNullObject(journal)) {
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
