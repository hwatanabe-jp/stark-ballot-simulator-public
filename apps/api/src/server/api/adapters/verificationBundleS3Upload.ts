import { promises as fs } from 'node:fs';
import path from 'node:path';
import { uploadFileToS3 } from '@stark-ballot/aws-adapters/aws/s3-upload';
import { createVerificationBundleArchive } from '@stark-ballot/node-adapters/verification-bundle';
import { PUBLIC_BUNDLE_ALLOWLIST, REQUIRED_PUBLIC_BUNDLE_ARTIFACTS } from '@stark-ballot/verification/bundle';
import type { BundlePublicationResult } from './proofBundleService';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging } from '@stark-ballot/diagnostics/logging';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

/**
 * Uploads a completed verification bundle directory to S3 for authenticated API delivery.
 */
export async function publishVerificationBundleArtifacts(input: {
  bundlePath: string;
  sessionId: string;
  executionId: string;
  upload: boolean;
}): Promise<BundlePublicationResult> {
  const { bundlePath, sessionId, executionId, upload } = input;
  const useS3 = process.env['USE_S3'] === 'true';
  const targetAwsRuntime = process.env['TARGET_AWS_RUNTIME'] === '1';
  if (upload && targetAwsRuntime && !useS3) {
    throw new Error('USE_S3=true is required for target AWS runtime bundle persistence');
  }

  const bundleArchivePath = await createVerificationBundleArchive(bundlePath, {
    publicBundleAllowlist: PUBLIC_BUNDLE_ALLOWLIST,
    requiredPublicBundleArtifacts: REQUIRED_PUBLIC_BUNDLE_ARTIFACTS,
  });
  if (!upload) {
    return { bundleArchivePath };
  }

  if (!useS3) {
    logger.info('[Bundle] S3 upload disabled (USE_S3=false)');
    return { bundleArchivePath };
  }

  try {
    const uploadResult = await uploadFileToS3({
      sessionId,
      executionId,
      filePath: bundleArchivePath,
      contentType: 'application/zip',
    });

    if (!uploadResult.success) {
      logger.warn(`[Bundle] S3 upload failed: ${uploadResult.error}`);
      if (targetAwsRuntime) {
        throw new Error(`Target AWS runtime bundle upload failed: ${uploadResult.error ?? 'unknown error'}`);
      }
      return { bundleArchivePath };
    }

    const s3ReportKey = await uploadOptionalReport(bundlePath, sessionId, executionId, targetAwsRuntime);
    await uploadPrivateSidecar(bundlePath, sessionId, executionId, 'included-bitmap.json', 'Included bitmap');
    await uploadPrivateSidecar(bundlePath, sessionId, executionId, 'seen-bitmap.json', 'Seen bitmap');

    logger.info('[Bundle] S3 upload successful', {
      s3: {
        operation: 'putObject',
        key_prefix: uploadResult.key ? hashKeyPrefixForLogging(uploadResult.key) : undefined,
      },
    });

    return {
      bundleArchivePath,
      s3BundleKey: uploadResult.key,
      ...omitUndefinedProperties({ s3ReportKey: s3ReportKey }),
      s3UploadedAt: uploadResult.uploadedAt,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[Bundle] S3 upload error:`, errorMessage);
    if (targetAwsRuntime) {
      throw error instanceof Error ? error : new Error(errorMessage);
    }
    return { bundleArchivePath };
  }
}

export async function uploadVerificationBundleToS3(
  bundlePath: string,
  sessionId: string,
  executionId: string,
): Promise<BundlePublicationResult> {
  return publishVerificationBundleArtifacts({ bundlePath, sessionId, executionId, upload: true });
}

async function uploadOptionalReport(
  bundlePath: string,
  sessionId: string,
  executionId: string,
  targetAwsRuntime: boolean,
): Promise<string | undefined> {
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
      return reportUploadResult.key;
    }
    logger.warn(`[Bundle] Verification report upload failed: ${reportUploadResult.error}`);
    if (targetAwsRuntime) {
      throw new Error(
        `Target AWS runtime verification report upload failed: ${reportUploadResult.error ?? 'unknown error'}`,
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[Bundle] Verification report upload skipped:`, errorMessage);
    if (targetAwsRuntime) {
      throw new Error(`Target AWS runtime verification report upload unavailable: ${errorMessage}`);
    }
  }

  return undefined;
}

async function uploadPrivateSidecar(
  bundlePath: string,
  sessionId: string,
  executionId: string,
  fileName: string,
  label: string,
): Promise<void> {
  const targetAwsRuntime = process.env['TARGET_AWS_RUNTIME'] === '1';
  const filePath = path.join(bundlePath, fileName);
  try {
    await fs.access(filePath);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[Bundle] ${label} upload skipped:`, errorMessage);
    return;
  }

  try {
    const sidecarUploadResult = await uploadFileToS3({
      sessionId,
      executionId,
      filePath,
      contentType: 'application/json',
    });
    if (!sidecarUploadResult.success) {
      logger.warn(`[Bundle] ${label} upload failed: ${sidecarUploadResult.error}`);
      if (targetAwsRuntime) {
        throw new Error(
          `Target AWS runtime ${label.toLowerCase()} upload failed: ${sidecarUploadResult.error ?? 'unknown error'}`,
        );
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[Bundle] ${label} upload failed:`, errorMessage);
    if (targetAwsRuntime) {
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }
}
