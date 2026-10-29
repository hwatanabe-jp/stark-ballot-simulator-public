import type { TranslationKey } from '@stark-ballot/web/i18n';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import type { UnifiedVerificationCardProps } from '@stark-ballot/web/components/verification/UnifiedVerificationCard';
import type { VerificationSummaryStatus } from '@stark-ballot/verification/summary';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { VerificationPayload } from './verification-data';
import { isStarkTimeoutError } from './stark-timeout';
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

type OverallStatusOverride = {
  status: VerificationDisplayStatus;
  message: string;
  subMessage?: string;
};

const SUMMARY_MAIN_MESSAGE_KEYS = {
  fully_verified: 'pages.verify.resultSummary.fullyVerifiedMain',
  demo_only: 'pages.verify.resultSummary.demoOnlyMain',
  in_progress: 'pages.verify.resultSummary.inProgressMain',
  missing_evidence: 'pages.verify.resultSummary.missingEvidenceMain',
  verified_with_limitations: 'pages.verify.resultSummary.verifiedWithLimitationsMain',
  user_vote_excluded: 'pages.verify.resultSummary.userVoteExcludedMain',
  votes_excluded: 'pages.verify.resultSummary.votesExcludedMain',
  votes_excluded_unknown: 'pages.verify.resultSummary.votesExcludedUnknownMain',
  recorded_integrity_failed: 'pages.verify.resultSummary.recordedIntegrityFailedMain',
  published_tally_mismatch: 'pages.verify.resultSummary.publishedTallyMismatchMain',
  counted_integrity_failed: 'pages.verify.resultSummary.countedIntegrityFailedMain',
  cast_integrity_failed: 'pages.verify.resultSummary.castIntegrityFailedMain',
  proof_verification_failed: 'pages.verify.resultSummary.proofVerificationFailedMain',
} satisfies Record<VerificationSummaryStatus, TranslationKey>;

const SUMMARY_SUB_MESSAGE_KEYS: Partial<Record<VerificationSummaryStatus, TranslationKey>> = {
  fully_verified: 'pages.verify.resultSummary.fullyVerifiedSub',
  demo_only: 'pages.verify.resultSummary.demoOnlySub',
  in_progress: 'pages.verify.resultSummary.inProgressSub',
  user_vote_excluded: 'pages.verify.resultSummary.userVoteExcludedSub',
  votes_excluded: 'pages.verify.resultSummary.votesExcludedSub',
  votes_excluded_unknown: 'pages.verify.resultSummary.votesExcludedUnknownSub',
  published_tally_mismatch: 'pages.verify.resultSummary.publishedTallyMismatchSub',
  counted_integrity_failed: 'pages.verify.resultSummary.countedIntegrityFailedSub',
  proof_verification_failed: 'pages.verify.resultSummary.proofVerificationFailedSub',
};

interface VerificationPagePresentationOptions {
  data: VerificationPayload | null;
  starkStep: { status: string; error?: string };
  sthSourcesConfigured: boolean;
  verificationStarted: boolean;
  sequenceComplete: boolean;
  t: UseTranslationResult['t'];
}

function resolveSequenceFailureMessage(step: VerificationPagePresentationOptions['starkStep']): string | undefined {
  if (step.status !== 'failed') return undefined;
  const message = step.error;
  return !message || isStarkTimeoutError(message) ? undefined : message;
}

function presentationContext(data: VerificationPayload | null, sthSourcesConfigured: boolean) {
  if (!data) return { devModeEvidence: false, sthSourcesConfigured };
  return {
    ...omitUndefinedProperties({
      missingSlots: data.missingSlots,
      invalidPresentedSlots: data.invalidPresentedSlots,
      rejectedRecords: data.rejectedRecords,
      excludedSlots: data.excludedSlots,
      devModeEvidence: data.verificationReport?.dev_mode_receipt === true || data.verificationStatus === 'dev_mode',
    }),
    sthSourcesConfigured,
  };
}

function derivePagePolicy(options: VerificationPagePresentationOptions, explicitFailure: boolean) {
  const { data, sthSourcesConfigured, verificationStarted, sequenceComplete } = options;
  return deriveVerificationPresentationPolicy({
    availability: data ? 'available' : 'unavailable',
    ...(data ? { checks: data.verificationChecks } : {}),
    context: presentationContext(data, sthSourcesConfigured),
    ...omitUndefinedProperties({
      verificationStatus: data?.verificationStatus,
      verificationReportStatus: data?.verificationReport?.status,
    }),
    explicitServerFailureStatus: explicitFailure ? 'failed' : null,
    verificationStarted,
    sequenceComplete,
  });
}

function resolveStarkGateStatus(
  policy: VerificationPresentationPolicyResult,
  explicitFailure: boolean,
): 'success' | 'failed' | 'pending' {
  if (explicitFailure) return 'failed';
  const status = policy.stageStatuses.stark_verification;
  return status === 'success' || status === 'failed' ? status : 'pending';
}

function resolveSummaryText(
  policy: VerificationPresentationPolicyResult,
  t: UseTranslationResult['t'],
): OverallStatusOverride | null {
  const summary = policy.summary;
  const status = policy.display.status;
  if (!summary || !status) return null;
  const mainKey = SUMMARY_MAIN_MESSAGE_KEYS[summary.status];
  const subKey = summary.messageKey ?? SUMMARY_SUB_MESSAGE_KEYS[summary.status];
  return { status, message: t(mainKey), ...omitUndefinedProperties({ subMessage: subKey ? t(subKey) : undefined }) };
}

function resolveFailureText(
  status: VerificationDisplayStatus,
  timeout: boolean,
  failure: string | undefined,
  t: UseTranslationResult['t'],
): OverallStatusOverride {
  if (timeout) return { status, message: t('pages.verify.status.timeout') };
  if (failure) return { status, message: t('pages.verify.failed'), subMessage: failure };
  return {
    status,
    message: t('pages.verify.resultSummary.proofVerificationFailedMain'),
    subMessage: t('pages.verify.resultSummary.proofVerificationFailedSub'),
  };
}

function resolveOverallText(
  policy: VerificationPresentationPolicyResult,
  summary: OverallStatusOverride | null,
  timeout: boolean,
  failure: string | undefined,
  t: UseTranslationResult['t'],
): OverallStatusOverride | null {
  const { status, source } = policy.display;
  if (!status || !source) return null;
  if (source === 'summary' && summary) return summary;
  if (source === 'explicit_server_failure') return resolveFailureText(status, timeout, failure, t);
  const partial = source === 'pending' || source === 'unavailable' || source === 'corrupt';
  return { status, message: t(partial ? 'pages.verify.status.partial' : 'pages.verify.failed') };
}

function resolveCardSummary(
  policy: VerificationPresentationPolicyResult,
  overall: OverallStatusOverride | null,
): UnifiedVerificationCardProps['summary'] {
  const status = resolveEligibleRenderedVerificationStatus(policy);
  if (!status || !overall) return null;
  const text = { message: overall.message, ...omitUndefinedProperties({ subMessage: overall.subMessage }) };
  if (status === 'verified') {
    return policy.fullyVerifiedLabelEligible ? { ...text, status, verifiedPresentation: policy } : null;
  }
  return { ...text, status };
}

export function resolveVerificationPagePresentation(options: VerificationPagePresentationOptions) {
  const timeout = isStarkTimeoutError(options.starkStep.error);
  const failure = resolveSequenceFailureMessage(options.starkStep);
  const explicitFailure = Boolean(timeout || failure);
  const policy = derivePagePolicy(options, explicitFailure);
  const summaryText = resolveSummaryText(policy, options.t);
  const overall = resolveOverallText(policy, summaryText, timeout, failure, options.t);
  return {
    showResults: policy.display.readiness === 'ready',
    starkGateStatus: resolveStarkGateStatus(policy, explicitFailure),
    summary: resolveCardSummary(policy, overall),
  };
}
