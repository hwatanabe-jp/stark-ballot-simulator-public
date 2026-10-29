import {
  getObjectProperty,
  getStringProperty,
  getStringArrayProperty,
  isNonNegativeSafeInteger,
  isNonNullObject,
} from '@stark-ballot/validation/unknown-value-guards';
import { toCanonicalRfc6962Proof } from '@stark-ballot/merkle/rfc6962-proof';
import { isSupportedZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import type { KnowledgeData, InclusionProof } from './types';
import { KNOWLEDGE_KEYS } from './types';

/** Normalized keys whose values still require the store's admission. */
export type KnowledgeCandidate = Partial<Record<keyof KnowledgeData, unknown>>;

/**
 * Field name mappings from API payloads to knowledge keys.
 */
const FIELD_MAPPINGS: Record<string, keyof KnowledgeData> = {
  // User vote fields (from API response)
  vote: 'user.choice',
  rand: 'user.random',
  commitment: 'user.commitment',
  voteId: 'user.voteId',
  bulletinIndex: 'user.bulletinIndex',
  bulletinRootAtCast: 'user.bulletinRootAtCast',
  castAtMs: 'user.castAtMs',
};

/**
 * Nested field paths that need flattening with scope prefix
 */
const NESTED_MAPPINGS: Record<string, Record<string, keyof KnowledgeData>> = {
  userVote: {
    vote: 'user.choice',
    commitment: 'user.commitment',
    random: 'user.random',
    voteId: 'user.voteId',
  },
  // Note: voteReceipt is NOT included here - it's handled separately to
  // validate and preserve the canonical object as user.voteReceipt.
};

/**
 * Normalize a single field name
 */
function normalizeFieldName(key: string): string {
  return FIELD_MAPPINGS[key] ?? key;
}

/**
 * Normalize inclusion proof fields
 */
function normalizeInclusionProof(proof: Record<string, unknown>): InclusionProof | null {
  const canonicalProof = toCanonicalRfc6962Proof(proof);
  if (!canonicalProof) {
    return null;
  }

  return canonicalProof;
}

const TALLY_KEYS = ['A', 'B', 'C', 'D', 'E'] as const;
const KNOWLEDGE_KEY_SET = new Set<string>(KNOWLEDGE_KEYS);

function isKnowledgeKey(value: string): value is keyof KnowledgeData {
  return KNOWLEDGE_KEY_SET.has(value);
}

function normalizeTallyCounts(value: unknown): KnowledgeData['tally.counts'] | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }

  const counts: Record<(typeof TALLY_KEYS)[number], number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
  };

  for (const key of TALLY_KEYS) {
    const entry = value[key];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return undefined;
    }
    counts[key] = entry;
  }

  return counts;
}

function normalizeVerificationReportSummary(
  value: Record<string, unknown>,
): KnowledgeData['verification.reportSummary'] | undefined {
  const status = value['status'];
  const durationMs = value['duration_ms'];
  const errors = getStringArrayProperty(value, 'errors');
  if (
    typeof status !== 'string' ||
    status.length === 0 ||
    (durationMs !== undefined && !isNonNegativeSafeInteger(durationMs)) ||
    (value['errors'] !== undefined && errors === undefined)
  ) {
    return undefined;
  }
  return {
    status,
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    ...(errors === undefined ? {} : { errors }),
  };
}

function normalizeCanonicalJournalKnowledge(raw: Record<string, unknown>): Partial<KnowledgeData> {
  const journalValue = getObjectProperty(raw, 'journal');
  if (!isSupportedZkVMJournal(journalValue)) {
    return {};
  }

  const journal = journalValue;
  const normalized: Partial<KnowledgeData> = {};

  normalized.bulletinRoot = journal.bulletinRoot;
  normalized.treeSize = journal.treeSize;
  normalized.totalExpected = journal.totalExpected;
  normalized.missingSlots = journal.missingSlots;
  normalized.invalidPresentedSlots = journal.invalidPresentedSlots;
  normalized.rejectedRecords = journal.rejectedRecords;
  normalized.validVotes = journal.validVotes;
  normalized.excludedSlots = journal.excludedSlots;
  normalized.sthDigest = journal.sthDigest;
  normalized.seenBitmapRoot = journal.seenBitmapRoot;
  normalized.includedBitmapRoot = journal.includedBitmapRoot;
  normalized.inputCommitment = journal.inputCommitment;

  return normalized;
}

function normalizeVoteReceipt(receipt: Record<string, unknown>): KnowledgeData['user.voteReceipt'] | undefined {
  const voteId = getStringProperty(receipt, 'voteId');
  const commitment = getStringProperty(receipt, 'commitment');
  const bulletinIndex = receipt['bulletinIndex'];
  const bulletinRootAtCast = getStringProperty(receipt, 'bulletinRootAtCast');
  const castAtMs = receipt['castAtMs'];
  const inputCommitment = getStringProperty(receipt, 'inputCommitment');

  if (voteId && commitment && typeof bulletinIndex === 'number' && bulletinRootAtCast && typeof castAtMs === 'number') {
    return {
      voteId,
      commitment,
      bulletinIndex,
      bulletinRootAtCast,
      timestamp: castAtMs,
      ...(inputCommitment ? { inputCommitment } : {}),
    } satisfies KnowledgeData['user.voteReceipt'];
  }
  return undefined;
}

function normalizeNestedKnowledge(key: string, value: unknown): KnowledgeCandidate {
  const mappings = NESTED_MAPPINGS[key];
  if (!mappings || !isNonNullObject(value)) return {};
  const normalized: KnowledgeCandidate = {};
  for (const [nestedKey, targetKey] of Object.entries(mappings)) {
    const nestedValue = value[nestedKey];
    if (nestedValue !== undefined && nestedValue !== null) normalized[targetKey] = nestedValue;
  }
  if (key === 'userVote' && isNonNullObject(value['proof'])) {
    const proof = normalizeInclusionProof(value['proof']);
    if (proof) normalized['user.merklePath'] = proof;
  }
  return normalized;
}

function normalizeTallyKnowledge(tally: Record<string, unknown>): KnowledgeCandidate {
  const normalized: KnowledgeCandidate = {};
  const counts = normalizeTallyCounts(tally['counts']);
  if (counts) normalized['tally.counts'] = counts;
  if (tally['totalVotes'] !== undefined) normalized['tally.totalVotes'] = tally['totalVotes'];
  if (tally['tamperedCount'] !== undefined) normalized['tally.tamperedCount'] = tally['tamperedCount'];
  return normalized;
}

function normalizeProofKnowledge(value: unknown): KnowledgeCandidate {
  if (!isNonNullObject(value) || !('leafIndex' in value)) return {};
  const proof = normalizeInclusionProof(value);
  return proof ? { 'user.merklePath': proof } : {};
}

function normalizeReportKnowledge(value: unknown): KnowledgeCandidate {
  if (!isNonNullObject(value)) return {};
  const summary = normalizeVerificationReportSummary(value);
  return summary ? { 'verification.reportSummary': summary } : {};
}

function normalizeReceiptKnowledge(value: unknown): KnowledgeCandidate {
  if (!isNonNullObject(value)) return {};
  const receipt = normalizeVoteReceipt(value);
  return receipt ? { 'user.voteReceipt': receipt } : {};
}

function normalizeStructuredKnowledge(key: string, value: unknown): KnowledgeCandidate | undefined {
  switch (key) {
    case 'proof':
      return normalizeProofKnowledge(value);
    case 'tally':
      return isNonNullObject(value) ? normalizeTallyKnowledge(value) : {};
    case 'verificationSteps':
      return Array.isArray(value) ? { 'verification.steps': value } : {};
    case 'verificationReport':
      return normalizeReportKnowledge(value);
    case 'voteReceipt':
      return normalizeReceiptKnowledge(value);
    default:
      return undefined;
  }
}

function normalizeKnowledgeField(key: string, value: unknown): KnowledgeCandidate {
  if (value === undefined || value === null) return {};
  if (key in NESTED_MAPPINGS) return normalizeNestedKnowledge(key, value);
  const structured = normalizeStructuredKnowledge(key, value);
  if (structured !== undefined) return structured;
  const canonicalKey = normalizeFieldName(key);
  return isKnowledgeKey(canonicalKey) ? { [canonicalKey]: value } : {};
}

/**
 * Normalize raw API keys; the knowledge store admits the resulting values
 *
 * Handles:
 * - Field name mappings (API payload -> knowledge keys)
 * - Nested object flattening (userVote.proof -> user.merklePath)
 */
export function normalizeKnowledgeData(raw: Record<string, unknown>): KnowledgeCandidate {
  const normalized: KnowledgeCandidate = {};
  // Preserve payload order for overlapping projections; the admitted journal wins last.
  for (const [key, value] of Object.entries(raw)) {
    Object.assign(normalized, normalizeKnowledgeField(key, value));
  }
  return { ...normalized, ...normalizeCanonicalJournalKnowledge(raw) };
}

/**
 * Get phase for a given knowledge key
 */
const RESULT_KNOWLEDGE_KEYS = new Set<keyof KnowledgeData>([
  'scenarioId',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'validVotes',
  'excludedSlots',
  'totalExpected',
  'bulletinRoot',
  'treeSize',
  'sthDigest',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'inputCommitment',
  'imageId',
  'receiptPublication',
  'proofBundleStatus',
]);

export function getPhaseForKey(key: keyof KnowledgeData): string {
  if (['sessionId', 'electionId', 'electionConfigHash', 'logId'].includes(key)) {
    return 'session';
  }

  if (
    key.startsWith('user.') &&
    !key.includes('Receipt') &&
    !key.includes('merklePath') &&
    !key.includes('verification')
  ) {
    return 'vote';
  }

  if (key === 'botVotesStatus') {
    return 'vote';
  }

  if (key.startsWith('tally.') || RESULT_KNOWLEDGE_KEYS.has(key)) return 'result';

  if (
    key.startsWith('verification.') ||
    key === 'user.voteReceipt' ||
    key === 'user.merklePath' ||
    key.startsWith('bot.')
  ) {
    return 'verify';
  }

  return 'session';
}
