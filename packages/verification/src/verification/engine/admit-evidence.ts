import type { VerificationFailureCategory, VerificationStatus } from '@stark-ballot/verification/shared/types';
import {
  TERMINAL_VERIFICATION_STATUS_VALUES,
  VERIFICATION_FAILURE_CATEGORY_VALUES,
  VERIFICATION_STATUS_VALUES,
} from '@stark-ballot/verification/shared/types';
import { isNonNullObject } from '@stark-ballot/validation/unknown-value-guards';
import type {
  AdmittedEvidence,
  AdmittedVerificationEvidence,
  AdmittedVerifierOutcome,
  VerificationComparisonReportEvidence,
  VerificationEvaluationInput,
  VerificationOutcomeInput,
  VerificationReportEvidence,
} from './types';

const VERIFICATION_STATUSES = new Set<VerificationStatus>(VERIFICATION_STATUS_VALUES);
const TERMINAL_VERIFICATION_STATUSES = new Set<VerificationStatus>(TERMINAL_VERIFICATION_STATUS_VALUES);
const FAILURE_CATEGORIES = new Set<VerificationFailureCategory>(VERIFICATION_FAILURE_CATEGORY_VALUES);

export function admitVerifierOutcome(input: unknown): VerificationOutcomeInput | undefined {
  if (!isNonNullObject(input)) return undefined;
  const evidence = admitVerifierStatusEvidence(input);
  if (!evidence) return undefined;
  const failureCategory = admitFailureCategory(input['failureCategory']);
  if (input['failureCategory'] !== undefined && failureCategory === undefined) return undefined;
  if (evidence.status !== 'failed' && failureCategory !== undefined && failureCategory !== 'none') return undefined;
  return buildVerifierOutcome(evidence.status, evidence.report, failureCategory);
}

function admitVerifierStatusEvidence(input: Record<string, unknown>) {
  const verificationStatus = admitVerificationStatus(input['verificationStatus']);
  if (input['verificationStatus'] !== undefined && verificationStatus === undefined) {
    return undefined;
  }

  const reportStatus = admitVerificationStatus(input['verificationReportStatus']);
  if (
    input['verificationReportStatus'] !== undefined &&
    (reportStatus === undefined || !TERMINAL_VERIFICATION_STATUSES.has(reportStatus))
  ) {
    return undefined;
  }

  const report =
    input['verificationReport'] === undefined ? undefined : admitReportEvidence(input['verificationReport']);
  if (input['verificationReport'] !== undefined && report === undefined) {
    return undefined;
  }

  return resolveCoherentVerifierStatus(verificationStatus, reportStatus, report);
}

function resolveCoherentVerifierStatus(
  verificationStatus: VerificationStatus | undefined,
  reportStatus: VerificationStatus | undefined,
  report: VerificationReportEvidence | undefined,
) {
  const statusBearingReportStatus = report?.status;
  const statuses = [verificationStatus, reportStatus, statusBearingReportStatus].filter(
    (status): status is VerificationStatus => status !== undefined,
  );
  const distinctStatuses = new Set(statuses);
  if (distinctStatuses.size > 1) {
    return undefined;
  }

  const status = statuses[0] ?? 'not_run';
  if ((status === 'not_run' || status === 'running') && report !== undefined) {
    return undefined;
  }

  return { status, report };
}

function buildVerifierOutcome(
  status: VerificationStatus,
  report: VerificationReportEvidence | undefined,
  failureCategory: VerificationFailureCategory | undefined,
): VerificationOutcomeInput | undefined {
  switch (status) {
    case 'not_run':
    case 'running':
      return { status, failureCategory: 'none' };
    case 'success': {
      return {
        status,
        ...(report ? { report: asSuccessOrComparisonReport(report) } : {}),
        failureCategory: 'none',
      };
    }
    case 'dev_mode': {
      return {
        status,
        ...(report ? { report: asDevModeOrComparisonReport(report) } : {}),
        failureCategory: 'none',
      };
    }
    case 'failed':
      return buildFailedVerifierOutcome(report, failureCategory);
  }
}

function buildFailedVerifierOutcome(
  report: VerificationReportEvidence | undefined,
  failureCategory: VerificationFailureCategory | undefined,
): VerificationOutcomeInput | undefined {
  if (failureCategory === 'none') return undefined;
  return {
    status: 'failed',
    ...(report ? { report: asFailedOrComparisonReport(report) } : {}),
    failureCategory: failureCategory ?? 'unknown',
  };
}

function normalizeVerifierOutcome(input: VerificationOutcomeInput): AdmittedVerifierOutcome {
  switch (input.status) {
    case 'not_run':
    case 'running':
      return {
        status: input.status,
        report: { availability: 'unavailable' },
        failureCategory: 'none',
      };
    case 'success':
      return {
        status: 'success',
        report: toAdmittedEvidence(input.report),
        failureCategory: 'none',
      };
    case 'dev_mode':
      return {
        status: 'dev_mode',
        report: toAdmittedEvidence(input.report),
        failureCategory: 'none',
      };
    case 'failed':
      return {
        status: 'failed',
        report: toAdmittedEvidence(input.report),
        failureCategory: input.failureCategory ?? 'unknown',
      };
  }
}

export function admitVerificationEvidence(input: VerificationEvaluationInput): AdmittedVerificationEvidence {
  const verifierOutcome = normalizeVerifierOutcome(input.verifierOutcome ?? { status: 'not_run' });

  return {
    identity: {
      electionId: toAdmittedEvidence(input.electionId),
      electionConfigHash: toAdmittedEvidence(input.electionConfigHash),
      logId: toAdmittedEvidence(input.logId),
      sthSourcesConfigured: toAdmittedEvidence(input.sthSourcesConfigured),
      claimedImageId: toAdmittedEvidence(input.claimedImageId),
      comparisonImageId: toAdmittedEvidence(input.comparisonImageId),
      allowDevModeVerification: toAdmittedEvidence(input.allowDevModeVerification),
    },
    userReceipt: {
      voteReceipt: toAdmittedEvidence(input.voteReceipt),
      userVote: toAdmittedEvidence(input.userVote),
    },
    artifacts: {
      journal: toAdmittedEvidence(input.journal),
      electionManifest: toAdmittedEvidence(input.electionManifest),
      closeStatement: toAdmittedEvidence(input.closeStatement),
      sthDigest: toAdmittedEvidence(input.sthDigest),
      sthVerification: toAdmittedEvidence(input.sthVerification),
      bulletinRoot: toAdmittedEvidence(input.bulletinRoot),
      treeSize: toAdmittedEvidence(input.treeSize),
      publicInputAuthority: toAdmittedEvidence(input.publicInputAuthority),
      seenBitmapRoot: toAdmittedEvidence(input.seenBitmapRoot),
      includedBitmapRoot: toAdmittedEvidence(input.includedBitmapRoot),
      bitmapProofSource: toAdmittedEvidence(input.bitmapProofSource),
      consistencyProof: input.consistencyProof ?? { kind: 'unavailable' },
      includedBitmapProof: input.includedBitmapProof ?? { kind: 'unavailable' },
      seenBitmapProof: input.seenBitmapProof ?? { kind: 'unavailable' },
    },
    tally: {
      missingSlots: toAdmittedEvidence(input.missingSlots),
      invalidPresentedSlots: toAdmittedEvidence(input.invalidPresentedSlots),
      rejectedRecords: toAdmittedEvidence(input.rejectedRecords),
      excludedSlots: toAdmittedEvidence(input.excludedSlots),
      tally: toAdmittedEvidence(input.tally),
      verifiedTally: toAdmittedEvidence(input.verifiedTally),
      totalExpected: toAdmittedEvidence(input.totalExpected),
      inputCommitment: toAdmittedEvidence(input.inputCommitment),
    },
    verifierOutcome,
  };
}

export function evidenceValue<T>(evidence: AdmittedEvidence<T>): T | undefined {
  return evidence.availability === 'available' ? evidence.value : undefined;
}

function toAdmittedEvidence<T>(value: T | undefined): AdmittedEvidence<T> {
  return value === undefined ? { availability: 'unavailable' } : { availability: 'available', value };
}

function admitVerificationStatus(value: unknown): VerificationStatus | undefined {
  return typeof value === 'string' && VERIFICATION_STATUSES.has(value as VerificationStatus)
    ? (value as VerificationStatus)
    : undefined;
}

function admitFailureCategory(value: unknown): VerificationFailureCategory | undefined {
  return typeof value === 'string' && FAILURE_CATEGORIES.has(value as VerificationFailureCategory)
    ? (value as VerificationFailureCategory)
    : undefined;
}

function admitReportEvidence(input: unknown): VerificationReportEvidence | undefined {
  if (!isNonNullObject(input)) {
    return undefined;
  }

  const expectedImageId = input['expected_image_id'];
  const receiptImageId = input['receipt_image_id'];
  if (expectedImageId !== undefined && typeof expectedImageId !== 'string') {
    return undefined;
  }
  if (receiptImageId !== undefined && receiptImageId !== null && typeof receiptImageId !== 'string') {
    return undefined;
  }

  return admitStatusBearingReport(input, expectedImageId, receiptImageId);
}

function admitComparisonReport(
  expectedImageId: string | undefined,
  receiptImageId: string | null | undefined,
  devModeReceipt: unknown,
): VerificationComparisonReportEvidence | undefined {
  if (
    typeof expectedImageId !== 'string' ||
    (typeof receiptImageId !== 'string' && receiptImageId !== null) ||
    devModeReceipt !== undefined
  ) {
    return undefined;
  }
  return {
    expected_image_id: expectedImageId,
    receipt_image_id: receiptImageId,
  } satisfies VerificationComparisonReportEvidence;
}

function projectAdmittedReportImageIds(expectedImageId: string | undefined, receiptImageId: string | null | undefined) {
  return {
    ...(expectedImageId === undefined ? {} : { expected_image_id: expectedImageId }),
    ...(receiptImageId === undefined ? {} : { receipt_image_id: receiptImageId }),
  };
}

function admitStatusBearingReport(
  input: Record<string, unknown>,
  expectedImageId: string | undefined,
  receiptImageId: string | null | undefined,
): VerificationReportEvidence | undefined {
  const status = input['status'];
  const devModeReceipt = input['dev_mode_receipt'];
  if (status === undefined) {
    return admitComparisonReport(expectedImageId, receiptImageId, devModeReceipt);
  }

  const imageIds = projectAdmittedReportImageIds(expectedImageId, receiptImageId);
  if (status === 'success' && devModeReceipt === false) return admitSuccessReport(expectedImageId, receiptImageId);
  if (status === 'dev_mode' && devModeReceipt === true) return { status, ...imageIds, dev_mode_receipt: true };
  if (status === 'failed' && typeof devModeReceipt === 'boolean')
    return { status, ...imageIds, dev_mode_receipt: devModeReceipt };
  return undefined;
}

function admitSuccessReport(
  expectedImageId: string | undefined,
  receiptImageId: string | null | undefined,
): VerificationReportEvidence | undefined {
  if (receiptImageId === null) return undefined;
  return {
    status: 'success',
    ...(expectedImageId === undefined ? {} : { expected_image_id: expectedImageId }),
    ...(receiptImageId === undefined ? {} : { receipt_image_id: receiptImageId }),
    dev_mode_receipt: false,
  };
}

function asSuccessOrComparisonReport(
  report: VerificationReportEvidence,
): NonNullable<Extract<VerificationOutcomeInput, { status: 'success' }>['report']> {
  if (report.status === 'success' || report.status === undefined) {
    return report;
  }
  throw new Error('Expected success or comparison-only report evidence');
}

function asDevModeOrComparisonReport(
  report: VerificationReportEvidence,
): NonNullable<Extract<VerificationOutcomeInput, { status: 'dev_mode' }>['report']> {
  if (report.status === 'dev_mode' || report.status === undefined) {
    return report;
  }
  throw new Error('Expected development or comparison-only report evidence');
}

function asFailedOrComparisonReport(
  report: VerificationReportEvidence,
): NonNullable<Extract<VerificationOutcomeInput, { status: 'failed' }>['report']> {
  if (report.status === 'failed' || report.status === undefined) {
    return report;
  }
  throw new Error('Expected failed or comparison-only report evidence');
}
