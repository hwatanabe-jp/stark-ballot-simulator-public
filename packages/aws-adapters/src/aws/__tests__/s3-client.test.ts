import { afterEach, describe, expect, it } from 'vitest';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';
import { getS3Config, resetS3Client } from '@stark-ballot/aws-adapters/aws/s3-client';

describe('getS3Config', () => {
  afterEach(() => {
    resetS3Client();
  });

  it.each(['local-demo', 'static-mock-e2e', 'local-proof-development', 'local-proof-production'] as const)(
    'rejects S3 proof storage for the %s profile',
    (profileName) => {
      expect(() => getS3Config(localRuntimeProfile(profileName))).toThrow(
        'The selected runtime profile does not permit S3 proof storage',
      );
    },
  );

  it('derives S3 config only from the resolved target profile', () => {
    const profile = targetRuntimeProfile();
    if (profile.external.kind !== 'aws') {
      throw new Error('Expected target AWS profile fixture');
    }

    expect(getS3Config(profile)).toEqual({
      region: profile.external.region,
      bucket: profile.external.artifactStorage.bucket,
      prefix: profile.external.artifactStorage.prefix,
      expectedBucketOwner: profile.external.accountId,
    });
  });
});
