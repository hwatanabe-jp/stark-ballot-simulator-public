import { hasOnlyAllowedKeys, isNonNegativeInteger } from '@stark-ballot/validation/unknown-value-guards';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import {
  isNonNegativeSafeInteger,
  hasExactOwnKeys as hasExactKeys,
} from '@stark-ballot/validation/unknown-value-guards';
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
  getObjectProperty,
  getStringArrayProperty,
  getStringProperty,
  isNonNullObject,
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

function isIntegerArray(value: number[]): boolean {
  return value.every((entry) => Number.isInteger(entry));
}

function parseVerificationStatus(value: unknown): VerificationStatus | undefined {
  return typeof value === 'string' && VERIFICATION_STATUSES.has(value as VerificationStatus)
    ? (value as VerificationStatus)
    : undefined;
}

function parseCountRecord(value: unknown): Record<VoteChoice, number> | undefined {
  if (!isNonNullObject(value) || Object.keys(value).length !== VOTE_CHOICES.length) {
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
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, FINALIZATION_TALLY_KEYS)) {
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
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, RECEIPT_JOURNAL_KEYS)) {
    return undefined;
  }

  const bytes = getNumberArrayProperty(value, 'bytes');
  if (!bytes || !isIntegerArray(bytes)) {
    return undefined;
  }

  return { bytes: [...bytes] };
}

function parseReceiptWithImageId(value: unknown): ReceiptWithImageId | undefined {
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, RECEIPT_KEYS)) {
    return undefined;
  }

  const seal = getStringProperty(value, 'seal');
  const journal = parseReceiptJournal(value['journal']);
  if (typeof seal !== 'string' || !journal) {
    return undefined;
  }

  const imageId = getStringProperty(value, 'imageId');
  const metadata = getObjectProperty(value, 'metadata');

  return {
    seal,
    journal,
    ...(imageId ? { imageId } : {}),
    ...(metadata ? { metadata: { ...metadata } } : {}),
  };
}

function parseReceiptPublication(value: unknown): FinalizationReceiptPublication | undefined {
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, RECEIPT_PUBLICATION_KEYS)) {
    return undefined;
  }

  const receiptHash = getStringProperty(value, 'receiptHash');
  const boardIndex = getNumberProperty(value, 'boardIndex');
  const timestamp = getNumberProperty(value, 'timestamp');
  if (typeof receiptHash !== 'string' || !isNonNegativeInteger(boardIndex)) {
    return undefined;
  }
  if (Object.hasOwn(value, 'timestamp') && !isNonNegativeInteger(timestamp)) {
    return undefined;
  }

  return {
    receiptHash,
    boardIndex,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function parseFinalizationBitmapData(value: unknown): FinalizationBitmapData | undefined {
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, BITMAP_DATA_KEYS)) return undefined;
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
  )
    return undefined;
  const seen = parseStoredSeenBitmap(value);
  if (!seen) return undefined;
  return { includedBitmap: [...includedBitmap], includedBitmapRoot, ...seen, treeSize, finalizedAtMs };
}

function parseStoredSeenBitmap(
  value: Record<string, unknown>,
): Pick<FinalizationBitmapData, 'seenBitmap' | 'seenBitmapRoot'> | undefined {
  const seenBitmap = getBooleanArrayProperty(value, 'seenBitmap');
  const seenBitmapRoot = getStringProperty(value, 'seenBitmapRoot');
  const hasSeenBitmap = Object.hasOwn(value, 'seenBitmap');
  const hasSeenBitmapRoot = Object.hasOwn(value, 'seenBitmapRoot');
  if (hasSeenBitmap !== hasSeenBitmapRoot) return undefined;
  if (hasSeenBitmap && !seenBitmap) return undefined;
  if (hasSeenBitmapRoot && (typeof seenBitmapRoot !== 'string' || !BITMAP_ROOT_PATTERN.test(seenBitmapRoot)))
    return undefined;
  return seenBitmap && seenBitmapRoot ? { seenBitmap: [...seenBitmap], seenBitmapRoot } : {};
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

function readVerificationFailureCategory(
  value: Record<string, unknown>,
): VerificationFailureCategory | undefined | null {
  const category = getStringProperty(value, 'failureCategory');
  if (
    Object.hasOwn(value, 'failureCategory') &&
    (typeof category !== 'string' || !VERIFICATION_FAILURE_CATEGORIES.has(category as VerificationFailureCategory))
  ) {
    return null;
  }
  return category as VerificationFailureCategory | undefined;
}

function buildFailedVerificationResult(
  report: VerificationReport | undefined,
  category: VerificationFailureCategory | undefined,
): VerificationResult | undefined {
  if ((report !== undefined && report.status !== 'failed') || category === 'none') return undefined;
  return {
    status: 'failed',
    ...(report?.status === 'failed' ? { report } : {}),
    ...(category ? { failureCategory: category } : {}),
  };
}

function buildVerificationOutcome(
  status: VerificationStatus,
  report: VerificationReport | undefined,
  category: VerificationFailureCategory | undefined,
): VerificationResult | undefined {
  if (status === 'failed') return buildFailedVerificationResult(report, category);
  if (category !== undefined && category !== 'none') return undefined;
  const metadata: { failureCategory?: 'none' } = category ? { failureCategory: category } : {};
  if (report === undefined) return { status, ...metadata };
  if (report.status !== status) return undefined;
  // Branch on the admitted report to preserve the status/report relationship in the type system.
  switch (report.status) {
    case 'success':
      return { status: 'success', report, ...metadata };
    case 'dev_mode':
      return { status: 'dev_mode', report, ...metadata };
  }
}

export function parseVerificationResult(value: unknown): VerificationResult | undefined {
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, VERIFICATION_RESULT_KEYS)) return undefined;
  const status = parseVerificationStatus(value['status']);
  if (!status) return undefined;
  const rawReport = value['report'];
  const report = rawReport !== undefined ? parseVerificationReport(rawReport) : undefined;
  if (rawReport !== undefined && !report) return undefined;
  const category = readVerificationFailureCategory(value);
  return category === null ? undefined : buildVerificationOutcome(status, report, category);
}

function parseTamperSummary(value: unknown): FinalizationTamperSummary | undefined {
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, TAMPER_SUMMARY_KEYS)) {
    return undefined;
  }

  const ignoredVotes = getNumberProperty(value, 'ignoredVotes');
  const recountedVotes = getNumberProperty(value, 'recountedVotes');
  const userRecountedTo = value['userRecountedTo'];
  const affectedBotIds = parseAffectedBotIds(value);
  if (
    !isNonNegativeInteger(ignoredVotes) ||
    !isNonNegativeInteger(recountedVotes) ||
    !isNullableVoteChoice(userRecountedTo)
  ) {
    return undefined;
  }
  if (affectedBotIds === null) {
    return undefined;
  }

  return {
    ignoredVotes,
    recountedVotes,
    userRecountedTo,
    ...(affectedBotIds ? { affectedBotIds: [...affectedBotIds] } : {}),
  };
}

type StoredArtifacts = FinalizationResultAuthority['artifacts'];

function parseStoredReceiptArtifacts(
  value: Record<string, unknown>,
): Pick<StoredArtifacts, 'receipt' | 'receiptPublication'> | undefined {
  const hasReceipt = Object.hasOwn(value, 'receipt');
  const receipt = hasReceipt ? parseReceiptWithImageId(value['receipt']) : undefined;
  if (hasReceipt && !receipt) return undefined;
  const hasPublication = Object.hasOwn(value, 'receiptPublication');
  const publication = hasPublication ? parseReceiptPublication(value['receiptPublication']) : undefined;
  if (hasPublication && !publication) return undefined;
  return {
    receipt: receipt ? { availability: 'available', receipt } : { availability: 'unavailable' },
    receiptPublication: publication ? { availability: 'available', publication } : { availability: 'unavailable' },
  };
}

function parseStoredElectionManifest(value: unknown): ElectionManifest | undefined {
  return isNonNullObject(value) && hasOnlyAllowedKeys(value, ELECTION_MANIFEST_KEYS) && isElectionManifest(value)
    ? value
    : undefined;
}

function parseStoredCloseStatement(value: unknown): CloseStatement | undefined {
  return isNonNullObject(value) && hasOnlyAllowedKeys(value, CLOSE_STATEMENT_KEYS) && isCloseStatement(value)
    ? value
    : undefined;
}

function parseStoredPublicAuditArtifacts(value: Record<string, unknown>): StoredArtifacts['publicAudit'] | undefined {
  const presence = ['publicInputArtifact', 'electionManifest', 'closeStatement'].map((key) =>
    Object.hasOwn(value, key),
  );
  if (presence.every((present) => !present)) return { availability: 'unavailable' };
  if (!presence.every(Boolean)) return undefined;
  const publicInputArtifact = parseStoredPublicInputArtifact(value['publicInputArtifact']);
  const electionManifest = parseStoredElectionManifest(value['electionManifest']);
  const closeStatement = parseStoredCloseStatement(value['closeStatement']);
  if (!publicInputArtifact || !electionManifest || !closeStatement) return undefined;
  return { availability: 'available', publicInputArtifact, electionManifest, closeStatement };
}

function parseStoredBitmapArtifact(value: Record<string, unknown>): StoredArtifacts['bitmap'] | undefined {
  const hasSource = Object.hasOwn(value, 'bitmapProofSource');
  const hasData = Object.hasOwn(value, 'bitmapData');
  if (!hasSource && !hasData) return { availability: 'unavailable' };
  if (hasSource !== hasData) return undefined;
  const proofSource = value['bitmapProofSource'];
  if (!BITMAP_PROOF_SOURCES.has(proofSource as BitmapProofSource)) return undefined;
  const data = finalizationBitmapDataCodec.decode(value['bitmapData']);
  return data ? { availability: 'available', proofSource: proofSource as BitmapProofSource, data } : undefined;
}

function parseStoredScenarioPresentation(
  value: Record<string, unknown>,
): Pick<FinalizationResultAuthority, 'tamperDetected' | 'scenarios' | 'tamperSummary'> | undefined {
  const tamperDetected = value['tamperDetected'];
  if (Object.hasOwn(value, 'tamperDetected') && typeof tamperDetected !== 'boolean') return undefined;
  const scenarios = getStringArrayProperty(value, 'scenarios');
  if (value['scenarios'] !== undefined && !scenarios) return undefined;
  const rawSummary = value['tamperSummary'];
  const tamperSummary = rawSummary !== undefined ? parseTamperSummary(rawSummary) : undefined;
  if (rawSummary !== undefined && !tamperSummary) return undefined;
  return projectStoredScenarioPresentation(tamperDetected, scenarios, tamperSummary);
}

export function parseFinalizationResultAuthority(value: unknown): FinalizationResultAuthority | undefined {
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, FINALIZATION_RESULT_AUTHORITY_KEYS)) return undefined;
  const tally = parseFinalizationTally(value['tally']);
  const imageId = getStringProperty(value, 'imageId');
  const journalValue = value['journal'];
  if (
    !tally ||
    typeof imageId !== 'string' ||
    !isNonNullObject(journalValue) ||
    !hasOnlyAllowedKeys(journalValue, JOURNAL_KEYS) ||
    !isSupportedZkVMJournal(journalValue)
  )
    return undefined;
  const journal = toPublicZkvmJournal(journalValue);
  const presentation = parseStoredScenarioPresentation(value);
  const receipts = parseStoredReceiptArtifacts(value);
  const publicAudit = parseStoredPublicAuditArtifacts(value);
  const bitmap = parseStoredBitmapArtifact(value);
  if (!presentation || !receipts || !publicAudit || !bitmap) return undefined;
  return { tally, imageId, journal, ...presentation, artifacts: { ...receipts, publicAudit, bitmap } };
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

function hasExactAvailabilityKeys(value: unknown, availableKeys: readonly string[]): value is Record<string, unknown> {
  if (!isNonNullObject(value)) {
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
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, ADMITTED_FINALIZATION_RESULT_AUTHORITY_KEYS)) {
    return undefined;
  }
  const artifacts = value['artifacts'];
  if (!isNonNullObject(artifacts) || !hasExactKeys(artifacts, FINALIZATION_ARTIFACT_AVAILABILITY_KEYS)) {
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
    ...(Object.hasOwn(value, 'tamperDetected') ? { tamperDetected: value['tamperDetected'] } : {}),
    ...(Object.hasOwn(value, 'scenarios') ? { scenarios: value['scenarios'] } : {}),
    ...(Object.hasOwn(value, 'tamperSummary') ? { tamperSummary: value['tamperSummary'] } : {}),
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
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, FINALIZATION_ERROR_KEYS)) return undefined;
  const code = getStringProperty(value, 'code');
  const message = getStringProperty(value, 'message');
  const category = parseFinalizationErrorCategory(value);
  if (typeof code !== 'string' || typeof message !== 'string' || category === null) return undefined;
  return {
    code,
    message,
    ...(category ? { category } : {}),
    ...(Object.hasOwn(value, 'details') ? { details: value['details'] } : {}),
  };
}

function parseFinalizationErrorCategory(
  value: Record<string, unknown>,
): FinalizationFailureCategory | undefined | null {
  const category = getStringProperty(value, 'category');
  if (
    Object.hasOwn(value, 'category') &&
    (typeof category !== 'string' || !FINALIZATION_FAILURE_CATEGORIES.has(category as FinalizationFailureCategory))
  )
    return null;
  return category as FinalizationFailureCategory | undefined;
}

const FINALIZATION_STATE_KEYS_BY_STATUS: Record<FinalizationState['status'], ReadonlySet<string>> = {
  pending: new Set(['status', 'finalizationId', 'queuedAtMs']),
  running: new Set(['status', 'finalizationId', 'queuedAtMs', 'startedAtMs']),
  succeeded: new Set(['status', 'finalizationId', 'queuedAtMs', 'startedAtMs', 'completedAtMs']),
  failed: new Set(['status', 'finalizationId', 'queuedAtMs', 'startedAtMs', 'failedAtMs', 'error']),
  timeout: new Set(['status', 'finalizationId', 'queuedAtMs', 'startedAtMs', 'timeoutAtMs']),
};

type StoredFinalizationTiming = Pick<FinalizationState, 'finalizationId' | 'queuedAtMs'> & { startedAtMs?: number };

function parseFailedFinalization(
  value: Record<string, unknown>,
  timing: StoredFinalizationTiming,
): FinalizationState | undefined {
  const failedAtMs = getNumberProperty(value, 'failedAtMs');
  const error = parseFinalizationError(value['error']);
  if (!isNonNegativeInteger(failedAtMs) || !error) return undefined;
  return { status: 'failed', ...timing, failedAtMs, error };
}

function parseCompletedFinalization(
  value: Record<string, unknown>,
  timing: StoredFinalizationTiming,
): FinalizationState | undefined {
  const completedAtMs = getNumberProperty(value, 'completedAtMs');
  if (!isNonNegativeInteger(timing.startedAtMs) || !isNonNegativeInteger(completedAtMs)) return undefined;
  return { status: 'succeeded', ...timing, startedAtMs: timing.startedAtMs, completedAtMs };
}

function parseFinalizationProgress(
  status: FinalizationState['status'],
  value: Record<string, unknown>,
  timing: StoredFinalizationTiming,
): FinalizationState | undefined {
  switch (status) {
    case 'pending':
      return { status, finalizationId: timing.finalizationId, queuedAtMs: timing.queuedAtMs };
    case 'running':
      return isNonNegativeInteger(timing.startedAtMs)
        ? { status, ...timing, startedAtMs: timing.startedAtMs }
        : undefined;
    case 'succeeded':
      return parseCompletedFinalization(value, timing);
    case 'failed':
      return parseFailedFinalization(value, timing);
    case 'timeout': {
      const timeoutAtMs = getNumberProperty(value, 'timeoutAtMs');
      return isNonNegativeInteger(timeoutAtMs) ? { status, ...timing, timeoutAtMs } : undefined;
    }
  }
}

function isFinalizationStatus(value: string): value is FinalizationState['status'] {
  return Object.hasOwn(FINALIZATION_STATE_KEYS_BY_STATUS, value);
}

export function parseFinalizationState(value: unknown): FinalizationState | undefined {
  if (!isNonNullObject(value)) return undefined;
  const status = getStringProperty(value, 'status');
  if (!status || !isFinalizationStatus(status)) return undefined;
  if (!hasOnlyAllowedKeys(value, FINALIZATION_STATE_KEYS_BY_STATUS[status])) return undefined;
  const finalizationId = parseFinalizationId(value['finalizationId']);
  const queuedAtMs = getNumberProperty(value, 'queuedAtMs');
  if (!finalizationId || !isNonNegativeInteger(queuedAtMs)) return undefined;
  const startedAtMs = getNumberProperty(value, 'startedAtMs');
  if (Object.hasOwn(value, 'startedAtMs') && !isNonNegativeInteger(startedAtMs)) return undefined;
  return parseFinalizationProgress(status, value, {
    finalizationId,
    queuedAtMs,
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  });
}

export function parseFinalizationScenarioContext(value: unknown): FinalizationScenarioContext | undefined {
  if (!isNonNullObject(value) || !hasOnlyAllowedKeys(value, FINALIZATION_SCENARIO_CONTEXT_KEYS)) {
    return undefined;
  }

  const scenarios = getStringArrayProperty(value, 'scenarios');
  const tamperMode = getStringProperty(value, 'tamperMode');
  const claimedCounts = parseCountRecord(value['claimedCounts']);
  const claimedTotalVotes = getNumberProperty(value, 'claimedTotalVotes');
  const summary = getObjectProperty(value, 'summary');
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
  const affectedBotIds = parseAffectedBotIds(summary);
  if (
    !isNonNegativeInteger(ignoredCount) ||
    !isNonNegativeInteger(recountedCount) ||
    !isNullableVoteChoice(userRecountChoice)
  ) {
    return undefined;
  }
  if (affectedBotIds === null) {
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
      userRecountChoice,
      ...(affectedBotIds ? { affectedBotIds: [...affectedBotIds] } : {}),
    },
  };
}

function isNullableVoteChoice(value: unknown): value is VoteChoice | null {
  return value === null || VOTE_CHOICES.some((choice) => choice === value);
}

function parseAffectedBotIds(value: Record<string, unknown>): number[] | undefined | null {
  const affectedBotIds = getNumberArrayProperty(value, 'affectedBotIds');
  if (Object.hasOwn(value, 'affectedBotIds') && (!affectedBotIds || !isIntegerArray(affectedBotIds))) return null;
  return affectedBotIds;
}

function projectStoredScenarioPresentation(
  tamperDetected: unknown,
  scenarios: string[] | undefined,
  tamperSummary: FinalizationTamperSummary | undefined,
): Pick<FinalizationResultAuthority, 'tamperDetected' | 'scenarios' | 'tamperSummary'> {
  return omitUndefinedProperties({
    tamperDetected: typeof tamperDetected === 'boolean' ? tamperDetected : undefined,
    scenarios: scenarios ? [...scenarios] : undefined,
    tamperSummary,
  });
}
