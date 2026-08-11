import {
  VERIFICATION_CHECK_DEFINITIONS,
  getVerificationRequiredCheckIdsForStep,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { deriveStageStatusFromChecks } from '@stark-ballot/verification/stage-status';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import {
  VERIFICATION_SUMMARY_STATUS_VALUES,
  VERIFICATION_SUMMARY_TONE_VALUES,
  deriveVerificationSummary,
  type VerificationSummaryContext,
  type VerificationSummaryResult,
  type VerificationSummaryTone,
} from '@stark-ballot/verification/summary';
import type { VerificationStepId, VerificationStepStatus } from './step-types';

export { VERIFICATION_SUMMARY_STATUS_VALUES, VERIFICATION_SUMMARY_TONE_VALUES };

export const VERIFICATION_AVAILABILITY_VALUES = ['available', 'unavailable', 'corrupt'] as const;
export type VerificationAvailability = (typeof VERIFICATION_AVAILABILITY_VALUES)[number];

export const VERIFICATION_DISPLAY_STATUS_VALUES = ['verified', 'failed', 'warning', 'demo_only'] as const;
export type VerificationDisplayStatus = (typeof VERIFICATION_DISPLAY_STATUS_VALUES)[number];

export const VERIFICATION_DISPLAY_SOURCE_VALUES = [
  'explicit_server_failure',
  'summary',
  'hard_failure',
  'pending',
  'unavailable',
  'corrupt',
] as const;
export type VerificationDisplaySource = (typeof VERIFICATION_DISPLAY_SOURCE_VALUES)[number];

export const VERIFICATION_DISPLAY_READINESS_VALUES = [
  'not_started',
  'sequence_incomplete',
  'pending',
  'ready',
] as const;
export type VerificationDisplayReadiness = (typeof VERIFICATION_DISPLAY_READINESS_VALUES)[number];

export type VerificationExplicitServerFailureStatus = Exclude<VerificationDisplayStatus, 'verified'>;

export interface VerificationDisplayDecisionInput {
  verificationStarted: boolean;
  sequenceComplete: boolean;
  hasCheckPending: boolean;
  explicitServerFailureStatus: VerificationExplicitServerFailureStatus | null;
  summaryTone: VerificationSummaryTone | null;
  hasVerificationChecks: boolean;
  hardFailureDetected: boolean;
}

export interface VerificationDisplayDecision {
  readiness: VerificationDisplayReadiness;
  source: VerificationDisplaySource | null;
  status: VerificationDisplayStatus | null;
  renderedStatus: VerificationDisplayStatus | null;
}

export interface VerificationPresentationPolicyInput {
  availability: VerificationAvailability;
  checks?: readonly VerificationCheck[] | null;
  context?: VerificationSummaryContext;
  verificationStatus?: VerificationStatus;
  verificationReportStatus?: VerificationStatus;
  explicitServerFailureStatus?: VerificationExplicitServerFailureStatus | null;
  verificationStarted?: boolean;
  sequenceComplete?: boolean;
}

export type VerificationStageStatuses = Readonly<Record<VerificationStepId, VerificationStepStatus>>;

export interface VerificationPresentationPolicyResult {
  summary: VerificationSummaryResult | null;
  stageStatuses: VerificationStageStatuses;
  evidenceFullyVerified: boolean;
  fullyVerifiedLabelEligible: boolean;
  display: VerificationDisplayDecision;
  publishedTallyMismatch: boolean;
  devModeEvidence: boolean;
  missingEvidence: boolean;
  explanationKey?: string;
}

const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const satisfies readonly VerificationStepId[];

const HARD_FAILURE_CHECK_IDS = new Set<VerificationCheckId>([
  'recorded_consistency_proof',
  'counted_missing_indices_zero',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'stark_receipt_verify',
]);

const EXPLICIT_PROOF_FAILURE_CHECK_IDS = new Set<VerificationCheckId>(['stark_image_id_match', 'stark_receipt_verify']);

const CHECK_DEFINITION_BY_ID = new Map(
  VERIFICATION_CHECK_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

const STATUS_PRIORITY: Record<VerificationStepStatus, number> = {
  success: 0,
  not_run: 1,
  pending: 2,
  running: 3,
  failed: 4,
};

const SUMMARY_TONE_TO_DISPLAY_STATUS: Record<VerificationSummaryTone, VerificationDisplayStatus> = {
  verified: 'verified',
  demo: 'demo_only',
  warning: 'warning',
  failed: 'failed',
};

function resolveDisplayReadiness(input: {
  verificationStarted: boolean;
  sequenceComplete: boolean;
  hasCheckPending: boolean;
}): VerificationDisplayReadiness {
  if (!input.verificationStarted) {
    return 'not_started';
  }
  if (!input.sequenceComplete) {
    return 'sequence_incomplete';
  }
  if (input.hasCheckPending) {
    return 'pending';
  }
  return 'ready';
}

export function resolveVerificationDisplayDecision(
  input: VerificationDisplayDecisionInput,
): VerificationDisplayDecision {
  let source: VerificationDisplaySource | null = null;
  let status: VerificationDisplayStatus | null = null;

  if (input.explicitServerFailureStatus) {
    source = 'explicit_server_failure';
    status = input.explicitServerFailureStatus;
  } else if (input.hasVerificationChecks && input.hardFailureDetected && input.summaryTone !== 'failed') {
    source = 'hard_failure';
    status = 'failed';
  } else if (input.summaryTone) {
    source = 'summary';
    status = SUMMARY_TONE_TO_DISPLAY_STATUS[input.summaryTone];
  } else if (input.hasVerificationChecks && input.hasCheckPending) {
    source = 'pending';
    status = 'warning';
  }

  const readiness = resolveDisplayReadiness(input);
  return {
    readiness,
    source,
    status,
    renderedStatus: readiness === 'ready' ? status : null,
  };
}

function resolveWorstStatus(left: VerificationStepStatus, right: VerificationStepStatus): VerificationStepStatus {
  return STATUS_PRIORITY[right] > STATUS_PRIORITY[left] ? right : left;
}

function buildCheckResultMap(
  checks: readonly VerificationCheck[],
): Map<VerificationCheckId, Pick<VerificationCheck, 'status'>> {
  const results = new Map<VerificationCheckId, Pick<VerificationCheck, 'status'>>();
  for (const check of checks) {
    if (!CHECK_DEFINITION_BY_ID.has(check.id)) {
      continue;
    }
    const current = results.get(check.id);
    results.set(check.id, {
      status: current ? resolveWorstStatus(current.status, check.status) : check.status,
    });
  }
  return results;
}

function deriveStageStatuses(
  checks: readonly VerificationCheck[],
  context: VerificationSummaryContext,
): VerificationStageStatuses {
  const results = buildCheckResultMap(checks);
  const requirementContext = {
    sthSourcesConfigured: context.sthSourcesConfigured === true,
  };
  return Object.fromEntries(
    VERIFICATION_STEP_IDS.map((stepId) => [
      stepId,
      deriveStageStatusFromChecks(results, getVerificationRequiredCheckIdsForStep(stepId, requirementContext)),
    ]),
  ) as Record<VerificationStepId, VerificationStepStatus>;
}

function hasFailedCheck(checks: readonly VerificationCheck[], ids: ReadonlySet<VerificationCheckId>): boolean {
  return checks.some((check) => ids.has(check.id) && check.status === 'failed');
}

function hasFailClosedExclusionSignal(context: VerificationSummaryContext): boolean {
  const { missingSlots, invalidPresentedSlots, excludedSlots } = context;
  const definedCounts = [missingSlots, invalidPresentedSlots, excludedSlots].filter(
    (value): value is number => value !== undefined,
  );
  if (definedCounts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return true;
  }
  if ((missingSlots ?? 0) > 0 || (invalidPresentedSlots ?? 0) > 0 || (excludedSlots ?? 0) > 0) {
    return true;
  }
  return (
    missingSlots !== undefined &&
    invalidPresentedSlots !== undefined &&
    excludedSlots !== undefined &&
    excludedSlots !== missingSlots + invalidPresentedSlots
  );
}

function hasHardFailure(checks: readonly VerificationCheck[], context: VerificationSummaryContext): boolean {
  if (hasFailClosedExclusionSignal(context)) {
    return true;
  }
  if (hasFailedCheck(checks, HARD_FAILURE_CHECK_IDS)) {
    return true;
  }
  return (
    context.sthSourcesConfigured === true &&
    checks.some((check) => check.id === 'recorded_sth_third_party' && check.status === 'failed')
  );
}

function hasExplicitProofFailure(
  checks: readonly VerificationCheck[],
  verificationStatus: VerificationStatus | undefined,
  verificationReportStatus: VerificationStatus | undefined,
): boolean {
  if (verificationReportStatus === 'failed' || hasFailedCheck(checks, EXPLICIT_PROOF_FAILURE_CHECK_IDS)) {
    return true;
  }

  const receiptSucceeded = checks.some((check) => check.id === 'stark_receipt_verify' && check.status === 'success');
  const imageIdChecks = checks.filter((check) => check.id === 'stark_image_id_match');
  const imageIdSucceededOrAbsent =
    imageIdChecks.length === 0 || imageIdChecks.some((check) => check.status === 'success');
  const proofSucceeded =
    verificationReportStatus === 'success' ||
    verificationReportStatus === 'dev_mode' ||
    (receiptSucceeded && imageIdSucceededOrAbsent);
  const resolvedStatus =
    verificationStatus === 'running' || verificationStatus === 'not_run'
      ? verificationStatus
      : (verificationReportStatus ?? verificationStatus);

  return resolvedStatus === 'failed' && !proofSucceeded;
}

function deriveUnavailableDisplay(
  availability: Exclude<VerificationAvailability, 'available'>,
  input: Pick<VerificationPresentationPolicyInput, 'verificationStarted' | 'sequenceComplete'>,
): VerificationDisplayDecision {
  const readiness = resolveDisplayReadiness({
    verificationStarted: input.verificationStarted ?? true,
    sequenceComplete: input.sequenceComplete ?? true,
    hasCheckPending: false,
  });
  const status: VerificationDisplayStatus = availability === 'corrupt' ? 'failed' : 'warning';
  return {
    readiness,
    source: availability,
    status,
    renderedStatus: readiness === 'ready' ? status : null,
  };
}

const NOT_RUN_STAGE_STATUSES: VerificationStageStatuses = {
  cast_as_intended: 'not_run',
  recorded_as_cast: 'not_run',
  counted_as_recorded: 'not_run',
  stark_verification: 'not_run',
};

export function deriveVerificationPresentationPolicy(
  input: VerificationPresentationPolicyInput,
): VerificationPresentationPolicyResult {
  const checks = input.checks ? [...input.checks] : [];
  const devModeEvidence =
    input.context?.devModeEvidence === true ||
    input.verificationStatus === 'dev_mode' ||
    input.verificationReportStatus === 'dev_mode' ||
    checks.some((check) => check.evidence === 'demo');

  if (input.availability !== 'available') {
    return {
      summary: null,
      stageStatuses: NOT_RUN_STAGE_STATUSES,
      evidenceFullyVerified: false,
      fullyVerifiedLabelEligible: false,
      display: deriveUnavailableDisplay(input.availability, input),
      publishedTallyMismatch: false,
      devModeEvidence,
      missingEvidence: true,
    };
  }

  const context: VerificationSummaryContext = {
    ...input.context,
    devModeEvidence,
  };
  const summary = deriveVerificationSummary(checks, context);
  const hardFailureDetected = hasHardFailure(checks, context);
  const explicitServerFailureStatus =
    input.explicitServerFailureStatus ??
    (hasExplicitProofFailure(checks, input.verificationStatus, input.verificationReportStatus) ? 'failed' : null);
  const hasCheckPending = checks.some((check) => check.status === 'pending' || check.status === 'running');
  const display = resolveVerificationDisplayDecision({
    verificationStarted: input.verificationStarted ?? true,
    sequenceComplete: input.sequenceComplete ?? true,
    hasCheckPending,
    explicitServerFailureStatus,
    summaryTone: summary?.tone ?? null,
    hasVerificationChecks: checks.length > 0,
    hardFailureDetected,
  });
  const evidenceFullyVerified =
    summary?.status === 'fully_verified' &&
    summary.tone === 'verified' &&
    !hardFailureDetected &&
    explicitServerFailureStatus === null;

  return {
    summary,
    stageStatuses: deriveStageStatuses(checks, context),
    evidenceFullyVerified,
    fullyVerifiedLabelEligible: evidenceFullyVerified && display.renderedStatus === 'verified',
    display,
    publishedTallyMismatch: summary?.status === 'published_tally_mismatch',
    devModeEvidence,
    missingEvidence: summary === null || summary.status === 'missing_evidence',
    ...(summary?.messageKey ? { explanationKey: summary.messageKey } : {}),
  };
}
