import { afterEach, describe, expect, it, vi } from 'vitest';
import { getS3Config, resetS3Client } from '@stark-ballot/aws-adapters/aws/s3-client';

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
  resetS3Client();
}

describe('getS3Config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('does not provide legacy local defaults outside target AWS runtime', () => {
    delete process.env['TARGET_AWS_RUNTIME'];
    process.env['USE_S3'] = 'true';
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    delete process.env['S3_PROOF_BUCKET'];
    delete process.env['S3_PROOF_PREFIX'];

    expect(() => getS3Config()).toThrow('TARGET_AWS_RUNTIME=1 is required for S3 proof storage');
  });

  it('requires explicit S3 enablement in target AWS runtime', () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    delete process.env['USE_S3'];
    process.env['AWS_DEFAULT_REGION'] = 'ap-northeast-1';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';

    expect(() => getS3Config()).toThrow('USE_S3=true is required for S3 proof storage');
  });

  it('requires explicit bucket, prefix, region, and expected owner in target AWS runtime', () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';

    expect(() => getS3Config()).toThrow('AWS_REGION or AWS_DEFAULT_REGION is required for target AWS runtime');

    process.env['AWS_REGION'] = 'ap-northeast-1';
    delete process.env['S3_PROOF_BUCKET'];
    expect(() => getS3Config()).toThrow('S3_PROOF_BUCKET is required for target AWS runtime');

    process.env['S3_PROOF_BUCKET'] = 'target-bucket';
    delete process.env['S3_PROOF_PREFIX'];
    expect(() => getS3Config()).toThrow('S3_PROOF_PREFIX is required for target AWS runtime');

    process.env['S3_PROOF_PREFIX'] = 'sessions/';
    delete process.env['AWS_ACCOUNT_ID'];
    expect(() => getS3Config()).toThrow('AWS_ACCOUNT_ID is required for target AWS runtime S3 owner protection');
  });

  it('accepts explicit target AWS runtime S3 config', () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';
    process.env['AWS_DEFAULT_REGION'] = 'ap-northeast-1';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';

    expect(getS3Config()).toEqual({
      region: 'ap-northeast-1',
      bucket: 'stark-ballot-simulator-stark-dev-develop-proof-artifacts',
      prefix: 'sessions/',
      expectedBucketOwner: '123456789012',
    });
  });

  it.each([
    [
      'stark-ballot-simulator-proof-bundles-develop',
      'sessions/',
      'S3_PROOF_BUCKET must reference Terraform-managed target runtime resources',
    ],
    [
      'stark-ballot-simulator-legacy-proof-artifacts',
      'sessions/',
      'S3_PROOF_BUCKET must reference Terraform-managed target runtime resources',
    ],
    [
      'stark-ballot-simulator-stark-dev-main-proof-artifacts',
      'sessions/',
      'S3_PROOF_BUCKET must reference the Terraform-managed target proof/artifact bucket',
    ],
    [
      'stark-ballot-simulator-stark-dev-develop-proof-artifacts',
      'public/',
      'S3_PROOF_PREFIX must match the Terraform-managed target proof/artifact prefix',
    ],
  ])('rejects invalid target AWS runtime S3 config bucket=%s prefix=%s', (bucket, prefix, expectedMessage) => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';
    process.env['AWS_DEFAULT_REGION'] = 'ap-northeast-1';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = bucket;
    process.env['S3_PROOF_PREFIX'] = prefix;

    expect(() => getS3Config()).toThrow(expectedMessage);
  });
});
