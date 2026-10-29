import {
  VERIFICATION_CHECK_DEFINITIONS,
  getVerificationRequiredCheckIdsForStep,
  getVerificationStepInputs,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { deriveStageStatusFromChecks } from '@stark-ballot/verification/stage-status';
import { VOTE_CHOICES, type VoteChoice } from '@stark-ballot/verification/shared/constants';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import { normalizeHexString } from '@stark-ballot/zkvm-contract/zkvm/hex';
import {
  VERIFICATION_SUMMARY_STATUS_VALUES,
  VERIFICATION_SUMMARY_TONE_VALUES,
  deriveVerificationSummary,
  type VerificationSummaryContext,
  type VerificationSummaryResult,
  type VerificationSummaryTone,
} from '@stark-ballot/verification/summary';
import type { VerificationStepId, VerificationStepStatus } from './step-types';
import {
  resolveCountedExpectedVsTreeSize,
  resolveCountedMissingIndicesZero,
  resolveCountedTallyConsistent,
  resolveRecordedInclusionProof,
  resolveRecordedIndexInRange,
  resolveZkGateStatus,
} from './engine/evaluate-checks';

export { VERIFICATION_SUMMARY_STATUS_VALUES, VERIFICATION_SUMMARY_TONE_VALUES };

const VERIFICATION_AVAILABILITY_VALUES = ['available', 'unavailable', 'corrupt'] as const;
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

type VerificationDisplayResolution =
  | { source: null; status: null }
  | {
      [TStatus in VerificationExplicitServerFailureStatus]: {
        source: 'explicit_server_failure';
        status: TStatus;
      };
    }[VerificationExplicitServerFailureStatus]
  | {
      [TStatus in VerificationDisplayStatus]: { source: 'summary'; status: TStatus };
    }[VerificationDisplayStatus]
  | { source: 'hard_failure'; status: 'failed' }
  | { source: 'pending'; status: 'warning' }
  | { source: 'unavailable'; status: 'warning' }
  | { source: 'corrupt'; status: 'failed' };

type NonReadyVerificationDisplayDecision = VerificationDisplayResolution & {
  readiness: Exclude<VerificationDisplayReadiness, 'ready'>;
  renderedStatus: null;
};

type ReadyVerificationDisplayDecision =
  | ({ readiness: 'ready'; renderedStatus: null } & Extract<VerificationDisplayResolution, { status: null }>)
  | ({ readiness: 'ready'; renderedStatus: 'verified' } & Extract<
      VerificationDisplayResolution,
      { status: 'verified' }
    >)
  | ({ readiness: 'ready'; renderedStatus: 'failed' } & Extract<VerificationDisplayResolution, { status: 'failed' }>)
  | ({ readiness: 'ready'; renderedStatus: 'warning' } & Extract<VerificationDisplayResolution, { status: 'warning' }>)
  | ({ readiness: 'ready'; renderedStatus: 'demo_only' } & Extract<
      VerificationDisplayResolution,
      { status: 'demo_only' }
    >);

export type VerificationDisplayDecision = NonReadyVerificationDisplayDecision | ReadyVerificationDisplayDecision;

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
export interface VerificationCheckStatusEvidence {
  readonly id: VerificationCheckId;
  readonly status: VerificationCheck['status'];
}

export interface FullyVerifiedPresentationEvidenceInput {
  readonly scenarioId: string;
  readonly checks: readonly (VerificationCheckStatusEvidence & {
    readonly evidence: VerificationCheck['evidence'];
    readonly inputs: readonly string[];
    readonly derivedFrom?: VerificationCheckId | undefined;
  })[];
  readonly stageStatuses: VerificationStageStatuses;
  readonly verificationStatus: VerificationStatus;
  readonly verificationReport?:
    | {
        readonly status: VerificationStatus;
        readonly expected_image_id: string;
        readonly receipt_image_id: string | null;
      }
    | undefined;
  readonly proof: {
    readonly imageId: string;
    readonly bulletinRoot: string;
    readonly inputCommitment: string;
    readonly seenBitmapRoot: string;
    readonly includedBitmapRoot: string;
    readonly verifiedTally: readonly [number, number, number, number, number];
    readonly missingSlots: number;
    readonly invalidPresentedSlots: number;
    readonly rejectedRecords: number;
    readonly excludedSlots: number;
    readonly totalExpected: number;
    readonly treeSize: number;
    readonly seenIndicesCount: number;
  };
  readonly presentation: {
    readonly counts: Readonly<Record<VoteChoice, number>>;
    readonly totalVotes: number;
    readonly tamperedCount?: number | undefined;
    readonly tamperDetected?: boolean | undefined;
    readonly tamperSummary?:
      | {
          readonly ignoredVotes: number;
          readonly recountedVotes: number;
          readonly userRecountedTo: VoteChoice | null;
          readonly affectedBotIds?: readonly number[] | undefined;
        }
      | undefined;
  };
  readonly voterEvidence: FullyVerifiedVoterEvidenceInput;
}

interface FullyVerifiedAvailableVoterEvidenceInput {
  readonly availability: 'available';
  readonly voteReceipt: {
    readonly voteId: string;
    readonly commitment: string;
    readonly bulletinIndex: number;
    readonly bulletinRootAtCast: string;
    readonly inputCommitment: string;
  };
  readonly userVote: {
    readonly voteId: string;
    readonly commitment: string;
    readonly proof: {
      readonly leafIndex: number;
      readonly treeSize: number;
      readonly bulletinRootAtCast: string;
    };
  };
}

type FullyVerifiedVoterEvidenceInput =
  | FullyVerifiedAvailableVoterEvidenceInput
  | { readonly availability: 'unavailable' };

interface VerificationPresentationPolicyBase {
  summary: VerificationSummaryResult | null;
  stageStatuses: VerificationStageStatuses;
  evidenceFullyVerified: boolean;
  display: VerificationDisplayDecision;
  publishedTallyMismatch: boolean;
  devModeEvidence: boolean;
  missingEvidence: boolean;
  explanationKey?: string;
}

const fullyVerifiedEligibilityWitness = Symbol('fully-verified-eligibility');

type FullyVerifiedDisplayDecision = {
  readiness: 'ready';
  source: 'summary';
  status: 'verified';
  renderedStatus: 'verified';
};

export interface VerifiedPresentation extends Omit<
  VerificationPresentationPolicyBase,
  | 'summary'
  | 'evidenceFullyVerified'
  | 'display'
  | 'stageStatuses'
  | 'publishedTallyMismatch'
  | 'devModeEvidence'
  | 'missingEvidence'
  | 'explanationKey'
> {
  readonly [fullyVerifiedEligibilityWitness]: true;
  summary: VerificationSummaryResult & { status: 'fully_verified'; tone: 'verified' };
  evidenceFullyVerified: true;
  fullyVerifiedLabelEligible: true;
  stageStatuses: Readonly<Record<VerificationStepId, 'success'>>;
  display: FullyVerifiedDisplayDecision;
  publishedTallyMismatch: false;
  devModeEvidence: false;
  missingEvidence: false;
  explanationKey?: never;
}

export type IneligibleVerificationPresentation = VerificationPresentationPolicyBase & {
  fullyVerifiedLabelEligible: false;
  display: Exclude<VerificationDisplayDecision, FullyVerifiedDisplayDecision>;
};

export type VerificationPresentationPolicyResult = VerifiedPresentation | IneligibleVerificationPresentation;

export interface SerializableVerificationPresentationPolicy {
  readonly summary: {
    readonly status: VerificationSummaryResult['status'];
    readonly tone: VerificationSummaryResult['tone'];
    readonly messageKey?: string | undefined;
  } | null;
  readonly stageStatuses: VerificationStageStatuses;
  readonly evidenceFullyVerified: boolean;
  readonly fullyVerifiedLabelEligible: boolean;
  readonly display: {
    readonly readiness: VerificationDisplayReadiness;
    readonly source: VerificationDisplaySource | null;
    readonly status: VerificationDisplayStatus | null;
    readonly renderedStatus: VerificationDisplayStatus | null;
  };
  readonly publishedTallyMismatch: boolean;
  readonly devModeEvidence: boolean;
  readonly missingEvidence: boolean;
  readonly explanationKey?: string | undefined;
}

function isFullyVerifiedDisplayDecision(display: VerificationDisplayDecision): display is FullyVerifiedDisplayDecision {
  return display.renderedStatus === 'verified';
}

type SuccessfulVerificationStageStatuses = Readonly<Record<VerificationStepId, 'success'>>;

function areAllVerificationStagesSuccessful(
  statuses: VerificationStageStatuses,
): statuses is SuccessfulVerificationStageStatuses {
  return (
    statuses.cast_as_intended === 'success' &&
    statuses.recorded_as_cast === 'success' &&
    statuses.counted_as_recorded === 'success' &&
    statuses.stark_verification === 'success'
  );
}

const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const satisfies readonly VerificationStepId[];

/** Apply the current presentation policy while retaining admitted server step metadata. */
export function projectVerificationPresentationSteps(
  steps: readonly {
    readonly id: VerificationStepId;
    readonly inputs?: readonly string[] | undefined;
    readonly error?: string | undefined;
  }[],
  policy: VerificationPresentationPolicyResult,
) {
  const serverSteps = new Map(steps.map((step) => [step.id, step] as const));
  return VERIFICATION_STEP_IDS.map((id) => {
    const serverStep = serverSteps.get(id);
    return {
      id,
      status: policy.stageStatuses[id],
      inputs: serverStep?.inputs ? [...serverStep.inputs] : getVerificationStepInputs(id),
      ...(serverStep?.error ? { error: serverStep.error } : {}),
    };
  });
}

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
  let resolution: VerificationDisplayResolution = { source: null, status: null };

  if (input.explicitServerFailureStatus) {
    resolution = { source: 'explicit_server_failure', status: input.explicitServerFailureStatus };
  } else if (input.hasVerificationChecks && input.hardFailureDetected && input.summaryTone !== 'failed') {
    resolution = { source: 'hard_failure', status: 'failed' };
  } else if (input.summaryTone) {
    resolution = { source: 'summary', status: SUMMARY_TONE_TO_DISPLAY_STATUS[input.summaryTone] };
  } else if (input.hasVerificationChecks && input.hasCheckPending) {
    resolution = { source: 'pending', status: 'warning' };
  }

  const readiness = resolveDisplayReadiness(input);
  return {
    readiness,
    ...resolution,
    renderedStatus: readiness === 'ready' ? resolution.status : null,
  } as VerificationDisplayDecision;
}

function resolveWorstStatus(left: VerificationStepStatus, right: VerificationStepStatus): VerificationStepStatus {
  return STATUS_PRIORITY[right] > STATUS_PRIORITY[left] ? right : left;
}

function buildCheckResultMap(
  checks: readonly VerificationCheckStatusEvidence[],
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
  checks: readonly VerificationCheckStatusEvidence[],
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

function hasSameStageStatuses(left: VerificationStageStatuses, right: VerificationStageStatuses): boolean {
  return VERIFICATION_STEP_IDS.every((stepId) => left[stepId] === right[stepId]);
}

function resolveEffectiveSthSourcesConfigured(
  checks: readonly VerificationCheckStatusEvidence[],
  expectedStageStatuses: VerificationStageStatuses,
): boolean {
  const withoutConfiguredSth = deriveStageStatuses(checks, { sthSourcesConfigured: false });
  const thirdPartySthCheck = checks.find((check) => check.id === 'recorded_sth_third_party');
  return (
    (thirdPartySthCheck !== undefined && thirdPartySthCheck.status !== 'not_run') ||
    expectedStageStatuses.recorded_as_cast !== withoutConfiguredSth.recorded_as_cast
  );
}

export function hasCanonicalVerificationCheckEvidence(
  checks: FullyVerifiedPresentationEvidenceInput['checks'],
  devModeEvidence: boolean,
): boolean {
  if (checks.length !== VERIFICATION_CHECK_DEFINITIONS.length) {
    return false;
  }
  return VERIFICATION_CHECK_DEFINITIONS.every((definition, index) => {
    const check = checks[index];
    const expectedEvidence = devModeEvidence && definition.evidence === 'zk' ? 'demo' : definition.evidence;
    if (
      !check ||
      check.id !== definition.id ||
      check.evidence !== expectedEvidence ||
      check.inputs.length !== definition.inputs.length ||
      check.inputs.some((input, index) => input !== definition.inputs[index]) ||
      check.derivedFrom !== definition.derivedFrom
    ) {
      return false;
    }
    return true;
  });
}

/** Re-evaluates check statuses whose complete evidence is present in the public resource. */
export function hasCoherentPublicFactDerivedCheckStatuses(input: {
  readonly checks: readonly {
    readonly id: VerificationCheckId;
    readonly status: VerificationStepStatus;
    readonly derivedFrom?: VerificationCheckId | undefined;
    readonly noteKey?: VerificationCheck['noteKey'] | undefined;
  }[];
  readonly verificationStatus: VerificationStatus;
  readonly voterEvidence:
    | {
        readonly availability: 'available';
        readonly voteReceipt: {
          readonly voteId: string;
          readonly commitment: string;
          readonly bulletinIndex: number;
          readonly bulletinRootAtCast: string;
          readonly castAtMs: number;
          readonly inputCommitment: string;
        };
        readonly userVote: {
          readonly voteId: string;
          readonly commitment: string;
          readonly proof: {
            readonly leafIndex: number;
            readonly treeSize: number;
            readonly merklePath: readonly string[];
            readonly bulletinRootAtCast: string;
          };
        };
      }
    | {
        readonly availability: 'unavailable';
        readonly reason: 'vote_id_unavailable' | 'exact_proof_unavailable';
      };
  readonly proof: {
    readonly verifiedTally: readonly [number, number, number, number, number];
    readonly missingSlots: number;
    readonly invalidPresentedSlots: number;
    readonly excludedSlots: number;
    readonly totalExpected: number;
    readonly treeSize: number;
    readonly inputCommitment: string;
  };
  readonly presentation: {
    readonly counts: Readonly<Record<VoteChoice, number>>;
    readonly totalVotes: number;
  };
}): boolean {
  const statusById = new Map(input.checks.map((check) => [check.id, check.status]));
  if (!hasCoherentCanonicalFactChecks(input, statusById)) return false;
  const zkGateStatus = resolvePublicFactZkGate(input.verificationStatus, statusById.get('stark_receipt_verify'));
  return (
    hasCoherentPublicMyVoteCheck(input, zkGateStatus) &&
    hasCoherentRecordedFactChecks(input, statusById) &&
    hasCoherentCountedFactChecks(input, statusById, zkGateStatus)
  );
}

type PublicFactCheckInput = Parameters<typeof hasCoherentPublicFactDerivedCheckStatuses>[0];
type PublicFactStatuses = ReadonlyMap<VerificationCheckId, VerificationStepStatus>;

function hasCoherentCanonicalFactChecks(input: PublicFactCheckInput, statusById: PublicFactStatuses): boolean {
  for (const definition of VERIFICATION_CHECK_DEFINITIONS) {
    const status = statusById.get(definition.id);
    if (status === undefined || (definition.category === 'cast_as_intended' && status !== 'not_run')) {
      return false;
    }
    if (definition.derivedFrom !== undefined && status !== statusById.get(definition.derivedFrom)) {
      return false;
    }
  }
  if (input.checks.some((check) => check.id !== 'counted_my_vote_included' && check.noteKey !== undefined)) {
    return false;
  }

  return true;
}

function resolvePublicFactZkGate(
  verificationStatus: VerificationStatus,
  starkReceiptStatus: VerificationStepStatus | undefined,
): ReturnType<typeof resolveZkGateStatus> {
  if (verificationStatus === 'dev_mode') return starkReceiptStatus === 'not_run' ? 'not_run' : undefined;
  return resolveZkGateStatus(verificationStatus);
}

function hasCoherentPublicMyVoteCheck(
  input: PublicFactCheckInput,
  zkGateStatus: ReturnType<typeof resolveZkGateStatus>,
): boolean {
  const myVoteIncludedCheck = input.checks.find((check) => check.id === 'counted_my_vote_included');
  if (myVoteIncludedCheck === undefined) {
    return false;
  }
  if (zkGateStatus !== undefined) {
    if (myVoteIncludedCheck.status !== zkGateStatus || myVoteIncludedCheck.noteKey !== undefined) {
      return false;
    }
  } else {
    return hasCoherentUngatedMyVoteCheck(input, myVoteIncludedCheck);
  }

  return true;
}

function hasCoherentUngatedMyVoteCheck(
  input: PublicFactCheckInput,
  myVoteIncludedCheck: PublicFactCheckInput['checks'][number],
): boolean {
  if (input.voterEvidence.availability === 'unavailable') {
    const expectedNote =
      input.proof.excludedSlots > 0
        ? 'pages.verify.stepsCard.notes.myVoteIncluded.excluded'
        : 'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt';
    if (myVoteIncludedCheck.status !== 'not_run' || myVoteIncludedCheck.noteKey !== expectedNote) {
      return false;
    }
  } else if (
    myVoteIncludedCheck.noteKey === 'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt' ||
    (myVoteIncludedCheck.status === 'success' && myVoteIncludedCheck.noteKey !== undefined)
  ) {
    return false;
  }

  return true;
}

function hasCoherentRecordedFactChecks(input: PublicFactCheckInput, statusById: PublicFactStatuses): boolean {
  const recordedCheckIds = [
    'recorded_index_in_range',
    'recorded_inclusion_proof',
    'recorded_consistency_proof',
  ] as const satisfies readonly VerificationCheckId[];
  if (input.voterEvidence.availability === 'unavailable') {
    if (recordedCheckIds.some((id) => statusById.get(id) !== 'not_run')) {
      return false;
    }
  } else {
    const voteReceipt = {
      ...input.voterEvidence.voteReceipt,
      timestamp: input.voterEvidence.voteReceipt.castAtMs,
    };
    const recordedIndexStatus = resolveRecordedIndexInRange(voteReceipt, input.proof.treeSize).status;
    if (statusById.get('recorded_index_in_range') !== recordedIndexStatus) {
      return false;
    }
    const recordedInclusionStatus = resolveRecordedInclusionProof({
      voteReceipt,
      userVote: {
        ...input.voterEvidence.userVote,
        proof: {
          ...input.voterEvidence.userVote.proof,
          merklePath: [...input.voterEvidence.userVote.proof.merklePath],
        },
      },
    }).status;
    if (statusById.get('recorded_inclusion_proof') !== recordedInclusionStatus) {
      return false;
    }
  }

  return true;
}

function hasCoherentCountedFactChecks(
  input: PublicFactCheckInput,
  statusById: PublicFactStatuses,
  zkGateStatus: ReturnType<typeof resolveZkGateStatus>,
): boolean {
  if (
    zkGateStatus !== undefined &&
    (statusById.get('counted_election_manifest_consistent') !== zkGateStatus ||
      statusById.get('counted_close_statement_consistent') !== zkGateStatus ||
      statusById.get('counted_input_commitment_match') !== zkGateStatus)
  ) {
    return false;
  }

  const expectedMissingIndicesStatus = resolveCountedMissingIndicesZero(
    {
      journal: undefined,
      missingSlots: input.proof.missingSlots,
      invalidPresentedSlots: input.proof.invalidPresentedSlots,
      excludedSlots: input.proof.excludedSlots,
    },
    zkGateStatus,
  ).status;
  if (statusById.get('counted_missing_indices_zero') !== expectedMissingIndicesStatus) {
    return false;
  }

  const expectedTallyStatus = resolveCountedTallyConsistent(
    {
      journal: undefined,
      tally: { counts: input.presentation.counts, totalVotes: input.presentation.totalVotes },
      verifiedTally: [
        input.proof.verifiedTally[0],
        input.proof.verifiedTally[1],
        input.proof.verifiedTally[2],
        input.proof.verifiedTally[3],
        input.proof.verifiedTally[4],
      ],
    },
    zkGateStatus,
  ).status;
  if (statusById.get('counted_tally_consistent') !== expectedTallyStatus) {
    return false;
  }

  const expectedVsTreeStatus = resolveCountedExpectedVsTreeSize(
    { journal: undefined, totalExpected: input.proof.totalExpected, treeSize: input.proof.treeSize },
    zkGateStatus,
  ).status;
  return statusById.get('counted_expected_vs_tree_size') === expectedVsTreeStatus;
}

export function hasCoherentPublicVerifierChecks(input: {
  readonly checks: readonly VerificationCheckStatusEvidence[];
  readonly verifierResult: {
    readonly status: VerificationStatus;
    readonly report?:
      | {
          readonly receipt_image_id: string | null;
          readonly dev_mode_receipt: boolean;
        }
      | undefined;
  };
}): boolean {
  const imageIdCheck = input.checks.find((check) => check.id === 'stark_image_id_match');
  const receiptCheck = input.checks.find((check) => check.id === 'stark_receipt_verify');
  if (!imageIdCheck || !receiptCheck) {
    return false;
  }

  const status = input.verifierResult.status;
  if (isUnverifiedReceiptStatus(status)) return imageIdCheck.status === status && receiptCheck.status === status;
  switch (status) {
    case 'success':
      return (
        receiptCheck.status === 'success' &&
        imageIdCheck.status === (input.verifierResult.report === undefined ? 'not_run' : 'success')
      );
    case 'dev_mode':
      return hasCoherentDevelopmentVerifierChecks(input, imageIdCheck, receiptCheck);
  }
}

function isUnverifiedReceiptStatus(status: VerificationStatus): status is 'not_run' | 'running' | 'failed' {
  return status === 'not_run' || status === 'running' || status === 'failed';
}

function hasCoherentDevelopmentVerifierChecks(
  input: Parameters<typeof hasCoherentPublicVerifierChecks>[0],
  imageIdCheck: VerificationCheckStatusEvidence,
  receiptCheck: VerificationCheckStatusEvidence,
): boolean {
  if (receiptCheck.status === 'not_run' && imageIdCheck.status === 'not_run') {
    return true;
  }
  const expectedImageStatus =
    input.verifierResult.report === undefined
      ? 'not_run'
      : input.verifierResult.report.receipt_image_id === null
        ? 'failed'
        : 'success';
  return receiptCheck.status === 'success' && imageIdCheck.status === expectedImageStatus;
}

function hasSameVerificationSummary(
  left: VerificationSummaryResult | null,
  right: SerializableVerificationPresentationPolicy['summary'],
): boolean {
  if (left === null || right === null) return left === right;
  return left.status === right.status && left.tone === right.tone && left.messageKey === right.messageKey;
}

function hasSameDisplayDecision(
  left: VerificationDisplayDecision,
  right: SerializableVerificationPresentationPolicy['display'],
): boolean {
  return (
    left.readiness === right.readiness &&
    left.source === right.source &&
    left.status === right.status &&
    left.renderedStatus === right.renderedStatus
  );
}

function hasSamePresentationExplanation(
  derived: VerificationPresentationPolicyResult,
  candidate: SerializableVerificationPresentationPolicy,
): boolean {
  return (
    derived.publishedTallyMismatch === candidate.publishedTallyMismatch &&
    derived.devModeEvidence === candidate.devModeEvidence &&
    derived.missingEvidence === candidate.missingEvidence &&
    derived.explanationKey === candidate.explanationKey
  );
}

function hasSamePresentationPolicy(
  derived: VerificationPresentationPolicyResult,
  candidate: SerializableVerificationPresentationPolicy,
): boolean {
  return (
    hasSameVerificationSummary(derived.summary, candidate.summary) &&
    hasSameStageStatuses(derived.stageStatuses, candidate.stageStatuses) &&
    derived.evidenceFullyVerified === candidate.evidenceFullyVerified &&
    derived.fullyVerifiedLabelEligible === candidate.fullyVerifiedLabelEligible &&
    hasSameDisplayDecision(derived.display, candidate.display) &&
    hasSamePresentationExplanation(derived, candidate)
  );
}

export function hasCoherentPublicPresentationPolicy(input: {
  readonly checks: FullyVerifiedPresentationEvidenceInput['checks'];
  readonly policy: SerializableVerificationPresentationPolicy;
  readonly proof: Pick<
    VerificationSummaryContext,
    'missingSlots' | 'invalidPresentedSlots' | 'rejectedRecords' | 'excludedSlots'
  >;
  readonly verificationStatus: VerificationStatus;
  readonly verificationReportStatus?: VerificationStatus | undefined;
  readonly devModeEvidence: boolean;
}): boolean {
  const checks = projectCanonicalVerificationChecks(input.checks, input.devModeEvidence);
  if (!checks) {
    return false;
  }
  return [false, true].some((sthSourcesConfigured) =>
    hasSamePresentationPolicy(
      deriveVerificationPresentationPolicy({
        availability: 'available',
        checks,
        context: { ...input.proof, sthSourcesConfigured },
        verificationStatus: input.verificationStatus,
        ...(input.verificationReportStatus === undefined
          ? {}
          : { verificationReportStatus: input.verificationReportStatus }),
      }),
      input.policy,
    ),
  );
}

function projectCanonicalVerificationChecks(
  checks: FullyVerifiedPresentationEvidenceInput['checks'],
  devModeEvidence: boolean,
): VerificationCheck[] | undefined {
  if (!hasCanonicalVerificationCheckEvidence(checks, devModeEvidence)) {
    return undefined;
  }
  return VERIFICATION_CHECK_DEFINITIONS.map((definition, index) => {
    const check = checks[index];
    if (!check) {
      return undefined;
    }
    return {
      id: definition.id,
      status: check.status,
      evidence: devModeEvidence && definition.evidence === 'zk' ? 'demo' : definition.evidence,
      inputs: [...definition.inputs],
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    };
  }).filter((check): check is VerificationCheck => check !== undefined);
}

export function hasCoherentVerificationReportExpectedImageId(
  report: { readonly expected_image_id: string } | undefined,
  proofImageId: string,
): boolean {
  return report === undefined || normalizeHexString(report.expected_image_id) === normalizeHexString(proofImageId);
}

export function hasCoherentAvailableVoterEvidence(input: {
  readonly voterEvidence: FullyVerifiedAvailableVoterEvidenceInput;
  readonly proofAuthority: {
    readonly bulletinRoot: string;
    readonly inputCommitment: string;
    readonly treeSize: number;
  };
}): boolean {
  const { voteReceipt, userVote } = input.voterEvidence;
  const castTreeSize = userVote.proof.treeSize;
  if (
    voteReceipt.voteId !== userVote.voteId ||
    normalizeHexString(voteReceipt.commitment) !== normalizeHexString(userVote.commitment) ||
    voteReceipt.bulletinIndex !== userVote.proof.leafIndex ||
    normalizeHexString(voteReceipt.bulletinRootAtCast) !== normalizeHexString(userVote.proof.bulletinRootAtCast) ||
    normalizeHexString(voteReceipt.inputCommitment) !== normalizeHexString(input.proofAuthority.inputCommitment) ||
    !Number.isSafeInteger(userVote.proof.leafIndex) ||
    userVote.proof.leafIndex < 0 ||
    !Number.isSafeInteger(castTreeSize) ||
    castTreeSize !== voteReceipt.bulletinIndex + 1 ||
    userVote.proof.leafIndex >= castTreeSize ||
    castTreeSize > input.proofAuthority.treeSize
  ) {
    return false;
  }
  return (
    castTreeSize !== input.proofAuthority.treeSize ||
    normalizeHexString(userVote.proof.bulletinRootAtCast) === normalizeHexString(input.proofAuthority.bulletinRoot)
  );
}

export function hasCoherentTamperPresentation(input: {
  readonly scenarioId: string;
  readonly tamperDetected: boolean;
  readonly tamperedCount: number;
  readonly proof: {
    readonly missingSlots: number;
    readonly invalidPresentedSlots: number;
    readonly rejectedRecords: number;
    readonly excludedSlots: number;
  };
  readonly tamperSummary?: FullyVerifiedPresentationEvidenceInput['presentation']['tamperSummary'];
}): boolean {
  if (input.scenarioId !== 'S0' && !input.tamperDetected) {
    return false;
  }
  if (input.tamperDetected) {
    return true;
  }
  const tamperSummary = input.tamperSummary;
  return (
    input.tamperedCount === 0 &&
    input.proof.missingSlots === 0 &&
    input.proof.invalidPresentedSlots === 0 &&
    input.proof.rejectedRecords === 0 &&
    input.proof.excludedSlots === 0 &&
    (tamperSummary === undefined ||
      (tamperSummary.ignoredVotes === 0 &&
        tamperSummary.recountedVotes === 0 &&
        tamperSummary.userRecountedTo === null &&
        (tamperSummary.affectedBotIds?.length ?? 0) === 0))
  );
}

function hasSuccessfulPresentationReceipt(
  report: FullyVerifiedPresentationEvidenceInput['verificationReport'],
  imageId: string,
): boolean {
  return (
    report === undefined ||
    (report.status === 'success' &&
      hasCoherentVerificationReportExpectedImageId(report, imageId) &&
      report.receipt_image_id !== null &&
      normalizeHexString(report.receipt_image_id) === normalizeHexString(imageId))
  );
}

function hasCompletePublicVotePartition(proof: FullyVerifiedPresentationEvidenceInput['proof']): boolean {
  return (
    proof.missingSlots === 0 &&
    proof.invalidPresentedSlots === 0 &&
    proof.rejectedRecords === 0 &&
    proof.excludedSlots === 0 &&
    proof.treeSize === proof.totalExpected &&
    proof.seenIndicesCount === proof.treeSize
  );
}

function hasHonestTamperPresentation(input: FullyVerifiedPresentationEvidenceInput): boolean {
  return (
    hasCoherentTamperPresentation({
      scenarioId: input.scenarioId,
      tamperDetected: input.presentation.tamperDetected ?? false,
      tamperedCount: input.presentation.tamperedCount ?? 0,
      proof: input.proof,
      tamperSummary: input.presentation.tamperSummary,
    }) && input.presentation.tamperDetected !== true
  );
}

function hasAdmissibleFullyVerifiedFacts(input: FullyVerifiedPresentationEvidenceInput): boolean {
  return (
    input.scenarioId === 'S0' &&
    input.verificationStatus === 'success' &&
    input.voterEvidence.availability === 'available' &&
    normalizeHexString(input.proof.seenBitmapRoot) === normalizeHexString(input.proof.includedBitmapRoot) &&
    hasSuccessfulPresentationReceipt(input.verificationReport, input.proof.imageId) &&
    hasCoherentAvailableVoterEvidence({ voterEvidence: input.voterEvidence, proofAuthority: input.proof }) &&
    hasHonestTamperPresentation(input) &&
    hasCompletePublicVotePartition(input.proof)
  );
}

/** Recomputes every public fact that can authorize the fully verified presentation. */
export function hasCoherentFullyVerifiedPresentationEvidence(input: FullyVerifiedPresentationEvidenceInput): boolean {
  if (!hasAdmissibleFullyVerifiedFacts(input)) return false;

  const checks = projectCanonicalVerificationChecks(input.checks, false);
  if (!checks) {
    return false;
  }
  const sthSourcesConfigured = resolveEffectiveSthSourcesConfigured(checks, input.stageStatuses);
  const derivedPolicy = deriveVerificationPresentationPolicy({
    availability: 'available',
    checks,
    context: {
      missingSlots: input.proof.missingSlots,
      invalidPresentedSlots: input.proof.invalidPresentedSlots,
      rejectedRecords: input.proof.rejectedRecords,
      excludedSlots: input.proof.excludedSlots,
      sthSourcesConfigured,
      devModeEvidence: false,
    },
    verificationStatus: input.verificationStatus,
    verificationReportStatus: input.verificationStatus,
  });
  if (
    !derivedPolicy.fullyVerifiedLabelEligible ||
    !hasSameStageStatuses(derivedPolicy.stageStatuses, input.stageStatuses)
  ) {
    return false;
  }

  const verifiedCounts: Readonly<Record<VoteChoice, number>> = {
    A: input.proof.verifiedTally[0],
    B: input.proof.verifiedTally[1],
    C: input.proof.verifiedTally[2],
    D: input.proof.verifiedTally[3],
    E: input.proof.verifiedTally[4],
  };
  const verifiedTotal = VOTE_CHOICES.reduce((sum, choice) => sum + verifiedCounts[choice], 0);
  return (
    VOTE_CHOICES.every((choice) => input.presentation.counts[choice] === verifiedCounts[choice]) &&
    input.presentation.totalVotes === verifiedTotal &&
    input.presentation.totalVotes === input.proof.totalExpected
  );
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
  if (definedCounts.some((value) => value > 0)) {
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

function hasSuccessfulProofChecks(checks: readonly VerificationCheck[]): boolean {
  const receiptSucceeded = checks.some((check) => check.id === 'stark_receipt_verify' && check.status === 'success');
  const imageIdChecks = checks.filter((check) => check.id === 'stark_image_id_match');
  const imageIdSucceededOrAbsent =
    imageIdChecks.length === 0 || imageIdChecks.some((check) => check.status === 'success');
  return receiptSucceeded && imageIdSucceededOrAbsent;
}

function resolvePresentationVerificationStatus(
  verificationStatus: VerificationStatus | undefined,
  verificationReportStatus: VerificationStatus | undefined,
): VerificationStatus | undefined {
  const resolvedStatus =
    verificationStatus === 'running' || verificationStatus === 'not_run'
      ? verificationStatus
      : (verificationReportStatus ?? verificationStatus);
  return resolvedStatus;
}

function hasExplicitProofFailure(
  checks: readonly VerificationCheck[],
  verificationStatus: VerificationStatus | undefined,
  verificationReportStatus: VerificationStatus | undefined,
): boolean {
  if (verificationReportStatus === 'failed' || hasFailedCheck(checks, EXPLICIT_PROOF_FAILURE_CHECK_IDS)) {
    return true;
  }

  const proofSucceeded =
    verificationReportStatus === 'success' ||
    verificationReportStatus === 'dev_mode' ||
    hasSuccessfulProofChecks(checks);
  const resolvedStatus = resolvePresentationVerificationStatus(verificationStatus, verificationReportStatus);

  return resolvedStatus === 'failed' && !proofSucceeded;
}

function deriveUnavailableDisplay(
  availability: Exclude<VerificationAvailability, 'available'>,
  input: Pick<VerificationPresentationPolicyInput, 'verificationStarted' | 'sequenceComplete'>,
): Exclude<VerificationDisplayDecision, FullyVerifiedDisplayDecision> {
  const readiness = resolveDisplayReadiness({
    verificationStarted: input.verificationStarted ?? true,
    sequenceComplete: input.sequenceComplete ?? true,
    hasCheckPending: false,
  });
  if (availability === 'corrupt') {
    return readiness === 'ready'
      ? { readiness: 'ready', source: 'corrupt', status: 'failed', renderedStatus: 'failed' }
      : { readiness, source: 'corrupt', status: 'failed', renderedStatus: null };
  }
  return readiness === 'ready'
    ? { readiness: 'ready', source: 'unavailable', status: 'warning', renderedStatus: 'warning' }
    : { readiness, source: 'unavailable', status: 'warning', renderedStatus: null };
}

const NOT_RUN_STAGE_STATUSES: VerificationStageStatuses = {
  cast_as_intended: 'not_run',
  recorded_as_cast: 'not_run',
  counted_as_recorded: 'not_run',
  stark_verification: 'not_run',
};

function hasDevelopmentPresentationEvidence(
  input: VerificationPresentationPolicyInput,
  checks: readonly VerificationCheck[],
): boolean {
  return (
    input.context?.devModeEvidence === true ||
    input.verificationStatus === 'dev_mode' ||
    input.verificationReportStatus === 'dev_mode' ||
    checks.some((check) => check.evidence === 'demo')
  );
}

function deriveAvailableDisplay(
  input: VerificationPresentationPolicyInput,
  checks: readonly VerificationCheck[],
  summary: VerificationSummaryResult | null,
  hardFailureDetected: boolean,
  explicitServerFailureStatus: VerificationExplicitServerFailureStatus | null,
): VerificationDisplayDecision {
  return resolveVerificationDisplayDecision({
    verificationStarted: input.verificationStarted ?? true,
    sequenceComplete: input.sequenceComplete ?? true,
    hasCheckPending: checks.some((check) => check.status === 'pending' || check.status === 'running'),
    explicitServerFailureStatus,
    summaryTone: summary?.tone ?? null,
    hasVerificationChecks: checks.length > 0,
    hardFailureDetected,
  });
}

function hasFullyVerifiedSummaryEvidence(
  summary: VerificationSummaryResult | null,
  hardFailureDetected: boolean,
  explicitServerFailureStatus: VerificationExplicitServerFailureStatus | null,
): summary is VerificationSummaryResult & { status: 'fully_verified'; tone: 'verified' } {
  return (
    summary?.status === 'fully_verified' &&
    summary.tone === 'verified' &&
    !hardFailureDetected &&
    explicitServerFailureStatus === null
  );
}

function deriveIneligiblePresentationPolicy(
  summary: VerificationSummaryResult | null,
  stageStatuses: VerificationStageStatuses,
  evidenceFullyVerified: boolean,
  display: VerificationDisplayDecision,
  devModeEvidence: boolean,
): VerificationPresentationPolicyResult {
  if (isFullyVerifiedDisplayDecision(display)) {
    throw new Error('Verification presentation policy derived contradictory fully verified facts');
  }
  return {
    summary,
    stageStatuses,
    evidenceFullyVerified,
    fullyVerifiedLabelEligible: false,
    display,
    publishedTallyMismatch: summary?.status === 'published_tally_mismatch',
    devModeEvidence,
    missingEvidence: summary === null || summary.status === 'missing_evidence',
    ...(summary?.messageKey ? { explanationKey: summary.messageKey } : {}),
  };
}

export function deriveVerificationPresentationPolicy(
  input: VerificationPresentationPolicyInput,
): VerificationPresentationPolicyResult {
  const checks = input.checks ? [...input.checks] : [];
  const devModeEvidence = hasDevelopmentPresentationEvidence(input, checks);

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
  const display = deriveAvailableDisplay(input, checks, summary, hardFailureDetected, explicitServerFailureStatus);
  const evidenceFullyVerified = hasFullyVerifiedSummaryEvidence(
    summary,
    hardFailureDetected,
    explicitServerFailureStatus,
  );

  const stageStatuses = deriveStageStatuses(checks, context);
  if (
    evidenceFullyVerified &&
    summary.status === 'fully_verified' &&
    summary.tone === 'verified' &&
    isFullyVerifiedDisplayDecision(display) &&
    areAllVerificationStagesSuccessful(stageStatuses) &&
    !devModeEvidence
  ) {
    return {
      [fullyVerifiedEligibilityWitness]: true,
      summary: { ...summary, status: 'fully_verified', tone: 'verified' },
      stageStatuses,
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
    };
  }

  return deriveIneligiblePresentationPolicy(summary, stageStatuses, evidenceFullyVerified, display, devModeEvidence);
}
