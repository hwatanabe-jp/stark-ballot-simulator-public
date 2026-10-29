/**
 * S3 download module
 *
 * Downloads verification bundles from S3 for receipt restoration.
 * Handles large files (up to ~25 MiB) with stream-based processing.
 */

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging } from '@stark-ballot/diagnostics/logging';
import { getS3Client, getS3Config } from './s3-client';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

export interface S3ObjectMetadata {
  contentLength: number;
  etag?: string;
  versionId?: string;
}

export interface S3ObjectDownload {
  body: Buffer;
  contentLength?: number;
  etag?: string;
  versionId?: string;
}

export interface S3ObjectReadCondition {
  etag?: string;
  versionId?: string;
}

export interface S3ByteRange {
  start: number;
  end: number;
}

export interface S3RangeDownload {
  body: Buffer;
  contentLength?: number;
  contentRange?: string;
  etag?: string;
  versionId?: string;
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

async function readS3ResponseBody(body: unknown): Promise<Buffer> {
  if (!body) {
    throw new Error('S3 object not found');
  }
  if (!isAsyncIterable(body)) {
    throw new Error('S3 response body is not a readable stream');
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    if (!isUint8Array(chunk)) {
      throw new Error('S3 response chunk is not a Uint8Array');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Download a file from S3 bucket
 *
 * @param bucketKey S3 object key (e.g., "sessions/{sessionId}/{finalizationId}/bundle.zip")
 * @returns Buffer containing the downloaded file
 * @throws Error if download fails or object not found
 */
export async function downloadS3Object(
  profile: ResolvedRuntimeProfile,
  bucketKey: string,
  condition: S3ObjectReadCondition = {},
): Promise<S3ObjectDownload> {
  const client = getS3Client(profile);
  const { bucket, expectedBucketOwner } = getS3Config(profile);

  logger.info('[S3 Download] Fetching object from S3', buildS3LogFields('getObject', bucket, bucketKey));

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: bucketKey,
    ExpectedBucketOwner: expectedBucketOwner,
    IfMatch: condition.etag,
    VersionId: condition.versionId,
  });

  const response = await client.send(command);

  const buffer = await readS3ResponseBody(response.Body);

  logger.info('[S3 Download] Downloaded object from S3', {
    ...buildS3LogFields('getObject', bucket, bucketKey),
    bytes: buffer.byteLength,
  });

  return {
    body: buffer,
    ...omitUndefinedProperties({
      contentLength: response.ContentLength,
      etag: response.ETag,
      versionId: response.VersionId,
    }),
  };
}

export async function downloadFromS3(profile: ResolvedRuntimeProfile, bucketKey: string): Promise<Buffer> {
  return (await downloadS3Object(profile, bucketKey)).body;
}

export async function headS3Object(profile: ResolvedRuntimeProfile, bucketKey: string): Promise<S3ObjectMetadata> {
  const client = getS3Client(profile);
  const { bucket, expectedBucketOwner } = getS3Config(profile);

  const response = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: bucketKey,
      ExpectedBucketOwner: expectedBucketOwner,
    }),
  );

  if (typeof response.ContentLength !== 'number' || !Number.isFinite(response.ContentLength)) {
    throw new Error('S3 object size unavailable');
  }

  return {
    contentLength: response.ContentLength,
    ...omitUndefinedProperties({
      etag: response.ETag,
      versionId: response.VersionId,
    }),
  };
}

export async function downloadRangeFromS3(
  profile: ResolvedRuntimeProfile,
  bucketKey: string,
  range: S3ByteRange,
  condition: S3ObjectReadCondition = {},
): Promise<S3RangeDownload> {
  const client = getS3Client(profile);
  const { bucket, expectedBucketOwner } = getS3Config(profile);

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: bucketKey,
      Range: `bytes=${range.start}-${range.end}`,
      ExpectedBucketOwner: expectedBucketOwner,
      IfMatch: condition.etag,
      VersionId: condition.versionId,
    }),
  );

  const buffer = await readS3ResponseBody(response.Body);

  return {
    body: buffer,
    ...omitUndefinedProperties({
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      etag: response.ETag,
      versionId: response.VersionId,
    }),
  };
}
