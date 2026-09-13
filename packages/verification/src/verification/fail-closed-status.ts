import { VOTE_CHOICES, type VoteChoice } from '@stark-ballot/verification/shared/constants';
import { resolveExcludedCount } from '@stark-ballot/verification/excluded-count';
import { normalizeHexString } from '@stark-ballot/crypto-primitives';
import {
  getNumberArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
  isRecord,
} from '@stark-ballot/validation/unknown-value-guards';
import { hasLegacyJournalCountAliases, isSupportedZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import type {
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from '@stark-ballot/verification/shared/types';
import { VERIFICATION_STATUS_VALUES } from '@stark-ballot/verification/shared/types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

interface FinalizationTallyStatusCarrier {
  counts: Record<VoteChoice, number>;
  totalVotes: number;
  tamperedCount: number;
}

interface FinalizationResultStatusCarrier {
  tally: FinalizationTallyStatusCarrier;
  imageId: string;
  journal: ZkVMJournal;
  verificationResult?: VerificationResult;
  verifiedTally?: number[];
  missingSlots?: number;
  invalidPresentedSlots?: number;
  excludedSlots?: number;
  totalExpected?: number;
  treeSize?: number;
}

interface FailClosedVerificationStatusInput {
  currentStatus?: VerificationStatus;
  tally?: FinalizationTallyStatusCarrier;
  verifiedTally?: number[];
  journal?: ZkVMJournal;
  missingSlots?: number;
  invalidPresentedSlots?: number;
  excludedSlots?: number;
  totalExpected?: number;
  treeSize?: number;
  journalHasLegacyCountAliases?: boolean;
  journalAdmissionFailed?: boolean;
  claimedImageId?: string;
  comparisonImageId?: string;
  verificationReport?: {
    expected_image_id?: VerificationReport['expected_image_id'];
    receipt_image_id?: VerificationReport['receipt_image_id'];
  };
}

const TERMINAL_SUCCESS_STATUSES = new Set<VerificationStatus>(['success', 'dev_mode']);
function toVerificationStatus(value: unknown): VerificationStatus | undefined {
  return typeof value === 'string' && VERIFICATION_STATUS_VALUES.includes(value as VerificationStatus)
    ? (value as VerificationStatus)
    : undefined;
}

function hasCountedExclusions(input: FailClosedVerificationStatusInput): boolean {
  if (input.journalHasLegacyCountAliases || input.journalAdmissionFailed) {
    return true;
  }

  const resolvedExcludedSlots = resolveExcludedCount({
    ...omitUndefinedProperties({
      journal: input.journal,
      missingSlots: input.missingSlots,
      invalidPresentedSlots: input.invalidPresentedSlots,
      excludedSlots: input.excludedSlots,
    }),
  });

  return typeof resolvedExcludedSlots === 'number' && resolvedExcludedSlots > 0;
}

function hasTreeSizeMismatch(input: FailClosedVerificationStatusInput): boolean {
  const totalExpected = input.journal?.totalExpected ?? input.totalExpected;
  const treeSize = input.journal?.treeSize ?? input.treeSize;

  return (
    typeof totalExpected === 'number' &&
    Number.isInteger(totalExpected) &&
    typeof treeSize === 'number' &&
    Number.isInteger(treeSize) &&
    totalExpected !== treeSize
  );
}

function hasImageIdMismatch(input: FailClosedVerificationStatusInput): boolean {
  const claimedImageId =
    typeof input.claimedImageId === 'string' && input.claimedImageId.length > 0 ? input.claimedImageId : undefined;
  const comparisonImageId =
    typeof input.comparisonImageId === 'string' && input.comparisonImageId.length > 0
      ? input.comparisonImageId
      : undefined;

  if (
    claimedImageId &&
    comparisonImageId &&
    normalizeHexString(claimedImageId) !== normalizeHexString(comparisonImageId)
  ) {
    return true;
  }

  const expectedImageId = input.verificationReport?.expected_image_id;
  const receiptImageId = input.verificationReport?.receipt_image_id;
  if (typeof expectedImageId !== 'string' || receiptImageId === undefined) {
    return false;
  }

  if (!receiptImageId) {
    return true;
  }

  const normalizedReceipt = normalizeHexString(receiptImageId);
  if (normalizeHexString(expectedImageId) !== normalizedReceipt) {
    return true;
  }
  if (claimedImageId && normalizeHexString(claimedImageId) !== normalizedReceipt) {
    return true;
  }
  return Boolean(comparisonImageId && normalizeHexString(comparisonImageId) !== normalizedReceipt);
}

function resolveFailClosedReasons(input: FailClosedVerificationStatusInput): {
  countedExclusions: boolean;
  treeSizeMismatch: boolean;
  imageIdMismatch: boolean;
} {
  return {
    countedExclusions: hasCountedExclusions(input),
    treeSizeMismatch: hasTreeSizeMismatch(input),
    imageIdMismatch: hasImageIdMismatch(input),
  };
}

export function resolveFailClosedVerificationStatus(
  input: FailClosedVerificationStatusInput,
): VerificationStatus | undefined {
  const currentStatus = input.currentStatus;
  if (!currentStatus) {
    return undefined;
  }
  if (!TERMINAL_SUCCESS_STATUSES.has(currentStatus)) {
    return currentStatus;
  }

  // Claimed tally mismatches are surfaced by counted_tally_consistent in the
  // verification pipeline. Keep fail-closed focused on proof/result integrity
  // signals so S2/S4 remain "proof is valid, published tally is wrong".
  const reasons = resolveFailClosedReasons(input);
  if (reasons.countedExclusions || reasons.treeSizeMismatch || reasons.imageIdMismatch) {
    return 'failed';
  }

  return currentStatus;
}

export function sanitizeFinalizationResultVerificationStatus<T extends FinalizationResultStatusCarrier | undefined>(
  result: T,
): T {
  if (!result?.verificationResult) {
    return result;
  }

  const nextStatus = resolveFailClosedVerificationStatus({
    currentStatus: result.verificationResult.status,
    ...omitUndefinedProperties({ tally: result.tally }),
    ...omitUndefinedProperties({ verifiedTally: result.verifiedTally }),
    ...omitUndefinedProperties({ journal: result.journal }),
    ...omitUndefinedProperties({
      missingSlots: result.missingSlots,
      invalidPresentedSlots: result.invalidPresentedSlots,
      excludedSlots: result.excludedSlots,
      totalExpected: result.totalExpected,
      treeSize: result.treeSize,
      comparisonImageId: result.journal.imageId,
      verificationReport: result.verificationResult.report,
    }),
    journalHasLegacyCountAliases: hasLegacyJournalCountAliases(result.journal),
    claimedImageId: result.imageId,
  });

  if (!nextStatus || result.verificationResult.status === nextStatus) {
    return result;
  }

  return {
    ...result,
    verificationResult: { status: 'failed' },
  };
}

function parseTallyFromRecord(payload: Record<string, unknown>): FinalizationTallyStatusCarrier | undefined {
  const tally = getRecordProperty(payload, 'tally');
  const counts = getRecordProperty(tally, 'counts');
  if (!counts) {
    return undefined;
  }

  const tallyCounts = VOTE_CHOICES.reduce(
    (accumulator, choice) => {
      const value = getNumberProperty(counts, choice);
      accumulator[choice] = typeof value === 'number' ? value : 0;
      return accumulator;
    },
    {} as Record<VoteChoice, number>,
  );

  const totalVotes = getNumberProperty(tally, 'totalVotes');
  const tamperedCount = getNumberProperty(tally, 'tamperedCount');
  if (typeof totalVotes !== 'number' || typeof tamperedCount !== 'number') {
    return undefined;
  }

  return {
    counts: tallyCounts,
    totalVotes,
    tamperedCount,
  };
}

function parseVerificationReportFromRecord(
  payload: Record<string, unknown>,
  verificationResult: Record<string, unknown> | undefined,
): FailClosedVerificationStatusInput['verificationReport'] {
  const nestedReport = getRecordProperty(verificationResult, 'report');
  const topLevelReport = getRecordProperty(payload, 'verificationReport');
  const report = nestedReport ?? topLevelReport;

  if (!isRecord(report)) {
    return undefined;
  }

  const rawReceiptImageId = report['receipt_image_id'];
  return omitUndefinedProperties({
    expected_image_id: getStringProperty(report, 'expected_image_id'),
    receipt_image_id:
      rawReceiptImageId === null || typeof rawReceiptImageId === 'string' ? rawReceiptImageId : undefined,
  });
}

export function sanitizeFinalizationPayloadVerificationStatus<T extends object>(payload: T): T {
  const record = payload as Record<string, unknown>;
  const verificationResult = getRecordProperty(record, 'verificationResult');
  const topLevelStatus = toVerificationStatus(getStringProperty(record, 'verificationStatus'));
  const nestedStatus = toVerificationStatus(getStringProperty(verificationResult, 'status'));
  const currentStatus = topLevelStatus ?? nestedStatus;
  if (!currentStatus) {
    return payload;
  }

  const journalCandidate = getRecordProperty(record, 'journal');
  const journal = isSupportedZkVMJournal(journalCandidate) ? journalCandidate : undefined;
  const nextStatus = resolveFailClosedVerificationStatus({
    currentStatus,
    ...omitUndefinedProperties({ tally: parseTallyFromRecord(record) }),
    ...omitUndefinedProperties({
      verifiedTally: getNumberArrayProperty(record, 'verifiedTally'),
      journal,
      missingSlots: getNumberProperty(record, 'missingSlots'),
      invalidPresentedSlots: getNumberProperty(record, 'invalidPresentedSlots'),
      excludedSlots: getNumberProperty(record, 'excludedSlots'),
      totalExpected: getNumberProperty(record, 'totalExpected'),
      treeSize: getNumberProperty(record, 'treeSize'),
      claimedImageId: getStringProperty(record, 'imageId'),
      comparisonImageId: journal?.imageId,
      verificationReport: parseVerificationReportFromRecord(record, verificationResult),
    }),
    journalHasLegacyCountAliases: hasLegacyJournalCountAliases(journalCandidate),
    journalAdmissionFailed: journalCandidate !== undefined && journal === undefined,
  });

  if (!nextStatus) {
    return payload;
  }

  let next: Record<string, unknown> = record;
  if (topLevelStatus && topLevelStatus !== nextStatus) {
    next = { ...next, verificationStatus: nextStatus };
  }
  if (verificationResult && nestedStatus && nestedStatus !== nextStatus) {
    next = {
      ...next,
      verificationResult: {
        ...verificationResult,
        status: nextStatus,
      },
    };
  }

  return next as T;
}
