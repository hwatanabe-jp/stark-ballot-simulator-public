import type {
  VerificationDisplayStatus,
  VerificationPresentationPolicyResult,
} from '@stark-ballot/verification/presentation-policy';

export function resolveEligibleRenderedVerificationStatus(
  policy: VerificationPresentationPolicyResult,
): VerificationDisplayStatus | null {
  if (policy.display.renderedStatus !== 'verified') {
    return policy.display.renderedStatus;
  }
  return policy.fullyVerifiedLabelEligible ? 'verified' : null;
}
