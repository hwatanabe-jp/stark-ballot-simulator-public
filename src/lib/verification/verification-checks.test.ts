import { describe, expect, it } from 'vitest';
import { getVerificationRequiredCheckIdsForStep, getVerificationStepInputs } from './verification-checks';

describe('verification-checks step metadata', () => {
  it('includes optional audit inputs in recorded_as_cast step highlights', () => {
    expect(getVerificationStepInputs('recorded_as_cast')).toEqual([
      'user.commitment',
      'user.voteReceipt',
      'user.merklePath',
      'treeSize',
      'bulletinRoot',
      'sthDigest',
    ]);
  });

  it('only treats third-party STH as required when sources are configured', () => {
    expect(getVerificationRequiredCheckIdsForStep('recorded_as_cast', { sthSourcesConfigured: false })).not.toContain(
      'recorded_sth_third_party',
    );
    expect(getVerificationRequiredCheckIdsForStep('recorded_as_cast', { sthSourcesConfigured: true })).toContain(
      'recorded_sth_third_party',
    );
  });
});
