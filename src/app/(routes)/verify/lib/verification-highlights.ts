import type { VerificationStepId } from '@/lib/knowledge';
import { getVerificationStepInputs } from '@/lib/verification/verification-checks';

export interface VerificationStepInput {
  id: VerificationStepId;
  inputs?: string[];
}

export const DEFAULT_VERIFICATION_HIGHLIGHTS: Record<VerificationStepId, string[]> = {
  cast_as_intended: getVerificationStepInputs('cast_as_intended'),
  recorded_as_cast: getVerificationStepInputs('recorded_as_cast'),
  counted_as_recorded: getVerificationStepInputs('counted_as_recorded'),
  stark_verification: getVerificationStepInputs('stark_verification'),
};

export function resolveHighlightedKnowledge(stepId: VerificationStepId, apiSteps?: VerificationStepInput[]): string[] {
  const matched = apiSteps?.find((step) => step.id === stepId);
  if (matched?.inputs && matched.inputs.length > 0) {
    return matched.inputs;
  }
  return DEFAULT_VERIFICATION_HIGHLIGHTS[stepId];
}
