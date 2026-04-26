import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '@/lib/utils/logger';
import { hashKeyPrefixForLogging } from '@/lib/utils/logging';
import { getS3Client, getS3Config } from './s3-client';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
const DEFAULT_BUNDLE_SIGNED_URL_TTL_SECONDS = 300;
const MAX_BUNDLE_SIGNED_URL_TTL_SECONDS = 900;

function resolveBundlePresignedUrlTtlSeconds(): number {
  const bundleTtl = parseSignedUrlTtlSeconds(
    process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS,
    DEFAULT_BUNDLE_SIGNED_URL_TTL_SECONDS,
  );
  return Math.min(bundleTtl, MAX_BUNDLE_SIGNED_URL_TTL_SECONDS);
}

/**
 * Presigned URL Options
 */
export interface PresignedUrlOptions {
  bucket?: string;
  key: string;
  expiresIn?: number; // seconds
}

/**
 * Presigned URL Result
 */
export interface PresignedUrlResult {
  url: string;
  expiresAt: string;
  expiresIn: number;
  success: boolean;
  error?: string;
}

/**
 * Generate a presigned URL for downloading a file from S3
 *
 * @param options URL generation options
 * @returns Presigned URL with expiration information
 */
export async function generatePresignedUrl(options: PresignedUrlOptions): Promise<PresignedUrlResult> {
  const config = getS3Config();
  const client = getS3Client();

  // Default TTL: 3600 seconds (1 hour)
  const defaultTtl = parseSignedUrlTtlSeconds(process.env.S3_SIGNED_URL_TTL_SECONDS, DEFAULT_SIGNED_URL_TTL_SECONDS);
  const expiresIn = options.expiresIn ?? defaultTtl;
  const bucket = options.bucket || config.bucket;
  const rawKeyPrefix = options.key.includes('/') ? options.key.split('/').slice(0, -1).join('/') + '/' : options.key;
  const keyPrefix = hashKeyPrefixForLogging(rawKeyPrefix);

  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: options.key,
    });

    const url = await getSignedUrl(client, command, {
      expiresIn,
    });

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    logger.info('generated presigned url', {
      event: 's3_presign_success',
      s3: {
        operation: 'getObject',
        bucket,
        key_prefix: keyPrefix,
        is_presigned: true,
      },
      expires_in: expiresIn,
    });

    return {
      url,
      expiresAt,
      expiresIn,
      success: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('failed to generate presigned url', {
      event: 's3_presign_failed',
      s3: {
        operation: 'getObject',
        bucket,
        key_prefix: keyPrefix,
        is_presigned: true,
        error_code: error instanceof Error ? error.name : 'UnknownError',
      },
      error: errorMessage,
    });

    return {
      url: '',
      expiresAt: new Date().toISOString(),
      expiresIn: 0,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Generate presigned URL for a verification bundle
 *
 * @param sessionId Session ID
 * @param executionId Execution ID
 * @param fileName File name (default: bundle.zip)
 * @returns Presigned URL result
 */
export async function generateBundlePresignedUrl(
  sessionId: string,
  executionId: string,
  fileName: string = 'bundle.zip',
): Promise<PresignedUrlResult> {
  const config = getS3Config();
  const key = `${config.prefix}${sessionId}/${executionId}/${fileName}`;
  return generateBundlePresignedUrlForKey(key);
}

export async function generateBundlePresignedUrlForKey(key: string): Promise<PresignedUrlResult> {
  return generatePresignedUrl({ key, expiresIn: resolveBundlePresignedUrlTtlSeconds() });
}

function parseSignedUrlTtlSeconds(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
