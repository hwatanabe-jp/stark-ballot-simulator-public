import type { VerificationFailureCategory, VerificationStatus } from '@stark-ballot/verification/shared/types';
import {
  TERMINAL_VERIFICATION_STATUS_VALUES,
  VERIFICATION_FAILURE_CATEGORY_VALUES,
  VERIFICATION_STATUS_VALUES,
} from '@stark-ballot/verification/shared/types';
import { isRecord } from '@stark-ballot/validation/unknown-value-guards';
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
  if (!isRecord(input)) {
    return undefined;
  }

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

  const failureCategory = admitFailureCategory(input['failureCategory']);
  if (input['failureCategory'] !== undefined && failureCategory === undefined) {
    return undefined;
  }

  switch (status) {
    case 'not_run':
    case 'running':
      return failureCategory === undefined || failureCategory === 'none'
        ? { status, failureCategory: 'none' }
        : undefined;
    case 'success': {
      if (
        (report?.status !== undefined && report.status !== 'success') ||
        (failureCategory !== undefined && failureCategory !== 'none')
      ) {
        return undefined;
      }
      const successReport = report ? asSuccessOrComparisonReport(report) : undefined;
      return {
        status,
        ...(successReport ? { report: successReport } : {}),
        failureCategory: 'none',
      };
    }
    case 'dev_mode': {
      if (
        (report?.status !== undefined && report.status !== 'dev_mode') ||
        (failureCategory !== undefined && failureCategory !== 'none')
      ) {
        return undefined;
      }
      const devModeReport = report ? asDevModeOrComparisonReport(report) : undefined;
      return {
        status,
        ...(devModeReport ? { report: devModeReport } : {}),
        failureCategory: 'none',
      };
    }
    case 'failed': {
      if ((report?.status !== undefined && report.status !== 'failed') || failureCategory === 'none') {
        return undefined;
      }
      const failedReport = report ? asFailedOrComparisonReport(report) : undefined;
      return {
        status,
        ...(failedReport ? { report: failedReport } : {}),
        failureCategory: failureCategory ?? 'unknown',
      };
    }
  }
}

export function normalizeVerifierOutcome(input: VerificationOutcomeInput): AdmittedVerifierOutcome {
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
  if (!isRecord(input)) {
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

  const status = input['status'];
  const devModeReceipt = input['dev_mode_receipt'];
  if (status === undefined) {
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

  if (status === 'success' && devModeReceipt === false) {
    if (receiptImageId === null) {
      return undefined;
    }
    return {
      status,
      ...(typeof expectedImageId === 'string' ? { expected_image_id: expectedImageId } : {}),
      ...(typeof receiptImageId === 'string' ? { receipt_image_id: receiptImageId } : {}),
      dev_mode_receipt: false,
    };
  }
  if (status === 'dev_mode' && devModeReceipt === true) {
    return {
      status,
      ...(typeof expectedImageId === 'string' ? { expected_image_id: expectedImageId } : {}),
      ...(typeof receiptImageId === 'string' || receiptImageId === null ? { receipt_image_id: receiptImageId } : {}),
      dev_mode_receipt: true,
    };
  }
  if (status === 'failed' && typeof devModeReceipt === 'boolean') {
    return {
      status,
      ...(typeof expectedImageId === 'string' ? { expected_image_id: expectedImageId } : {}),
      ...(typeof receiptImageId === 'string' || receiptImageId === null ? { receipt_image_id: receiptImageId } : {}),
      dev_mode_receipt: devModeReceipt,
    };
  }
  return undefined;
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
