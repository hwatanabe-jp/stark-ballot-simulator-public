import type {
  VerificationDisplayDecision,
  VerificationPresentationPolicyResult,
} from './verification-presentation-policy';

declare const policy: VerificationPresentationPolicyResult;

if (policy.fullyVerifiedLabelEligible) {
  const eligibleEvidence: true = policy.evidenceFullyVerified;
  const eligibleSummary: 'fully_verified' = policy.summary.status;
  const eligibleTone: 'verified' = policy.summary.tone;
  const eligibleReadiness: 'ready' = policy.display.readiness;
  const eligibleRenderedStatus: 'verified' = policy.display.renderedStatus;
  const castStageSucceeded: 'success' = policy.stageStatuses.cast_as_intended;
  const recordedStageSucceeded: 'success' = policy.stageStatuses.recorded_as_cast;
  const countedStageSucceeded: 'success' = policy.stageStatuses.counted_as_recorded;
  const starkStageSucceeded: 'success' = policy.stageStatuses.stark_verification;
  const noDevelopmentEvidence: false = policy.devModeEvidence;
  const noMissingEvidence: false = policy.missingEvidence;

  void [
    eligibleEvidence,
    eligibleSummary,
    eligibleTone,
    eligibleReadiness,
    eligibleRenderedStatus,
    castStageSucceeded,
    recordedStageSucceeded,
    countedStageSucceeded,
    starkStageSucceeded,
    noDevelopmentEvidence,
    noMissingEvidence,
  ];
}

declare function acceptPolicy(value: VerificationPresentationPolicyResult): void;

// The verified branch requires a private policy-produced witness.
// @ts-expect-error Callers cannot construct the verified branch directly.
acceptPolicy({
  summary: { status: 'fully_verified', tone: 'verified' },
  stageStatuses: {
    cast_as_intended: 'success',
    recorded_as_cast: 'success',
    counted_as_recorded: 'success',
    stark_verification: 'success',
  },
  evidenceFullyVerified: true,
  fullyVerifiedLabelEligible: true,
  display: {
    readiness: 'ready',
    source: 'summary',
    status: 'verified',
    renderedStatus: 'verified',
  },
  publishedTallyMismatch: false,
  devModeEvidence: false,
  missingEvidence: false,
});

// A false evidence bit cannot make a fully-verified display safe for an ineligible branch.
// @ts-expect-error Ineligible policies can never carry a fully-verified display.
acceptPolicy({
  summary: { status: 'fully_verified', tone: 'verified' },
  stageStatuses: {
    cast_as_intended: 'success',
    recorded_as_cast: 'success',
    counted_as_recorded: 'success',
    stark_verification: 'success',
  },
  evidenceFullyVerified: false,
  fullyVerifiedLabelEligible: false,
  display: {
    readiness: 'ready',
    source: 'summary',
    status: 'verified',
    renderedStatus: 'verified',
  },
  publishedTallyMismatch: false,
  devModeEvidence: false,
  missingEvidence: false,
});

// The ineligible branch must contain a negative fact, not only a false label flag.
// @ts-expect-error Fully verified facts cannot be relabelled as ineligible.
acceptPolicy({
  summary: { status: 'fully_verified', tone: 'verified' },
  stageStatuses: {
    cast_as_intended: 'success',
    recorded_as_cast: 'success',
    counted_as_recorded: 'success',
    stark_verification: 'success',
  },
  evidenceFullyVerified: true,
  fullyVerifiedLabelEligible: false,
  display: {
    readiness: 'ready',
    source: 'summary',
    status: 'verified',
    renderedStatus: 'verified',
  },
  publishedTallyMismatch: false,
  devModeEvidence: false,
  missingEvidence: false,
});

declare function acceptDisplay(value: VerificationDisplayDecision): void;

// @ts-expect-error Non-ready decisions cannot render a terminal status.
acceptDisplay({ readiness: 'pending', source: 'summary', status: 'verified', renderedStatus: 'verified' });

// @ts-expect-error Ready decisions must render the resolved status.
acceptDisplay({ readiness: 'ready', source: 'summary', status: 'failed', renderedStatus: 'verified' });

// @ts-expect-error A hard-failure source can resolve only to failed.
acceptDisplay({ readiness: 'ready', source: 'hard_failure', status: 'warning', renderedStatus: 'warning' });
