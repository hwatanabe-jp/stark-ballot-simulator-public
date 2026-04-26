import { getRecordProperty, isRecord } from '@/lib/utils/guards';
import { toCanonicalRfc6962Proof } from '@/lib/merkle/rfc6962-proof';
import { isSupportedZkVMJournal } from '@/lib/zkvm/journal-guards';
import type { KnowledgeData, InclusionProof } from './types';
import { KNOWLEDGE_KEYS } from './types';

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
  timestamp: 'user.voteTimestamp',
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
const KNOWLEDGE_KEY_SET = new Set(KNOWLEDGE_KEYS as readonly string[]);

function normalizeTallyCounts(value: unknown): KnowledgeData['tally.counts'] | undefined {
  if (!isRecord(value)) {
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

function normalizeCanonicalJournalKnowledge(raw: Record<string, unknown>): Partial<KnowledgeData> {
  const journalValue = getRecordProperty(raw, 'journal');
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

/**
 * Normalize raw API data to canonical KnowledgeData structure
 *
 * Handles:
 * - Field name mappings (API payload -> knowledge keys)
 * - Nested object flattening (userVote.proof -> user.merklePath)
 */
export function normalizeKnowledgeData(raw: Record<string, unknown>): Partial<KnowledgeData> {
  const normalized: Partial<KnowledgeData> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) {
      continue;
    }

    // Handle nested mappings
    if (key in NESTED_MAPPINGS) {
      const nestedMappings = NESTED_MAPPINGS[key];
      const nestedObj = value as Record<string, unknown>;

      for (const [nestedKey, targetKey] of Object.entries(nestedMappings)) {
        const nestedValue = nestedObj[nestedKey];
        if (nestedValue !== undefined && nestedValue !== null) {
          (normalized as Record<string, unknown>)[targetKey] = nestedValue;
        }
      }

      // Handle proof inside userVote
      if (key === 'userVote' && nestedObj.proof) {
        const proof = nestedObj.proof as Record<string, unknown>;
        const normalizedProof = normalizeInclusionProof(proof);
        if (normalizedProof) {
          normalized['user.merklePath'] = normalizedProof;
        }
      }

      continue;
    }

    // Handle direct field mappings
    const canonicalKey = normalizeFieldName(key);

    // Special handling for proof objects
    if (key === 'proof' && isRecord(value) && 'leafIndex' in value) {
      const normalizedProof = normalizeInclusionProof(value);
      if (normalizedProof) {
        normalized['user.merklePath'] = normalizedProof;
      }
      continue;
    }

    // Special handling for tally object
    if (key === 'tally' && isRecord(value)) {
      const tally = value;
      const counts = normalizeTallyCounts(tally.counts);
      if (counts) {
        normalized['tally.counts'] = counts;
      }
      if (tally.totalVotes !== undefined) {
        normalized['tally.totalVotes'] = tally.totalVotes as number;
      }
      if (tally.tamperedCount !== undefined) {
        normalized['tally.tamperedCount'] = tally.tamperedCount as number;
      }
      continue;
    }

    // Special handling for verificationSteps
    if (key === 'verificationSteps' && Array.isArray(value)) {
      normalized['verification.steps'] = value as KnowledgeData['verification.steps'];
      continue;
    }

    // Special handling for verificationReport
    if (key === 'verificationReport' && isRecord(value)) {
      normalized['verification.reportSummary'] = value as unknown as KnowledgeData['verification.reportSummary'];
      continue;
    }

    // Special handling for voteReceipt (canonical fields only)
    if (key === 'voteReceipt' && isRecord(value)) {
      const receipt = value;
      const voteId = typeof receipt.voteId === 'string' ? receipt.voteId : undefined;
      const commitment = typeof receipt.commitment === 'string' ? receipt.commitment : undefined;
      const bulletinIndex = typeof receipt.bulletinIndex === 'number' ? receipt.bulletinIndex : undefined;
      const bulletinRootAtCast =
        typeof receipt.bulletinRootAtCast === 'string' ? receipt.bulletinRootAtCast : undefined;
      const timestamp = typeof receipt.timestamp === 'number' ? receipt.timestamp : undefined;
      const inputCommitment = typeof receipt.inputCommitment === 'string' ? receipt.inputCommitment : undefined;

      if (
        voteId &&
        commitment &&
        typeof bulletinIndex === 'number' &&
        bulletinRootAtCast &&
        typeof timestamp === 'number'
      ) {
        normalized['user.voteReceipt'] = {
          voteId,
          commitment,
          bulletinIndex,
          bulletinRootAtCast,
          timestamp,
          ...(inputCommitment ? { inputCommitment } : {}),
        } satisfies KnowledgeData['user.voteReceipt'];
      }
      continue;
    }

    // Apply mapping for primitive values
    if (KNOWLEDGE_KEY_SET.has(canonicalKey)) {
      (normalized as Record<string, unknown>)[canonicalKey] = value;
    }
  }

  return {
    ...normalized,
    ...normalizeCanonicalJournalKnowledge(raw),
  };
}

/**
 * Normalize bot data from /api/botdata/:id response
 */
export function normalizeBotData(raw: Record<string, unknown>): Partial<KnowledgeData> {
  const normalized: Partial<KnowledgeData> = {};

  if (raw.id !== undefined) {
    normalized['bot.id'] = raw.id as number;
    normalized['bot.bulletinIndex'] = raw.id as number; // botId === bulletinIndex
  }
  if (raw.vote !== undefined) {
    normalized['bot.choice'] = raw.vote as KnowledgeData['bot.choice'];
  }
  if (raw.random !== undefined) {
    normalized['bot.random'] = raw.random as string;
  }
  if (raw.commitment !== undefined) {
    normalized['bot.commitment'] = raw.commitment as string;
  }
  if (raw.voteId !== undefined) {
    normalized['bot.voteId'] = raw.voteId as string;
  }
  if (raw.timestamp !== undefined) {
    normalized['bot.voteTimestamp'] = raw.timestamp as number;
  }
  if (raw.proof && typeof raw.proof === 'object') {
    const proof = raw.proof as Record<string, unknown>;
    const normalizedProof = normalizeInclusionProof(proof);
    if (normalizedProof) {
      normalized['bot.merklePath'] = normalizedProof;
      normalized['bot.bulletinRootAtCast'] = normalizedProof.bulletinRootAtCast;
    }
  }

  return normalized;
}

/**
 * Get phase for a given knowledge key
 */
export function getPhaseForKey(key: keyof KnowledgeData): string {
  if (key === 'sessionId' || key === 'electionId' || key === 'electionConfigHash' || key === 'logId') {
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

  if (
    key.startsWith('tally.') ||
    key === 'scenarioId' ||
    key === 'missingSlots' ||
    key === 'invalidPresentedSlots' ||
    key === 'rejectedRecords' ||
    key === 'validVotes' ||
    key === 'excludedSlots' ||
    key === 'totalExpected' ||
    key === 'bulletinRoot' ||
    key === 'treeSize' ||
    key === 'sthDigest' ||
    key === 'seenBitmapRoot' ||
    key === 'includedBitmapRoot' ||
    key === 'inputCommitment' ||
    key === 'imageId' ||
    key === 'receiptPublication' ||
    key === 'proofBundleStatus'
  ) {
    return 'result';
  }

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
