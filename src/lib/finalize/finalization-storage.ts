import { VOTE_CHOICES, type VoteChoice } from '@/shared/constants';
import type { ScenarioTamperMode } from '@/types/scenario';
import type {
  BitmapProofSource,
  FinalizationBitmapData,
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
  FinalizationTally,
  FinalizationTamperSummary,
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from '@/types/server';
import type { ReceiptJournal, ReceiptWithImageId } from '@/lib/verification/image-id-types';
import { parseStoredPublicInputArtifact } from '@/lib/verification/public-input-contract';
import { isCloseStatement, isElectionManifest } from '@/lib/verification/public-audit-artifacts';
import {
  getBooleanArrayProperty,
  getNumberArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringArrayProperty,
  getStringProperty,
  isRecord,
} from '@/lib/utils/guards';
import { isSupportedZkVMJournal } from '@/lib/zkvm/journal-guards';
import { toPublicZkvmJournal } from '@/lib/zkvm/public-journal';

const VERIFICATION_STATUSES = new Set<VerificationStatus>(['success', 'failed', 'dev_mode', 'not_run', 'running']);
const BITMAP_PROOF_SOURCES = new Set<BitmapProofSource>(['mock', 'real']);
const SCENARIO_TAMPER_MODES = new Set<ScenarioTamperMode>(['none', 'input', 'claim']);

export interface ParsedFinalizationStoragePayload {
  contractGeneration: string;
  finalizationResult: FinalizationResultAuthority | null;
  finalizationState: FinalizationState | null;
  finalizationScenarioContext?: FinalizationScenarioContext | null;
}

export interface ParsedFinalizationStorageEnvelope {
  contractGeneration: string;
  hasFinalizationResult: boolean;
  hasFinalizationState: boolean;
  hasFinalizationScenarioContext: boolean;
}

const FINALIZATION_RESULT_AUTHORITY_KEYS = new Set<string>([
  'tally',
  // Legacy delivery fields are accepted at the parser boundary and discarded.
  's3BundleUrl',
  's3BundleKey',
  's3UploadedAt',
  's3BundleExpiresAt',
  'receipt',
  'receiptRaw',
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
  'verificationResult',
  'verificationExecutionId',
  'tamperSummary',
]);

const FINALIZATION_STORAGE_PAYLOAD_KEYS = new Set<keyof ParsedFinalizationStoragePayload>([
  'contractGeneration',
  'finalizationResult',
  'finalizationState',
  'finalizationScenarioContext',
]);

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
  if (!isRecord(value)) {
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
  if (!isRecord(value)) {
    return undefined;
  }

  const counts = parseCountRecord(value.counts);
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
  if (!isRecord(value)) {
    return undefined;
  }

  const bytes = getNumberArrayProperty(value, 'bytes');
  if (!bytes || !isIntegerArray(bytes)) {
    return undefined;
  }

  return { bytes: [...bytes] };
}

function parseReceiptWithImageId(value: unknown): ReceiptWithImageId | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const seal = getStringProperty(value, 'seal');
  const journal = parseReceiptJournal(value.journal);
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
  if (!isRecord(value)) {
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
  if (!isRecord(value)) {
    return undefined;
  }

  const includedBitmap = getBooleanArrayProperty(value, 'includedBitmap');
  const includedBitmapRoot = getStringProperty(value, 'includedBitmapRoot');
  const treeSize = getNumberProperty(value, 'treeSize');
  const finalizedAt = getNumberProperty(value, 'finalizedAt');
  if (
    !includedBitmap ||
    typeof includedBitmapRoot !== 'string' ||
    !isNonNegativeInteger(treeSize) ||
    !isNonNegativeInteger(finalizedAt)
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
    finalizedAt,
  };
}

function parseVerificationReport(value: unknown): VerificationReport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = parseVerificationStatus(value.status);
  if (!status) {
    return undefined;
  }

  const durationMs = getNumberProperty(value, 'duration_ms');
  const errors = getStringArrayProperty(value, 'errors');
  const verifierVersion = getStringProperty(value, 'verifier_version');
  const verifiedAt = getStringProperty(value, 'verified_at');
  const expectedImageId = getStringProperty(value, 'expected_image_id');
  const bundlePath = getStringProperty(value, 'bundle_path');
  const receiptPath = getStringProperty(value, 'receipt_path');
  const rawReceiptImageId = value.receipt_image_id;
  const devModeReceipt = value.dev_mode_receipt;

  if (hasOwn(value, 'duration_ms') && !isNonNegativeInteger(durationMs)) {
    return undefined;
  }
  if (hasOwn(value, 'errors') && !errors) {
    return undefined;
  }
  if (hasOwn(value, 'receipt_image_id') && rawReceiptImageId !== null && typeof rawReceiptImageId !== 'string') {
    return undefined;
  }
  if (hasOwn(value, 'dev_mode_receipt') && typeof devModeReceipt !== 'boolean') {
    return undefined;
  }

  // Preserve extra verifier CLI fields for internal/debug use. Public API
  // responses are projected through an explicit allowlist before exposure.
  return {
    ...value,
    status,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(errors ? { errors: [...errors] } : {}),
    ...(verifierVersion ? { verifier_version: verifierVersion } : {}),
    ...(verifiedAt ? { verified_at: verifiedAt } : {}),
    ...(expectedImageId ? { expected_image_id: expectedImageId } : {}),
    ...(rawReceiptImageId !== undefined ? { receipt_image_id: rawReceiptImageId } : {}),
    ...(bundlePath ? { bundle_path: bundlePath } : {}),
    ...(receiptPath ? { receipt_path: receiptPath } : {}),
    ...(typeof devModeReceipt === 'boolean' ? { dev_mode_receipt: devModeReceipt } : {}),
  } as VerificationReport;
}

function parseVerificationResult(value: unknown): VerificationResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = parseVerificationStatus(value.status);
  if (!status) {
    return undefined;
  }

  const report = value.report;
  if (report !== undefined && !parseVerificationReport(report)) {
    return undefined;
  }

  return {
    status,
    ...(report !== undefined ? { report: parseVerificationReport(report) } : {}),
    ...(getStringProperty(value, 's3BundleKey') !== undefined
      ? { s3BundleKey: getStringProperty(value, 's3BundleKey') }
      : {}),
    ...(getStringProperty(value, 's3ReportKey') !== undefined
      ? { s3ReportKey: getStringProperty(value, 's3ReportKey') }
      : {}),
    ...(getStringProperty(value, 's3UploadedAt') !== undefined
      ? { s3UploadedAt: getStringProperty(value, 's3UploadedAt') }
      : {}),
    ...(getStringProperty(value, 'executionId') !== undefined
      ? { executionId: getStringProperty(value, 'executionId') }
      : {}),
  };
}

function parseTamperSummary(value: unknown): FinalizationTamperSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const ignoredVotes = getNumberProperty(value, 'ignoredVotes');
  const recountedVotes = getNumberProperty(value, 'recountedVotes');
  const userRecountedTo = value.userRecountedTo;
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

  const tally = parseFinalizationTally(value.tally);
  const imageId = getStringProperty(value, 'imageId');
  const journalValue = value.journal;
  if (!tally || typeof imageId !== 'string' || !isSupportedZkVMJournal(journalValue)) {
    return undefined;
  }
  const journal = toPublicZkvmJournal(journalValue);

  if (hasOwn(value, 'tamperDetected') && typeof value.tamperDetected !== 'boolean') {
    return undefined;
  }

  const scenarios = getStringArrayProperty(value, 'scenarios');
  if (value.scenarios !== undefined && !scenarios) {
    return undefined;
  }

  const receipt = value.receipt;
  if (receipt !== undefined && !parseReceiptWithImageId(receipt)) {
    return undefined;
  }

  const receiptPublication = value.receiptPublication;
  if (receiptPublication !== undefined && !parseReceiptPublication(receiptPublication)) {
    return undefined;
  }

  const publicInputArtifact = value.publicInputArtifact;
  if (publicInputArtifact !== undefined && !parseStoredPublicInputArtifact(publicInputArtifact)) {
    return undefined;
  }

  if (value.electionManifest !== undefined && !isElectionManifest(value.electionManifest)) {
    return undefined;
  }
  if (value.closeStatement !== undefined && !isCloseStatement(value.closeStatement)) {
    return undefined;
  }

  const bitmapProofSource = value.bitmapProofSource;
  if (bitmapProofSource !== undefined && !BITMAP_PROOF_SOURCES.has(bitmapProofSource as BitmapProofSource)) {
    return undefined;
  }

  const bitmapData = value.bitmapData;
  if (bitmapData !== undefined && !parseBitmapData(bitmapData)) {
    return undefined;
  }

  const verificationResult = value.verificationResult;
  if (verificationResult !== undefined && !parseVerificationResult(verificationResult)) {
    return undefined;
  }

  const verificationExecutionId = getStringProperty(value, 'verificationExecutionId');
  if (hasOwn(value, 'verificationExecutionId') && typeof verificationExecutionId !== 'string') {
    return undefined;
  }

  const tamperSummary = value.tamperSummary;
  if (tamperSummary !== undefined && !parseTamperSummary(tamperSummary)) {
    return undefined;
  }

  return {
    tally,
    ...(getStringProperty(value, 's3BundleKey') !== undefined
      ? { s3BundleKey: getStringProperty(value, 's3BundleKey') }
      : {}),
    ...(getStringProperty(value, 's3UploadedAt') !== undefined
      ? { s3UploadedAt: getStringProperty(value, 's3UploadedAt') }
      : {}),
    ...(receipt !== undefined ? { receipt: parseReceiptWithImageId(receipt) } : {}),
    ...(hasOwn(value, 'receiptRaw') ? { receiptRaw: value.receiptRaw } : {}),
    ...(receiptPublication !== undefined ? { receiptPublication: parseReceiptPublication(receiptPublication) } : {}),
    imageId,
    ...(typeof value.tamperDetected === 'boolean' ? { tamperDetected: value.tamperDetected } : {}),
    ...(scenarios ? { scenarios: [...scenarios] } : {}),
    journal,
    ...(publicInputArtifact !== undefined
      ? { publicInputArtifact: parseStoredPublicInputArtifact(publicInputArtifact) }
      : {}),
    ...(value.electionManifest !== undefined ? { electionManifest: value.electionManifest } : {}),
    ...(value.closeStatement !== undefined ? { closeStatement: value.closeStatement } : {}),
    ...(bitmapProofSource !== undefined ? { bitmapProofSource: bitmapProofSource as BitmapProofSource } : {}),
    ...(bitmapData !== undefined ? { bitmapData: parseBitmapData(bitmapData) } : {}),
    ...(verificationResult !== undefined ? { verificationResult: parseVerificationResult(verificationResult) } : {}),
    ...(verificationExecutionId ? { verificationExecutionId } : {}),
    ...(tamperSummary !== undefined ? { tamperSummary: parseTamperSummary(tamperSummary) } : {}),
  };
}

function parseFinalizationError(value: unknown): Extract<FinalizationState, { status: 'failed' }>['error'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const code = getStringProperty(value, 'code');
  const message = getStringProperty(value, 'message');
  if (typeof code !== 'string' || typeof message !== 'string') {
    return undefined;
  }

  return {
    code,
    message,
    ...(hasOwn(value, 'details') ? { details: value.details } : {}),
  };
}

export function parseFinalizationState(value: unknown): FinalizationState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = getStringProperty(value, 'status');
  const executionId = getStringProperty(value, 'executionId');
  const queuedAt = getNumberProperty(value, 'queuedAt');
  const stepFunctionsArn = getStringProperty(value, 'stepFunctionsArn');
  if (
    !status ||
    typeof executionId !== 'string' ||
    !isNonNegativeInteger(queuedAt) ||
    (hasOwn(value, 'stepFunctionsArn') && typeof stepFunctionsArn !== 'string')
  ) {
    return undefined;
  }

  if (status === 'pending') {
    return {
      status: 'pending',
      executionId,
      queuedAt,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
  }

  const startedAt = getNumberProperty(value, 'startedAt');
  if (hasOwn(value, 'startedAt') && !isNonNegativeInteger(startedAt)) {
    return undefined;
  }

  if (status === 'running') {
    if (!isNonNegativeInteger(startedAt)) {
      return undefined;
    }
    return {
      status: 'running',
      executionId,
      queuedAt,
      startedAt,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
  }

  if (status === 'succeeded') {
    const completedAt = getNumberProperty(value, 'completedAt');
    if (!isNonNegativeInteger(startedAt) || !isNonNegativeInteger(completedAt)) {
      return undefined;
    }

    const bundleMetadata = getRecordProperty(value, 'bundleMetadata');
    if (hasOwn(value, 'bundleMetadata') && !bundleMetadata) {
      return undefined;
    }

    return {
      status: 'succeeded',
      executionId,
      queuedAt,
      startedAt,
      completedAt,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
      ...(bundleMetadata
        ? {
            bundleMetadata: {
              ...(getStringProperty(bundleMetadata, 's3BundleKey') !== undefined
                ? { s3BundleKey: getStringProperty(bundleMetadata, 's3BundleKey') }
                : {}),
              ...(getStringProperty(bundleMetadata, 's3UploadedAt') !== undefined
                ? { s3UploadedAt: getStringProperty(bundleMetadata, 's3UploadedAt') }
                : {}),
            },
          }
        : {}),
    };
  }

  if (status === 'failed') {
    const failedAt = getNumberProperty(value, 'failedAt');
    const error = parseFinalizationError(value.error);
    if (!isNonNegativeInteger(failedAt) || !error) {
      return undefined;
    }

    return {
      status: 'failed',
      executionId,
      queuedAt,
      ...(startedAt !== undefined ? { startedAt } : {}),
      failedAt,
      error,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
  }

  if (status === 'timeout') {
    const timeoutAt = getNumberProperty(value, 'timeoutAt');
    if (!isNonNegativeInteger(timeoutAt)) {
      return undefined;
    }

    return {
      status: 'timeout',
      executionId,
      queuedAt,
      ...(startedAt !== undefined ? { startedAt } : {}),
      timeoutAt,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
  }

  return undefined;
}

export function parseFinalizationScenarioContext(value: unknown): FinalizationScenarioContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const scenarios = getStringArrayProperty(value, 'scenarios');
  const tamperMode = getStringProperty(value, 'tamperMode');
  const claimedCounts = parseCountRecord(value.claimedCounts);
  const claimedTotalVotes = getNumberProperty(value, 'claimedTotalVotes');
  const summary = getRecordProperty(value, 'summary');
  if (
    !scenarios ||
    !tamperMode ||
    !SCENARIO_TAMPER_MODES.has(tamperMode as ScenarioTamperMode) ||
    !claimedCounts ||
    !isNonNegativeInteger(claimedTotalVotes) ||
    !summary
  ) {
    return undefined;
  }

  const ignoredCount = getNumberProperty(summary, 'ignoredCount');
  const recountedCount = getNumberProperty(summary, 'recountedCount');
  const userRecountChoice = summary.userRecountChoice;
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

export function parseFinalizationStoragePayload(value: unknown): ParsedFinalizationStoragePayload | undefined {
  const envelope = parseFinalizationStorageEnvelope(value);
  if (!envelope || !isRecord(value)) {
    return undefined;
  }

  const rawResult = value.finalizationResult;
  const rawState = value.finalizationState;
  const rawScenarioContext = value.finalizationScenarioContext;
  const parsedResult = rawResult == null ? null : parseFinalizationResultAuthority(rawResult);
  const parsedState = rawState == null ? null : parseFinalizationState(rawState);
  const parsedScenarioContext =
    rawScenarioContext == null ? null : parseFinalizationScenarioContext(rawScenarioContext);

  if (rawResult !== null && rawResult !== undefined && !parsedResult) {
    return undefined;
  }
  if (rawState !== null && rawState !== undefined && !parsedState) {
    return undefined;
  }
  if (
    hasOwn(value, 'finalizationScenarioContext') &&
    rawScenarioContext !== null &&
    rawScenarioContext !== undefined &&
    !parsedScenarioContext
  ) {
    return undefined;
  }
  const finalizationResult: ParsedFinalizationStoragePayload['finalizationResult'] =
    rawResult == null ? null : (parsedResult ?? null);
  const finalizationState: ParsedFinalizationStoragePayload['finalizationState'] =
    rawState == null ? null : (parsedState ?? null);

  return {
    contractGeneration: envelope.contractGeneration,
    finalizationResult,
    finalizationState,
    ...(hasOwn(value, 'finalizationScenarioContext')
      ? {
          finalizationScenarioContext: parsedScenarioContext,
        }
      : {}),
  };
}

export function parseFinalizationStorageEnvelope(value: unknown): ParsedFinalizationStorageEnvelope | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!hasOnlyAllowedKeys(value, FINALIZATION_STORAGE_PAYLOAD_KEYS)) {
    return undefined;
  }

  const hasFinalizationResult = hasOwn(value, 'finalizationResult');
  const hasFinalizationState = hasOwn(value, 'finalizationState');
  const hasFinalizationScenarioContext = hasOwn(value, 'finalizationScenarioContext');
  if (!hasFinalizationResult && !hasFinalizationState && !hasFinalizationScenarioContext) {
    return undefined;
  }

  const contractGeneration = getStringProperty(value, 'contractGeneration');
  if (typeof contractGeneration !== 'string' || contractGeneration.trim().length === 0) {
    return undefined;
  }

  return {
    contractGeneration,
    hasFinalizationResult,
    hasFinalizationState,
    hasFinalizationScenarioContext,
  };
}
