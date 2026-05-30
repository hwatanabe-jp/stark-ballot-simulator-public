import { PutObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import path from 'path';
import { getS3Client, getS3Config } from './s3-client';
import { logger } from '@/lib/utils/logger';
import { hashKeyPrefixForLogging } from '@/lib/utils/logging';

/**
 * S3 Upload Result
 */
export interface S3UploadResult {
  bucket: string;
  key: string;
  uploadedAt: string;
  success: boolean;
  error?: string;
}

/**
 * Upload Options
 */
export interface S3UploadOptions {
  sessionId: string;
  executionId: string;
  filePath: string;
  contentType?: string;
  maxRetries?: number;
}

/**
 * Upload a file to S3 with retry logic
 *
 * @param options Upload options
 * @returns Upload result with S3 key and timestamp
 */
export async function uploadFileToS3(options: S3UploadOptions): Promise<S3UploadResult> {
  const { sessionId, executionId, filePath, contentType = 'application/zip', maxRetries = 3 } = options;

  const config = getS3Config();
  const client = getS3Client();

  // Construct S3 key: sessions/<sessionId>/<executionId>/bundle.zip
  const fileName = path.basename(filePath);
  const key = `${config.prefix}${sessionId}/${executionId}/${fileName}`;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Read file content
      const fileContent = await fs.readFile(filePath);

      // Upload to S3
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: fileContent,
        ContentType: contentType,
        Metadata: {
          sessionId,
          executionId,
          uploadedAt: new Date().toISOString(),
        },
      });

      await client.send(command);

      logger.info('[S3] Upload successful', {
        s3: {
          operation: 'putObject',
          bucket: config.bucket,
          key_prefix: hashKeyPrefixForLogging(key),
        },
      });

      return {
        bucket: config.bucket,
        key,
        uploadedAt: new Date().toISOString(),
        success: true,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(`[S3] Upload attempt ${attempt}/${maxRetries} failed:`, lastError.message);

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  logger.error(`[S3] Upload failed after ${maxRetries} attempts:`, lastError?.message);

  return {
    bucket: config.bucket,
    key,
    uploadedAt: new Date().toISOString(),
    success: false,
    error: lastError?.message || 'Unknown error',
  };
}

/**
 * Check if S3 upload is enabled
 */
export function isS3UploadEnabled(): boolean {
  return process.env.USE_S3 === 'true' || isLambdaRuntime();
}

function isLambdaRuntime(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}
