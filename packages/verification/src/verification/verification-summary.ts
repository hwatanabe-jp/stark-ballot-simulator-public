import type { VerificationStepId, VerificationStepStatus } from './step-types';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  isVerificationCheckRequired,
  type VerificationCheck,
  type VerificationCheckDefinition,
  type VerificationCheckRole,
} from '@stark-ballot/verification/checks';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export const VERIFICATION_SUMMARY_STATUS_VALUES = [
  'fully_verified',
  'demo_only',
  'in_progress',
  'missing_evidence',
  'verified_with_limitations',
  'user_vote_excluded',
  'votes_excluded',
  'votes_excluded_unknown',
  'recorded_integrity_failed',
  'published_tally_mismatch',
  'counted_integrity_failed',
  'cast_integrity_failed',
  'proof_verification_failed',
] as const;

export type VerificationSummaryStatus = (typeof VERIFICATION_SUMMARY_STATUS_VALUES)[number];

export const VERIFICATION_SUMMARY_TONE_VALUES = ['verified', 'demo', 'warning', 'failed'] as const;

export type VerificationSummaryTone = (typeof VERIFICATION_SUMMARY_TONE_VALUES)[number];

export interface VerificationSummaryContext {
  /** Slot-based count of bulletin indices not presented to the guest. */
  missingSlots?: number;
  /** Slot-based count of presented in-range slots that still failed counting. */
  invalidPresentedSlots?: number;
  /** Record-based count of rejected presented records, including duplicates. */
  rejectedRecords?: number;
  /** Slot-based fail-closed exclusion signal. */
  excludedSlots?: number;
  sthSourcesConfigured?: boolean;
  devModeEvidence?: boolean;
}

export interface VerificationSummaryResult {
  status: VerificationSummaryStatus;
  tone: VerificationSummaryTone;
  messageKey?: ExclusionMessageKey;
}

interface ResolvedCheck {
  check: VerificationCheck;
  definition: VerificationCheckDefinition;
}

const CHECK_DEFINITION_BY_ID = new Map(VERIFICATION_CHECK_DEFINITIONS.map((definition) => [definition.id, definition]));

const STATUS_PRIORITY: Record<VerificationStepStatus, number> = {
  success: 0,
  not_run: 1,
  pending: 2,
  running: 3,
  failed: 4,
};

type ExclusionReason = 'missing' | 'invalid' | 'mixed' | 'unknown';

const EXCLUSION_MESSAGE_KEYS = {
  user_vote_excluded: {
    missing: 'pages.verify.resultSummary.userVoteMissingSub',
    invalid: 'pages.verify.resultSummary.userVoteInvalidSub',
  },
  votes_excluded: {
    missing: 'pages.verify.resultSummary.votesMissingSub',
    invalid: 'pages.verify.resultSummary.votesInvalidSub',
  },
  votes_excluded_unknown: {
    missing: 'pages.verify.resultSummary.votesMissingUnknownUserSub',
    invalid: 'pages.verify.resultSummary.votesInvalidUnknownUserSub',
  },
} as const satisfies Partial<Record<VerificationSummaryStatus, Partial<Record<ExclusionReason, string>>>>;

type ExclusionMessages = (typeof EXCLUSION_MESSAGE_KEYS)[keyof typeof EXCLUSION_MESSAGE_KEYS];
type ExclusionMessageKey = ExclusionMessages[keyof ExclusionMessages];

/**
 * Derive a single verification summary from verification check results.
 *
 * The summary logic intentionally avoids check IDs and relies on check metadata
 * (category, role, criticality) defined in VERIFICATION_CHECK_DEFINITIONS.
 */
export function deriveVerificationSummary(
  checks?: VerificationCheck[] | null,
  context?: VerificationSummaryContext,
): VerificationSummaryResult | null {
  if (!checks || checks.length === 0) {
    return null;
  }

  const { resolved, hasUnknown } = resolveChecks(checks);
  if (resolved.length === 0) {
    return null;
  }

  const evidence = resolveSummaryEvidence(resolved, hasUnknown, context);
  return deriveBlockingSummary(evidence, context) ?? deriveTerminalSummary(evidence, context);
}

function resolveSummaryEvidence(
  resolved: ResolvedCheck[],
  hasUnknown: boolean,
  context: VerificationSummaryContext | undefined,
) {
  const requiredDefinitions = VERIFICATION_CHECK_DEFINITIONS.filter((definition) =>
    isRequiredCheck(definition, context),
  );
  const requiredChecks = resolved.filter((entry) => isRequiredCheck(entry.definition, context));
  const optionalChecks = resolved.filter((entry) => !isRequiredCheck(entry.definition, context));
  const resolvedIds = new Set(resolved.map((entry) => entry.definition.id));
  const missingRequiredChecks = requiredDefinitions.filter((definition) => !resolvedIds.has(definition.id));

  return { resolved, hasUnknown, requiredChecks, optionalChecks, missingRequiredChecks };
}

type SummaryEvidence = ReturnType<typeof resolveSummaryEvidence>;

function deriveExclusionSummary(
  userInclusionStatus: VerificationStepStatus | undefined,
  context: VerificationSummaryContext | undefined,
): VerificationSummaryResult {
  const status =
    userInclusionStatus === 'failed'
      ? 'user_vote_excluded'
      : userInclusionStatus === 'success'
        ? 'votes_excluded'
        : 'votes_excluded_unknown';
  const messageKey = resolveExclusionMessageKey(status, resolveExclusionReason(context));
  return { status, tone: 'failed', ...(messageKey ? { messageKey } : {}) };
}

function deriveBlockingSummary(
  evidence: SummaryEvidence,
  context: VerificationSummaryContext | undefined,
): VerificationSummaryResult | undefined {
  const { resolved, requiredChecks } = evidence;
  const hasRequiredInProgress = requiredChecks.some((entry) => isInProgress(entry.check.status));
  if (hasRequiredInProgress) {
    return { status: 'in_progress', tone: 'warning' };
  }

  const proofStatus = resolveRoleStatus(resolved, 'proof_verification');
  if (proofStatus === 'failed') {
    return { status: 'proof_verification_failed', tone: 'failed' };
  }

  const completenessStatus = resolveRoleStatus(resolved, 'tally_completeness');
  const userInclusionStatus = resolveRoleStatus(resolved, 'user_inclusion');

  if (completenessStatus === 'failed') return deriveExclusionSummary(userInclusionStatus, context);

  if (categoryFailed(requiredChecks, 'recorded_as_cast')) {
    return { status: 'recorded_integrity_failed', tone: 'failed' };
  }

  return undefined;
}

function hasPublishedTallyMismatch(evidence: SummaryEvidence, hasRequiredNotRun: boolean): boolean {
  const { resolved, requiredChecks, missingRequiredChecks, hasUnknown } = evidence;
  const hasSuccessfulTallyEvidence = (
    [
      'proof_verification',
      'tally_completeness',
      'user_inclusion',
      'tally_input_integrity',
    ] satisfies VerificationCheckRole[]
  ).every((role) => resolveRoleStatus(resolved, role) === 'success');
  const consistencyStatus = resolveRoleStatus(resolved, 'tally_consistency');
  const recordedAllRequiredSucceeded = categoryAllRequiredSucceeded(
    requiredChecks,
    missingRequiredChecks,
    'recorded_as_cast',
  );
  if (
    consistencyStatus === 'failed' &&
    hasSuccessfulTallyEvidence &&
    recordedAllRequiredSucceeded &&
    !hasRequiredNotRun &&
    missingRequiredChecks.length === 0 &&
    !hasUnknown
  ) {
    return true;
  }

  return false;
}

function deriveTerminalSummary(
  evidence: SummaryEvidence,
  context: VerificationSummaryContext | undefined,
): VerificationSummaryResult {
  const { resolved, requiredChecks, missingRequiredChecks, hasUnknown } = evidence;
  const hasRequiredNotRun = requiredChecks.some((entry) => entry.check.status === 'not_run');
  if (hasPublishedTallyMismatch(evidence, hasRequiredNotRun))
    return { status: 'published_tally_mismatch', tone: 'failed' };

  if (categoryFailed(requiredChecks, 'counted_as_recorded')) {
    return { status: 'counted_integrity_failed', tone: 'failed' };
  }
  if (categoryFailed(requiredChecks, 'cast_as_intended')) {
    return { status: 'cast_integrity_failed', tone: 'failed' };
  }

  const hasMissingRequiredRoles =
    !resolveRoleStatus(resolved, 'tally_completeness') || !resolveRoleStatus(resolved, 'user_inclusion');
  if (hasRequiredNotRun || hasUnknown || hasMissingRequiredRoles || missingRequiredChecks.length > 0) {
    return { status: 'missing_evidence', tone: 'warning' };
  }

  return deriveSuccessfulEvidenceSummary(evidence, context);
}

function deriveSuccessfulEvidenceSummary(
  evidence: SummaryEvidence,
  context: VerificationSummaryContext | undefined,
): VerificationSummaryResult {
  const { resolved, optionalChecks } = evidence;
  if (context?.devModeEvidence || hasDemoEvidence(resolved)) {
    return { status: 'demo_only', tone: 'demo' };
  }

  const optionalDegraded = optionalChecks.some(
    (entry) => entry.check.status === 'failed' || entry.check.status === 'not_run',
  );
  if (optionalDegraded) {
    return { status: 'verified_with_limitations', tone: 'warning' };
  }

  return { status: 'fully_verified', tone: 'verified' };
}

function isRequiredCheck(definition: VerificationCheckDefinition, context?: VerificationSummaryContext): boolean {
  return isVerificationCheckRequired(definition, {
    ...omitUndefinedProperties({ sthSourcesConfigured: context?.sthSourcesConfigured }),
  });
}

/**
 * Prefer the explicit slot-based breakdown for explanatory copy.
 * `excludedSlots` only tells us to fail closed when that breakdown is missing.
 */
function resolveExclusionReason(context?: VerificationSummaryContext): ExclusionReason | undefined {
  const { missing, invalid, excluded } = resolvePositiveExclusionCounts(context);

  if (!missing && !invalid) {
    return excluded ? 'unknown' : undefined;
  }
  if (missing && invalid) {
    return 'mixed';
  }
  return missing ? 'missing' : 'invalid';
}

function resolvePositiveExclusionCounts(context: VerificationSummaryContext | undefined) {
  return {
    missing: toPositiveCount(context?.missingSlots),
    invalid: toPositiveCount(context?.invalidPresentedSlots),
    excluded: toPositiveCount(context?.excludedSlots),
  };
}

function resolveExclusionMessageKey(
  status: keyof typeof EXCLUSION_MESSAGE_KEYS,
  reason?: ExclusionReason,
): ExclusionMessageKey | undefined {
  if (!reason || reason === 'mixed' || reason === 'unknown') {
    return undefined;
  }
  const entry = EXCLUSION_MESSAGE_KEYS[status];
  return entry[reason];
}

function toPositiveCount(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value > 0 ? value : undefined;
}

function resolveChecks(checks: VerificationCheck[]): { resolved: ResolvedCheck[]; hasUnknown: boolean } {
  const resolved: ResolvedCheck[] = [];
  let hasUnknown = false;

  for (const check of checks) {
    const definition = CHECK_DEFINITION_BY_ID.get(check.id);
    if (!definition) {
      hasUnknown = true;
      continue;
    }
    resolved.push({ check, definition });
  }

  return { resolved, hasUnknown };
}

function hasDemoEvidence(checks: ResolvedCheck[]): boolean {
  return checks.some((entry) => entry.check.evidence === 'demo');
}

function isInProgress(status: VerificationStepStatus): boolean {
  return status === 'pending' || status === 'running';
}

function resolveRoleStatus(checks: ResolvedCheck[], role: VerificationCheckRole): VerificationStepStatus | undefined {
  const statuses = checks.filter((entry) => entry.definition.role === role).map((entry) => entry.check.status);
  if (statuses.length === 0) {
    return undefined;
  }
  return resolveWorstStatus(statuses);
}

function resolveWorstStatus(statuses: VerificationStepStatus[]): VerificationStepStatus {
  return statuses.reduce((worst, status) => (STATUS_PRIORITY[status] > STATUS_PRIORITY[worst] ? status : worst));
}

function categoryFailed(checks: ResolvedCheck[], category: VerificationStepId): boolean {
  return checks.some((entry) => entry.definition.category === category && entry.check.status === 'failed');
}

function categoryAllRequiredSucceeded(
  requiredChecks: ResolvedCheck[],
  missingRequiredChecks: VerificationCheckDefinition[],
  category: VerificationStepId,
): boolean {
  if (missingRequiredChecks.some((definition) => definition.category === category)) {
    return false;
  }
  const categoryChecks = requiredChecks.filter((entry) => entry.definition.category === category);
  if (categoryChecks.length === 0) {
    return false;
  }
  return categoryChecks.every((entry) => entry.check.status === 'success');
}
