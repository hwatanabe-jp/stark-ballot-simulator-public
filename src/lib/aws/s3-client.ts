import { S3Client } from '@aws-sdk/client-s3';

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
}

/**
 * Load S3 configuration from environment variables
 */
export function getS3Config(): S3Config {
  const region = process.env.AWS_REGION || 'ap-northeast-1';
  const bucket = process.env.S3_PROOF_BUCKET || 'stark-ballot-simulator-proof-bundles-develop';
  const prefix = process.env.S3_PROOF_PREFIX || 'sessions/';

  return {
    region,
    bucket,
    prefix,
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
