/**
 * S3 download module
 *
 * Downloads verification bundles from S3 for receipt restoration.
 * Handles large files (up to ~25 MiB) with stream-based processing.
 */

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '@/lib/utils/logger';
import { getS3Client } from './s3-client';

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/**
 * Download a file from S3 bucket
 *
 * @param bucketKey S3 object key (e.g., "sessions/{sessionId}/{executionId}/bundle.zip")
 * @returns Buffer containing the downloaded file
 * @throws Error if download fails or object not found
 */
export async function downloadFromS3(bucketKey: string): Promise<Buffer> {
  const client = getS3Client();
  const bucket = process.env.S3_PROOF_BUCKET || 'stark-ballot-simulator-proof-bundles-develop';

  logger.info(`[S3 Download] Fetching from s3://${bucket}/${bucketKey}`);

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: bucketKey,
  });

  const response = await client.send(command);

  if (!response.Body) {
    throw new Error(`S3 object not found: ${bucketKey}`);
  }
  if (!isAsyncIterable(response.Body)) {
    throw new Error('S3 response body is not a readable stream');
  }

  // Stream to Buffer (memory-efficient for large files)
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body) {
    if (!isUint8Array(chunk)) {
      throw new Error('S3 response chunk is not a Uint8Array');
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  logger.info(`[S3 Download] Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MiB from S3`);

  return buffer;
}
