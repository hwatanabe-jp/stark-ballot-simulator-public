import type { KnowledgeData, InclusionProof } from './types';
import { KNOWLEDGE_KEYS } from './types';
import { toCanonicalRfc6962Proof } from '@stark-ballot/merkle/rfc6962-proof';
import { isValidHexString } from '@stark-ballot/crypto-primitives';
import {
  isNonNullObject,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from '@stark-ballot/validation/unknown-value-guards';

const KNOWLEDGE_KEY_SET = new Set<string>(KNOWLEDGE_KEYS);
const STRING_KNOWLEDGE_KEYS = new Set<keyof KnowledgeData>([
  'sessionId',
  'electionId',
  'electionConfigHash',
  'logId',
  'user.random',
  'user.commitment',
  'user.voteId',
  'user.bulletinRootAtCast',
  'bulletinRoot',
  'sthDigest',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'inputCommitment',
  'imageId',
  'bot.random',
  'bot.commitment',
  'bot.voteId',
  'bot.bulletinRootAtCast',
]);
const COUNT_KNOWLEDGE_KEYS = new Set<keyof KnowledgeData>([
  'user.bulletinIndex',
  'user.castAtMs',
  'tally.totalVotes',
  'tally.tamperedCount',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'validVotes',
  'excludedSlots',
  'totalExpected',
  'treeSize',
  'bot.id',
  'bot.bulletinIndex',
  'bot.voteTimestamp',
]);
const VERIFICATION_STEP_IDS = new Set([
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
]);
const VERIFICATION_STEP_STATUSES = new Set(['pending', 'running', 'success', 'failed', 'not_run']);

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function hasCanonicalProofFields(value: Record<string, unknown>): value is Record<string, unknown> & InclusionProof {
  const leafIndex = value['leafIndex'];
  const treeSize = value['treeSize'];
  const merklePath = value['merklePath'];
  const bulletinRootAtCast = value['bulletinRootAtCast'];
  return (
    isNonNegativeSafeInteger(leafIndex) &&
    isPositiveSafeInteger(treeSize) &&
    leafIndex < treeSize &&
    Array.isArray(merklePath) &&
    merklePath.every((node) => typeof node === 'string' && isValidHexString(node, 32)) &&
    typeof bulletinRootAtCast === 'string' &&
    isValidHexString(bulletinRootAtCast, 32)
  );
}

function isCanonicalInclusionProof(value: unknown): boolean {
  if (!isNonNullObject(value) || !hasExactKeys(value, ['leafIndex', 'treeSize', 'merklePath', 'bulletinRootAtCast'])) {
    return false;
  }
  if (!hasCanonicalProofFields(value)) return false;
  const proof = toCanonicalRfc6962Proof(value);
  const merklePath = value['merklePath'];
  if (!proof) return false;
  return (
    proof.leafIndex === value['leafIndex'] &&
    proof.treeSize === value['treeSize'] &&
    proof.bulletinRootAtCast === value['bulletinRootAtCast'] &&
    proof.merklePath.length === merklePath.length &&
    proof.merklePath.every((node, index) => node === merklePath[index])
  );
}

function isVerificationStep(value: unknown): boolean {
  if (!isNonNullObject(value) || !hasExactKeys(value, ['id', 'status', 'inputs'], ['error'])) {
    return false;
  }
  return (
    typeof value['id'] === 'string' &&
    VERIFICATION_STEP_IDS.has(value['id']) &&
    typeof value['status'] === 'string' &&
    VERIFICATION_STEP_STATUSES.has(value['status']) &&
    isStringArray(value['inputs']) &&
    (value['error'] === undefined || typeof value['error'] === 'string')
  );
}

function isBotVotesStatus(value: unknown): boolean {
  if (value === 'pending' || value === 'completed') return true;
  if (!isNonNullObject(value) || !hasExactKeys(value, ['status'], ['total'])) return false;
  return (
    (value['status'] === 'pending' || value['status'] === 'completed') &&
    (value['total'] === undefined || isNonNegativeSafeInteger(value['total']))
  );
}

function isStoredTally(value: unknown): boolean {
  return (
    isNonNullObject(value) &&
    hasExactKeys(value, ['A', 'B', 'C', 'D', 'E']) &&
    Object.values(value).every(isNonNegativeSafeInteger)
  );
}

function isStoredVoteReceipt(value: unknown): boolean {
  if (
    !isNonNullObject(value) ||
    !hasExactKeys(
      value,
      ['voteId', 'commitment', 'bulletinIndex', 'bulletinRootAtCast', 'timestamp'],
      ['inputCommitment'],
    )
  )
    return false;
  return (
    ['voteId', 'commitment', 'bulletinRootAtCast'].every((key) => typeof value[key] === 'string') &&
    isNonNegativeSafeInteger(value['bulletinIndex']) &&
    isNonNegativeSafeInteger(value['timestamp']) &&
    (value['inputCommitment'] === undefined || typeof value['inputCommitment'] === 'string')
  );
}

function isStoredReceiptPublication(value: unknown): boolean {
  if (!isNonNullObject(value) || !hasExactKeys(value, ['receiptHash', 'boardIndex'], ['timestamp'])) return false;
  return (
    typeof value['receiptHash'] === 'string' &&
    isValidHexString(value['receiptHash'], 32) &&
    isNonNegativeSafeInteger(value['boardIndex']) &&
    (value['timestamp'] === undefined || isNonNegativeSafeInteger(value['timestamp']))
  );
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStoredReportSummary(value: unknown): boolean {
  if (!isNonNullObject(value) || !hasExactKeys(value, ['status'], ['duration_ms', 'errors'])) return false;
  return (
    typeof value['status'] === 'string' &&
    value['status'].length > 0 &&
    (value['duration_ms'] === undefined || isNonNegativeSafeInteger(value['duration_ms'])) &&
    (value['errors'] === undefined || isStringArray(value['errors']))
  );
}

function isStoredVerificationSteps(value: unknown): boolean {
  return Array.isArray(value) && value.every(isVerificationStep);
}

const STRUCTURED_KNOWLEDGE_VALIDATORS: Partial<Record<keyof KnowledgeData, (value: unknown) => boolean>> = {
  'user.choice': (value) => typeof value === 'string' && ['A', 'B', 'C', 'D', 'E'].includes(value),
  'bot.choice': (value) => typeof value === 'string' && ['A', 'B', 'C', 'D', 'E'].includes(value),
  scenarioId: (value) => typeof value === 'string' && ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].includes(value),
  proofBundleStatus: (value) => typeof value === 'string' && ['not_downloaded', 'downloaded'].includes(value),
  botVotesStatus: isBotVotesStatus,
  'tally.counts': isStoredTally,
  'user.merklePath': isCanonicalInclusionProof,
  'bot.merklePath': isCanonicalInclusionProof,
  'verification.steps': isStoredVerificationSteps,
  'bot.verification.steps': isStoredVerificationSteps,
  'user.voteReceipt': isStoredVoteReceipt,
  receiptPublication: isStoredReceiptPublication,
  'verification.reportSummary': isStoredReportSummary,
};

function isCurrentKnowledgeEntry(rawKey: string, entry: unknown): boolean {
  if (!KNOWLEDGE_KEY_SET.has(rawKey) || entry === null || entry === undefined) return false;
  const key = rawKey as keyof KnowledgeData;
  if (STRING_KNOWLEDGE_KEYS.has(key)) return typeof entry === 'string' && entry.length > 0;
  if (COUNT_KNOWLEDGE_KEYS.has(key)) return isNonNegativeSafeInteger(entry);
  return STRUCTURED_KNOWLEDGE_VALIDATORS[key]?.(entry) ?? true;
}

export function isCurrentKnowledgeData(value: unknown): value is Record<string, unknown> & KnowledgeData {
  return isNonNullObject(value) && Object.entries(value).every(([key, entry]) => isCurrentKnowledgeEntry(key, entry));
}
