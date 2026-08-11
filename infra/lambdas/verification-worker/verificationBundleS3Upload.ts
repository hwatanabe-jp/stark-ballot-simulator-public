import { promises as fs } from 'node:fs';
import path from 'node:path';
import { uploadFileToS3 } from '@stark-ballot/aws-adapters/aws/s3-upload';
import { createVerificationBundleArchive } from '@stark-ballot/node-adapters/verification-bundle';
import { resolvePublicBundlePolicy } from '@stark-ballot/verification/public-bundle-manifest';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging } from '@stark-ballot/diagnostics/logging';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

const ASYNC_PUBLIC_BUNDLE_POLICY = resolvePublicBundlePolicy('async');

export interface BundlePublicationResult {
  bundleArchivePath: string;
  s3BundleKey?: string;
  s3ReportKey?: string;
  s3UploadedAtMs?: number;
}

/**
 * Uploads a completed verification bundle directory to S3 for authenticated API delivery.
 */
export async function publishVerificationBundleArtifacts(input: {
  profile: ResolvedRuntimeProfile;
  bundlePath: string;
  sessionId: string;
  finalizationId: string;
  upload: boolean;
}): Promise<BundlePublicationResult> {
  const { profile, bundlePath, sessionId, finalizationId, upload } = input;
  const useS3 = profile.artifacts.kind === 's3';
  const targetAwsRuntime = profile.target.kind === 'aws';

  const bundleArchivePath = await createVerificationBundleArchive(bundlePath, {
    policy: ASYNC_PUBLIC_BUNDLE_POLICY,
  });
  if (!upload) {
    return { bundleArchivePath };
  }

  if (!useS3) {
    logger.info('[Bundle] Local artifact profile selected; S3 upload skipped');
    return { bundleArchivePath };
  }

  try {
    const uploadResult = await uploadFileToS3({
      profile,
      sessionId,
      finalizationId,
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

    const s3ReportKey = await uploadOptionalReport(profile, bundlePath, sessionId, finalizationId, targetAwsRuntime);
    await uploadPrivateSidecar(
      profile,
      bundlePath,
      sessionId,
      finalizationId,
      'included-bitmap.json',
      'Included bitmap',
    );
    await uploadPrivateSidecar(profile, bundlePath, sessionId, finalizationId, 'seen-bitmap.json', 'Seen bitmap');

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
      s3UploadedAtMs: uploadResult.uploadedAtMs,
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
  profile: ResolvedRuntimeProfile,
  bundlePath: string,
  sessionId: string,
  finalizationId: string,
): Promise<BundlePublicationResult> {
  return publishVerificationBundleArtifacts({ profile, bundlePath, sessionId, finalizationId, upload: true });
}

async function uploadOptionalReport(
  profile: ResolvedRuntimeProfile,
  bundlePath: string,
  sessionId: string,
  finalizationId: string,
  targetAwsRuntime: boolean,
): Promise<string | undefined> {
  const reportPath = path.join(bundlePath, 'verification.json');
  try {
    await fs.access(reportPath);
    const reportUploadResult = await uploadFileToS3({
      profile,
      sessionId,
      finalizationId,
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
  profile: ResolvedRuntimeProfile,
  bundlePath: string,
  sessionId: string,
  finalizationId: string,
  fileName: string,
  label: string,
): Promise<void> {
  const targetAwsRuntime = profile.target.kind === 'aws';
  const filePath = path.join(bundlePath, fileName);
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[Bundle] ${label} access failed:`, errorMessage);
    if (targetAwsRuntime) {
      throw error instanceof Error ? error : new Error(errorMessage);
    }
    return;
  }

  try {
    const sidecarUploadResult = await uploadFileToS3({
      profile,
      sessionId,
      finalizationId,
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
