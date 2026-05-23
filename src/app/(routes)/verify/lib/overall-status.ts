import type { VerificationSummaryTone } from '@/lib/verification/verification-summary';

export type VerifyPageOverallStatus = 'verified' | 'failed' | 'warning';
export type VerifyPageOverallStatusOverrideSource = 'explicit_server_failure' | 'summary' | 'hard_failure' | 'pending';

export interface VerifyPageRenderedOverallStatusInput {
  verificationStarted: boolean;
  sequenceComplete: boolean;
  hasCheckPending: boolean;
  overrideStatus: VerifyPageOverallStatus | null;
}

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

export function resolveVerifyPageRenderedOverallStatus({
  verificationStarted,
  sequenceComplete,
  hasCheckPending,
  overrideStatus,
}: VerifyPageRenderedOverallStatusInput): VerifyPageOverallStatus | null {
  if (!verificationStarted || !sequenceComplete || hasCheckPending) {
    return null;
  }
  return overrideStatus;
}
