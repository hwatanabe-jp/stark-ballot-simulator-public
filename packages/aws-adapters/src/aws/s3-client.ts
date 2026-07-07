import { S3Client } from '@aws-sdk/client-s3';
import { validateTargetS3ProofReferences } from '@stark-ballot/runtime-config/env/targetRuntimeReferences';
import { isTargetAwsRuntime } from '@stark-ballot/runtime-config/env/targetRuntime';

/**
 * S3 client configuration
 *
 * This module provides a configured S3 client for proof bundle storage.
 *
 * Authentication methods (in order of precedence):
 * 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 2. AWS CLI profile (AWS_PROFILE)
 * 3. IAM role (Lambda/EC2 execution environment)
 */

export interface S3Config {
  region: string;
  bucket: string;
  prefix: string;
  expectedBucketOwner?: string;
}

/**
 * Load S3 configuration from environment variables
 */
export function getS3Config(): S3Config {
  const targetAwsRuntime = isTargetAwsRuntime();
  const region = process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'];
  const expectedBucketOwner = process.env['AWS_ACCOUNT_ID'];
  const bucket = process.env['S3_PROOF_BUCKET'];
  const prefix = process.env['S3_PROOF_PREFIX'];

  if (!targetAwsRuntime) {
    throw new Error('TARGET_AWS_RUNTIME=1 is required for S3 proof storage');
  }
  if (process.env['USE_S3'] !== 'true') {
    throw new Error('USE_S3=true is required for S3 proof storage');
  }
  if (!region) {
    throw new Error('AWS_REGION or AWS_DEFAULT_REGION is required for target AWS runtime');
  }
  if (!bucket) {
    throw new Error('S3_PROOF_BUCKET is required for target AWS runtime');
  }
  if (!prefix) {
    throw new Error('S3_PROOF_PREFIX is required for target AWS runtime');
  }
  if (!expectedBucketOwner) {
    throw new Error('AWS_ACCOUNT_ID is required for target AWS runtime S3 owner protection');
  }
  if (!/^[0-9]{12}$/.test(expectedBucketOwner)) {
    throw new Error('AWS_ACCOUNT_ID must be a 12-digit AWS account ID for target AWS runtime S3 owner protection');
  }
  validateTargetS3ProofReferences({
    s3ProofBucket: bucket,
    s3ProofPrefix: prefix,
  });

  return {
    region,
    bucket,
    prefix,
    expectedBucketOwner,
  };
}

/**
 * Create a configured S3 client
 *
 * Credentials are automatically resolved by the SDK in the following order:
 * 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 2. AWS CLI profile (AWS_PROFILE environment variable)
 * 3. IAM role credentials (Lambda/EC2)
 */
export function createS3Client(): S3Client {
  const config = getS3Config();

  return new S3Client({
    region: config.region,
    // Credentials are automatically resolved by the SDK
    // No need to explicitly pass them here
  });
}

/**
 * Singleton S3 client instance
 */
let s3ClientInstance: S3Client | null = null;

/**
 * Get or create S3 client instance
 */
export function getS3Client(): S3Client {
  if (!s3ClientInstance) {
    s3ClientInstance = createS3Client();
  }
  return s3ClientInstance;
}

/**
 * Reset S3 client instance (useful for testing)
 */
export function resetS3Client(): void {
  s3ClientInstance = null;
}
