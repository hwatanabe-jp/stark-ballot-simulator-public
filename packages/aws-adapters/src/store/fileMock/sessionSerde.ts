import { parseRootSnapshotFields } from '../root-snapshot-admission';
import {
  isNonArrayObject as isRecord,
  hasExactOwnKeys as hasExactKeys,
  isNonNegativeSafeInteger,
} from '@stark-ballot/validation/unknown-value-guards';
import type { FinalizationBitmapRecord } from '@stark-ballot/application/finalize/finalization-store';
import { finalizationBitmapDataCodec } from '@stark-ballot/application/finalize/finalization-storage';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import {
  finalizationRecordCodec,
  type FinalizationRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import { admitSuccessfulFinalizationReceipt } from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import {
  parseVerificationResultRecord,
  type VerificationResultRecord,
} from '@stark-ballot/application/finalize/finalization-result-store';
import type { AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type { AwsFinalizationRuntimeMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type {
  RootSnapshot,
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
  UserParticipation,
} from '@stark-ballot/domain/types/sessionRecords';
import { parseSessionIdentityRecord } from '@stark-ballot/domain/types/sessionRecords';
import { parseSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import {
  parseVerificationObservation,
  type VerificationObservation,
} from '@stark-ballot/domain/types/verificationObservation';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import type {
  AwsDeliveryMetadataRecord,
  AwsRuntimeMetadataRecord,
  FileStoreSnapshot,
  ReceiptRecord,
  SerializableSessionVotingRecord,
  VerificationObservationRecord,
} from './types';
import { computeSuccessfulFinalizationReceiptHash } from '../successfulFinalizationReceipt';

export interface FileStoreState {
  identityRecords: Map<string, SessionIdentityRecord>;
  votingRecords: Map<string, SessionVotingRecord>;
  finalizationRecords: Map<string, FinalizationRecord>;
  currentFinalizationIdBySession: Map<string, FinalizationId>;
  verificationResultRecords: Map<string, VerificationResultRecord>;
  verificationObservationRecords: Map<string, VerificationObservation>;
  bitmapRecords: Map<string, FinalizationBitmapRecord>;
  voteIdIndex: Map<string, { sessionId: SessionId; index: number }>;
  runtimeMetadataRecords: Map<string, AwsFinalizationRuntimeMetadata>;
  deliveryMetadataRecords: Map<string, AwsVerificationDeliveryMetadataInput>;
  receiptRecords: Map<string, ReceiptRecord>;
  receiptCounter: number;
}

const SNAPSHOT_KEYS = new Set([
  'identities',
  'voting',
  'finalizations',
  'currentFinalizationIds',
  'verificationResults',
  'verificationObservations',
  'bitmaps',
  'voteIdIndex',
  'runtimeMetadata',
  'deliveryMetadata',
  'receipts',
  'receiptCounter',
]);
const SERIALIZED_VOTING_KEYS = new Set([
  'sessionId',
  'votes',
  'bulletinRootHistory',
  'botCount',
  'userParticipation',
  'lastActivityMs',
]);
const STORED_VOTE_KEYS = new Set(['voteId', 'vote', 'rand', 'commit', 'timestamp', 'rootAtCast']);
const NOT_CAST_KEYS = new Set(['status']);
const CAST_KEYS = new Set(['status', 'voteIndex']);
const RUNTIME_METADATA_KEYS = new Set(['sessionId', 'finalizationId', 'stepFunctionsArn', 'bundleMetadata']);
const BUNDLE_METADATA_KEYS = new Set(['s3BundleKey', 's3UploadedAtMs']);
const DELIVERY_METADATA_KEYS = new Set([
  'sessionId',
  'finalizationId',
  's3BundleKey',
  's3ReportKey',
  's3UploadedAtMs',
  'verificationWorkQueuedAtMs',
]);
const RECEIPT_KEYS = new Set(['sessionId', 'finalizationId', 'receiptHash', 'boardIndex', 'receipt']);
const OBSERVATION_RECORD_KEYS = new Set(['sessionId', 'finalizationId', 'fingerprint', 'observedAt']);
const VOTE_CHOICES = new Set(['A', 'B', 'C', 'D', 'E']);
const SHA256_PATTERN = /^(?:0x)?[0-9a-f]{64}$/;
const PREFIXED_SHA256_PATTERN = /^0x[0-9a-f]{64}$/;
const INITIAL_RECEIPT_COUNTER = 100;

function scopedKey(sessionId: string, finalizationId: string): string {
  return `${sessionId}\u0000${finalizationId}`;
}

function hasOnlyAllowedKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isExactRecord(value: unknown, keys: ReadonlySet<string>): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function isScopedMetadata(
  value: unknown,
  keys: ReadonlySet<string>,
): value is Record<string, unknown> & { sessionId: string; finalizationId: string } {
  return (
    isRecord(value) &&
    hasOnlyAllowedKeys(value, keys) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['finalizationId'] === 'string'
  );
}

function isPrefixedSha256(value: unknown): value is string {
  return typeof value === 'string' && PREFIXED_SHA256_PATTERN.test(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeSafeInteger(value);
}

function parseStoredVote(value: unknown): StoredVoteRecord | undefined {
  if (!isExactRecord(value, STORED_VOTE_KEYS)) {
    return undefined;
  }
  const voteId = value['voteId'];
  const vote = value['vote'];
  const rand = value['rand'];
  const commit = value['commit'];
  const timestamp = value['timestamp'];
  const rootAtCast = value['rootAtCast'];
  if (
    typeof voteId !== 'string' ||
    typeof vote !== 'string' ||
    !VOTE_CHOICES.has(vote) ||
    typeof rand !== 'string' ||
    !isPrefixedSha256(commit) ||
    !isNonNegativeSafeInteger(timestamp) ||
    !isPrefixedSha256(rootAtCast)
  ) {
    return undefined;
  }
  return {
    voteId,
    vote: vote as StoredVoteRecord['vote'],
    rand,
    commit,
    timestamp,
    rootAtCast,
  };
}

function parseUserParticipation(
  value: unknown,
  votes: ReadonlyMap<number, StoredVoteRecord>,
): UserParticipation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value['status'] === 'not_cast' && hasExactKeys(value, NOT_CAST_KEYS) && votes.size === 0) {
    return { status: 'not_cast' };
  }
  if (value['status'] === 'cast' && hasExactKeys(value, CAST_KEYS) && value['voteIndex'] === 0 && votes.has(0)) {
    return { status: 'cast', voteIndex: 0 };
  }
  return undefined;
}

function parseRootSnapshot(value: unknown, expectedRoot: string, expectedTreeSize: number): RootSnapshot | undefined {
  const fields = parseRootSnapshotFields(value);
  if (!fields) {
    return undefined;
  }
  const { timestamp, root, treeSize, signature } = fields;
  if (
    !SHA256_PATTERN.test(root) ||
    treeSize !== expectedTreeSize ||
    normalizeHex(root, { allowEmpty: true }) !== expectedRoot
  ) {
    return undefined;
  }
  return {
    timestamp,
    root,
    treeSize,
    ...(typeof signature === 'string' ? { signature } : {}),
  };
}

function restoreBulletinVotes(serializedVotes: readonly unknown[], logId: string) {
  const votes = new Map<number, StoredVoteRecord>();
  const bulletin = new SimpleBulletinBoard(logId);
  const expectedRoots: string[] = [];
  for (const [expectedIndex, entry] of serializedVotes.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2 || entry[0] !== expectedIndex) {
      return undefined;
    }
    const vote = parseStoredVote(entry[1]);
    if (!vote || votes.has(expectedIndex)) {
      return undefined;
    }
    try {
      const append = bulletin.appendVote(vote.voteId, vote.commit.slice(2));
      const expectedRoot = normalizeHex(append.rootAtAppend, { allowEmpty: true });
      if (normalizeHex(vote.rootAtCast, { allowEmpty: true }) !== expectedRoot) {
        return undefined;
      }
      expectedRoots.push(expectedRoot);
    } catch {
      return undefined;
    }
    votes.set(expectedIndex, vote);
  }

  return { votes, bulletin, expectedRoots };
}

function restoreRootHistory(
  serializedHistory: readonly unknown[],
  votes: ReadonlyMap<number, StoredVoteRecord>,
  expectedRoots: readonly string[],
): RootSnapshot[] | undefined {
  if (serializedHistory.length !== votes.size) {
    return undefined;
  }
  const bulletinRootHistory: RootSnapshot[] = [];
  for (const [index, serializedSnapshot] of serializedHistory.entries()) {
    const expectedRoot = expectedRoots[index];
    if (!expectedRoot) {
      return undefined;
    }
    const snapshot = parseRootSnapshot(serializedSnapshot, expectedRoot, index + 1);
    if (!snapshot || snapshot.timestamp !== votes.get(index)?.timestamp) {
      return undefined;
    }
    bulletinRootHistory.push(snapshot);
  }

  return bulletinRootHistory;
}

type VotingEnvelope = Pick<SerializableSessionVotingRecord, 'sessionId' | 'botCount' | 'lastActivityMs'> & {
  votes: unknown[];
  bulletinRootHistory: unknown[];
  userParticipation: unknown;
};

function isVotingEnvelope(value: unknown): value is VotingEnvelope {
  return (
    isExactRecord(value, SERIALIZED_VOTING_KEYS) &&
    typeof value['sessionId'] === 'string' &&
    Array.isArray(value['votes']) &&
    Array.isArray(value['bulletinRootHistory']) &&
    isNonNegativeSafeInteger(value['botCount']) &&
    isNonNegativeSafeInteger(value['lastActivityMs'])
  );
}

function parseVotingRecord(value: unknown, identity: SessionIdentityRecord): SessionVotingRecord | undefined {
  if (!isVotingEnvelope(value) || value['sessionId'] !== identity.sessionId) {
    return undefined;
  }
  const serializedVotes = value['votes'];
  const serializedHistory = value['bulletinRootHistory'];
  const botCount = value['botCount'];
  const lastActivityMs = value['lastActivityMs'];
  const restored = restoreBulletinVotes(serializedVotes, identity.logId);
  if (!restored) {
    return undefined;
  }
  const { votes, bulletin, expectedRoots } = restored;
  const bulletinRootHistory = restoreRootHistory(serializedHistory, votes, expectedRoots);
  if (!bulletinRootHistory) {
    return undefined;
  }

  const userParticipation = parseUserParticipation(value['userParticipation'], votes);
  const expectedBotCount = votes.size === 0 ? 0 : votes.size - 1;
  if (!userParticipation || botCount !== expectedBotCount) {
    return undefined;
  }
  return {
    sessionId: identity.sessionId,
    votes,
    bulletin,
    bulletinRootHistory,
    botCount,
    userParticipation,
    lastActivityMs,
  };
}

function parseBitmap(value: unknown): FinalizationBitmapRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sessionId = parseSessionId(value['sessionId']);
  const finalizationId = parseFinalizationId(value['finalizationId']);
  const { sessionId: _sessionId, finalizationId: _finalizationId, ...bitmapValue } = value;
  void _sessionId;
  void _finalizationId;
  const bitmap = finalizationBitmapDataCodec.decode(bitmapValue);
  if (!sessionId || !finalizationId || !bitmap) {
    return undefined;
  }
  return {
    sessionId,
    finalizationId,
    ...bitmap,
  };
}

function isBundleMetadata(value: unknown): value is NonNullable<AwsFinalizationRuntimeMetadata['bundleMetadata']> {
  return (
    isRecord(value) &&
    hasOnlyAllowedKeys(value, BUNDLE_METADATA_KEYS) &&
    isOptionalString(value['s3BundleKey']) &&
    isOptionalTimestamp(value['s3UploadedAtMs'])
  );
}

function copyBundleMetadata(value: NonNullable<AwsFinalizationRuntimeMetadata['bundleMetadata']>) {
  return {
    ...(typeof value.s3BundleKey === 'string' ? { s3BundleKey: value.s3BundleKey } : {}),
    ...(typeof value.s3UploadedAtMs === 'number' ? { s3UploadedAtMs: value.s3UploadedAtMs } : {}),
  };
}

function parseRuntimeMetadata(value: unknown): AwsRuntimeMetadataRecord | undefined {
  if (!isScopedMetadata(value, RUNTIME_METADATA_KEYS)) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const finalizationId = value['finalizationId'];
  const stepFunctionsArn = value['stepFunctionsArn'];
  const bundleMetadata = value['bundleMetadata'];
  if (!isOptionalString(stepFunctionsArn) || (bundleMetadata !== undefined && !isBundleMetadata(bundleMetadata))) {
    return undefined;
  }
  return {
    sessionId,
    finalizationId,
    ...(typeof stepFunctionsArn === 'string' ? { stepFunctionsArn } : {}),
    ...(bundleMetadata !== undefined ? { bundleMetadata: copyBundleMetadata(bundleMetadata) } : {}),
  };
}

function isDeliveryMetadata(value: unknown): value is AwsDeliveryMetadataRecord {
  return (
    isScopedMetadata(value, DELIVERY_METADATA_KEYS) &&
    isOptionalString(value['s3BundleKey']) &&
    isOptionalString(value['s3ReportKey']) &&
    isOptionalTimestamp(value['s3UploadedAtMs']) &&
    isOptionalTimestamp(value['verificationWorkQueuedAtMs'])
  );
}

function parseDeliveryMetadata(value: unknown): AwsDeliveryMetadataRecord | undefined {
  if (!isDeliveryMetadata(value)) {
    return undefined;
  }
  const { sessionId, finalizationId, s3BundleKey, s3ReportKey, s3UploadedAtMs, verificationWorkQueuedAtMs } = value;
  return {
    sessionId,
    finalizationId,
    ...(typeof s3BundleKey === 'string' ? { s3BundleKey } : {}),
    ...(typeof s3ReportKey === 'string' ? { s3ReportKey } : {}),
    ...(typeof s3UploadedAtMs === 'number' ? { s3UploadedAtMs } : {}),
    ...(typeof verificationWorkQueuedAtMs === 'number' ? { verificationWorkQueuedAtMs } : {}),
  };
}

function parseReceiptPayload(value: Record<string, unknown>) {
  try {
    return admitSuccessfulFinalizationReceipt(value);
  } catch {
    return undefined;
  }
}

function parseReceipt(value: unknown): ReceiptRecord | undefined {
  if (!isExactRecord(value, RECEIPT_KEYS) || !isRecord(value['receipt'])) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const finalizationId = value['finalizationId'];
  const receiptHash = value['receiptHash'];
  const boardIndex = value['boardIndex'];
  const receipt = parseReceiptPayload(value['receipt']);
  if (
    typeof sessionId !== 'string' ||
    typeof finalizationId !== 'string' ||
    !isPrefixedSha256(receiptHash) ||
    !isNonNegativeSafeInteger(boardIndex) ||
    !receipt ||
    receiptHash !== computeSuccessfulFinalizationReceiptHash(receipt)
  ) {
    return undefined;
  }
  return {
    sessionId,
    finalizationId,
    receiptHash,
    boardIndex,
    receipt,
  };
}

function parseObservationRecord(value: unknown): VerificationObservationRecord | undefined {
  if (!isExactRecord(value, OBSERVATION_RECORD_KEYS)) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  if (typeof sessionId !== 'string') {
    return undefined;
  }
  const observation = parseVerificationObservation(value);
  if (observation) {
    return { sessionId, ...observation };
  }
  const { sessionId: _sessionId, ...observationValue } = value;
  void _sessionId;
  const parsed = parseVerificationObservation(observationValue);
  return parsed ? { sessionId, ...parsed } : undefined;
}

function addUnique<T>(map: Map<string, T>, key: string, value: T): boolean {
  if (map.has(key)) {
    return false;
  }
  map.set(key, value);
  return true;
}

export function createEmptyFileStoreState(): FileStoreState {
  return {
    identityRecords: new Map(),
    votingRecords: new Map(),
    finalizationRecords: new Map(),
    currentFinalizationIdBySession: new Map(),
    verificationResultRecords: new Map(),
    verificationObservationRecords: new Map(),
    bitmapRecords: new Map(),
    voteIdIndex: new Map(),
    runtimeMetadataRecords: new Map(),
    deliveryMetadataRecords: new Map(),
    receiptRecords: new Map(),
    receiptCounter: INITIAL_RECEIPT_COUNTER,
  };
}

// Populate a temporary state in dependency order; the caller discards it on any admission failure.
function loadSessionRecords(
  state: FileStoreState,
  identities: readonly unknown[],
  voting: readonly unknown[],
): boolean {
  for (const rawIdentity of identities) {
    const identity = parseSessionIdentityRecord(rawIdentity);
    if (!identity || !addUnique(state.identityRecords, identity.sessionId, identity)) {
      return false;
    }
  }
  return loadVotingRecords(state, voting);
}

function loadVotingRecords(state: FileStoreState, voting: readonly unknown[]): boolean {
  for (const rawVoting of voting) {
    if (!isRecord(rawVoting) || typeof rawVoting['sessionId'] !== 'string') {
      return false;
    }
    const identity = state.identityRecords.get(rawVoting['sessionId']);
    const record = identity ? parseVotingRecord(rawVoting, identity) : undefined;
    if (!record || !addUnique(state.votingRecords, record.sessionId, record)) {
      return false;
    }
  }
  if (
    state.identityRecords.size !== state.votingRecords.size ||
    Array.from(state.identityRecords.keys()).some((sessionId) => !state.votingRecords.has(sessionId))
  ) {
    return false;
  }

  return true;
}

function loadFinalizationRecords(
  state: FileStoreState,
  finalizations: readonly unknown[],
  currentFinalizationIds: readonly unknown[],
): boolean {
  for (const rawFinalization of finalizations) {
    const record = finalizationRecordCodec.decode(rawFinalization);
    if (
      !record ||
      !state.identityRecords.has(record.sessionId) ||
      !addUnique(state.finalizationRecords, scopedKey(record.sessionId, record.finalizationId), record)
    ) {
      return false;
    }
  }
  return loadCurrentFinalizationIds(state, currentFinalizationIds);
}

function isStringPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}

function loadCurrentFinalizationIds(state: FileStoreState, currentFinalizationIds: readonly unknown[]): boolean {
  for (const entry of currentFinalizationIds) {
    if (
      !isStringPair(entry) ||
      state.currentFinalizationIdBySession.has(entry[0]) ||
      !state.finalizationRecords.has(scopedKey(entry[0], entry[1]))
    ) {
      return false;
    }
    const identity = state.identityRecords.get(entry[0]);
    const finalizationId = parseFinalizationId(entry[1]);
    if (!identity || !finalizationId) {
      return false;
    }
    state.currentFinalizationIdBySession.set(identity.sessionId, finalizationId);
  }

  return true;
}

function loadVerificationResults(state: FileStoreState, verificationResults: readonly unknown[]): boolean {
  for (const rawVerification of verificationResults) {
    const record = parseVerificationResultRecord(rawVerification);
    const finalization = record
      ? state.finalizationRecords.get(scopedKey(record.sessionId, record.finalizationId))
      : undefined;
    if (
      !record ||
      finalization?.state.status !== 'succeeded' ||
      !addUnique(state.verificationResultRecords, scopedKey(record.sessionId, record.finalizationId), record)
    ) {
      return false;
    }
  }
  return true;
}

function loadVerificationObservations(state: FileStoreState, verificationObservations: readonly unknown[]): boolean {
  for (const rawObservation of verificationObservations) {
    const record = parseObservationRecord(rawObservation);
    if (
      !record ||
      state.currentFinalizationIdBySession.get(record.sessionId) !== record.finalizationId ||
      !addUnique(state.verificationObservationRecords, scopedKey(record.sessionId, record.finalizationId), {
        finalizationId: record.finalizationId,
        fingerprint: record.fingerprint,
        observedAt: record.observedAt,
      })
    ) {
      return false;
    }
  }
  return true;
}

function loadBitmaps(state: FileStoreState, bitmaps: readonly unknown[]): boolean {
  for (const rawBitmap of bitmaps) {
    const record = parseBitmap(rawBitmap);
    const finalization = record
      ? state.finalizationRecords.get(scopedKey(record.sessionId, record.finalizationId))
      : undefined;
    if (
      !record ||
      finalization?.state.status !== 'succeeded' ||
      !addUnique(state.bitmapRecords, scopedKey(record.sessionId, record.finalizationId), record)
    ) {
      return false;
    }
  }

  return true;
}

function deriveVoteIdIndex(state: FileStoreState) {
  const derivedVoteIdIndex = new Map<string, { sessionId: SessionId; index: number }>();
  for (const [sessionId, record] of state.votingRecords) {
    for (const [index, vote] of record.votes) {
      if (!addUnique(derivedVoteIdIndex, vote.voteId, { sessionId, index })) {
        return undefined;
      }
    }
  }
  return derivedVoteIdIndex;
}

function isVoteIndexEntry(value: unknown): value is [string, { sessionId: string; index: number }] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    isRecord(value[1]) &&
    hasExactKeys(value[1], new Set(['sessionId', 'index'])) &&
    typeof value[1]['sessionId'] === 'string' &&
    isNonNegativeSafeInteger(value[1]['index'])
  );
}

function loadVoteIndex(state: FileStoreState, voteIdIndex: readonly unknown[]): boolean {
  const derivedVoteIdIndex = deriveVoteIdIndex(state);
  if (!derivedVoteIdIndex) {
    return false;
  }
  for (const entry of voteIdIndex) {
    if (!isVoteIndexEntry(entry)) {
      return false;
    }
    const expected = derivedVoteIdIndex.get(entry[0]);
    if (
      !expected ||
      expected.sessionId !== entry[1]['sessionId'] ||
      expected.index !== entry[1]['index'] ||
      !addUnique(state.voteIdIndex, entry[0], {
        sessionId: expected.sessionId,
        index: entry[1]['index'],
      })
    ) {
      return false;
    }
  }
  if (state.voteIdIndex.size !== derivedVoteIdIndex.size) {
    return false;
  }

  return true;
}

function loadRuntimeMetadata(state: FileStoreState, runtimeMetadata: readonly unknown[]): boolean {
  for (const rawMetadata of runtimeMetadata) {
    const record = parseRuntimeMetadata(rawMetadata);
    if (
      !record ||
      !state.identityRecords.has(record.sessionId) ||
      !addUnique(state.runtimeMetadataRecords, scopedKey(record.sessionId, record.finalizationId), {
        ...(record.stepFunctionsArn ? { stepFunctionsArn: record.stepFunctionsArn } : {}),
        ...(record.bundleMetadata ? { bundleMetadata: { ...record.bundleMetadata } } : {}),
      })
    ) {
      return false;
    }
  }
  return true;
}

function deliveryMetadataValue(record: AwsDeliveryMetadataRecord): AwsVerificationDeliveryMetadataInput {
  return {
    ...(record.s3BundleKey ? { s3BundleKey: record.s3BundleKey } : {}),
    ...(record.s3ReportKey ? { s3ReportKey: record.s3ReportKey } : {}),
    ...(record.s3UploadedAtMs === undefined ? {} : { s3UploadedAtMs: record.s3UploadedAtMs }),
    ...(record.verificationWorkQueuedAtMs === undefined
      ? {}
      : { verificationWorkQueuedAtMs: record.verificationWorkQueuedAtMs }),
  };
}

function loadDeliveryMetadata(state: FileStoreState, deliveryMetadata: readonly unknown[]): boolean {
  for (const rawMetadata of deliveryMetadata) {
    const record = parseDeliveryMetadata(rawMetadata);
    if (
      !record ||
      !state.identityRecords.has(record.sessionId) ||
      !addUnique(
        state.deliveryMetadataRecords,
        scopedKey(record.sessionId, record.finalizationId),
        deliveryMetadataValue(record),
      )
    ) {
      return false;
    }
  }
  return true;
}

function receiptPublicationFor(state: FileStoreState, record: ReceiptRecord) {
  const finalization = state.finalizationRecords.get(scopedKey(record.sessionId, record.finalizationId));
  if (finalization?.state.status !== 'succeeded' || !finalization.finalizationResult) {
    return undefined;
  }
  const publication = finalization.finalizationResult.artifacts.receiptPublication;
  return publication.availability === 'available' ? publication.publication : undefined;
}

function loadReceiptPublications(state: FileStoreState, receipts: readonly unknown[], receiptCounter: number): boolean {
  let maximumBoardIndex = INITIAL_RECEIPT_COUNTER - 1;
  for (const rawReceipt of receipts) {
    const record = parseReceipt(rawReceipt);
    const publication = record ? receiptPublicationFor(state, record) : undefined;
    if (
      !record ||
      !publication ||
      publication.receiptHash !== record.receiptHash ||
      publication.boardIndex !== record.boardIndex ||
      !addUnique(state.receiptRecords, scopedKey(record.sessionId, record.finalizationId), record)
    ) {
      return false;
    }
    maximumBoardIndex = Math.max(maximumBoardIndex, record.boardIndex);
  }
  if (receiptCounter <= maximumBoardIndex) {
    return false;
  }
  return true;
}

type FileStoreEnvelope = {
  [Key in Exclude<keyof FileStoreSnapshot, 'receiptCounter'>]: unknown[];
} & { receiptCounter: number };

function isFileStoreEnvelope(value: unknown): value is FileStoreEnvelope {
  if (!isExactRecord(value, SNAPSHOT_KEYS)) {
    return false;
  }
  return (
    Array.from(SNAPSHOT_KEYS).every((key) => key === 'receiptCounter' || Array.isArray(value[key])) &&
    isNonNegativeSafeInteger(value['receiptCounter']) &&
    value['receiptCounter'] >= INITIAL_RECEIPT_COUNTER
  );
}

export function parseFileStoreSnapshot(value: unknown): FileStoreState | undefined {
  if (!isFileStoreEnvelope(value)) {
    return undefined;
  }
  const {
    identities,
    voting,
    finalizations,
    currentFinalizationIds,
    verificationResults,
    verificationObservations,
    bitmaps,
    voteIdIndex,
    runtimeMetadata,
    deliveryMetadata,
    receipts,
    receiptCounter,
  } = value;
  const state = createEmptyFileStoreState();
  if (
    !loadSessionRecords(state, identities, voting) ||
    !loadFinalizationRecords(state, finalizations, currentFinalizationIds) ||
    !loadVerificationResults(state, verificationResults) ||
    !loadVerificationObservations(state, verificationObservations) ||
    !loadBitmaps(state, bitmaps) ||
    !loadVoteIndex(state, voteIdIndex) ||
    !loadRuntimeMetadata(state, runtimeMetadata) ||
    !loadDeliveryMetadata(state, deliveryMetadata) ||
    !loadReceiptPublications(state, receipts, receiptCounter)
  ) {
    return undefined;
  }
  state.receiptCounter = receiptCounter;
  return state;
}

function sortedValues<T>(map: ReadonlyMap<string, T>): T[] {
  return Array.from(map.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function serializeVotingRecord(record: SessionVotingRecord): SerializableSessionVotingRecord {
  return {
    sessionId: record.sessionId,
    votes: Array.from(record.votes.entries())
      .sort(([left], [right]) => left - right)
      .map(([index, vote]) => [index, { ...vote }]),
    bulletinRootHistory: record.bulletinRootHistory.map((snapshot) => ({ ...snapshot })),
    botCount: record.botCount,
    userParticipation: { ...record.userParticipation },
    lastActivityMs: record.lastActivityMs,
  };
}

function serializeScopedMetadata<T extends object>(records: ReadonlyMap<string, T>) {
  return Array.from(records.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, metadata]) => {
      const separator = key.indexOf('\u0000');
      return {
        sessionId: key.slice(0, separator),
        finalizationId: key.slice(separator + 1),
        ...metadata,
      };
    });
}

export function serializeFileStoreState(state: FileStoreState): FileStoreSnapshot {
  return {
    identities: sortedValues(state.identityRecords).map((record) => ({
      ...record,
      electionConfig: {
        ...record.electionConfig,
        choices: [...record.electionConfig.choices],
      },
    })),
    voting: sortedValues(state.votingRecords).map(serializeVotingRecord),
    finalizations: sortedValues(state.finalizationRecords).map((record) => finalizationRecordCodec.encode(record)),
    currentFinalizationIds: Array.from(state.currentFinalizationIdBySession.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    verificationResults: sortedValues(state.verificationResultRecords),
    verificationObservations: Array.from(state.verificationObservationRecords.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, observation]) => {
        const separator = key.indexOf('\u0000');
        return {
          sessionId: key.slice(0, separator),
          ...observation,
        };
      }),
    bitmaps: sortedValues(state.bitmapRecords).map((bitmap) => ({
      sessionId: bitmap.sessionId,
      finalizationId: bitmap.finalizationId,
      ...finalizationBitmapDataCodec.encode(bitmap),
    })),
    voteIdIndex: Array.from(state.voteIdIndex.entries()).sort(([left], [right]) => left.localeCompare(right)),
    runtimeMetadata: serializeScopedMetadata(state.runtimeMetadataRecords).map((record) => ({
      ...record,
      ...(record.bundleMetadata ? { bundleMetadata: { ...record.bundleMetadata } } : {}),
    })),
    deliveryMetadata: serializeScopedMetadata(state.deliveryMetadataRecords),
    receipts: sortedValues(state.receiptRecords).map((record) => ({
      ...record,
      receipt: { ...record.receipt },
    })),
    receiptCounter: state.receiptCounter,
  };
}
