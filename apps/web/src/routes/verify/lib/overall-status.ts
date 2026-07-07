import type { VerificationSummaryTone } from '@stark-ballot/verification/summary';

export type VerifyPageOverallStatus = 'verified' | 'failed' | 'warning' | 'demo_only';
export type VerifyPageOverallStatusOverrideSource = 'explicit_server_failure' | 'summary' | 'hard_failure' | 'pending';

export type VerifyPageRenderedOverallStatusInput =
  | { readiness: 'not_started' | 'sequence_incomplete' | 'pending' }
  | { readiness: 'ready'; overrideStatus: VerifyPageOverallStatus | null };

export interface VerifyPageOverallStatusOverrideInput {
  explicitServerFailureStatus: VerifyPageOverallStatus | null;
  summaryStatus: VerifyPageOverallStatus | null;
  hasVerificationChecks: boolean;
  hardFailureDetected: boolean;
  hasCheckPending: boolean;
}

export interface VerifyPageOverallStatusOverrideDecision {
  source: VerifyPageOverallStatusOverrideSource;
  status: VerifyPageOverallStatus;
}

const SUMMARY_TONE_STATUS: Record<VerificationSummaryTone, VerifyPageOverallStatus> = {
  verified: 'verified',
  demo: 'demo_only',
  warning: 'warning',
  failed: 'failed',
};

export function resolveVerifyPageStatusForSummaryTone(tone: VerificationSummaryTone): VerifyPageOverallStatus {
  return SUMMARY_TONE_STATUS[tone];
}

export function resolveVerifyPageOverallStatusOverride({
  explicitServerFailureStatus,
  summaryStatus,
  hasVerificationChecks,
  hardFailureDetected,
  hasCheckPending,
}: VerifyPageOverallStatusOverrideInput): VerifyPageOverallStatusOverrideDecision | null {
  if (explicitServerFailureStatus) {
    return { source: 'explicit_server_failure', status: explicitServerFailureStatus };
  }
  if (hasVerificationChecks && hardFailureDetected && summaryStatus !== 'failed') {
    return { source: 'hard_failure', status: 'failed' };
  }
  if (summaryStatus) {
    return { source: 'summary', status: summaryStatus };
  }
  if (!hasVerificationChecks) {
    return null;
  }
  if (hasCheckPending) {
    return { source: 'pending', status: 'warning' };
  }
  return null;
}

export function resolveVerifyPageRenderReadiness(input: {
  verificationStarted: boolean;
  sequenceComplete: boolean;
  hasCheckPending: boolean;
  overrideStatus: VerifyPageOverallStatus | null;
}): VerifyPageRenderedOverallStatusInput {
  if (!input.verificationStarted) {
    return { readiness: 'not_started' };
  }
  if (!input.sequenceComplete) {
    return { readiness: 'sequence_incomplete' };
  }
  if (input.hasCheckPending) {
    return { readiness: 'pending' };
  }
  return { readiness: 'ready', overrideStatus: input.overrideStatus };
}

export function resolveVerifyPageRenderedOverallStatus(
  input: VerifyPageRenderedOverallStatusInput,
): VerifyPageOverallStatus | null {
  if (input.readiness !== 'ready') {
    return null;
  }
  return input.overrideStatus;
}
