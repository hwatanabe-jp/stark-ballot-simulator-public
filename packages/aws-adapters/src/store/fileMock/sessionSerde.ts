import type { FinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-store';
import {
  parseFinalizationRecord,
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
  currentFinalizationIdBySession: Map<string, string>;
  verificationResultRecords: Map<string, VerificationResultRecord>;
  verificationObservationRecords: Map<string, VerificationObservation>;
  bitmapRecords: Map<string, FinalizationBitmapData>;
  voteIdIndex: Map<string, { sessionId: string; index: number }>;
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
const ROOT_SNAPSHOT_KEYS = new Set(['timestamp', 'root', 'treeSize']);
const SIGNED_ROOT_SNAPSHOT_KEYS = new Set(['timestamp', 'root', 'treeSize', 'signature']);
const BITMAP_KEYS = new Set([
  'sessionId',
  'finalizationId',
  'includedBitmap',
  'includedBitmapRoot',
  'treeSize',
  'finalizedAtMs',
]);
const BITMAP_WITH_SEEN_KEYS = new Set([...BITMAP_KEYS, 'seenBitmap', 'seenBitmapRoot']);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasOnlyAllowedKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseStoredVote(value: unknown): StoredVoteRecord | undefined {
  if (!isRecord(value) || !hasExactKeys(value, STORED_VOTE_KEYS)) {
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
    typeof commit !== 'string' ||
    !PREFIXED_SHA256_PATTERN.test(commit) ||
    !isNonNegativeSafeInteger(timestamp) ||
    typeof rootAtCast !== 'string' ||
    !PREFIXED_SHA256_PATTERN.test(rootAtCast)
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
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, ROOT_SNAPSHOT_KEYS) && !hasExactKeys(value, SIGNED_ROOT_SNAPSHOT_KEYS))
  ) {
    return undefined;
  }
  const timestamp = value['timestamp'];
  const root = value['root'];
  const treeSize = value['treeSize'];
  const signature = value['signature'];
  if (
    !isNonNegativeSafeInteger(timestamp) ||
    typeof root !== 'string' ||
    !SHA256_PATTERN.test(root) ||
    treeSize !== expectedTreeSize ||
    normalizeHex(root, { allowEmpty: true }) !== expectedRoot ||
    (signature !== undefined && typeof signature !== 'string')
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

function parseVotingRecord(value: unknown, identity: SessionIdentityRecord): SessionVotingRecord | undefined {
  if (!isRecord(value) || !hasExactKeys(value, SERIALIZED_VOTING_KEYS) || value['sessionId'] !== identity.sessionId) {
    return undefined;
  }
  const serializedVotes = value['votes'];
  const serializedHistory = value['bulletinRootHistory'];
  const botCount = value['botCount'];
  const lastActivityMs = value['lastActivityMs'];
  if (
    !Array.isArray(serializedVotes) ||
    !Array.isArray(serializedHistory) ||
    !isNonNegativeSafeInteger(botCount) ||
    !isNonNegativeSafeInteger(lastActivityMs)
  ) {
    return undefined;
  }

  const votes = new Map<number, StoredVoteRecord>();
  const bulletin = new SimpleBulletinBoard(identity.logId);
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

function parseBitmap(value: unknown): FinalizationBitmapData | undefined {
  if (!isRecord(value) || (!hasExactKeys(value, BITMAP_KEYS) && !hasExactKeys(value, BITMAP_WITH_SEEN_KEYS))) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const finalizationId = value['finalizationId'];
  const includedBitmap = value['includedBitmap'];
  const includedBitmapRoot = value['includedBitmapRoot'];
  const seenBitmap = value['seenBitmap'];
  const seenBitmapRoot = value['seenBitmapRoot'];
  const treeSize = value['treeSize'];
  const finalizedAtMs = value['finalizedAtMs'];
  if (
    typeof sessionId !== 'string' ||
    typeof finalizationId !== 'string' ||
    !Array.isArray(includedBitmap) ||
    !includedBitmap.every((bit) => typeof bit === 'boolean') ||
    typeof includedBitmapRoot !== 'string' ||
    !SHA256_PATTERN.test(includedBitmapRoot) ||
    !isNonNegativeSafeInteger(treeSize) ||
    !isNonNegativeSafeInteger(finalizedAtMs) ||
    (seenBitmap !== undefined &&
      (!Array.isArray(seenBitmap) ||
        !seenBitmap.every((bit) => typeof bit === 'boolean') ||
        typeof seenBitmapRoot !== 'string' ||
        !SHA256_PATTERN.test(seenBitmapRoot))) ||
    (seenBitmap === undefined && seenBitmapRoot !== undefined)
  ) {
    return undefined;
  }
  return {
    sessionId,
    finalizationId,
    includedBitmap: [...includedBitmap],
    includedBitmapRoot,
    ...(Array.isArray(seenBitmap) && typeof seenBitmapRoot === 'string'
      ? { seenBitmap: [...seenBitmap] as boolean[], seenBitmapRoot }
      : {}),
    treeSize,
    finalizedAtMs,
  };
}

function parseRuntimeMetadata(value: unknown): AwsRuntimeMetadataRecord | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, RUNTIME_METADATA_KEYS)) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const finalizationId = value['finalizationId'];
  const stepFunctionsArn = value['stepFunctionsArn'];
  const bundleMetadata = value['bundleMetadata'];
  if (
    typeof sessionId !== 'string' ||
    typeof finalizationId !== 'string' ||
    (stepFunctionsArn !== undefined && typeof stepFunctionsArn !== 'string') ||
    (bundleMetadata !== undefined &&
      (!isRecord(bundleMetadata) ||
        !hasOnlyAllowedKeys(bundleMetadata, BUNDLE_METADATA_KEYS) ||
        (bundleMetadata['s3BundleKey'] !== undefined && typeof bundleMetadata['s3BundleKey'] !== 'string') ||
        (bundleMetadata['s3UploadedAtMs'] !== undefined &&
          !isNonNegativeSafeInteger(bundleMetadata['s3UploadedAtMs']))))
  ) {
    return undefined;
  }
  return {
    sessionId,
    finalizationId,
    ...(typeof stepFunctionsArn === 'string' ? { stepFunctionsArn } : {}),
    ...(isRecord(bundleMetadata)
      ? {
          bundleMetadata: {
            ...(typeof bundleMetadata['s3BundleKey'] === 'string'
              ? { s3BundleKey: bundleMetadata['s3BundleKey'] }
              : {}),
            ...(typeof bundleMetadata['s3UploadedAtMs'] === 'number'
              ? { s3UploadedAtMs: bundleMetadata['s3UploadedAtMs'] }
              : {}),
          },
        }
      : {}),
  };
}

function parseDeliveryMetadata(value: unknown): AwsDeliveryMetadataRecord | undefined {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, DELIVERY_METADATA_KEYS)) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const finalizationId = value['finalizationId'];
  const s3BundleKey = value['s3BundleKey'];
  const s3ReportKey = value['s3ReportKey'];
  const s3UploadedAtMs = value['s3UploadedAtMs'];
  const verificationWorkQueuedAtMs = value['verificationWorkQueuedAtMs'];
  if (
    typeof sessionId !== 'string' ||
    typeof finalizationId !== 'string' ||
    (s3BundleKey !== undefined && typeof s3BundleKey !== 'string') ||
    (s3ReportKey !== undefined && typeof s3ReportKey !== 'string') ||
    (s3UploadedAtMs !== undefined && !isNonNegativeSafeInteger(s3UploadedAtMs)) ||
    (verificationWorkQueuedAtMs !== undefined && !isNonNegativeSafeInteger(verificationWorkQueuedAtMs))
  ) {
    return undefined;
  }
  return {
    sessionId,
    finalizationId,
    ...(typeof s3BundleKey === 'string' ? { s3BundleKey } : {}),
    ...(typeof s3ReportKey === 'string' ? { s3ReportKey } : {}),
    ...(typeof s3UploadedAtMs === 'number' ? { s3UploadedAtMs } : {}),
    ...(typeof verificationWorkQueuedAtMs === 'number' ? { verificationWorkQueuedAtMs } : {}),
  };
}

function parseReceipt(value: unknown): ReceiptRecord | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS) || !isRecord(value['receipt'])) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const finalizationId = value['finalizationId'];
  const receiptHash = value['receiptHash'];
  const boardIndex = value['boardIndex'];
  let receipt: ReturnType<typeof admitSuccessfulFinalizationReceipt>;
  try {
    receipt = admitSuccessfulFinalizationReceipt(value['receipt']);
  } catch {
    return undefined;
  }
  if (
    typeof sessionId !== 'string' ||
    typeof finalizationId !== 'string' ||
    typeof receiptHash !== 'string' ||
    !PREFIXED_SHA256_PATTERN.test(receiptHash) ||
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
  if (!isRecord(value) || !hasExactKeys(value, OBSERVATION_RECORD_KEYS)) {
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

export function parseFileStoreSnapshot(value: unknown): FileStoreState | undefined {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
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
  if (
    !Array.isArray(identities) ||
    !Array.isArray(voting) ||
    !Array.isArray(finalizations) ||
    !Array.isArray(currentFinalizationIds) ||
    !Array.isArray(verificationResults) ||
    !Array.isArray(verificationObservations) ||
    !Array.isArray(bitmaps) ||
    !Array.isArray(voteIdIndex) ||
    !Array.isArray(runtimeMetadata) ||
    !Array.isArray(deliveryMetadata) ||
    !Array.isArray(receipts) ||
    !isNonNegativeSafeInteger(receiptCounter) ||
    receiptCounter < INITIAL_RECEIPT_COUNTER
  ) {
    return undefined;
  }

  const state = createEmptyFileStoreState();
  for (const rawIdentity of identities) {
    const identity = parseSessionIdentityRecord(rawIdentity);
    if (!identity || !addUnique(state.identityRecords, identity.sessionId, identity)) {
      return undefined;
    }
  }
  for (const rawVoting of voting) {
    if (!isRecord(rawVoting) || typeof rawVoting['sessionId'] !== 'string') {
      return undefined;
    }
    const identity = state.identityRecords.get(rawVoting['sessionId']);
    const record = identity ? parseVotingRecord(rawVoting, identity) : undefined;
    if (!record || !addUnique(state.votingRecords, record.sessionId, record)) {
      return undefined;
    }
  }
  if (
    state.identityRecords.size !== state.votingRecords.size ||
    Array.from(state.identityRecords.keys()).some((sessionId) => !state.votingRecords.has(sessionId))
  ) {
    return undefined;
  }

  for (const rawFinalization of finalizations) {
    const record = parseFinalizationRecord(rawFinalization);
    if (
      !record ||
      !state.identityRecords.has(record.sessionId) ||
      !addUnique(state.finalizationRecords, scopedKey(record.sessionId, record.finalizationId), record)
    ) {
      return undefined;
    }
  }
  for (const entry of currentFinalizationIds) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      typeof entry[1] !== 'string' ||
      state.currentFinalizationIdBySession.has(entry[0]) ||
      !state.finalizationRecords.has(scopedKey(entry[0], entry[1]))
    ) {
      return undefined;
    }
    state.currentFinalizationIdBySession.set(entry[0], entry[1]);
  }

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
      return undefined;
    }
  }
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
      return undefined;
    }
  }
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
      return undefined;
    }
  }

  const derivedVoteIdIndex = new Map<string, { sessionId: string; index: number }>();
  for (const [sessionId, record] of state.votingRecords) {
    for (const [index, vote] of record.votes) {
      if (!addUnique(derivedVoteIdIndex, vote.voteId, { sessionId, index })) {
        return undefined;
      }
    }
  }
  for (const entry of voteIdIndex) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      !isRecord(entry[1]) ||
      !hasExactKeys(entry[1], new Set(['sessionId', 'index'])) ||
      typeof entry[1]['sessionId'] !== 'string' ||
      !isNonNegativeSafeInteger(entry[1]['index'])
    ) {
      return undefined;
    }
    const expected = derivedVoteIdIndex.get(entry[0]);
    if (
      !expected ||
      expected.sessionId !== entry[1]['sessionId'] ||
      expected.index !== entry[1]['index'] ||
      !addUnique(state.voteIdIndex, entry[0], {
        sessionId: entry[1]['sessionId'],
        index: entry[1]['index'],
      })
    ) {
      return undefined;
    }
  }
  if (state.voteIdIndex.size !== derivedVoteIdIndex.size) {
    return undefined;
  }

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
      return undefined;
    }
  }
  for (const rawMetadata of deliveryMetadata) {
    const record = parseDeliveryMetadata(rawMetadata);
    if (
      !record ||
      !state.identityRecords.has(record.sessionId) ||
      !addUnique(state.deliveryMetadataRecords, scopedKey(record.sessionId, record.finalizationId), {
        ...(record.s3BundleKey ? { s3BundleKey: record.s3BundleKey } : {}),
        ...(record.s3ReportKey ? { s3ReportKey: record.s3ReportKey } : {}),
        ...(record.s3UploadedAtMs === undefined ? {} : { s3UploadedAtMs: record.s3UploadedAtMs }),
        ...(record.verificationWorkQueuedAtMs === undefined
          ? {}
          : { verificationWorkQueuedAtMs: record.verificationWorkQueuedAtMs }),
      })
    ) {
      return undefined;
    }
  }
  let maximumBoardIndex = INITIAL_RECEIPT_COUNTER - 1;
  for (const rawReceipt of receipts) {
    const record = parseReceipt(rawReceipt);
    const finalization = record
      ? state.finalizationRecords.get(scopedKey(record.sessionId, record.finalizationId))
      : undefined;
    const publication =
      finalization && finalization.state.status === 'succeeded' && finalization.finalizationResult
        ? finalization.finalizationResult.receiptPublication
        : undefined;
    if (
      !record ||
      !publication ||
      publication.receiptHash !== record.receiptHash ||
      publication.boardIndex !== record.boardIndex ||
      !addUnique(state.receiptRecords, scopedKey(record.sessionId, record.finalizationId), record)
    ) {
      return undefined;
    }
    maximumBoardIndex = Math.max(maximumBoardIndex, record.boardIndex);
  }
  if (receiptCounter <= maximumBoardIndex) {
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
    finalizations: sortedValues(state.finalizationRecords),
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
      ...bitmap,
      includedBitmap: [...bitmap.includedBitmap],
      ...(bitmap.seenBitmap ? { seenBitmap: [...bitmap.seenBitmap] } : {}),
    })),
    voteIdIndex: Array.from(state.voteIdIndex.entries()).sort(([left], [right]) => left.localeCompare(right)),
    runtimeMetadata: Array.from(state.runtimeMetadataRecords.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, metadata]) => {
        const separator = key.indexOf('\u0000');
        return {
          sessionId: key.slice(0, separator),
          finalizationId: key.slice(separator + 1),
          ...metadata,
          ...(metadata.bundleMetadata ? { bundleMetadata: { ...metadata.bundleMetadata } } : {}),
        };
      }),
    deliveryMetadata: Array.from(state.deliveryMetadataRecords.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, metadata]) => {
        const separator = key.indexOf('\u0000');
        return {
          sessionId: key.slice(0, separator),
          finalizationId: key.slice(separator + 1),
          ...metadata,
        };
      }),
    receipts: sortedValues(state.receiptRecords).map((record) => ({
      ...record,
      receipt: { ...record.receipt },
    })),
    receiptCounter: state.receiptCounter,
  };
}
