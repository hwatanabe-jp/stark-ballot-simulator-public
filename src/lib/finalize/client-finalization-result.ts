import { VOTE_CHOICES, type VoteChoice } from '@/shared/constants';
import type {
  FinalizationReceiptPublication,
  FinalizationResultPublicProjection,
  FinalizationTamperSummary,
  PublicVerificationReport,
  PublicVerificationResult,
  VerificationStatus,
} from '@/types/server';
import { sanitizeFinalizationPayloadVerificationStatus } from '@/lib/verification/fail-closed-status';
import { isValidHexString, normalizeHexString } from '@/lib/utils/hex';
import {
  getArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
  isRecord,
} from '@/lib/utils/guards';
import { isSupportedZkVMJournal } from '@/lib/zkvm/journal-guards';
import { toPublicZkvmJournal } from '@/lib/zkvm/public-journal';
import { resolveFinalizationTamperDetected, resolveScenarioTamperCount } from '@/lib/finalize/finalization-tamper';
import { isSafeVerifierSegment } from '@/lib/finalize/finalize-urls';

type ClientVerificationResult = Pick<PublicVerificationResult, 'status' | 'report' | 'executionId'>;

export interface ClientFinalizationSnapshot extends Pick<
  FinalizationResultPublicProjection,
  | 'tally'
  | 'receiptPublication'
  | 'imageId'
  | 'tamperDetected'
  | 'scenarios'
  | 'journal'
  | 'verificationExecutionId'
  | 'tamperSummary'
  | 'bulletinRoot'
  | 'verifiedTally'
  | 'missingSlots'
  | 'invalidPresentedSlots'
  | 'rejectedRecords'
  | 'totalExpected'
  | 'treeSize'
  | 'excludedSlots'
  | 'sthDigest'
  | 'seenBitmapRoot'
  | 'includedBitmapRoot'
  | 'inputCommitment'
  | 'seenIndicesCount'
> {
  verificationStatus?: VerificationStatus;
  verificationResult?: ClientVerificationResult;
}

const IMAGE_ID_BYTE_LENGTH = 32;
const VERIFICATION_STATUS_VALUES: readonly VerificationStatus[] = [
  'success',
  'failed',
  'dev_mode',
  'not_run',
  'running',
];

function getSafeVerificationExecutionId(value: Record<string, unknown>): string | undefined {
  const executionId = getStringProperty(value, 'verificationExecutionId');
  return executionId && isSafeVerifierSegment(executionId) ? executionId : undefined;
}

function toVerificationStatus(value: unknown): VerificationStatus | undefined {
  return typeof value === 'string' && VERIFICATION_STATUS_VALUES.includes(value as VerificationStatus)
    ? (value as VerificationStatus)
    : undefined;
}

function buildCountsFromTally(values: Record<string, unknown>): Record<VoteChoice, number> | null {
  const counts = getRecordProperty(values, 'counts');
  if (!counts) {
    return null;
  }

  const tallyCounts = {} as Record<VoteChoice, number>;
  for (const choice of VOTE_CHOICES) {
    const count = getNumberProperty(counts, choice);
    if (typeof count !== 'number') {
      return null;
    }
    tallyCounts[choice] = count;
  }

  return tallyCounts;
}

function resolvePayloadScenarioTamperCount(value: Record<string, unknown>): number {
  const tamperSummary = getRecordProperty(value, 'tamperSummary');
  return resolveScenarioTamperCount({
    ignoredVotes: getNumberProperty(tamperSummary, 'ignoredVotes'),
    recountedVotes: getNumberProperty(tamperSummary, 'recountedVotes'),
  });
}

function resolveTallySnapshot(
  value: Record<string, unknown>,
  scenarioTamperCount: number,
): ClientFinalizationSnapshot['tally'] | null {
  // Browser-local snapshots are an explicit current-contract boundary.
  // Require a concrete claimed tally instead of reconstructing one from the journal.
  const tally = getRecordProperty(value, 'tally');
  if (!tally) {
    return null;
  }

  const counts = buildCountsFromTally(tally);
  if (!counts) {
    return null;
  }

  const totalVotes = getNumberProperty(tally, 'totalVotes');
  if (typeof totalVotes !== 'number') {
    return null;
  }

  const tamperedCount = getNumberProperty(tally, 'tamperedCount') ?? scenarioTamperCount;

  return {
    counts,
    totalVotes,
    tamperedCount,
  };
}

function resolveReceiptPublication(value: Record<string, unknown>): FinalizationReceiptPublication | undefined {
  const receiptPublication = getRecordProperty(value, 'receiptPublication');
  const receiptHash = getStringProperty(receiptPublication, 'receiptHash');
  const boardIndex = getNumberProperty(receiptPublication, 'boardIndex');
  if (!receiptHash || typeof boardIndex !== 'number') {
    return undefined;
  }

  const timestamp = getNumberProperty(receiptPublication, 'timestamp');
  return {
    receiptHash,
    boardIndex,
    ...(typeof timestamp === 'number' ? { timestamp } : {}),
  };
}

function resolveTamperSummary(value: Record<string, unknown>): FinalizationTamperSummary | undefined {
  const tamperSummary = getRecordProperty(value, 'tamperSummary');
  const ignoredVotes = getNumberProperty(tamperSummary, 'ignoredVotes');
  const recountedVotes = getNumberProperty(tamperSummary, 'recountedVotes');
  const userRecountedTo = getStringProperty(tamperSummary, 'userRecountedTo');
  if (
    typeof ignoredVotes !== 'number' ||
    typeof recountedVotes !== 'number' ||
    (userRecountedTo !== undefined && !VOTE_CHOICES.includes(userRecountedTo as VoteChoice))
  ) {
    return undefined;
  }

  const affectedBotIdsValue = getArrayProperty(tamperSummary, 'affectedBotIds');
  const affectedBotIds = Array.isArray(affectedBotIdsValue)
    ? affectedBotIdsValue.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    : undefined;

  return {
    ignoredVotes,
    recountedVotes,
    userRecountedTo: (userRecountedTo as VoteChoice | null | undefined) ?? null,
    ...(affectedBotIds && affectedBotIds.length > 0 ? { affectedBotIds } : {}),
  };
}

function resolveScenarios(value: Record<string, unknown>): string[] | undefined {
  const scenarios = getArrayProperty(value, 'scenarios');
  if (!scenarios) {
    return undefined;
  }

  const normalized = scenarios.filter((entry): entry is string => typeof entry === 'string');
  return normalized.length > 0 ? normalized : undefined;
}

function resolveVerificationReport(value: Record<string, unknown>): PublicVerificationReport | undefined {
  const report =
    getRecordProperty(getRecordProperty(value, 'verificationResult'), 'report') ??
    getRecordProperty(value, 'verificationReport');
  if (!report) {
    return undefined;
  }

  const status = toVerificationStatus(getStringProperty(report, 'status'));
  if (!status) {
    return undefined;
  }

  const receiptImageId = report.receipt_image_id;
  return {
    status,
    ...(getStringProperty(report, 'verifier_version')
      ? { verifier_version: getStringProperty(report, 'verifier_version') }
      : {}),
    ...(getStringProperty(report, 'verified_at') ? { verified_at: getStringProperty(report, 'verified_at') } : {}),
    ...(typeof getNumberProperty(report, 'duration_ms') === 'number'
      ? { duration_ms: getNumberProperty(report, 'duration_ms') }
      : {}),
    ...(getStringProperty(report, 'expected_image_id')
      ? { expected_image_id: getStringProperty(report, 'expected_image_id') }
      : {}),
    ...(receiptImageId === null || typeof receiptImageId === 'string' ? { receipt_image_id: receiptImageId } : {}),
    ...(typeof report.dev_mode_receipt === 'boolean' ? { dev_mode_receipt: report.dev_mode_receipt } : {}),
    ...(Array.isArray(report.errors)
      ? { errors: report.errors.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
}

function resolveVerificationResult(
  value: Record<string, unknown>,
  verificationStatus: VerificationStatus | undefined,
): ClientVerificationResult | undefined {
  const verificationResult = getRecordProperty(value, 'verificationResult');
  const status = verificationStatus ?? toVerificationStatus(getStringProperty(verificationResult, 'status'));
  if (!status) {
    return undefined;
  }

  const report = resolveVerificationReport(value);
  const executionId = getSafeVerificationExecutionId(value);

  return {
    status,
    ...(report ? { report } : {}),
    ...(executionId ? { executionId } : {}),
  };
}

function resolveClientSnapshotImageId(
  value: Record<string, unknown>,
  journal: ClientFinalizationSnapshot['journal'],
): string | undefined {
  const imageId = getStringProperty(value, 'imageId');
  if (!imageId || !isValidHexString(imageId, IMAGE_ID_BYTE_LENGTH)) {
    return undefined;
  }

  if (journal.imageId && normalizeHexString(imageId) !== normalizeHexString(journal.imageId)) {
    return undefined;
  }

  return imageId;
}

export function resolveClientFinalizationVerificationStatus(
  snapshot: ClientFinalizationSnapshot | null | undefined,
): VerificationStatus | undefined {
  if (!snapshot) {
    return undefined;
  }

  return (
    snapshot.verificationStatus ??
    snapshot.verificationResult?.status ??
    (snapshot.verificationExecutionId ? 'running' : undefined)
  );
}

/**
 * Client caches persist a minimal current-contract finalization snapshot.
 * Unsupported or stale payloads are rejected instead of being reinterpreted.
 */
export function resolveCanonicalFinalizationPayload(value: unknown): ClientFinalizationSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const sanitized = sanitizeFinalizationPayloadVerificationStatus(value);
  const journalValue = getRecordProperty(sanitized, 'journal');
  if (!isSupportedZkVMJournal(journalValue)) {
    return null;
  }

  const journal = toPublicZkvmJournal(journalValue);
  const scenarioTamperCount = resolvePayloadScenarioTamperCount(sanitized);
  const tally = resolveTallySnapshot(sanitized, scenarioTamperCount);
  if (!tally) {
    return null;
  }
  const imageId = resolveClientSnapshotImageId(sanitized, journal);
  if (!imageId) {
    return null;
  }

  const verificationStatus =
    toVerificationStatus(getStringProperty(sanitized, 'verificationStatus')) ??
    toVerificationStatus(getStringProperty(getRecordProperty(sanitized, 'verificationResult'), 'status'));
  const receiptPublication = resolveReceiptPublication(sanitized);
  const scenarios = resolveScenarios(sanitized);
  const verificationResult = resolveVerificationResult(sanitized, verificationStatus);
  const verificationExecutionId = getSafeVerificationExecutionId(sanitized);
  const tamperSummary = resolveTamperSummary(sanitized);

  return {
    tally,
    ...(receiptPublication ? { receiptPublication } : {}),
    imageId,
    tamperDetected:
      Boolean(sanitized.tamperDetected) ||
      resolveFinalizationTamperDetected({
        excludedSlots: journal.excludedSlots,
        rejectedRecords: journal.rejectedRecords,
        scenarioTamperCount,
      }),
    ...(scenarios ? { scenarios } : {}),
    journal,
    ...(verificationStatus ? { verificationStatus } : {}),
    ...(verificationResult ? { verificationResult } : {}),
    ...(verificationExecutionId ? { verificationExecutionId } : {}),
    ...(tamperSummary ? { tamperSummary } : {}),
    bulletinRoot: journal.bulletinRoot,
    verifiedTally: [...journal.verifiedTally],
    missingSlots: journal.missingSlots,
    invalidPresentedSlots: journal.invalidPresentedSlots,
    rejectedRecords: journal.rejectedRecords,
    totalExpected: journal.totalExpected,
    treeSize: journal.treeSize,
    excludedSlots: journal.excludedSlots,
    sthDigest: journal.sthDigest,
    seenBitmapRoot: journal.seenBitmapRoot,
    includedBitmapRoot: journal.includedBitmapRoot,
    inputCommitment: journal.inputCommitment,
    seenIndicesCount: journal.seenIndicesCount,
  };
}

export function projectClientFinalizationSnapshotForKnowledge(
  snapshot: ClientFinalizationSnapshot,
): Record<string, unknown> {
  return { ...snapshot };
}
