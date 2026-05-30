/**
 * Bundle restore module
 *
 * Restores STARK proof receipts from S3-stored verification bundles.
 * Handles zip extraction and JSON parsing with proper error handling.
 */

import { downloadFromS3 } from './s3-download';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { readZipEntriesFromBuffer } from '@/lib/utils/zip';
import { parseIncludedBitmapArtifact, type IncludedBitmapArtifact } from '@/lib/verification/included-bitmap-artifact';
import { parseSeenBitmapArtifact, type SeenBitmapArtifact } from '@/lib/verification/seen-bitmap-artifact';
import {
  parseSupportedPublicInputArtifact,
  type SupportedPublicInputArtifact,
} from '@/lib/verification/public-input-contract';
import {
  isCloseStatement,
  isElectionManifest,
  type CloseStatement,
  type ElectionManifest,
} from '@/lib/verification/public-audit-artifacts';
import { normalizeHexString } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';
import { hashKeyPrefixForLogging } from '@/lib/utils/logging';

/**
 * Restored receipt data structure
 */
export interface RestoredReceipt {
  receipt: unknown;
  receiptRaw: unknown;
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
 * @returns Restored receipt and receiptRaw
 * @throws Error if download fails, zip is invalid, or receipt.json is missing
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
      throw new Error('receipt.json not found in bundle');
    }

    // Step 3: Parse receipt.json
    const receiptData: unknown = JSON.parse(receiptBuffer.toString('utf8'));
    const receiptRecord = isRecord(receiptData) ? receiptData : null;
    const receiptPayload = receiptRecord ? (getRecordProperty(receiptRecord, 'receipt') ?? receiptRecord) : receiptData;

    // Step 4: Locate and parse journal.json (optional, may be large ~15 MB)
    const journalBuffer = entries.get('journal.json');
    let journalData: unknown = undefined;
    if (journalBuffer) {
      try {
        journalData = JSON.parse(journalBuffer.toString('utf8'));
        logger.info(`[S3 Restore] Journal restored successfully`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[S3 Restore] Failed to parse journal.json:`, errorMessage);
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
          executionId,
          bundleKey,
          source: 'bundle',
        });
        if (publicInputArtifact) {
          logger.info(`[S3 Restore] Public input authority restored successfully`);
        } else {
          logger.warn('[S3 Restore] public-input.json was readable but did not match the supported contract');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[S3 Restore] Failed to parse public-input.json:`, errorMessage);
      }
    }

    logger.info(`[S3 Restore] Receipt restored successfully`);

    // receipt.json には { receipt: { seal, journal, ... }, imageId, ... } という構造が含まれる
    // finalizationResult.receipt には receipt フィールドの中身を代入する必要がある
    // receiptRaw には全体を保存
    const restored: RestoredReceipt = {
      receipt: receiptPayload, // receipt フィールドがあれば取り出す、なければ全体
      receiptRaw: receiptData, // 全オブジェクトを保存
      journal: journalData, // zkVMResult 全体（15 MB in production mode）
      publicInputArtifact,
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
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[S3 Restore] Failed to parse election-manifest.json:`, errorMessage);
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
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[S3 Restore] Failed to parse close-statement.json:`, errorMessage);
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[S3 Restore] Included bitmap artifact unavailable:`, errorMessage);
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[S3 Restore] Seen bitmap artifact unavailable:`, errorMessage);
      }
    }

    return restored;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[S3 Restore] Failed to restore receipt', {
      s3: {
        operation: 'restoreBundle',
        key_prefix: keyPrefix,
      },
      errorMessage,
    });
    throw new Error(`Receipt restoration failed: ${errorMessage}`);
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
