import { S3Client } from '@aws-sdk/client-s3';
import { validateTargetS3ProofReferences } from '@stark-ballot/runtime-config/env/targetRuntimeReferences';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

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
export function getS3Config(profile: ResolvedRuntimeProfile): S3Config {
  if (profile.target.kind !== 'aws' || profile.artifacts.kind !== 's3' || profile.external.kind !== 'aws') {
    throw new Error('The selected runtime profile does not permit S3 proof storage');
  }
  const { region, accountId: expectedBucketOwner } = profile.external;
  const { bucket, prefix } = profile.external.artifactStorage;
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
function createS3Client(profile: ResolvedRuntimeProfile): S3Client {
  const config = getS3Config(profile);

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
export function getS3Client(profile: ResolvedRuntimeProfile): S3Client {
  if (!s3ClientInstance) {
    s3ClientInstance = createS3Client(profile);
  }
  return s3ClientInstance;
}

/**
 * Reset S3 client instance (useful for testing)
 */
export function resetS3Client(): void {
  s3ClientInstance = null;
}
