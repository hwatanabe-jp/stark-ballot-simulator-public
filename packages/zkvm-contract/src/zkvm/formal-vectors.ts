import {
  requireContractString as requireString,
  requireExactContractKeys,
  requireContractRecord as requireRecord,
  canonicalContractJson,
} from './contract-values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { CURRENT_METHOD_VERSION, INPUT_COMMITMENT_FORMAT_VERSION, UINT32_MAX, VERIFIED_TALLY_WIDTH } from './types';
import {
  MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
  MAX_GUEST_SERIALIZED_INPUT_BYTES,
  MAX_GUEST_TOTAL_EXPECTED,
  MAX_GUEST_TOTAL_PATH_NODES,
  MAX_GUEST_TREE_SIZE,
  MAX_GUEST_VOTE_COUNT,
} from './work-budget';

export const CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE = 'stark-ballot.formal-vector.current' as const;

export const FORMAL_VECTOR_KINDS = [
  'verification-summary-cases',
  'verification-display-cases',
  'check-definitions',
  'input-commitment-cases',
  'bitmap-cases',
  'guest-model-cases',
] as const;

export type FormalVectorKind = (typeof FORMAL_VECTOR_KINDS)[number];

export interface FormalVectorModeledBounds {
  inputCommitment: {
    formatVersion: number;
    u16Max: number;
    u32Max: number;
  };
  guest: {
    methodVersion: number;
    treeSizeMax: number;
    totalExpectedMax: number;
    voteCountMax: number;
    merklePathNodesPerRecordMax: number;
    totalMerklePathNodesMax: number;
    serializedInputBytesMax: number;
    tallyWidth: number;
    tallyBucketMax: number;
  };
}

export type FormalCheckStatus = 'success' | 'not_run' | 'pending' | 'running' | 'failed';

export type FormalVerificationCheckId =
  | 'cast_receipt_present'
  | 'cast_choice_range'
  | 'cast_random_format'
  | 'cast_commitment_match'
  | 'recorded_commitment_in_bulletin'
  | 'recorded_index_in_range'
  | 'recorded_root_at_cast_consistent'
  | 'recorded_inclusion_proof'
  | 'recorded_consistency_proof'
  | 'recorded_sth_third_party'
  | 'counted_input_sanity'
  | 'counted_unique_indices'
  | 'counted_unique_commitments'
  | 'counted_tally_consistent'
  | 'counted_missing_indices_zero'
  | 'counted_expected_vs_tree_size'
  | 'counted_election_manifest_consistent'
  | 'counted_close_statement_consistent'
  | 'counted_my_vote_included'
  | 'counted_input_commitment_match'
  | 'stark_image_id_match'
  | 'stark_receipt_verify';

export interface FormalVerificationSummaryCase {
  name: string;
  context: { sthSourcesConfigured: boolean };
  checkStatuses: Partial<Record<FormalVerificationCheckId, FormalCheckStatus>>;
  omitChecks: FormalVerificationCheckId[];
  extraKnownChecks: Array<{ id: FormalVerificationCheckId; status: FormalCheckStatus }>;
  extraUnknownChecks: Array<{ id: string; status: FormalCheckStatus }>;
  expectedStatus:
    | 'fully_verified'
    | 'in_progress'
    | 'missing_evidence'
    | 'verified_with_limitations'
    | 'user_vote_excluded'
    | 'votes_excluded'
    | 'votes_excluded_unknown'
    | 'recorded_integrity_failed'
    | 'published_tally_mismatch'
    | 'counted_integrity_failed'
    | 'cast_integrity_failed'
    | 'proof_verification_failed';
  expectedTone: 'verified' | 'warning' | 'failed';
}

export interface FormalVerificationDisplayCase {
  name: string;
  verificationStarted: boolean;
  sequenceComplete: boolean;
  hasCheckPending: boolean;
  explicitServerFailureStatus: 'failed' | 'warning' | null;
  summaryTone: 'verified' | 'warning' | 'failed' | null;
  hasVerificationChecks: boolean;
  hardFailureDetected: boolean;
  expectedOverrideSource: 'explicit_server_failure' | 'summary' | 'hard_failure' | 'pending' | null;
  expectedOverrideStatus: 'verified' | 'failed' | 'warning' | null;
  expectedRenderedStatus: 'verified' | 'failed' | 'warning' | null;
}

export interface FormalCheckDefinition {
  id: FormalVerificationCheckId;
  category: 'cast_as_intended' | 'recorded_as_cast' | 'counted_as_recorded' | 'stark_verification';
  role:
    | 'proof_verification'
    | 'cast_receipt_integrity'
    | 'recorded_inclusion'
    | 'recorded_append_only'
    | 'tally_input_integrity'
    | 'tally_completeness'
    | 'user_inclusion'
    | 'tally_consistency'
    | 'optional_external_audit';
  criticality: 'required' | 'optional';
  requiredWhenSthSourcesConfigured: boolean;
  requiredWhenSthSourcesNotConfigured: boolean;
}

export interface FormalInputCommitmentVote {
  id: string;
  index: number;
  commitment: string;
  merklePath: string[];
}

export interface FormalInputCommitmentCase {
  name: string;
  electionId: string;
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;
  votes: FormalInputCommitmentVote[];
  expectedCanonicalOrder: string[];
  expectedEncodedBytesHex: string;
}

export interface FormalBitmapProbe {
  bitIndex: number;
  byteIndex: number;
  bitIndexInByte: number;
  expectedValue: boolean;
}

export interface FormalBitmapCase {
  name: string;
  bitLength: number;
  trueIndices: number[];
  expectedPackedByteLength: number;
  expectedPackedBytesHex: string;
  probes: FormalBitmapProbe[];
}

export type FormalGuestRejectionReason =
  | 'out_of_range_index'
  | 'duplicate_index'
  | 'invalid_choice'
  | 'invalid_commitment'
  | 'duplicate_commitment'
  | 'invalid_inclusion_proof';

export interface FormalGuestVote {
  id: string;
  index: number;
  choice: number;
  randomByte: number;
  commitment: number;
  commitmentOk: boolean;
  inclusionOk: boolean;
}

export interface FormalGuestOutcome {
  accepted: boolean;
  reason: FormalGuestRejectionReason | null;
  slotSeen: boolean;
  commitmentReserved: boolean;
}

export interface FormalGuestModelCase {
  name: string;
  treeSize: number;
  votes: FormalGuestVote[];
  expectedOutcomes: FormalGuestOutcome[];
  expectedSeenIndicesCount: number;
  expectedMissingSlots: number;
  expectedInvalidPresentedSlots: number;
  expectedRejectedRecords: number;
  expectedRejectionReasons: FormalGuestRejectionReason[];
  expectedExcludedSlots: number;
  expectedValidVotes: number;
  expectedTally: [number, number, number, number, number];
  expectedIncludedBitmapTrueIndices: number[];
}

interface FormalVectorPayloads {
  'verification-summary-cases': FormalVerificationSummaryCase[];
  'verification-display-cases': FormalVerificationDisplayCase[];
  'check-definitions': FormalCheckDefinition[];
  'input-commitment-cases': FormalInputCommitmentCase[];
  'bitmap-cases': FormalBitmapCase[];
  'guest-model-cases': FormalGuestModelCase[];
}

export interface CurrentFormalVectorEnvelope<K extends FormalVectorKind> {
  envelopeType: typeof CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE;
  kind: K;
  modeledBounds: FormalVectorModeledBounds;
  payload: FormalVectorPayloads[K];
  canonicalSha256: string;
}

type AnyFormalVectorEnvelope = {
  [K in FormalVectorKind]: CurrentFormalVectorEnvelope<K>;
}[FormalVectorKind];

const CHECK_STATUSES = new Set<FormalCheckStatus>(['success', 'not_run', 'pending', 'running', 'failed']);
const CHECK_IDS = new Set<FormalVerificationCheckId>([
  'cast_receipt_present',
  'cast_choice_range',
  'cast_random_format',
  'cast_commitment_match',
  'recorded_commitment_in_bulletin',
  'recorded_index_in_range',
  'recorded_root_at_cast_consistent',
  'recorded_inclusion_proof',
  'recorded_consistency_proof',
  'recorded_sth_third_party',
  'counted_input_sanity',
  'counted_unique_indices',
  'counted_unique_commitments',
  'counted_tally_consistent',
  'counted_missing_indices_zero',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'counted_my_vote_included',
  'counted_input_commitment_match',
  'stark_image_id_match',
  'stark_receipt_verify',
]);
const SUMMARY_STATUSES = new Set<FormalVerificationSummaryCase['expectedStatus']>([
  'fully_verified',
  'in_progress',
  'missing_evidence',
  'verified_with_limitations',
  'user_vote_excluded',
  'votes_excluded',
  'votes_excluded_unknown',
  'recorded_integrity_failed',
  'published_tally_mismatch',
  'counted_integrity_failed',
  'cast_integrity_failed',
  'proof_verification_failed',
]);
const SUMMARY_TONES = new Set<FormalVerificationSummaryCase['expectedTone']>(['verified', 'warning', 'failed']);
const DISPLAY_STATUSES = new Set<Exclude<FormalVerificationDisplayCase['expectedOverrideStatus'], null>>([
  'verified',
  'warning',
  'failed',
]);
const EXPLICIT_SERVER_FAILURE_STATUSES = new Set<
  Exclude<FormalVerificationDisplayCase['explicitServerFailureStatus'], null>
>(['warning', 'failed']);
const DISPLAY_SOURCES = new Set<Exclude<FormalVerificationDisplayCase['expectedOverrideSource'], null>>([
  'explicit_server_failure',
  'summary',
  'hard_failure',
  'pending',
]);
const CHECK_CATEGORIES = new Set<FormalCheckDefinition['category']>([
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
]);
const CHECK_ROLES = new Set<FormalCheckDefinition['role']>([
  'proof_verification',
  'cast_receipt_integrity',
  'recorded_inclusion',
  'recorded_append_only',
  'tally_input_integrity',
  'tally_completeness',
  'user_inclusion',
  'tally_consistency',
  'optional_external_audit',
]);
const CHECK_CRITICALITIES = new Set<FormalCheckDefinition['criticality']>(['required', 'optional']);
const GUEST_REJECTION_REASONS = new Set<FormalGuestRejectionReason>([
  'out_of_range_index',
  'duplicate_index',
  'invalid_choice',
  'invalid_commitment',
  'duplicate_commitment',
  'invalid_inclusion_proof',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const HEX32_PATTERN = /^0x[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EVEN_HEX_PATTERN = /^(?:[0-9a-f]{2})*$/u;

function fail(label: string, message: string): never {
  throw new Error(`${label} ${message}`);
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  requireExactContractKeys(record, keys, label, 'current formal vector contract');
}

function requireBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    fail(`${label}.${key}`, 'must be a boolean');
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, label: string, max = UINT32_MAX): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    fail(`${label}.${key}`, `must be an integer in 0..${max}`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(label, 'must be an array');
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, admitted: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !admitted.has(value as T)) {
    fail(label, 'contains an unsupported value');
  }
  return value as T;
}

function requireNullableEnum<T extends string>(value: unknown, admitted: ReadonlySet<T>, label: string): T | null {
  return value === null ? null : requireEnum(value, admitted, label);
}

function parseStringArray(value: unknown, label: string, pattern?: RegExp): string[] {
  return requireArray(value, label).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || (pattern && !pattern.test(entry))) {
      fail(`${label}[${index}]`, 'must be an admitted string');
    }
    return entry;
  });
}

function parseIntegerArray(value: unknown, label: string, max = UINT32_MAX): number[] {
  return requireArray(value, label).map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0 || entry > max) {
      fail(`${label}[${index}]`, `must be an integer in 0..${max}`);
    }
    return entry;
  });
}

function parseNamedArray<T>(value: unknown, label: string, parse: (entry: unknown, label: string) => T): T[] {
  const entries = requireArray(value, label);
  if (entries.length === 0) {
    fail(label, 'must contain at least one entry');
  }
  return entries.map((entry, index) => parse(entry, `${label}[${index}]`));
}

function parseModeledBounds(value: unknown): FormalVectorModeledBounds {
  const bounds = requireRecord(value, 'formal vector.modeledBounds');
  requireExactKeys(bounds, ['inputCommitment', 'guest'], 'formal vector.modeledBounds');
  const inputCommitment = requireRecord(bounds['inputCommitment'], 'formal vector.modeledBounds.inputCommitment');
  requireExactKeys(
    inputCommitment,
    ['formatVersion', 'u16Max', 'u32Max'],
    'formal vector.modeledBounds.inputCommitment',
  );
  const guest = requireRecord(bounds['guest'], 'formal vector.modeledBounds.guest');
  requireExactKeys(
    guest,
    [
      'methodVersion',
      'treeSizeMax',
      'totalExpectedMax',
      'voteCountMax',
      'merklePathNodesPerRecordMax',
      'totalMerklePathNodesMax',
      'serializedInputBytesMax',
      'tallyWidth',
      'tallyBucketMax',
    ],
    'formal vector.modeledBounds.guest',
  );

  const parsed: FormalVectorModeledBounds = {
    inputCommitment: {
      formatVersion: requireInteger(inputCommitment, 'formatVersion', 'formal vector.modeledBounds.inputCommitment'),
      u16Max: requireInteger(inputCommitment, 'u16Max', 'formal vector.modeledBounds.inputCommitment'),
      u32Max: requireInteger(inputCommitment, 'u32Max', 'formal vector.modeledBounds.inputCommitment'),
    },
    guest: {
      methodVersion: requireInteger(guest, 'methodVersion', 'formal vector.modeledBounds.guest'),
      treeSizeMax: requireInteger(guest, 'treeSizeMax', 'formal vector.modeledBounds.guest'),
      totalExpectedMax: requireInteger(guest, 'totalExpectedMax', 'formal vector.modeledBounds.guest'),
      voteCountMax: requireInteger(guest, 'voteCountMax', 'formal vector.modeledBounds.guest'),
      merklePathNodesPerRecordMax: requireInteger(
        guest,
        'merklePathNodesPerRecordMax',
        'formal vector.modeledBounds.guest',
      ),
      totalMerklePathNodesMax: requireInteger(guest, 'totalMerklePathNodesMax', 'formal vector.modeledBounds.guest'),
      serializedInputBytesMax: requireInteger(guest, 'serializedInputBytesMax', 'formal vector.modeledBounds.guest'),
      tallyWidth: requireInteger(guest, 'tallyWidth', 'formal vector.modeledBounds.guest'),
      tallyBucketMax: requireInteger(guest, 'tallyBucketMax', 'formal vector.modeledBounds.guest'),
    },
  };

  const expected: FormalVectorModeledBounds = {
    inputCommitment: {
      formatVersion: INPUT_COMMITMENT_FORMAT_VERSION,
      u16Max: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
      u32Max: UINT32_MAX,
    },
    guest: {
      methodVersion: CURRENT_METHOD_VERSION,
      treeSizeMax: MAX_GUEST_TREE_SIZE,
      totalExpectedMax: MAX_GUEST_TOTAL_EXPECTED,
      voteCountMax: MAX_GUEST_VOTE_COUNT,
      merklePathNodesPerRecordMax: MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
      totalMerklePathNodesMax: MAX_GUEST_TOTAL_PATH_NODES,
      serializedInputBytesMax: MAX_GUEST_SERIALIZED_INPUT_BYTES,
      tallyWidth: VERIFIED_TALLY_WIDTH,
      tallyBucketMax: MAX_GUEST_TREE_SIZE,
    },
  };
  if (canonicalContractJson(parsed, 'formal vector') !== canonicalContractJson(expected, 'formal vector')) {
    fail('formal vector.modeledBounds', 'does not match the current TypeScript contract constants');
  }
  return parsed;
}

function parseCheckStatusMap(
  value: unknown,
  label: string,
): Partial<Record<FormalVerificationCheckId, FormalCheckStatus>> {
  const record = requireRecord(value, label);
  const parsed: Partial<Record<FormalVerificationCheckId, FormalCheckStatus>> = {};
  for (const [key, status] of Object.entries(record)) {
    const id = requireEnum(key, CHECK_IDS, `${label} key`);
    parsed[id] = requireEnum(status, CHECK_STATUSES, `${label}.${key}`);
  }
  return parsed;
}

function parseKnownCheckStatus(
  value: unknown,
  label: string,
): { id: FormalVerificationCheckId; status: FormalCheckStatus } {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['id', 'status'], label);
  return {
    id: requireEnum(record['id'], CHECK_IDS, `${label}.id`),
    status: requireEnum(record['status'], CHECK_STATUSES, `${label}.status`),
  };
}

function parseUnknownCheckStatus(value: unknown, label: string): { id: string; status: FormalCheckStatus } {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['id', 'status'], label);
  return {
    id: requireString(record, 'id', label),
    status: requireEnum(record['status'], CHECK_STATUSES, `${label}.status`),
  };
}

function parseSummaryCase(value: unknown, label: string): FormalVerificationSummaryCase {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    [
      'name',
      'context',
      'checkStatuses',
      'omitChecks',
      'extraKnownChecks',
      'extraUnknownChecks',
      'expectedStatus',
      'expectedTone',
    ],
    label,
  );
  const context = requireRecord(record['context'], `${label}.context`);
  requireExactKeys(context, ['sthSourcesConfigured'], `${label}.context`);
  return {
    name: requireString(record, 'name', label),
    context: { sthSourcesConfigured: requireBoolean(context, 'sthSourcesConfigured', `${label}.context`) },
    checkStatuses: parseCheckStatusMap(record['checkStatuses'], `${label}.checkStatuses`),
    omitChecks: requireArray(record['omitChecks'], `${label}.omitChecks`).map((entry, index) =>
      requireEnum(entry, CHECK_IDS, `${label}.omitChecks[${index}]`),
    ),
    extraKnownChecks: requireArray(record['extraKnownChecks'], `${label}.extraKnownChecks`).map((entry, index) =>
      parseKnownCheckStatus(entry, `${label}.extraKnownChecks[${index}]`),
    ),
    extraUnknownChecks: requireArray(record['extraUnknownChecks'], `${label}.extraUnknownChecks`).map((entry, index) =>
      parseUnknownCheckStatus(entry, `${label}.extraUnknownChecks[${index}]`),
    ),
    expectedStatus: requireEnum(record['expectedStatus'], SUMMARY_STATUSES, `${label}.expectedStatus`),
    expectedTone: requireEnum(record['expectedTone'], SUMMARY_TONES, `${label}.expectedTone`),
  };
}

function parseDisplayCase(value: unknown, label: string): FormalVerificationDisplayCase {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    [
      'name',
      'verificationStarted',
      'sequenceComplete',
      'hasCheckPending',
      'explicitServerFailureStatus',
      'summaryTone',
      'hasVerificationChecks',
      'hardFailureDetected',
      'expectedOverrideSource',
      'expectedOverrideStatus',
      'expectedRenderedStatus',
    ],
    label,
  );
  return {
    name: requireString(record, 'name', label),
    verificationStarted: requireBoolean(record, 'verificationStarted', label),
    sequenceComplete: requireBoolean(record, 'sequenceComplete', label),
    hasCheckPending: requireBoolean(record, 'hasCheckPending', label),
    explicitServerFailureStatus: requireNullableEnum(
      record['explicitServerFailureStatus'],
      EXPLICIT_SERVER_FAILURE_STATUSES,
      `${label}.explicitServerFailureStatus`,
    ),
    summaryTone: requireNullableEnum(record['summaryTone'], SUMMARY_TONES, `${label}.summaryTone`),
    hasVerificationChecks: requireBoolean(record, 'hasVerificationChecks', label),
    hardFailureDetected: requireBoolean(record, 'hardFailureDetected', label),
    expectedOverrideSource: requireNullableEnum(
      record['expectedOverrideSource'],
      DISPLAY_SOURCES,
      `${label}.expectedOverrideSource`,
    ),
    expectedOverrideStatus: requireNullableEnum(
      record['expectedOverrideStatus'],
      DISPLAY_STATUSES,
      `${label}.expectedOverrideStatus`,
    ),
    expectedRenderedStatus: requireNullableEnum(
      record['expectedRenderedStatus'],
      DISPLAY_STATUSES,
      `${label}.expectedRenderedStatus`,
    ),
  };
}

function parseCheckDefinition(value: unknown, label: string): FormalCheckDefinition {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    [
      'id',
      'category',
      'role',
      'criticality',
      'requiredWhenSthSourcesConfigured',
      'requiredWhenSthSourcesNotConfigured',
    ],
    label,
  );
  return {
    id: requireEnum(record['id'], CHECK_IDS, `${label}.id`),
    category: requireEnum(record['category'], CHECK_CATEGORIES, `${label}.category`),
    role: requireEnum(record['role'], CHECK_ROLES, `${label}.role`),
    criticality: requireEnum(record['criticality'], CHECK_CRITICALITIES, `${label}.criticality`),
    requiredWhenSthSourcesConfigured: requireBoolean(record, 'requiredWhenSthSourcesConfigured', label),
    requiredWhenSthSourcesNotConfigured: requireBoolean(record, 'requiredWhenSthSourcesNotConfigured', label),
  };
}

function parseInputCommitmentVote(value: unknown, label: string): FormalInputCommitmentVote {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['id', 'index', 'commitment', 'merklePath'], label);
  const commitment = requireString(record, 'commitment', label);
  if (!HEX32_PATTERN.test(commitment)) {
    fail(`${label}.commitment`, 'must be a lowercase 32-byte hex value');
  }
  return {
    id: requireString(record, 'id', label),
    index: requireInteger(record, 'index', label),
    commitment,
    merklePath: parseStringArray(record['merklePath'], `${label}.merklePath`, HEX32_PATTERN),
  };
}

function parseInputCommitmentCase(value: unknown, label: string): FormalInputCommitmentCase {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    [
      'name',
      'electionId',
      'bulletinRoot',
      'treeSize',
      'totalExpected',
      'votes',
      'expectedCanonicalOrder',
      'expectedEncodedBytesHex',
    ],
    label,
  );
  const electionId = requireString(record, 'electionId', label);
  const bulletinRoot = requireString(record, 'bulletinRoot', label);
  const expectedEncodedBytesHex = requireString(record, 'expectedEncodedBytesHex', label);
  if (!UUID_PATTERN.test(electionId)) fail(`${label}.electionId`, 'must be a lowercase UUID');
  if (!HEX32_PATTERN.test(bulletinRoot)) fail(`${label}.bulletinRoot`, 'must be a lowercase 32-byte hex value');
  if (!EVEN_HEX_PATTERN.test(expectedEncodedBytesHex)) {
    fail(`${label}.expectedEncodedBytesHex`, 'must be lowercase byte hex');
  }
  return {
    name: requireString(record, 'name', label),
    electionId,
    bulletinRoot,
    treeSize: requireInteger(record, 'treeSize', label),
    totalExpected: requireInteger(record, 'totalExpected', label),
    votes: parseNamedArray(record['votes'], `${label}.votes`, parseInputCommitmentVote),
    expectedCanonicalOrder: parseStringArray(record['expectedCanonicalOrder'], `${label}.expectedCanonicalOrder`),
    expectedEncodedBytesHex,
  };
}

function parseBitmapProbe(value: unknown, label: string): FormalBitmapProbe {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['bitIndex', 'byteIndex', 'bitIndexInByte', 'expectedValue'], label);
  return {
    bitIndex: requireInteger(record, 'bitIndex', label),
    byteIndex: requireInteger(record, 'byteIndex', label),
    bitIndexInByte: requireInteger(record, 'bitIndexInByte', label, 7),
    expectedValue: requireBoolean(record, 'expectedValue', label),
  };
}

function parseBitmapCase(value: unknown, label: string): FormalBitmapCase {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    ['name', 'bitLength', 'trueIndices', 'expectedPackedByteLength', 'expectedPackedBytesHex', 'probes'],
    label,
  );
  const expectedPackedBytesHex = record['expectedPackedBytesHex'];
  if (typeof expectedPackedBytesHex !== 'string' || !EVEN_HEX_PATTERN.test(expectedPackedBytesHex)) {
    fail(`${label}.expectedPackedBytesHex`, 'must be lowercase byte hex');
  }
  return {
    name: requireString(record, 'name', label),
    bitLength: requireInteger(record, 'bitLength', label),
    trueIndices: parseIntegerArray(record['trueIndices'], `${label}.trueIndices`),
    expectedPackedByteLength: requireInteger(record, 'expectedPackedByteLength', label),
    expectedPackedBytesHex,
    probes: requireArray(record['probes'], `${label}.probes`).map((entry, index) =>
      parseBitmapProbe(entry, `${label}.probes[${index}]`),
    ),
  };
}

function parseGuestVote(value: unknown, label: string): FormalGuestVote {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['id', 'index', 'choice', 'randomByte', 'commitment', 'commitmentOk', 'inclusionOk'], label);
  return {
    id: requireString(record, 'id', label),
    index: requireInteger(record, 'index', label),
    choice: requireInteger(record, 'choice', label, 255),
    randomByte: requireInteger(record, 'randomByte', label, 255),
    commitment: requireInteger(record, 'commitment', label, 255),
    commitmentOk: requireBoolean(record, 'commitmentOk', label),
    inclusionOk: requireBoolean(record, 'inclusionOk', label),
  };
}

function parseGuestOutcome(value: unknown, label: string): FormalGuestOutcome {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['accepted', 'reason', 'slotSeen', 'commitmentReserved'], label);
  const accepted = requireBoolean(record, 'accepted', label);
  const reason = requireNullableEnum(record['reason'], GUEST_REJECTION_REASONS, `${label}.reason`);
  if (accepted !== (reason === null)) {
    fail(label, 'must pair accepted=true with reason=null and rejected outcomes with a reason');
  }
  return {
    accepted,
    reason,
    slotSeen: requireBoolean(record, 'slotSeen', label),
    commitmentReserved: requireBoolean(record, 'commitmentReserved', label),
  };
}

function parseGuestModelCase(value: unknown, label: string): FormalGuestModelCase {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    [
      'name',
      'treeSize',
      'votes',
      'expectedOutcomes',
      'expectedSeenIndicesCount',
      'expectedMissingSlots',
      'expectedInvalidPresentedSlots',
      'expectedRejectedRecords',
      'expectedRejectionReasons',
      'expectedExcludedSlots',
      'expectedValidVotes',
      'expectedTally',
      'expectedIncludedBitmapTrueIndices',
    ],
    label,
  );
  const expectedTally = parseIntegerArray(record['expectedTally'], `${label}.expectedTally`);
  if (expectedTally.length !== VERIFIED_TALLY_WIDTH) {
    fail(`${label}.expectedTally`, `must contain exactly ${VERIFIED_TALLY_WIDTH} buckets`);
  }
  const reasons = requireArray(record['expectedRejectionReasons'], `${label}.expectedRejectionReasons`).map(
    (entry, index) => requireEnum(entry, GUEST_REJECTION_REASONS, `${label}.expectedRejectionReasons[${index}]`),
  );
  return {
    name: requireString(record, 'name', label),
    treeSize: requireInteger(record, 'treeSize', label),
    votes: parseNamedArray(record['votes'], `${label}.votes`, parseGuestVote),
    expectedOutcomes: parseNamedArray(record['expectedOutcomes'], `${label}.expectedOutcomes`, parseGuestOutcome),
    expectedSeenIndicesCount: requireInteger(record, 'expectedSeenIndicesCount', label),
    expectedMissingSlots: requireInteger(record, 'expectedMissingSlots', label),
    expectedInvalidPresentedSlots: requireInteger(record, 'expectedInvalidPresentedSlots', label),
    expectedRejectedRecords: requireInteger(record, 'expectedRejectedRecords', label),
    expectedRejectionReasons: reasons,
    expectedExcludedSlots: requireInteger(record, 'expectedExcludedSlots', label),
    expectedValidVotes: requireInteger(record, 'expectedValidVotes', label),
    expectedTally: [
      requireArrayIndex(expectedTally, 0, `${label}.expectedTally`),
      requireArrayIndex(expectedTally, 1, `${label}.expectedTally`),
      requireArrayIndex(expectedTally, 2, `${label}.expectedTally`),
      requireArrayIndex(expectedTally, 3, `${label}.expectedTally`),
      requireArrayIndex(expectedTally, 4, `${label}.expectedTally`),
    ],
    expectedIncludedBitmapTrueIndices: parseIntegerArray(
      record['expectedIncludedBitmapTrueIndices'],
      `${label}.expectedIncludedBitmapTrueIndices`,
    ),
  };
}

function requireArrayIndex(values: number[], index: number, label: string): number {
  const value = values[index];
  if (value === undefined) fail(`${label}[${index}]`, 'is required');
  return value;
}

function canonicalSha256(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalContractJson(value, 'formal vector'))));
}

interface ParsedEnvelopeHead {
  record: Record<string, unknown>;
  modeledBounds: FormalVectorModeledBounds;
  canonicalSha256: string;
}

function parseEnvelopeHead(value: unknown, expectedKind: FormalVectorKind): ParsedEnvelopeHead {
  const record = requireRecord(value, 'formal vector');
  requireExactKeys(record, ['envelopeType', 'kind', 'modeledBounds', 'payload', 'canonicalSha256'], 'formal vector');
  if (record['envelopeType'] !== CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE) {
    fail('formal vector.envelopeType', 'must identify the repository-owned current envelope');
  }
  if (record['kind'] !== expectedKind) {
    fail('formal vector.kind', `must be ${expectedKind}`);
  }
  const fingerprint = requireString(record, 'canonicalSha256', 'formal vector');
  if (!SHA256_PATTERN.test(fingerprint)) {
    fail('formal vector.canonicalSha256', 'must be a lowercase SHA-256');
  }
  return { record, modeledBounds: parseModeledBounds(record['modeledBounds']), canonicalSha256: fingerprint };
}

function verifyFingerprint(head: ParsedEnvelopeHead, payload: unknown): void {
  const expectedFingerprint = canonicalSha256({
    envelopeType: CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE,
    kind: head.record['kind'],
    modeledBounds: head.record['modeledBounds'],
    payload,
  });
  if (head.canonicalSha256 !== expectedFingerprint) {
    fail('formal vector.canonicalSha256', 'does not match the canonical envelope content');
  }
}

export function parseCurrentFormalVectorEnvelope(
  value: unknown,
  expectedKind: 'verification-summary-cases',
): CurrentFormalVectorEnvelope<'verification-summary-cases'>;
export function parseCurrentFormalVectorEnvelope(
  value: unknown,
  expectedKind: 'verification-display-cases',
): CurrentFormalVectorEnvelope<'verification-display-cases'>;
export function parseCurrentFormalVectorEnvelope(
  value: unknown,
  expectedKind: 'check-definitions',
): CurrentFormalVectorEnvelope<'check-definitions'>;
export function parseCurrentFormalVectorEnvelope(
  value: unknown,
  expectedKind: 'input-commitment-cases',
): CurrentFormalVectorEnvelope<'input-commitment-cases'>;
export function parseCurrentFormalVectorEnvelope(
  value: unknown,
  expectedKind: 'bitmap-cases',
): CurrentFormalVectorEnvelope<'bitmap-cases'>;
export function parseCurrentFormalVectorEnvelope(
  value: unknown,
  expectedKind: 'guest-model-cases',
): CurrentFormalVectorEnvelope<'guest-model-cases'>;
export function parseCurrentFormalVectorEnvelope(
  value: unknown,
  expectedKind: FormalVectorKind,
): AnyFormalVectorEnvelope {
  const head = parseEnvelopeHead(value, expectedKind);
  const rawPayload = head.record['payload'];
  switch (expectedKind) {
    case 'verification-summary-cases': {
      const payload = parseNamedArray(rawPayload, 'formal vector.payload', parseSummaryCase);
      verifyFingerprint(head, rawPayload);
      return {
        envelopeType: CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE,
        kind: expectedKind,
        modeledBounds: head.modeledBounds,
        payload,
        canonicalSha256: head.canonicalSha256,
      };
    }
    case 'verification-display-cases': {
      const payload = parseNamedArray(rawPayload, 'formal vector.payload', parseDisplayCase);
      verifyFingerprint(head, rawPayload);
      return {
        envelopeType: CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE,
        kind: expectedKind,
        modeledBounds: head.modeledBounds,
        payload,
        canonicalSha256: head.canonicalSha256,
      };
    }
    case 'check-definitions': {
      const payload = parseNamedArray(rawPayload, 'formal vector.payload', parseCheckDefinition);
      verifyFingerprint(head, rawPayload);
      return {
        envelopeType: CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE,
        kind: expectedKind,
        modeledBounds: head.modeledBounds,
        payload,
        canonicalSha256: head.canonicalSha256,
      };
    }
    case 'input-commitment-cases': {
      const payload = parseNamedArray(rawPayload, 'formal vector.payload', parseInputCommitmentCase);
      verifyFingerprint(head, rawPayload);
      return {
        envelopeType: CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE,
        kind: expectedKind,
        modeledBounds: head.modeledBounds,
        payload,
        canonicalSha256: head.canonicalSha256,
      };
    }
    case 'bitmap-cases': {
      const payload = parseNamedArray(rawPayload, 'formal vector.payload', parseBitmapCase);
      verifyFingerprint(head, rawPayload);
      return {
        envelopeType: CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE,
        kind: expectedKind,
        modeledBounds: head.modeledBounds,
        payload,
        canonicalSha256: head.canonicalSha256,
      };
    }
    case 'guest-model-cases': {
      const payload = parseNamedArray(rawPayload, 'formal vector.payload', parseGuestModelCase);
      verifyFingerprint(head, rawPayload);
      return {
        envelopeType: CURRENT_FORMAL_VECTOR_ENVELOPE_TYPE,
        kind: expectedKind,
        modeledBounds: head.modeledBounds,
        payload,
        canonicalSha256: head.canonicalSha256,
      };
    }
  }
}
