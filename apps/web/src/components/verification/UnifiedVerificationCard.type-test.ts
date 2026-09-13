import type { VerificationPresentationPolicyResult } from '@stark-ballot/verification/presentation-policy';
import type { UnifiedVerificationCardProps } from './UnifiedVerificationCard';

type Summary = NonNullable<UnifiedVerificationCardProps['summary']>;

// @ts-expect-error A literal status cannot grant Verified presentation eligibility.
const unsupportedVerified: Summary = { status: 'verified', message: 'type-test' };
const demo: Summary = { status: 'demo_only', message: 'type-test' };

function checkPolicyWitness(policy: VerificationPresentationPolicyResult): Summary | null {
  if (policy.fullyVerifiedLabelEligible) {
    return { status: 'verified', message: 'type-test', verifiedPresentation: policy };
  }
  // @ts-expect-error An ineligible policy cannot supply the private Verified witness.
  const ineligible: Summary = { status: 'verified', message: 'type-test', verifiedPresentation: policy };
  void ineligible;
  return null;
}

void unsupportedVerified;
void demo;
void checkPolicyWitness;
