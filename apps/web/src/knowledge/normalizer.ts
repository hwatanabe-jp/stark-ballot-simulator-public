import { getRecordProperty, isRecord } from '@stark-ballot/validation/unknown-value-guards';
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

function normalizeVerificationReportSummary(
  value: Record<string, unknown>,
): KnowledgeData['verification.reportSummary'] | undefined {
  const status = value['status'];
  const durationMs = value['duration_ms'];
  const errors = value['errors'];
  if (
    typeof status !== 'string' ||
    status.length === 0 ||
    (durationMs !== undefined &&
      (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0)) ||
    (errors !== undefined && (!Array.isArray(errors) || !errors.every((error) => typeof error === 'string')))
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
 * Normalize raw API keys; the knowledge store admits the resulting values
 *
 * Handles:
 * - Field name mappings (API payload -> knowledge keys)
 * - Nested object flattening (userVote.proof -> user.merklePath)
 */
export function normalizeKnowledgeData(raw: Record<string, unknown>): KnowledgeCandidate {
  const normalized: KnowledgeCandidate = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) {
      continue;
    }

    // Handle nested mappings
    if (key in NESTED_MAPPINGS) {
      const nestedMappings = NESTED_MAPPINGS[key];
      if (!nestedMappings || !isRecord(value)) {
        continue;
      }
      const nestedObj = value;

      for (const [nestedKey, targetKey] of Object.entries(nestedMappings)) {
        const nestedValue = nestedObj[nestedKey];
        if (nestedValue !== undefined && nestedValue !== null) {
          normalized[targetKey] = nestedValue;
        }
      }

      // Handle proof inside userVote
      if (key === 'userVote' && isRecord(nestedObj['proof'])) {
        const proof = nestedObj['proof'];
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
      const counts = normalizeTallyCounts(tally['counts']);
      if (counts) {
        normalized['tally.counts'] = counts;
      }
      if (tally['totalVotes'] !== undefined) {
        normalized['tally.totalVotes'] = tally['totalVotes'];
      }
      if (tally['tamperedCount'] !== undefined) {
        normalized['tally.tamperedCount'] = tally['tamperedCount'];
      }
      continue;
    }

    // Special handling for verificationSteps
    if (key === 'verificationSteps' && Array.isArray(value)) {
      normalized['verification.steps'] = value;
      continue;
    }

    // Special handling for verificationReport
    if (key === 'verificationReport' && isRecord(value)) {
      const summary = normalizeVerificationReportSummary(value);
      if (summary) {
        normalized['verification.reportSummary'] = summary;
      }
      continue;
    }

    // Special handling for voteReceipt (canonical fields only)
    if (key === 'voteReceipt' && isRecord(value)) {
      const receipt = value;
      const voteId = typeof receipt['voteId'] === 'string' ? receipt['voteId'] : undefined;
      const commitment = typeof receipt['commitment'] === 'string' ? receipt['commitment'] : undefined;
      const bulletinIndex = typeof receipt['bulletinIndex'] === 'number' ? receipt['bulletinIndex'] : undefined;
      const bulletinRootAtCast =
        typeof receipt['bulletinRootAtCast'] === 'string' ? receipt['bulletinRootAtCast'] : undefined;
      const castAtMs = typeof receipt['castAtMs'] === 'number' ? receipt['castAtMs'] : undefined;
      const inputCommitment = typeof receipt['inputCommitment'] === 'string' ? receipt['inputCommitment'] : undefined;

      if (
        voteId &&
        commitment &&
        typeof bulletinIndex === 'number' &&
        bulletinRootAtCast &&
        typeof castAtMs === 'number'
      ) {
        normalized['user.voteReceipt'] = {
          voteId,
          commitment,
          bulletinIndex,
          bulletinRootAtCast,
          timestamp: castAtMs,
          ...(inputCommitment ? { inputCommitment } : {}),
        } satisfies KnowledgeData['user.voteReceipt'];
      }
      continue;
    }

    // Apply mapping for primitive values
    if (isKnowledgeKey(canonicalKey)) {
      normalized[canonicalKey] = value;
    }
  }

  return {
    ...normalized,
    ...normalizeCanonicalJournalKnowledge(raw),
  };
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
