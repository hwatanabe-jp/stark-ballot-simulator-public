import type {
  AvailableVerificationResource,
  CurrentZkVMJournal,
  VerificationResource,
} from '@stark-ballot/api-contract/schemas/verification';
import type { DownloadCandidate, ReportCandidate } from '@stark-ballot/web/api/artifacts';
import {
  buildAuthenticatedBundleDownloadUrl,
  buildAuthenticatedReportDownloadUrl,
} from '@stark-ballot/web/api/artifacts';
import type { VerificationStepId, VerificationStepStatus } from '@stark-ballot/web/knowledge';
import type { SessionData } from '@stark-ballot/web/session/types';
import { getVerificationStepInputs, type VerificationCheck } from '@stark-ballot/verification/checks';
import {
  deriveVerificationPresentationPolicy,
  type VerificationPresentationPolicyResult,
} from '@stark-ballot/verification/presentation-policy';
import type { VerificationStatus, VoteReceipt } from '@stark-ballot/verification/shared/types';
import type { Receipt as DetectionReceipt, VoteData as DetectionVoteData } from '@stark-ballot/verification/types';
import type { VoteChoice } from '@stark-ballot/verification/shared/constants';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { evaluateBrowserLocalCastEvidence } from './local-cast-evidence';

export interface VerificationPayload {
  electionId?: string;
  electionConfigHash?: string;
  tally?: {
    counts?: Record<VoteChoice, number>;
    totalVotes?: number;
    tamperedCount?: number;
  };
  totalVotes?: number;
  scenarioId?: string;
  verificationStatus?: VerificationStatus;
  verificationReport?: {
    status: VerificationStatus;
    duration_ms?: number;
    errors?: string[];
    expected_image_id?: string;
    receipt_image_id?: string | null;
    dev_mode_receipt?: boolean;
  };
  verificationSteps?: Array<{
    id: VerificationStepId;
    status: VerificationStepStatus;
    inputs?: string[];
    error?: string;
  }>;
  verificationChecks?: VerificationCheck[];
  presentationPolicy?: VerificationPresentationPolicyResult;
  imageId?: string;
  tamperDetected?: boolean;
  verifiedTally?: number[];
  bulletinRoot?: string;
  missingSlots?: number;
  invalidPresentedSlots?: number;
  rejectedRecords?: number;
  validVotes?: number;
  totalExpected?: number;
  treeSize?: number;
  excludedSlots?: number;
  sthDigest?: string;
  seenBitmapRoot?: string;
  includedBitmapRoot?: string;
  inputCommitment?: string;
  seenIndicesCount?: number;
  journalStatus?: 'available' | 'omitted';
  journal?: CurrentZkVMJournal;
  voteReceipt?: VoteReceipt;
  userVote?: {
    commitment: string;
    voteId?: string;
    proof?: {
      leafIndex: number;
      treeSize: number;
      merklePath: string[];
      bulletinRootAtCast: string;
    };
  };
  botVotesSummary?: {
    total?: number;
    affectedBotIds?: number[];
    source: string;
  };
  finalizationId?: string;
}

export type VerificationResourceProjection =
  | {
      availability: 'available';
      data: VerificationPayload;
    }
  | {
      availability: 'unavailable' | 'corrupt';
      data: null;
      message: string;
    };

export interface VerificationProjectionOptions {
  sthSourcesConfigured?: boolean;
}

const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const satisfies readonly VerificationStepId[];

export function resolveStarkStatus(
  verificationStatus?: VerificationStatus,
  verificationReport?: { status?: VerificationStatus },
): VerificationStatus {
  if (verificationStatus === 'running' || verificationStatus === 'not_run') {
    return verificationStatus;
  }
  return verificationReport?.status ?? verificationStatus ?? 'not_run';
}

function buildPresentationPolicy(
  resource: AvailableVerificationResource,
  checks: readonly VerificationCheck[],
  options: VerificationProjectionOptions,
): VerificationPresentationPolicyResult {
  return deriveVerificationPresentationPolicy({
    availability: 'available',
    checks,
    context: {
      missingSlots: resource.proofAuthority.missingSlots,
      invalidPresentedSlots: resource.proofAuthority.invalidPresentedSlots,
      rejectedRecords: resource.proofAuthority.rejectedRecords,
      excludedSlots: resource.proofAuthority.excludedSlots,
      sthSourcesConfigured: options.sthSourcesConfigured === true,
      devModeEvidence: resource.verifierResult.report?.dev_mode_receipt === true,
    },
    verificationStatus: resource.verifierResult.status,
    ...(resource.verifierResult.report ? { verificationReportStatus: resource.verifierResult.report.status } : {}),
  });
}

function projectVerificationSteps(
  resource: AvailableVerificationResource,
  policy: VerificationPresentationPolicyResult,
): NonNullable<VerificationPayload['verificationSteps']> {
  const serverSteps = new Map(resource.verification.steps.map((step) => [step.id, step] as const));
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

function projectUserVote(resource: AvailableVerificationResource): NonNullable<VerificationPayload['userVote']> {
  const evidence = resource.voterEvidence;
  if (evidence.availability === 'available') {
    return {
      commitment: evidence.userVote.commitment,
      voteId: evidence.userVote.voteId,
      proof: {
        leafIndex: evidence.userVote.proof.leafIndex,
        treeSize: evidence.userVote.proof.treeSize,
        merklePath: [...evidence.userVote.proof.merklePath],
        bulletinRootAtCast: evidence.userVote.proof.bulletinRootAtCast,
      },
    };
  }
  return {
    commitment: evidence.userVote.commitment,
    ...(evidence.userVote.voteId ? { voteId: evidence.userVote.voteId } : {}),
  };
}

export function projectVerificationResource(
  resource: VerificationResource,
  session: SessionData | null,
  options: VerificationProjectionOptions = {},
): VerificationResourceProjection {
  if (resource.availability !== 'available') {
    return {
      availability: resource.availability,
      data: null,
      message: resource.message,
    };
  }

  const localEvidence = evaluateBrowserLocalCastEvidence(resource, session);
  if (!localEvidence) {
    return {
      availability: 'corrupt',
      data: null,
      message: 'Verification checks are incomplete or duplicated',
    };
  }

  const policy = buildPresentationPolicy(resource, localEvidence.checks, options);
  const journal = resource.journal.representation === 'included' ? resource.journal.value : undefined;
  const proof = resource.proofAuthority;
  const report = resource.verifierResult.report;

  return {
    availability: 'available',
    data: {
      electionId: proof.electionId,
      electionConfigHash: proof.electionConfigHash,
      tally: {
        counts: { ...resource.presentation.tally.counts },
        totalVotes: resource.presentation.tally.totalVotes,
        tamperedCount: resource.presentation.tally.tamperedCount ?? 0,
      },
      totalVotes: resource.presentation.tally.totalVotes,
      scenarioId: resource.presentation.scenarioId,
      verificationStatus: resource.verifierResult.status,
      ...(report
        ? {
            verificationReport: {
              status: report.status,
              ...omitUndefinedProperties({
                duration_ms: report.duration_ms,
                errors: report.errors ? [...report.errors] : undefined,
                expected_image_id: report.expected_image_id,
                receipt_image_id: report.receipt_image_id,
                dev_mode_receipt: report.dev_mode_receipt,
              }),
            },
          }
        : {}),
      verificationSteps: projectVerificationSteps(resource, policy),
      verificationChecks: localEvidence.checks,
      presentationPolicy: policy,
      imageId: proof.imageId,
      ...omitUndefinedProperties({ tamperDetected: resource.presentation.tamperDetected }),
      verifiedTally: [...proof.verifiedTally],
      bulletinRoot: proof.bulletinRoot,
      missingSlots: proof.missingSlots,
      invalidPresentedSlots: proof.invalidPresentedSlots,
      rejectedRecords: proof.rejectedRecords,
      ...omitUndefinedProperties({ validVotes: journal?.validVotes }),
      totalExpected: proof.totalExpected,
      treeSize: proof.treeSize,
      excludedSlots: proof.excludedSlots,
      sthDigest: proof.sthDigest,
      ...omitUndefinedProperties({ seenBitmapRoot: proof.seenBitmapRoot }),
      includedBitmapRoot: proof.includedBitmapRoot,
      inputCommitment: proof.inputCommitment,
      seenIndicesCount: proof.seenIndicesCount,
      journalStatus: journal ? 'available' : 'omitted',
      ...omitUndefinedProperties({ journal }),
      ...omitUndefinedProperties({ voteReceipt: localEvidence.voteReceipt }),
      userVote: projectUserVote(resource),
      ...omitUndefinedProperties({
        botVotesSummary: resource.presentation.botVotesSummary
          ? {
              source: resource.presentation.botVotesSummary.source,
              ...omitUndefinedProperties({ total: resource.presentation.botVotesSummary.total }),
              ...(resource.presentation.botVotesSummary.affectedBotIds
                ? { affectedBotIds: [...resource.presentation.botVotesSummary.affectedBotIds] }
                : {}),
            }
          : undefined,
      }),
      finalizationId: resource.finalizationId,
    },
  };
}

export function resolveBundleCandidate(data: VerificationPayload | null, sessionId?: string): DownloadCandidate | null {
  if (
    !data?.finalizationId ||
    !sessionId ||
    !isSafeVerifierSegment(sessionId) ||
    !isSafeVerifierSegment(data.finalizationId)
  ) {
    return null;
  }
  return {
    kind: 'bundle',
    url: buildAuthenticatedBundleDownloadUrl(sessionId, data.finalizationId),
    source: 'authenticated-endpoint',
    sessionId,
    finalizationId: data.finalizationId,
  };
}

export function resolveReportCandidate(data: VerificationPayload | null, sessionId?: string): ReportCandidate | null {
  if (
    !data?.finalizationId ||
    !sessionId ||
    !isSafeVerifierSegment(sessionId) ||
    !isSafeVerifierSegment(data.finalizationId)
  ) {
    return null;
  }
  return {
    kind: 'report',
    url: buildAuthenticatedReportDownloadUrl(sessionId, data.finalizationId),
    source: 'authenticated-endpoint',
    sessionId,
    finalizationId: data.finalizationId,
  };
}

export function buildDetectionReceipt(data: VerificationPayload): DetectionReceipt | null {
  const bulletinRoot = data.bulletinRoot || data.voteReceipt?.bulletinRootAtCast;
  const counts = data.tally?.counts;
  if (!bulletinRoot || !counts) {
    return null;
  }
  return omitUndefinedProperties({
    tally: counts,
    bulletinRoot,
    totalVotes: data.tally?.totalVotes ?? 0,
    tamperedCount: data.tally?.tamperedCount ?? 0,
    missingSlots: data.missingSlots,
    invalidPresentedSlots: data.invalidPresentedSlots,
    rejectedRecords: data.rejectedRecords,
    excludedSlots: data.excludedSlots,
    validVotes: data.validVotes,
    verifiedTally: data.verifiedTally,
  });
}

export function buildDetectionVote(data: VerificationPayload, session: SessionData | null): DetectionVoteData | null {
  const proof = data.userVote?.proof;
  if (!data.userVote || !proof || !session?.myVote || !session.myRand) {
    return null;
  }
  return {
    commitment: data.userVote.commitment,
    path: proof.merklePath,
    leafIndex: proof.leafIndex,
    choice: session.myVote,
    random: session.myRand,
    treeSize: proof.treeSize,
  };
}
