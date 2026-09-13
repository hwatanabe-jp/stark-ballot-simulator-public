import { VOTE_CHOICES, type VoteChoice } from '@stark-ballot/domain/shared/constants';
import type { ScenarioTamperMode } from '@stark-ballot/domain/types/scenario';
import {
  FinalizationFailureCategory,
  type BitmapProofSource,
  type FinalizationBitmapData,
  type FinalizationReceiptPublication,
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
import {
  VERIFICATION_FAILURE_CATEGORY_VALUES,
  VERIFICATION_STATUS_VALUES,
} from '@stark-ballot/verification/shared/types';
import { parseVerifierServiceReport } from '@stark-ballot/verification/verifier-service-report';
import type { ReceiptJournal, ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import {
  parseStoredPublicInputArtifact,
  type SupportedPublicInputArtifact,
} from '@stark-ballot/verification/public-input';
import {
  isCloseStatement,
  isElectionManifest,
  type CloseStatement,
  type ElectionManifest,
} from '@stark-ballot/verification/public-audit-artifacts';
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
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const VERIFICATION_STATUSES = new Set<VerificationStatus>(VERIFICATION_STATUS_VALUES);
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
const ADMITTED_FINALIZATION_RESULT_AUTHORITY_KEYS = new Set<string>([
  'tally',
  'imageId',
  'tamperDetected',
  'scenarios',
  'journal',
  'artifacts',
  'tamperSummary',
]);
const FINALIZATION_ARTIFACT_AVAILABILITY_KEYS = new Set<string>([
  'publicAudit',
  'receipt',
  'receiptPublication',
  'bitmap',
]);
const VERIFICATION_RESULT_KEYS = new Set<string>(['status', 'report', 'failureCategory']);
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
const BITMAP_ROOT_PATTERN = /^(?:0x)?[0-9a-f]{64}$/;
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

/** Exact current persisted result shape. Artifact availability is encoded by
 * the presence of its existing flat fields; no storage discriminator is added.
 */
export type PersistedFinalizationReceiptState = { receipt?: never } | { receipt: ReceiptWithImageId };

export type PersistedFinalizationReceiptPublicationState =
  | { receiptPublication?: never }
  | { receiptPublication: FinalizationReceiptPublication };

export type PersistedFinalizationPublicAuditState =
  | {
      publicInputArtifact?: never;
      electionManifest?: never;
      closeStatement?: never;
    }
  | {
      publicInputArtifact: SupportedPublicInputArtifact;
      electionManifest: ElectionManifest;
      closeStatement: CloseStatement;
    };

export type PersistedFinalizationBitmapState =
  | { bitmapProofSource?: never; bitmapData?: never }
  | { bitmapProofSource: BitmapProofSource; bitmapData: FinalizationBitmapData };

export type PersistedFinalizationResultAuthority = Omit<FinalizationResultAuthority, 'artifacts'> &
  PersistedFinalizationReceiptState &
  PersistedFinalizationReceiptPublicationState &
  PersistedFinalizationPublicAuditState &
  PersistedFinalizationBitmapState;

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

function parseReceiptPublication(value: unknown): FinalizationReceiptPublication | undefined {
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

export function parseFinalizationBitmapData(value: unknown): FinalizationBitmapData | undefined {
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
    !BITMAP_ROOT_PATTERN.test(includedBitmapRoot) ||
    !isNonNegativeSafeInteger(treeSize) ||
    !isNonNegativeSafeInteger(finalizedAtMs)
  ) {
    return undefined;
  }

  const seenBitmap = getBooleanArrayProperty(value, 'seenBitmap');
  const seenBitmapRoot = getStringProperty(value, 'seenBitmapRoot');
  const hasSeenBitmap = hasOwn(value, 'seenBitmap');
  const hasSeenBitmapRoot = hasOwn(value, 'seenBitmapRoot');
  if (hasSeenBitmap !== hasSeenBitmapRoot) {
    return undefined;
  }
  if (hasSeenBitmap && !seenBitmap) {
    return undefined;
  }
  if (hasSeenBitmapRoot && (typeof seenBitmapRoot !== 'string' || !BITMAP_ROOT_PATTERN.test(seenBitmapRoot))) {
    return undefined;
  }

  return {
    includedBitmap: [...includedBitmap],
    includedBitmapRoot,
    ...(seenBitmap && seenBitmapRoot ? { seenBitmap: [...seenBitmap], seenBitmapRoot } : {}),
    treeSize,
    finalizedAtMs,
  };
}

export function encodeFinalizationBitmapData(data: FinalizationBitmapData): FinalizationBitmapData {
  return {
    includedBitmap: [...data.includedBitmap],
    includedBitmapRoot: data.includedBitmapRoot,
    ...(data.seenBitmap !== undefined ? { seenBitmap: [...data.seenBitmap], seenBitmapRoot: data.seenBitmapRoot } : {}),
    treeSize: data.treeSize,
    finalizedAtMs: data.finalizedAtMs,
  };
}

export const finalizationBitmapDataCodec = {
  decode: parseFinalizationBitmapData,
  encode: encodeFinalizationBitmapData,
} as const;

function parseVerificationReport(value: unknown): VerificationReport | undefined {
  try {
    return parseVerifierServiceReport(value);
  } catch {
    return undefined;
  }
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

  const admittedFailureCategory = failureCategory as VerificationFailureCategory | undefined;
  switch (status) {
    case 'not_run':
    case 'running':
      if (parsedReport !== undefined || (admittedFailureCategory !== undefined && admittedFailureCategory !== 'none')) {
        return undefined;
      }
      return {
        status,
        ...(admittedFailureCategory ? { failureCategory: admittedFailureCategory } : {}),
      };
    case 'success':
      if (
        (parsedReport !== undefined && parsedReport.status !== 'success') ||
        (admittedFailureCategory !== undefined && admittedFailureCategory !== 'none')
      ) {
        return undefined;
      }
      return {
        status,
        ...(parsedReport?.status === 'success' ? { report: parsedReport } : {}),
        ...(admittedFailureCategory ? { failureCategory: admittedFailureCategory } : {}),
      };
    case 'dev_mode':
      if (
        (parsedReport !== undefined && parsedReport.status !== 'dev_mode') ||
        (admittedFailureCategory !== undefined && admittedFailureCategory !== 'none')
      ) {
        return undefined;
      }
      return {
        status,
        ...(parsedReport?.status === 'dev_mode' ? { report: parsedReport } : {}),
        ...(admittedFailureCategory ? { failureCategory: admittedFailureCategory } : {}),
      };
    case 'failed':
      if ((parsedReport !== undefined && parsedReport.status !== 'failed') || admittedFailureCategory === 'none') {
        return undefined;
      }
      return {
        status,
        ...(parsedReport?.status === 'failed' ? { report: parsedReport } : {}),
        ...(admittedFailureCategory ? { failureCategory: admittedFailureCategory } : {}),
      };
  }
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

  const hasReceipt = hasOwn(value, 'receipt');
  const parsedReceipt = hasReceipt ? parseReceiptWithImageId(value['receipt']) : undefined;
  if (hasReceipt && !parsedReceipt) {
    return undefined;
  }

  const hasReceiptPublication = hasOwn(value, 'receiptPublication');
  const parsedReceiptPublication = hasReceiptPublication
    ? parseReceiptPublication(value['receiptPublication'])
    : undefined;
  if (hasReceiptPublication && !parsedReceiptPublication) {
    return undefined;
  }

  const hasPublicInputArtifact = hasOwn(value, 'publicInputArtifact');
  const hasElectionManifest = hasOwn(value, 'electionManifest');
  const hasCloseStatement = hasOwn(value, 'closeStatement');
  const parsedPublicInputArtifact = hasPublicInputArtifact
    ? parseStoredPublicInputArtifact(value['publicInputArtifact'])
    : undefined;
  if (hasPublicInputArtifact && !parsedPublicInputArtifact) {
    return undefined;
  }

  let electionManifest: ElectionManifest | undefined;
  if (hasElectionManifest) {
    const candidate = value['electionManifest'];
    if (
      !isRecord(candidate) ||
      !hasOnlyAllowedKeys(candidate, ELECTION_MANIFEST_KEYS) ||
      !isElectionManifest(candidate)
    ) {
      return undefined;
    }
    electionManifest = candidate;
  }
  let closeStatement: CloseStatement | undefined;
  if (hasCloseStatement) {
    const candidate = value['closeStatement'];
    if (!isRecord(candidate) || !hasOnlyAllowedKeys(candidate, CLOSE_STATEMENT_KEYS) || !isCloseStatement(candidate)) {
      return undefined;
    }
    closeStatement = candidate;
  }

  const hasAnyPublicAuditArtifact = hasPublicInputArtifact || hasElectionManifest || hasCloseStatement;
  const hasCompletePublicAuditArtifacts =
    parsedPublicInputArtifact !== undefined && electionManifest !== undefined && closeStatement !== undefined;
  if (hasAnyPublicAuditArtifact !== hasCompletePublicAuditArtifacts) {
    return undefined;
  }
  const publicAuditArtifacts =
    parsedPublicInputArtifact && electionManifest && closeStatement
      ? {
          availability: 'available' as const,
          publicInputArtifact: parsedPublicInputArtifact,
          electionManifest,
          closeStatement,
        }
      : { availability: 'unavailable' as const };

  const hasBitmapProofSource = hasOwn(value, 'bitmapProofSource');
  const bitmapProofSource = hasBitmapProofSource ? value['bitmapProofSource'] : undefined;
  if (hasBitmapProofSource && !BITMAP_PROOF_SOURCES.has(bitmapProofSource as BitmapProofSource)) {
    return undefined;
  }

  const hasBitmapData = hasOwn(value, 'bitmapData');
  const parsedBitmapData = hasBitmapData ? finalizationBitmapDataCodec.decode(value['bitmapData']) : undefined;
  if (hasBitmapData && !parsedBitmapData) {
    return undefined;
  }
  if (hasBitmapProofSource !== hasBitmapData) {
    return undefined;
  }

  const tamperSummary = value['tamperSummary'];
  const parsedTamperSummary = tamperSummary !== undefined ? parseTamperSummary(tamperSummary) : undefined;
  if (tamperSummary !== undefined && !parsedTamperSummary) {
    return undefined;
  }

  return {
    tally,
    imageId,
    ...(typeof value['tamperDetected'] === 'boolean' ? { tamperDetected: value['tamperDetected'] } : {}),
    ...(scenarios ? { scenarios: [...scenarios] } : {}),
    journal,
    artifacts: {
      receipt: parsedReceipt ? { availability: 'available', receipt: parsedReceipt } : { availability: 'unavailable' },
      receiptPublication: parsedReceiptPublication
        ? { availability: 'available', publication: parsedReceiptPublication }
        : { availability: 'unavailable' },
      publicAudit: publicAuditArtifacts,
      bitmap:
        bitmapProofSource !== undefined && parsedBitmapData
          ? {
              availability: 'available',
              proofSource: bitmapProofSource as BitmapProofSource,
              data: parsedBitmapData,
            }
          : { availability: 'unavailable' },
    },
    ...(parsedTamperSummary ? { tamperSummary: parsedTamperSummary } : {}),
  };
}

export function encodeFinalizationResultAuthority(
  authority: FinalizationResultAuthority,
): PersistedFinalizationResultAuthority {
  const { artifacts, ...common } = authority;
  return {
    ...common,
    ...(artifacts.receipt.availability === 'available' ? { receipt: artifacts.receipt.receipt } : {}),
    ...(artifacts.receiptPublication.availability === 'available'
      ? { receiptPublication: artifacts.receiptPublication.publication }
      : {}),
    ...(artifacts.publicAudit.availability === 'available'
      ? {
          publicInputArtifact: artifacts.publicAudit.publicInputArtifact,
          electionManifest: artifacts.publicAudit.electionManifest,
          closeStatement: artifacts.publicAudit.closeStatement,
        }
      : {}),
    ...(artifacts.bitmap.availability === 'available'
      ? {
          bitmapProofSource: artifacts.bitmap.proofSource,
          bitmapData: finalizationBitmapDataCodec.encode(artifacts.bitmap.data),
        }
      : {}),
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasExactAvailabilityKeys(value: unknown, availableKeys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const availability = value['availability'];
  const expected = new Set(availability === 'available' ? ['availability', ...availableKeys] : ['availability']);
  return (availability === 'available' || availability === 'unavailable') && hasExactKeys(value, expected);
}

/** Admits an application-owned nested authority through the same exact-current
 * persisted codec. This is used at process/runtime command boundaries.
 */
export function admitFinalizationResultAuthority(value: unknown): FinalizationResultAuthority | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, ADMITTED_FINALIZATION_RESULT_AUTHORITY_KEYS)) {
    return undefined;
  }
  const artifacts = value['artifacts'];
  if (!isRecord(artifacts) || !hasExactKeys(artifacts, FINALIZATION_ARTIFACT_AVAILABILITY_KEYS)) {
    return undefined;
  }
  const publicAudit = artifacts['publicAudit'];
  const receipt = artifacts['receipt'];
  const receiptPublication = artifacts['receiptPublication'];
  const bitmap = artifacts['bitmap'];
  if (
    !hasExactAvailabilityKeys(publicAudit, ['publicInputArtifact', 'electionManifest', 'closeStatement']) ||
    !hasExactAvailabilityKeys(receipt, ['receipt']) ||
    !hasExactAvailabilityKeys(receiptPublication, ['publication']) ||
    !hasExactAvailabilityKeys(bitmap, ['proofSource', 'data'])
  ) {
    return undefined;
  }

  return parseFinalizationResultAuthority({
    tally: value['tally'],
    imageId: value['imageId'],
    journal: value['journal'],
    ...(hasOwn(value, 'tamperDetected') ? { tamperDetected: value['tamperDetected'] } : {}),
    ...(hasOwn(value, 'scenarios') ? { scenarios: value['scenarios'] } : {}),
    ...(hasOwn(value, 'tamperSummary') ? { tamperSummary: value['tamperSummary'] } : {}),
    ...(receipt['availability'] === 'available' ? { receipt: receipt['receipt'] } : {}),
    ...(receiptPublication['availability'] === 'available'
      ? { receiptPublication: receiptPublication['publication'] }
      : {}),
    ...(publicAudit['availability'] === 'available'
      ? {
          publicInputArtifact: publicAudit['publicInputArtifact'],
          electionManifest: publicAudit['electionManifest'],
          closeStatement: publicAudit['closeStatement'],
        }
      : {}),
    ...(bitmap['availability'] === 'available'
      ? { bitmapProofSource: bitmap['proofSource'], bitmapData: bitmap['data'] }
      : {}),
  });
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

  const finalizationId = parseFinalizationId(value['finalizationId']);
  const queuedAtMs = getNumberProperty(value, 'queuedAtMs');
  if (!status || !finalizationId || !isNonNegativeInteger(queuedAtMs)) {
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
