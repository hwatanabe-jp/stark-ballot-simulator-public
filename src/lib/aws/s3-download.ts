/**
 * S3 download module
 *
 * Downloads verification bundles from S3 for receipt restoration.
 * Handles large files (up to ~25 MiB) with stream-based processing.
 */

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '@/lib/utils/logger';
import { hashKeyPrefixForLogging } from '@/lib/utils/logging';
import { getS3Client } from './s3-client';

export interface S3ObjectMetadata {
  contentLength: number;
}

export interface S3ByteRange {
  start: number;
  end: number;
}

export interface S3RangeDownload {
  body: Buffer;
  contentLength?: number;
  contentRange?: string;
}

function buildS3LogFields(operation: string, bucket: string, bucketKey: string): Record<string, unknown> {
  return {
    s3: {
      operation,
      bucket,
      key_prefix: hashKeyPrefixForLogging(bucketKey),
    },
  };
}

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

  logger.info('[S3 Download] Fetching object from S3', buildS3LogFields('getObject', bucket, bucketKey));

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: bucketKey,
  });

  const response = await client.send(command);

  if (!response.Body) {
    throw new Error('S3 object not found');
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

  logger.info('[S3 Download] Downloaded object from S3', {
    ...buildS3LogFields('getObject', bucket, bucketKey),
    bytes: buffer.byteLength,
  });

  return buffer;
}

export async function headS3Object(bucketKey: string): Promise<S3ObjectMetadata> {
  const client = getS3Client();
  const bucket = process.env.S3_PROOF_BUCKET || 'stark-ballot-simulator-proof-bundles-develop';

  const response = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: bucketKey,
    }),
  );

  if (typeof response.ContentLength !== 'number' || !Number.isFinite(response.ContentLength)) {
    throw new Error('S3 object size unavailable');
  }

  return { contentLength: response.ContentLength };
}

export async function downloadRangeFromS3(bucketKey: string, range: S3ByteRange): Promise<S3RangeDownload> {
  const client = getS3Client();
  const bucket = process.env.S3_PROOF_BUCKET || 'stark-ballot-simulator-proof-bundles-develop';

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: bucketKey,
      Range: `bytes=${range.start}-${range.end}`,
    }),
  );

  if (!response.Body) {
    throw new Error('S3 object not found');
  }
  if (!isAsyncIterable(response.Body)) {
    throw new Error('S3 response body is not a readable stream');
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body) {
    if (!isUint8Array(chunk)) {
      throw new Error('S3 response chunk is not a Uint8Array');
    }
    chunks.push(chunk);
  }

  return {
    body: Buffer.concat(chunks),
    contentLength: response.ContentLength,
    contentRange: response.ContentRange,
  };
}
