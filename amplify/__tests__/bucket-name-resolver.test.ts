/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { resolveProofBundleBucketName } from '../lib/bucket-name-resolver';

describe('resolveProofBundleBucketName', () => {
  it('uses S3_PROOF_BUCKET when set', () => {
    const env = { S3_PROOF_BUCKET: 'custom-bucket' };
    const result = resolveProofBundleBucketName(env);
    expect(result).toBe('custom-bucket');
  });

  it('uses default when no environment variables are set', () => {
    const env = {};
    const result = resolveProofBundleBucketName(env);
    expect(result).toMatch(/proof-bundles-develop$/);
  });
});
