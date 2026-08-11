import { VOTE_CHOICES, type VoteChoice } from '@stark-ballot/domain/shared/constants';
import type { ScenarioTamperMode } from '@stark-ballot/domain/types/scenario';
import {
  FinalizationFailureCategory,
  type BitmapProofSource,
  type FinalizationBitmapData,
  type FinalizationResultAuthority,
  type FinalizationScenarioContext,
  type FinalizationState,
  type FinalizationTally,
  type FinalizationTamperSummary,
} from '@stark-ballot/application/finalize/finalization-types';
import type {
  VerificationFailureCategory,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from '@stark-ballot/verification/shared/types';
import { VERIFICATION_FAILURE_CATEGORY_VALUES } from '@stark-ballot/verification/shared/types';
import type { ReceiptJournal, ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import { parseStoredPublicInputArtifact } from '@stark-ballot/verification/public-input';
import { isCloseStatement, isElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import {
  getBooleanArrayProperty,
  getNumberArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringArrayProperty,
  getStringProperty,
  isRecord,
} from '@stark-ballot/validation/unknown-value-guards';
import { isSupportedZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import { toPublicZkvmJournal } from '@stark-ballot/zkvm-contract/zkvm/public-journal';

const VERIFICATION_STATUSES = new Set<VerificationStatus>(['success', 'failed', 'dev_mode', 'not_run', 'running']);
const VERIFICATION_FAILURE_CATEGORIES = new Set<VerificationFailureCategory>(VERIFICATION_FAILURE_CATEGORY_VALUES);
const BITMAP_PROOF_SOURCES = new Set<BitmapProofSource>(['mock', 'real']);
const SCENARIO_TAMPER_MODES = new Set<ScenarioTamperMode>(['none', 'input', 'claim']);
const FINALIZATION_FAILURE_CATEGORIES = new Set<FinalizationFailureCategory>(
  Object.values(FinalizationFailureCategory),
);

const FINALIZATION_RESULT_AUTHORITY_KEYS = new Set<string>([
  'tally',
  'receipt',
  'receiptPublication',
  'imageId',
  'tamperDetected',
  'scenarios',
  'journal',
  'publicInputArtifact',
  'electionManifest',
  'closeStatement',
  'bitmapProofSource',
  'bitmapData',
  'tamperSummary',
]);
const VERIFICATION_RESULT_KEYS = new Set<string>(['status', 'report', 'failureCategory']);
const VERIFICATION_REPORT_KEYS = new Set<string>([
  'status',
  'verifier_version',
  'verified_at',
  'duration_ms',
  'expected_image_id',
  'receipt_image_id',
  'dev_mode_receipt',
  'errors',
]);
const FINALIZATION_TALLY_KEYS = new Set<string>(['counts', 'totalVotes', 'tamperedCount']);
const FINALIZATION_ERROR_KEYS = new Set<string>(['code', 'message', 'category', 'details']);
const FINALIZATION_SCENARIO_CONTEXT_KEYS = new Set<string>([
  'scenarios',
  'tamperMode',
  'claimedCounts',
  'claimedTotalVotes',
  'summary',
]);
const FINALIZATION_SCENARIO_SUMMARY_KEYS = new Set<string>([
  'ignoredCount',
  'recountedCount',
  'userRecountChoice',
  'affectedBotIds',
]);
const RECEIPT_JOURNAL_KEYS = new Set<string>(['bytes']);
const RECEIPT_KEYS = new Set<string>(['seal', 'journal', 'imageId', 'metadata']);
const RECEIPT_PUBLICATION_KEYS = new Set<string>(['receiptHash', 'boardIndex', 'timestamp']);
const BITMAP_DATA_KEYS = new Set<string>([
  'includedBitmap',
  'includedBitmapRoot',
  'seenBitmap',
  'seenBitmapRoot',
  'treeSize',
  'finalizedAtMs',
]);
const TAMPER_SUMMARY_KEYS = new Set<string>(['ignoredVotes', 'recountedVotes', 'userRecountedTo', 'affectedBotIds']);
const JOURNAL_KEYS = new Set<string>([
  'electionId',
  'electionConfigHash',
  'bulletinRoot',
  'treeSize',
  'totalExpected',
  'sthDigest',
  'verifiedTally',
  'totalVotes',
  'validVotes',
  'invalidVotes',
  'seenIndicesCount',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'excludedSlots',
  'inputCommitment',
  'methodVersion',
  'imageId',
]);
const ELECTION_MANIFEST_KEYS = new Set<string>([
  'electionId',
  'totalExpected',
  'choices',
  'version',
  'botCount',
  'merkleTreeDepth',
  'electionConfigHash',
]);
const CLOSE_STATEMENT_KEYS = new Set<string>(['logId', 'treeSize', 'timestamp', 'bulletinRoot', 'sthDigest']);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isIntegerArray(value: number[]): boolean {
  return value.every((entry) => Number.isInteger(entry));
}

function parseVerificationStatus(value: unknown): VerificationStatus | undefined {
  return typeof value === 'string' && VERIFICATION_STATUSES.has(value as VerificationStatus)
    ? (value as VerificationStatus)
    : undefined;
}

function parseCountRecord(value: unknown): Record<VoteChoice, number> | undefined {
  if (!isRecord(value) || Object.keys(value).length !== VOTE_CHOICES.length) {
    return undefined;
  }

  const counts = {} as Record<VoteChoice, number>;
  for (const choice of VOTE_CHOICES) {
    const count = getNumberProperty(value, choice);
    if (!isNonNegativeInteger(count)) {
      return undefined;
    }
    counts[choice] = count;
  }

  return counts;
}

function parseFinalizationTally(value: unknown): FinalizationTally | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, FINALIZATION_TALLY_KEYS)) {
    return undefined;
  }

  const counts = parseCountRecord(value['counts']);
  const totalVotes = getNumberProperty(value, 'totalVotes');
  const tamperedCount = getNumberProperty(value, 'tamperedCount');
  if (!counts || !isNonNegativeInteger(totalVotes) || !isNonNegativeInteger(tamperedCount)) {
    return undefined;
  }

  return {
    counts,
    totalVotes,
    tamperedCount,
  };
}

function parseReceiptJournal(value: unknown): ReceiptJournal | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, RECEIPT_JOURNAL_KEYS)) {
    return undefined;
  }

  const bytes = getNumberArrayProperty(value, 'bytes');
  if (!bytes || !isIntegerArray(bytes)) {
    return undefined;
  }

  return { bytes: [...bytes] };
}

function parseReceiptWithImageId(value: unknown): ReceiptWithImageId | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, RECEIPT_KEYS)) {
    return undefined;
  }

  const seal = getStringProperty(value, 'seal');
  const journal = parseReceiptJournal(value['journal']);
  if (typeof seal !== 'string' || !journal) {
    return undefined;
  }

  const imageId = getStringProperty(value, 'imageId');
  const metadata = getRecordProperty(value, 'metadata');

  return {
    seal,
    journal,
    ...(imageId ? { imageId } : {}),
    ...(metadata ? { metadata: { ...metadata } } : {}),
  };
}

function parseReceiptPublication(
  value: unknown,
): NonNullable<FinalizationResultAuthority['receiptPublication']> | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, RECEIPT_PUBLICATION_KEYS)) {
    return undefined;
  }

  const receiptHash = getStringProperty(value, 'receiptHash');
  const boardIndex = getNumberProperty(value, 'boardIndex');
  const timestamp = getNumberProperty(value, 'timestamp');
  if (typeof receiptHash !== 'string' || !isNonNegativeInteger(boardIndex)) {
    return undefined;
  }
  if (hasOwn(value, 'timestamp') && !isNonNegativeInteger(timestamp)) {
    return undefined;
  }

  return {
    receiptHash,
    boardIndex,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function parseBitmapData(value: unknown): FinalizationBitmapData | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, BITMAP_DATA_KEYS)) {
    return undefined;
  }

  const includedBitmap = getBooleanArrayProperty(value, 'includedBitmap');
  const includedBitmapRoot = getStringProperty(value, 'includedBitmapRoot');
  const treeSize = getNumberProperty(value, 'treeSize');
  const finalizedAtMs = getNumberProperty(value, 'finalizedAtMs');
  if (
    !includedBitmap ||
    typeof includedBitmapRoot !== 'string' ||
    !isNonNegativeInteger(treeSize) ||
    !isNonNegativeInteger(finalizedAtMs)
  ) {
    return undefined;
  }

  const seenBitmap = getBooleanArrayProperty(value, 'seenBitmap');
  const seenBitmapRoot = getStringProperty(value, 'seenBitmapRoot');
  if (hasOwn(value, 'seenBitmap') && !seenBitmap) {
    return undefined;
  }
  if (hasOwn(value, 'seenBitmapRoot') && typeof seenBitmapRoot !== 'string') {
    return undefined;
  }

  return {
    includedBitmap: [...includedBitmap],
    includedBitmapRoot,
    ...(seenBitmap ? { seenBitmap: [...seenBitmap] } : {}),
    ...(seenBitmapRoot ? { seenBitmapRoot } : {}),
    treeSize,
    finalizedAtMs,
  };
}

function parseVerificationReport(value: unknown): VerificationReport | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, VERIFICATION_REPORT_KEYS)) {
    return undefined;
  }

  const status = parseVerificationStatus(value['status']);
  if (!status) {
    return undefined;
  }

  const durationMs = getNumberProperty(value, 'duration_ms');
  const errors = getStringArrayProperty(value, 'errors');
  const verifierVersion = getStringProperty(value, 'verifier_version');
  const verifiedAt = getStringProperty(value, 'verified_at');
  const expectedImageId = getStringProperty(value, 'expected_image_id');
  const rawReceiptImageId = value['receipt_image_id'];
  const devModeReceipt = value['dev_mode_receipt'];

  if (!isNonNegativeInteger(durationMs)) {
    return undefined;
  }
  if (hasOwn(value, 'errors') && !errors) {
    return undefined;
  }
  if (typeof verifierVersion !== 'string' || typeof verifiedAt !== 'string' || typeof expectedImageId !== 'string') {
    return undefined;
  }
  if (rawReceiptImageId !== null && typeof rawReceiptImageId !== 'string') {
    return undefined;
  }
  if (typeof devModeReceipt !== 'boolean') {
    return undefined;
  }

  return {
    status,
    verifier_version: verifierVersion,
    verified_at: verifiedAt,
    duration_ms: durationMs,
    expected_image_id: expectedImageId,
    receipt_image_id: rawReceiptImageId,
    dev_mode_receipt: devModeReceipt,
    ...(errors ? { errors: [...errors] } : {}),
  };
}

export function parseVerificationResult(value: unknown): VerificationResult | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, VERIFICATION_RESULT_KEYS)) {
    return undefined;
  }

  const status = parseVerificationStatus(value['status']);
  if (!status) {
    return undefined;
  }

  const report = value['report'];
  const parsedReport = report !== undefined ? parseVerificationReport(report) : undefined;
  if (report !== undefined && !parsedReport) {
    return undefined;
  }

  const failureCategory = getStringProperty(value, 'failureCategory');
  if (
    hasOwn(value, 'failureCategory') &&
    (typeof failureCategory !== 'string' ||
      !VERIFICATION_FAILURE_CATEGORIES.has(failureCategory as VerificationFailureCategory))
  ) {
    return undefined;
  }

  return {
    status,
    ...(parsedReport ? { report: parsedReport } : {}),
    ...(failureCategory ? { failureCategory: failureCategory as VerificationFailureCategory } : {}),
  };
}

function parseTamperSummary(value: unknown): FinalizationTamperSummary | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, TAMPER_SUMMARY_KEYS)) {
    return undefined;
  }

  const ignoredVotes = getNumberProperty(value, 'ignoredVotes');
  const recountedVotes = getNumberProperty(value, 'recountedVotes');
  const userRecountedTo = value['userRecountedTo'];
  const affectedBotIds = getNumberArrayProperty(value, 'affectedBotIds');
  if (
    !isNonNegativeInteger(ignoredVotes) ||
    !isNonNegativeInteger(recountedVotes) ||
    (userRecountedTo !== null && !VOTE_CHOICES.includes(userRecountedTo as VoteChoice))
  ) {
    return undefined;
  }
  if (hasOwn(value, 'affectedBotIds') && (!affectedBotIds || !isIntegerArray(affectedBotIds))) {
    return undefined;
  }

  return {
    ignoredVotes,
    recountedVotes,
    userRecountedTo: userRecountedTo as VoteChoice | null,
    ...(affectedBotIds ? { affectedBotIds: [...affectedBotIds] } : {}),
  };
}

export function parseFinalizationResultAuthority(value: unknown): FinalizationResultAuthority | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!hasOnlyAllowedKeys(value, FINALIZATION_RESULT_AUTHORITY_KEYS)) {
    return undefined;
  }

  const tally = parseFinalizationTally(value['tally']);
  const imageId = getStringProperty(value, 'imageId');
  const journalValue = value['journal'];
  if (
    !tally ||
    typeof imageId !== 'string' ||
    !isRecord(journalValue) ||
    !hasOnlyAllowedKeys(journalValue, JOURNAL_KEYS) ||
    !isSupportedZkVMJournal(journalValue)
  ) {
    return undefined;
  }
  const journal = toPublicZkvmJournal(journalValue);

  if (hasOwn(value, 'tamperDetected') && typeof value['tamperDetected'] !== 'boolean') {
    return undefined;
  }

  const scenarios = getStringArrayProperty(value, 'scenarios');
  if (value['scenarios'] !== undefined && !scenarios) {
    return undefined;
  }

  const receipt = value['receipt'];
  const parsedReceipt = receipt !== undefined ? parseReceiptWithImageId(receipt) : undefined;
  if (receipt !== undefined && !parsedReceipt) {
    return undefined;
  }

  const receiptPublication = value['receiptPublication'];
  const parsedReceiptPublication =
    receiptPublication !== undefined ? parseReceiptPublication(receiptPublication) : undefined;
  if (receiptPublication !== undefined && !parsedReceiptPublication) {
    return undefined;
  }

  const publicInputArtifact = value['publicInputArtifact'];
  const parsedPublicInputArtifact =
    publicInputArtifact !== undefined ? parseStoredPublicInputArtifact(publicInputArtifact) : undefined;
  if (publicInputArtifact !== undefined && !parsedPublicInputArtifact) {
    return undefined;
  }

  const electionManifest = value['electionManifest'];
  if (
    electionManifest !== undefined &&
    (!isRecord(electionManifest) ||
      !hasOnlyAllowedKeys(electionManifest, ELECTION_MANIFEST_KEYS) ||
      !isElectionManifest(electionManifest))
  ) {
    return undefined;
  }
  const closeStatement = value['closeStatement'];
  if (
    closeStatement !== undefined &&
    (!isRecord(closeStatement) ||
      !hasOnlyAllowedKeys(closeStatement, CLOSE_STATEMENT_KEYS) ||
      !isCloseStatement(closeStatement))
  ) {
    return undefined;
  }

  const bitmapProofSource = value['bitmapProofSource'];
  if (bitmapProofSource !== undefined && !BITMAP_PROOF_SOURCES.has(bitmapProofSource as BitmapProofSource)) {
    return undefined;
  }

  const bitmapData = value['bitmapData'];
  const parsedBitmapData = bitmapData !== undefined ? parseBitmapData(bitmapData) : undefined;
  if (bitmapData !== undefined && !parsedBitmapData) {
    return undefined;
  }

  const tamperSummary = value['tamperSummary'];
  const parsedTamperSummary = tamperSummary !== undefined ? parseTamperSummary(tamperSummary) : undefined;
  if (tamperSummary !== undefined && !parsedTamperSummary) {
    return undefined;
  }

  return {
    tally,
    ...(parsedReceipt ? { receipt: parsedReceipt } : {}),
    ...(parsedReceiptPublication ? { receiptPublication: parsedReceiptPublication } : {}),
    imageId,
    ...(typeof value['tamperDetected'] === 'boolean' ? { tamperDetected: value['tamperDetected'] } : {}),
    ...(scenarios ? { scenarios: [...scenarios] } : {}),
    journal,
    ...(parsedPublicInputArtifact ? { publicInputArtifact: parsedPublicInputArtifact } : {}),
    ...(electionManifest !== undefined ? { electionManifest } : {}),
    ...(closeStatement !== undefined ? { closeStatement } : {}),
    ...(bitmapProofSource !== undefined ? { bitmapProofSource: bitmapProofSource as BitmapProofSource } : {}),
    ...(parsedBitmapData ? { bitmapData: parsedBitmapData } : {}),
    ...(parsedTamperSummary ? { tamperSummary: parsedTamperSummary } : {}),
  };
}

function parseFinalizationError(value: unknown): Extract<FinalizationState, { status: 'failed' }>['error'] | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, FINALIZATION_ERROR_KEYS)) {
    return undefined;
  }

  const code = getStringProperty(value, 'code');
  const message = getStringProperty(value, 'message');
  const category = getStringProperty(value, 'category');
  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }
  if (
    hasOwn(value, 'category') &&
    (typeof category !== 'string' || !FINALIZATION_FAILURE_CATEGORIES.has(category as FinalizationFailureCategory))
  ) {
    return undefined;
  }

  return {
    code,
    message,
    ...(category ? { category: category as FinalizationFailureCategory } : {}),
    ...(hasOwn(value, 'details') ? { details: value['details'] } : {}),
  };
}

const FINALIZATION_STATE_KEYS_BY_STATUS: Record<FinalizationState['status'], ReadonlySet<string>> = {
  pending: new Set(['status', 'finalizationId', 'queuedAtMs']),
  running: new Set(['status', 'finalizationId', 'queuedAtMs', 'startedAtMs']),
  succeeded: new Set(['status', 'finalizationId', 'queuedAtMs', 'startedAtMs', 'completedAtMs']),
  failed: new Set(['status', 'finalizationId', 'queuedAtMs', 'startedAtMs', 'failedAtMs', 'error']),
  timeout: new Set(['status', 'finalizationId', 'queuedAtMs', 'startedAtMs', 'timeoutAtMs']),
};

export function parseFinalizationState(value: unknown): FinalizationState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = getStringProperty(value, 'status');
  const allowedKeys = status ? FINALIZATION_STATE_KEYS_BY_STATUS[status as FinalizationState['status']] : undefined;
  if (!allowedKeys || !hasOnlyAllowedKeys(value, allowedKeys)) {
    return undefined;
  }

  const finalizationId = getStringProperty(value, 'finalizationId');
  const queuedAtMs = getNumberProperty(value, 'queuedAtMs');
  if (!status || typeof finalizationId !== 'string' || !isNonNegativeInteger(queuedAtMs)) {
    return undefined;
  }

  if (status === 'pending') {
    return {
      status: 'pending',
      finalizationId,
      queuedAtMs,
    };
  }

  const startedAtMs = getNumberProperty(value, 'startedAtMs');
  if (hasOwn(value, 'startedAtMs') && !isNonNegativeInteger(startedAtMs)) {
    return undefined;
  }

  if (status === 'running') {
    if (!isNonNegativeInteger(startedAtMs)) {
      return undefined;
    }
    return {
      status: 'running',
      finalizationId,
      queuedAtMs,
      startedAtMs,
    };
  }

  if (status === 'succeeded') {
    const completedAtMs = getNumberProperty(value, 'completedAtMs');
    if (!isNonNegativeInteger(startedAtMs) || !isNonNegativeInteger(completedAtMs)) {
      return undefined;
    }

    return {
      status: 'succeeded',
      finalizationId,
      queuedAtMs,
      startedAtMs,
      completedAtMs,
    };
  }

  if (status === 'failed') {
    const failedAtMs = getNumberProperty(value, 'failedAtMs');
    const error = parseFinalizationError(value['error']);
    if (!isNonNegativeInteger(failedAtMs) || !error) {
      return undefined;
    }

    return {
      status: 'failed',
      finalizationId,
      queuedAtMs,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      failedAtMs,
      error,
    };
  }

  if (status === 'timeout') {
    const timeoutAtMs = getNumberProperty(value, 'timeoutAtMs');
    if (!isNonNegativeInteger(timeoutAtMs)) {
      return undefined;
    }

    return {
      status: 'timeout',
      finalizationId,
      queuedAtMs,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      timeoutAtMs,
    };
  }

  return undefined;
}

export function parseFinalizationScenarioContext(value: unknown): FinalizationScenarioContext | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, FINALIZATION_SCENARIO_CONTEXT_KEYS)) {
    return undefined;
  }

  const scenarios = getStringArrayProperty(value, 'scenarios');
  const tamperMode = getStringProperty(value, 'tamperMode');
  const claimedCounts = parseCountRecord(value['claimedCounts']);
  const claimedTotalVotes = getNumberProperty(value, 'claimedTotalVotes');
  const summary = getRecordProperty(value, 'summary');
  if (
    !scenarios ||
    !tamperMode ||
    !SCENARIO_TAMPER_MODES.has(tamperMode as ScenarioTamperMode) ||
    !claimedCounts ||
    !isNonNegativeInteger(claimedTotalVotes) ||
    !summary ||
    !hasOnlyAllowedKeys(summary, FINALIZATION_SCENARIO_SUMMARY_KEYS)
  ) {
    return undefined;
  }

  const ignoredCount = getNumberProperty(summary, 'ignoredCount');
  const recountedCount = getNumberProperty(summary, 'recountedCount');
  const userRecountChoice = summary['userRecountChoice'];
  const affectedBotIds = getNumberArrayProperty(summary, 'affectedBotIds');
  if (
    !isNonNegativeInteger(ignoredCount) ||
    !isNonNegativeInteger(recountedCount) ||
    (userRecountChoice !== null && !VOTE_CHOICES.includes(userRecountChoice as VoteChoice))
  ) {
    return undefined;
  }
  if (hasOwn(summary, 'affectedBotIds') && (!affectedBotIds || !isIntegerArray(affectedBotIds))) {
    return undefined;
  }

  return {
    scenarios: [...scenarios],
    tamperMode: tamperMode as ScenarioTamperMode,
    claimedCounts,
    claimedTotalVotes,
    summary: {
      ignoredCount,
      recountedCount,
      userRecountChoice: userRecountChoice as VoteChoice | null,
      ...(affectedBotIds ? { affectedBotIds: [...affectedBotIds] } : {}),
    },
  };
}
