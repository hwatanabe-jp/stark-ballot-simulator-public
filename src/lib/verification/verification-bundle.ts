import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as yazl from 'yazl';
import type { ElectionConfig } from '@/lib/zkvm/election-config';
import type { ZkVMInput } from '@/lib/zkvm/types';
import type { ZkVMExecutionResult } from '@/lib/zkvm/executor';
import { serializeZkvmAggregatorInput } from '@/lib/zkvm/executor';
import { toPublicZkvmJournal } from '@/lib/zkvm/public-journal';
import type { ReceiptWithImageId } from '@/lib/verification/image-id-types';
import {
  buildCloseStatement,
  buildElectionManifest,
  resolveElectionConfigForManifest,
  type ElectionManifest,
} from '@/lib/verification/public-audit-artifacts';
import { createIncludedBitmapArtifact } from '@/lib/verification/included-bitmap-artifact';
import { createSeenBitmapArtifact } from '@/lib/verification/seen-bitmap-artifact';
import { getStringProperty } from '@/lib/utils/guards';
import {
  buildSupportedPublicInputArtifactFromZkvmInput,
  buildPublicInputArtifactFromZkvmInput,
} from '@/lib/verification/public-input-contract';
import { logger } from '@/lib/utils/logger';
import { resolveConsistentPublicAuditArtifacts } from '@/lib/finalize/finalization-result';

export interface VerificationBundleContext {
  sessionId: string;
  contractGeneration: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  electionManifest?: ElectionManifest;
  zkvmResult: ZkVMExecutionResult;
  normalizedReceipt?: {
    receipt?: ReceiptWithImageId;
    rawPayload?: Record<string, unknown>;
  };
}

export interface VerificationBundleResult {
  bundlePath: string;
  receiptPath: string;
  inputPath: string;
  journalPath: string;
  electionManifestPath: string;
  closeStatementPath: string;
  metadataPath: string;
  reportPath: string;
  sessionId: string;
  executionId: string;
}

const PUBLIC_BUNDLE_ALLOWLIST = new Set([
  'public-input.json',
  'election-manifest.json',
  'close-statement.json',
  'receipt.json',
  'journal.json',
  'metadata.json',
  'sth.json',
  'consistency-proof.json',
  // Private artifacts such as included-bitmap.json and seen-bitmap.json must stay out
  // of the public bundle even though they are persisted alongside it.
]);

const REQUIRED_PUBLIC_BUNDLE_ARTIFACTS = [
  'public-input.json',
  'election-manifest.json',
  'close-statement.json',
  'receipt.json',
  'journal.json',
  'metadata.json',
] as const;

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} for bundle path`);
  }
}

function resolveVerifierWorkDir(): string {
  const envDir = process.env.VERIFIER_WORK_DIR?.trim();
  if (envDir) {
    return path.resolve(envDir);
  }

  return path.resolve('.verifier-bundles');
}

function resolveBundlePath(baseDir: string, sessionId: string, executionId: string): string {
  assertSafePathSegment(sessionId, 'sessionId');
  assertSafePathSegment(executionId, 'executionId');

  const resolvedBaseDir = path.resolve(baseDir);
  const bundlePath = path.resolve(resolvedBaseDir, sessionId, executionId);
  const relative = path.relative(resolvedBaseDir, bundlePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Bundle path escapes base directory');
  }

  return bundlePath;
}

/**
 * S3 upload result
 */
export interface S3UploadResult {
  s3BundleUrl?: string;
  s3BundleKey?: string;
  s3ReportKey?: string;
  s3UploadedAt?: string;
  s3BundleExpiresAt?: string;
}

export async function persistVerificationBundle(context: VerificationBundleContext): Promise<VerificationBundleResult> {
  const baseDir = resolveVerifierWorkDir();
  const executionId = crypto.randomUUID();
  const bundlePath = resolveBundlePath(baseDir, context.sessionId, executionId);

  const serializedInput = serializeZkvmAggregatorInput(context.zkvmInput);
  const privateInputPayload = {
    ...serializedInput,
    election_config: {
      totalExpected: context.electionConfig.totalExpected,
      choices: [...context.electionConfig.choices],
      version: context.electionConfig.version,
      botCount: context.electionConfig.botCount,
      merkleTreeDepth: context.electionConfig.merkleTreeDepth,
    },
  };

  const publicInput = buildPublicInputArtifactFromZkvmInput(
    context.zkvmInput,
    context.zkvmResult.methodVersion,
    context.contractGeneration,
  );
  const canonicalJournal = toPublicZkvmJournal(context.zkvmResult);
  const publicInputArtifact = buildSupportedPublicInputArtifactFromZkvmInput(
    context.zkvmInput,
    context.zkvmResult.methodVersion,
    context.contractGeneration,
    { source: 'generated' },
  );

  const electionManifest =
    context.electionManifest ??
    buildElectionManifest(
      context.zkvmInput.electionId,
      resolveElectionConfigForManifest({
        electionConfig: context.electionConfig,
        electionConfigHash: context.zkvmInput.electionConfigHash,
        totalExpected: context.zkvmInput.totalExpected,
      }),
    );

  const closeStatement = buildCloseStatement({
    logId: publicInput.logId,
    treeSize: canonicalJournal.treeSize,
    timestamp: publicInput.timestamp,
    bulletinRoot: canonicalJournal.bulletinRoot,
  });

  const artifactResolution = resolveConsistentPublicAuditArtifacts({
    journal: canonicalJournal,
    publicInputArtifact,
    electionManifest,
    closeStatement,
    hasLocalPublicInputAuthority: true,
  });
  if (artifactResolution.issues.length > 0) {
    throw new Error(
      `Public audit artifacts are inconsistent with canonical proof data: ${artifactResolution.issues
        .map((issue) => `${issue.artifact}:${issue.reason}`)
        .join(', ')}`,
    );
  }

  const receiptPayload = resolveReceiptPayload(context);

  const metadata = {
    sessionId: context.sessionId,
    createdAt: new Date().toISOString(),
    methodVersion: context.zkvmResult.methodVersion,
  };

  await fs.mkdir(bundlePath, { recursive: true });

  const inputPath = path.join(bundlePath, 'input.json');
  const publicInputPath = path.join(bundlePath, 'public-input.json');
  const includedBitmapPath = path.join(bundlePath, 'included-bitmap.json');
  const seenBitmapPath = path.join(bundlePath, 'seen-bitmap.json');
  const journalPath = path.join(bundlePath, 'journal.json');
  const receiptPath = path.join(bundlePath, 'receipt.json');
  const electionManifestPath = path.join(bundlePath, 'election-manifest.json');
  const closeStatementPath = path.join(bundlePath, 'close-statement.json');
  const metadataPath = path.join(bundlePath, 'metadata.json');
  const reportPath = path.join(bundlePath, 'verification.json');

  await fs.writeFile(inputPath, JSON.stringify(privateInputPayload, null, 2), 'utf-8');
  await fs.writeFile(publicInputPath, JSON.stringify(publicInput, null, 2), 'utf-8');

  if (context.zkvmResult.includedBitmap) {
    const includedBitmapArtifact = createIncludedBitmapArtifact({
      includedBitmap: context.zkvmResult.includedBitmap,
      includedBitmapRoot: context.zkvmResult.includedBitmapRoot,
      treeSize: context.zkvmResult.treeSize,
    });
    await fs.writeFile(includedBitmapPath, JSON.stringify(includedBitmapArtifact, null, 2), 'utf-8');
  }

  if (context.zkvmResult.seenBitmap && context.zkvmResult.seenBitmapRoot) {
    const seenBitmapArtifact = createSeenBitmapArtifact({
      seenBitmap: context.zkvmResult.seenBitmap,
      seenBitmapRoot: context.zkvmResult.seenBitmapRoot,
      treeSize: context.zkvmResult.treeSize,
    });
    await fs.writeFile(seenBitmapPath, JSON.stringify(seenBitmapArtifact, null, 2), 'utf-8');
  }

  await fs.writeFile(electionManifestPath, JSON.stringify(electionManifest, null, 2), 'utf-8');
  await fs.writeFile(closeStatementPath, JSON.stringify(closeStatement, null, 2), 'utf-8');
  await fs.writeFile(journalPath, JSON.stringify(canonicalJournal, null, 2), 'utf-8');
  await fs.writeFile(receiptPath, JSON.stringify(receiptPayload, null, 2), 'utf-8');
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

  return {
    bundlePath,
    receiptPath,
    inputPath,
    journalPath,
    electionManifestPath,
    closeStatementPath,
    metadataPath,
    reportPath,
    sessionId: context.sessionId,
    executionId,
  };
}

/**
 * Upload verification bundle to S3
 *
 * This function should be called AFTER invokeVerifierService has written verification.json
 * to ensure the bundle is complete.
 *
 * @param bundlePath Path to the bundle directory (contains all JSON files including verification.json)
 * @param sessionId Session identifier
 * @param executionId Execution identifier
 * @returns S3 upload result with presigned URL
 */
export async function uploadVerificationBundleToS3(
  bundlePath: string,
  sessionId: string,
  executionId: string,
): Promise<S3UploadResult> {
  // Check if S3 upload is enabled
  const useS3 = process.env.USE_S3 === 'true';
  if (!useS3) {
    logger.info('[Bundle] S3 upload disabled (USE_S3=false)');
    return {};
  }

  try {
    const { uploadFileToS3 } = await import('@/lib/aws/s3-upload');
    const { generateBundlePresignedUrl } = await import('@/lib/aws/presigned-url');

    // Create public bundle archive (allowlist of public JSON artifacts only)
    const bundleArchivePath = await createVerificationBundleArchive(bundlePath);

    // Upload archive to S3
    const uploadResult = await uploadFileToS3({
      sessionId,
      executionId,
      filePath: bundleArchivePath,
      contentType: 'application/zip',
    });

    if (!uploadResult.success) {
      logger.warn(`[Bundle] S3 upload failed: ${uploadResult.error}`);
      return {};
    }

    let s3ReportKey: string | undefined;

    // Upload verification report JSON for direct access
    const reportPath = path.join(bundlePath, 'verification.json');
    try {
      await fs.access(reportPath);
      const reportUploadResult = await uploadFileToS3({
        sessionId,
        executionId,
        filePath: reportPath,
        contentType: 'application/json',
      });
      if (reportUploadResult.success) {
        s3ReportKey = reportUploadResult.key;
      } else {
        logger.warn(`[Bundle] Verification report upload failed: ${reportUploadResult.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[Bundle] Verification report upload skipped:`, errorMessage);
    }

    const includedBitmapPath = path.join(bundlePath, 'included-bitmap.json');
    try {
      await fs.access(includedBitmapPath);
      await uploadFileToS3({
        sessionId,
        executionId,
        filePath: includedBitmapPath,
        contentType: 'application/json',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[Bundle] Included bitmap upload skipped:`, errorMessage);
    }

    const seenBitmapPath = path.join(bundlePath, 'seen-bitmap.json');
    try {
      await fs.access(seenBitmapPath);
      await uploadFileToS3({
        sessionId,
        executionId,
        filePath: seenBitmapPath,
        contentType: 'application/json',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[Bundle] Seen bitmap upload skipped:`, errorMessage);
    }

    // Generate presigned URL
    const urlResult = await generateBundlePresignedUrl(sessionId, executionId);

    if (!urlResult.success) {
      logger.warn(`[Bundle] Presigned URL generation failed: ${urlResult.error}`);
      return {
        s3BundleKey: uploadResult.key,
        s3ReportKey,
        s3UploadedAt: uploadResult.uploadedAt,
        s3BundleExpiresAt: undefined,
      };
    }

    logger.info(`[Bundle] S3 upload successful: ${uploadResult.key}`);

    return {
      s3BundleUrl: urlResult.url,
      s3BundleKey: uploadResult.key,
      s3ReportKey,
      s3UploadedAt: uploadResult.uploadedAt,
      s3BundleExpiresAt: urlResult.expiresAt,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[Bundle] S3 upload error:`, errorMessage);
    return {};
  }
}

function resolveReceiptPayload(context: VerificationBundleContext): unknown {
  const { zkvmResult, normalizedReceipt } = context;
  const derivedImageId =
    normalizedReceipt?.receipt?.imageId ?? zkvmResult.imageId ?? getStringProperty(zkvmResult, 'imageID');

  if (zkvmResult.receipt?.raw && typeof zkvmResult.receipt.raw === 'object') {
    return injectImageIdentifiers(zkvmResult.receipt.raw as Record<string, unknown>, derivedImageId);
  }

  if (normalizedReceipt?.rawPayload) {
    return injectImageIdentifiers(normalizedReceipt.rawPayload, derivedImageId);
  }

  if (normalizedReceipt?.receipt) {
    const { receipt } = normalizedReceipt;
    return {
      receipt: {
        seal: receipt.seal,
        journal: receipt.journal,
        imageId: receipt.imageId,
        image_id: receipt.imageId,
      },
      imageId: receipt.imageId,
      image_id: receipt.imageId,
    };
  }

  throw new Error('zkVM receipt payload unavailable for verification bundle');
}

function injectImageIdentifiers(
  payload: Record<string, unknown>,
  imageId: string | undefined,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  if (imageId) {
    if (typeof cloned.image_id !== 'string') {
      cloned.image_id = imageId;
    }
    if (typeof cloned.imageId !== 'string') {
      cloned.imageId = imageId;
    }

    if (cloned.receipt && typeof cloned.receipt === 'object') {
      const receipt = cloned.receipt as Record<string, unknown>;
      if (typeof receipt.image_id !== 'string') {
        receipt.image_id = imageId;
      }
      if (typeof receipt.imageId !== 'string') {
        receipt.imageId = imageId;
      }
    }
  }

  return cloned;
}

export async function createVerificationBundleArchive(bundlePath: string): Promise<string> {
  const archivePath = path.join(bundlePath, 'bundle.zip');

  try {
    await fs.rm(archivePath, { force: true });
  } catch {
    // noop
  }

  const entries = await fs.readdir(bundlePath, { withFileTypes: true });
  const filesToInclude = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((entry) => entry.toLowerCase().endsWith('.json'))
    .filter((entry) => PUBLIC_BUNDLE_ALLOWLIST.has(entry))
    .sort();

  const missingRequiredArtifacts = REQUIRED_PUBLIC_BUNDLE_ARTIFACTS.filter(
    (fileName) => !filesToInclude.includes(fileName),
  );
  if (missingRequiredArtifacts.length > 0) {
    throw new Error(`Missing required public bundle artifact(s): ${missingRequiredArtifacts.join(', ')}`);
  }

  if (filesToInclude.length === 0) {
    throw new Error('No public JSON artifacts found to archive');
  }

  await new Promise<void>((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    for (const fileName of filesToInclude) {
      zipfile.addFile(path.join(bundlePath, fileName), fileName, {
        mtime: new Date(0),
        compress: false,
      });
    }

    const output = createWriteStream(archivePath);
    output.on('close', resolve);
    output.on('error', reject);
    zipfile.outputStream.on('error', reject);
    zipfile.on('error', reject);

    zipfile.outputStream.pipe(output);
    zipfile.end();
  });

  return archivePath;
}
