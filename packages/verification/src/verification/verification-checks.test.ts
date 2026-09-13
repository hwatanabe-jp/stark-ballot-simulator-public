import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  getVerificationAllCheckDefinitionsForStep,
  getVerificationRequiredCheckIdsForStep,
  getVerificationStepInputs,
  type VerificationCheck,
} from './verification-checks';
import { deriveVerificationPresentationPolicy } from './verification-presentation-policy';

describe('verification-checks step metadata', () => {
  it('preserves required-check authority through its public projections', () => {
    const definition = getVerificationAllCheckDefinitionsForStep('cast_as_intended').find(
      (entry) => entry.id === 'cast_random_format',
    );
    if (!definition) throw new Error('Expected the required random-format check');

    const incompleteChecks: VerificationCheck[] = VERIFICATION_CHECK_DEFINITIONS.filter(
      (entry) => entry.id !== definition.id,
    ).map((entry) => ({
      id: entry.id,
      status: 'success',
      evidence: entry.evidence,
      inputs: [...entry.inputs],
    }));

    expect(Reflect.set(definition, 'criticality', 'optional')).toBe(false);
    expect(Reflect.set(definition.inputs, '0', 'unrelated')).toBe(false);
    expect(Reflect.deleteProperty(VERIFICATION_CHECK_DEFINITIONS, '0')).toBe(false);
    expect(getVerificationRequiredCheckIdsForStep('cast_as_intended')).toContain('cast_random_format');
    expect(
      deriveVerificationPresentationPolicy({ availability: 'available', checks: incompleteChecks })
        .fullyVerifiedLabelEligible,
    ).toBe(false);
  });

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
