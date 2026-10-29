import { parseRootSnapshotFields } from './root-snapshot-admission';
import {
  isNonArrayObject as isRecord,
  hasExactOwnKeys as hasExactKeys,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from '@stark-ballot/validation/unknown-value-guards';
/** Exact persisted record admission and keys. No AWS calls or secret decryption. */

import {
  finalizationRecordCodec,
  type FinalizationRecord,
  type PersistedFinalizationRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import { finalizationBitmapDataCodec } from '@stark-ballot/application/finalize/finalization-storage';
import {
  parseVerificationResultRecord,
  type VerificationResultRecord,
} from '@stark-ballot/application/finalize/finalization-result-store';
import { type FinalizationBitmapRecord } from '@stark-ballot/application/finalize/finalization-store';

import { admitSuccessfulFinalizationReceipt } from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import type { FinalizationLifecycleRevision } from '@stark-ballot/application/finalize/finalization-transition-persistence';

import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';

import { type AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import {
  parseAwsFinalizationRuntimeMetadata,
  parseAwsVerificationDeliveryMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationMetadataAdmission';
import { type AwsFinalizationRuntimeMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';

import { computeSuccessfulFinalizationReceiptHash } from './successfulFinalizationReceipt';
import { isValidHexString } from '@stark-ballot/crypto-primitives';

import type { RootSnapshot, SessionIdentityRecord, UserParticipation } from '@stark-ballot/domain/types/sessionRecords';
import { parseSessionIdentityRecord } from '@stark-ballot/domain/types/sessionRecords';
import { type SessionId } from '@stark-ballot/domain/types/identifiers';
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

import {
  parseVerificationObservation,
  type VerificationObservation,
} from '@stark-ballot/domain/types/verificationObservation';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';

export interface IdentityItem {
  sessionId: SessionId;
  itemType: 'SESSION_IDENTITY';
  identity: SessionIdentityRecord;
  expiresAt: number;
}

export interface PersistedVotingRecord {
  sessionId: SessionId;
  bulletinRootHistory: RootSnapshot[];
  botCount: number;
  userParticipation: UserParticipation;
  lastActivityMs: number;
}

export interface VotingItem {
  sessionId: string;
  itemType: 'SESSION_VOTING';
  record: PersistedVotingRecord;
  revision: number;
  expiresAt: number;
}

export interface VoteItem {
  sessionId: SessionId;
  voteIndex: number;
  itemType: 'VOTE';
  voteId: string;
  vote: string;
  rand: string;
  commit: string;
  timestamp: number;
  rootAtCast: string;
  isUserVote: boolean;
  expiresAt: number;
}

export interface CurrentFinalizationItem {
  sessionId: string;
  itemType: 'FINALIZATION_CURRENT';
  ownerSessionId: SessionId;
  currentFinalizationId: FinalizationId;
  revision: number;
  expiresAt: number;
}

interface FinalizationItem {
  sessionId: string;
  itemType: 'FINALIZATION';
  ownerSessionId: SessionId;
  finalizationId: FinalizationId;
  record: FinalizationRecord;
  revision: number;
  expiresAt: number;
}

export interface PersistedFinalizationItem extends Omit<FinalizationItem, 'record'> {
  record: PersistedFinalizationRecord;
}

export interface VerificationItem {
  sessionId: string;
  itemType: 'VERIFICATION_RESULT';
  ownerSessionId: SessionId;
  finalizationId: FinalizationId;
  record: VerificationResultRecord;
  revision: number;
  expiresAt: number;
}

export interface VerificationRollbackItem {
  sessionId: string;
  itemType: 'VERIFICATION_ROLLBACK';
  ownerSessionId: SessionId;
  finalizationId: FinalizationId;
  record: VerificationResultRecord | null;
  expiresAt: number;
}

export interface ObservationItem {
  sessionId: string;
  itemType: 'VERIFICATION_OBSERVATION';
  ownerSessionId: SessionId;
  finalizationId: FinalizationId;
  observation: VerificationObservation;
  expiresAt: number;
}

export interface BitmapItem {
  sessionId: string;
  itemType: 'FINALIZATION_BITMAP';
  ownerSessionId: SessionId;
  finalizationId: FinalizationId;
  bitmap: FinalizationBitmapRecord;
  expiresAt: number;
}

export interface RuntimeMetadataItem {
  sessionId: string;
  itemType: 'FINALIZATION_RUNTIME';
  ownerSessionId: SessionId;
  finalizationId: FinalizationId;
  metadata: AwsFinalizationRuntimeMetadata;
  revision: number;
  expiresAt: number;
}

export interface DeliveryMetadataItem {
  sessionId: string;
  itemType: 'VERIFICATION_DELIVERY';
  ownerSessionId: SessionId;
  finalizationId: FinalizationId;
  metadata: AwsVerificationDeliveryMetadataInput;
  revision: number;
  expiresAt: number;
}

export interface ReceiptItem {
  sessionId: string;
  itemType: 'FINALIZATION_RECEIPT';
  ownerSessionId: SessionId;
  finalizationId: FinalizationId;
  receiptHash: string;
  boardIndex: number;
  receipt: {
    receipt: string;
    timestamp: number;
  };
  expiresAt: number;
}

export interface ReceiptCounterItem {
  sessionId: 'RECEIPT_BOARD_COUNTER';
  itemType: 'RECEIPT_COUNTER';
  nextBoardIndex: number;
}

interface EncodedLifecycleRevision {
  currentFinalizationId: FinalizationId | null;
  revision: number;
}

const IDENTITY_ITEM_KEYS = new Set(['sessionId', 'itemType', 'identity', 'expiresAt']);
const VOTING_ITEM_KEYS = new Set(['sessionId', 'itemType', 'record', 'revision', 'expiresAt']);
const PERSISTED_VOTING_KEYS = new Set([
  'sessionId',
  'bulletinRootHistory',
  'botCount',
  'userParticipation',
  'lastActivityMs',
]);
const VOTE_ITEM_KEYS = new Set([
  'sessionId',
  'voteIndex',
  'itemType',
  'voteId',
  'vote',
  'rand',
  'commit',
  'timestamp',
  'rootAtCast',
  'isUserVote',
  'expiresAt',
]);
const CURRENT_FINALIZATION_ITEM_KEYS = new Set([
  'sessionId',
  'itemType',
  'ownerSessionId',
  'currentFinalizationId',
  'revision',
  'expiresAt',
]);
const FINALIZATION_ITEM_KEYS = new Set([
  'sessionId',
  'itemType',
  'ownerSessionId',
  'finalizationId',
  'record',
  'revision',
  'expiresAt',
]);
const VERIFICATION_ITEM_KEYS = new Set([
  'sessionId',
  'itemType',
  'ownerSessionId',
  'finalizationId',
  'record',
  'revision',
  'expiresAt',
]);
const ROLLBACK_ITEM_KEYS = new Set([
  'sessionId',
  'itemType',
  'ownerSessionId',
  'finalizationId',
  'record',
  'expiresAt',
]);
const OBSERVATION_ITEM_KEYS = new Set([
  'sessionId',
  'itemType',
  'ownerSessionId',
  'finalizationId',
  'observation',
  'expiresAt',
]);
const BITMAP_ITEM_KEYS = new Set(['sessionId', 'itemType', 'ownerSessionId', 'finalizationId', 'bitmap', 'expiresAt']);
const METADATA_ITEM_KEYS = new Set([
  'sessionId',
  'itemType',
  'ownerSessionId',
  'finalizationId',
  'metadata',
  'revision',
  'expiresAt',
]);
const RECEIPT_ITEM_KEYS = new Set([
  'sessionId',
  'itemType',
  'ownerSessionId',
  'finalizationId',
  'receiptHash',
  'boardIndex',
  'receipt',
  'expiresAt',
]);
const RECEIPT_COUNTER_KEYS = new Set(['sessionId', 'itemType', 'nextBoardIndex']);
const USER_NOT_CAST_KEYS = new Set(['status']);
const USER_CAST_KEYS = new Set(['status', 'voteIndex']);

export function isExpiredItem(value: unknown): boolean {
  return (
    isRecord(value) && typeof value['expiresAt'] === 'number' && value['expiresAt'] <= Math.floor(Date.now() / 1000)
  );
}

export function normalizeStrictHex32(value: unknown): string {
  if (typeof value !== 'string' || !isValidHexString(value, 32)) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }
  return normalizeHex(value, { allowOddLength: false });
}

export function identityKey(sessionId: string): string {
  return sessionId;
}

export function votingKey(sessionId: string): string {
  return `VOTING#${sessionId}`;
}

export function currentFinalizationKey(sessionId: string): string {
  return `FINALIZATION_CURRENT#${sessionId}`;
}

export function finalizationKey(sessionId: string, finalizationId: string): string {
  return `FINALIZATION#${sessionId}#${finalizationId}`;
}

export function verificationKey(sessionId: string, finalizationId: string): string {
  return `VERIFICATION#${sessionId}#${finalizationId}`;
}

export function verificationRollbackKey(sessionId: string, finalizationId: string): string {
  return `VERIFICATION_ROLLBACK#${sessionId}#${finalizationId}`;
}

export function observationKey(sessionId: string, finalizationId: string): string {
  return `OBSERVATION#${sessionId}#${finalizationId}`;
}

export function bitmapKey(sessionId: string, finalizationId: string): string {
  return `BITMAP#${sessionId}#${finalizationId}`;
}

export function runtimeMetadataKey(sessionId: string, finalizationId: string): string {
  return `FINALIZATION_RUNTIME#${sessionId}#${finalizationId}`;
}

export function deliveryMetadataKey(sessionId: string, finalizationId: string): string {
  return `VERIFICATION_DELIVERY#${sessionId}#${finalizationId}`;
}

export function receiptKey(sessionId: string, finalizationId: string): string {
  return `RECEIPT#${sessionId}#${finalizationId}`;
}

export function encodeLifecycleRevision(value: EncodedLifecycleRevision): FinalizationLifecycleRevision {
  return JSON.stringify(value);
}

export function decodeLifecycleRevision(value: FinalizationLifecycleRevision): EncodedLifecycleRevision | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, new Set(['currentFinalizationId', 'revision'])) ||
      (parsed['currentFinalizationId'] !== null && typeof parsed['currentFinalizationId'] !== 'string') ||
      !isNonNegativeSafeInteger(parsed['revision'])
    ) {
      return undefined;
    }
    let currentFinalizationId: FinalizationId | null;
    if (parsed['currentFinalizationId'] === null) {
      currentFinalizationId = null;
    } else {
      const admittedFinalizationId = parseFinalizationId(parsed['currentFinalizationId']);
      if (!admittedFinalizationId) {
        return undefined;
      }
      currentFinalizationId = admittedFinalizationId;
    }
    return {
      currentFinalizationId,
      revision: parsed['revision'],
    };
  } catch {
    return undefined;
  }
}

function parseRootSnapshot(value: unknown): RootSnapshot | undefined {
  const fields = parseRootSnapshotFields(value);
  if (!fields) {
    return undefined;
  }
  const { timestamp, root, treeSize, signature } = fields;
  if (!isPositiveSafeInteger(treeSize) || !isValidHexString(root, 32)) {
    return undefined;
  }
  return {
    timestamp,
    root: normalizeHex(root, { allowOddLength: false }),
    treeSize,
    ...(signature === undefined ? {} : { signature }),
  };
}

function parseUserParticipation(value: unknown): UserParticipation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value['status'] === 'not_cast' && hasExactKeys(value, USER_NOT_CAST_KEYS)) {
    return { status: 'not_cast' };
  }
  if (
    value['status'] === 'cast' &&
    hasExactKeys(value, USER_CAST_KEYS) &&
    isNonNegativeSafeInteger(value['voteIndex'])
  ) {
    return { status: 'cast', voteIndex: value['voteIndex'] };
  }
  return undefined;
}

export function parseIdentityItem(value: unknown, expectedSessionId?: SessionId): IdentityItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, IDENTITY_ITEM_KEYS) ||
    value['itemType'] !== 'SESSION_IDENTITY' ||
    typeof value['sessionId'] !== 'string' ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  const identity = parseSessionIdentityRecord(value['identity']);
  if (
    !identity ||
    identity.sessionId !== value['sessionId'] ||
    (expectedSessionId !== undefined && identity.sessionId !== expectedSessionId)
  ) {
    return undefined;
  }
  return {
    sessionId: identity.sessionId,
    itemType: 'SESSION_IDENTITY',
    identity,
    expiresAt: value['expiresAt'],
  };
}

function parseRootHistory(history: readonly unknown[]): RootSnapshot[] | undefined {
  const bulletinRootHistory: RootSnapshot[] = [];
  for (const entry of history) {
    const snapshot = parseRootSnapshot(entry);
    if (!snapshot) {
      return undefined;
    }
    bulletinRootHistory.push(snapshot);
  }
  return bulletinRootHistory;
}

function parsePersistedVotingRecord(value: unknown, expectedSessionId: SessionId): PersistedVotingRecord | undefined {
  if (!isRecord(value) || !hasExactKeys(value, PERSISTED_VOTING_KEYS)) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const history = value['bulletinRootHistory'];
  const botCount = value['botCount'];
  const userParticipation = parseUserParticipation(value['userParticipation']);
  const lastActivityMs = value['lastActivityMs'];
  if (
    sessionId !== expectedSessionId ||
    !Array.isArray(history) ||
    !isNonNegativeSafeInteger(botCount) ||
    !userParticipation ||
    !isNonNegativeSafeInteger(lastActivityMs)
  ) {
    return undefined;
  }
  const bulletinRootHistory = parseRootHistory(history);
  if (!bulletinRootHistory) {
    return undefined;
  }
  return {
    sessionId: expectedSessionId,
    bulletinRootHistory,
    botCount,
    userParticipation,
    lastActivityMs,
  };
}

export function parseVotingItem(value: unknown, expectedSessionId: SessionId): VotingItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, VOTING_ITEM_KEYS) ||
    value['itemType'] !== 'SESSION_VOTING' ||
    value['sessionId'] !== votingKey(expectedSessionId) ||
    !isNonNegativeSafeInteger(value['revision']) ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  const record = parsePersistedVotingRecord(value['record'], expectedSessionId);
  if (!record) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'SESSION_VOTING',
    record,
    revision: value['revision'],
    expiresAt: value['expiresAt'],
  };
}

export function parseVoteItem(value: unknown, expectedSessionId: SessionId): VoteItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, VOTE_ITEM_KEYS) ||
    value['itemType'] !== 'VOTE' ||
    value['sessionId'] !== expectedSessionId ||
    !isNonNegativeSafeInteger(value['voteIndex']) ||
    typeof value['voteId'] !== 'string' ||
    typeof value['vote'] !== 'string' ||
    typeof value['rand'] !== 'string' ||
    typeof value['commit'] !== 'string' ||
    !isNonNegativeSafeInteger(value['timestamp']) ||
    typeof value['rootAtCast'] !== 'string' ||
    typeof value['isUserVote'] !== 'boolean' ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  return {
    sessionId: expectedSessionId,
    voteIndex: value['voteIndex'],
    itemType: 'VOTE',
    voteId: value['voteId'],
    vote: value['vote'],
    rand: value['rand'],
    commit: value['commit'],
    timestamp: value['timestamp'],
    rootAtCast: value['rootAtCast'],
    isUserVote: value['isUserVote'],
    expiresAt: value['expiresAt'],
  };
}

export function parseCurrentFinalizationItem(
  value: unknown,
  expectedSessionId: SessionId,
): CurrentFinalizationItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CURRENT_FINALIZATION_ITEM_KEYS) ||
    value['itemType'] !== 'FINALIZATION_CURRENT' ||
    value['sessionId'] !== currentFinalizationKey(expectedSessionId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    !isPositiveSafeInteger(value['revision']) ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  const currentFinalizationId = parseFinalizationId(value['currentFinalizationId']);
  if (!currentFinalizationId) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'FINALIZATION_CURRENT',
    ownerSessionId: expectedSessionId,
    currentFinalizationId,
    revision: value['revision'],
    expiresAt: value['expiresAt'],
  };
}

type VersionedFinalizationHeader = Pick<
  FinalizationItem,
  'sessionId' | 'ownerSessionId' | 'finalizationId' | 'revision' | 'expiresAt'
>;

function hasVersionedFinalizationHeader(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
  keys: ReadonlySet<string>,
  itemType: 'FINALIZATION' | 'VERIFICATION_RESULT' | 'FINALIZATION_RUNTIME' | 'VERIFICATION_DELIVERY',
  key: (sessionId: string, finalizationId: string) => string,
): value is Record<string, unknown> & VersionedFinalizationHeader {
  return (
    isRecord(value) &&
    hasExactKeys(value, keys) &&
    value['itemType'] === itemType &&
    value['sessionId'] === key(expectedSessionId, expectedFinalizationId) &&
    value['ownerSessionId'] === expectedSessionId &&
    value['finalizationId'] === expectedFinalizationId &&
    isPositiveSafeInteger(value['revision']) &&
    isNonNegativeSafeInteger(value['expiresAt']) &&
    !isExpiredItem(value)
  );
}

export function parseFinalizationItem(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): FinalizationItem | undefined {
  if (
    !hasVersionedFinalizationHeader(
      value,
      expectedSessionId,
      expectedFinalizationId,
      FINALIZATION_ITEM_KEYS,
      'FINALIZATION',
      finalizationKey,
    )
  )
    return undefined;
  const record = finalizationRecordCodec.decode(value['record']);
  if (!record || record.sessionId !== expectedSessionId || record.finalizationId !== expectedFinalizationId) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'FINALIZATION',
    ownerSessionId: expectedSessionId,
    finalizationId: expectedFinalizationId,
    record,
    revision: value['revision'],
    expiresAt: value['expiresAt'],
  };
}

export function parseVerificationItem(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): VerificationItem | undefined {
  if (
    !hasVersionedFinalizationHeader(
      value,
      expectedSessionId,
      expectedFinalizationId,
      VERIFICATION_ITEM_KEYS,
      'VERIFICATION_RESULT',
      verificationKey,
    )
  )
    return undefined;
  const record = parseVerificationResultRecord(value['record']);
  if (!record || record.sessionId !== expectedSessionId || record.finalizationId !== expectedFinalizationId) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'VERIFICATION_RESULT',
    ownerSessionId: expectedSessionId,
    finalizationId: expectedFinalizationId,
    record,
    revision: value['revision'],
    expiresAt: value['expiresAt'],
  };
}

export function parseRollbackItem(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): VerificationRollbackItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ROLLBACK_ITEM_KEYS) ||
    value['itemType'] !== 'VERIFICATION_ROLLBACK' ||
    value['sessionId'] !== verificationRollbackKey(expectedSessionId, expectedFinalizationId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  const rawRecord = value['record'];
  const record = rawRecord === null ? null : parseVerificationResultRecord(rawRecord);
  if (
    record === undefined ||
    (record !== null && (record.sessionId !== expectedSessionId || record.finalizationId !== expectedFinalizationId))
  ) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'VERIFICATION_ROLLBACK',
    ownerSessionId: expectedSessionId,
    finalizationId: expectedFinalizationId,
    record,
    expiresAt: value['expiresAt'],
  };
}

export function parseObservationItem(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): ObservationItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, OBSERVATION_ITEM_KEYS) ||
    value['itemType'] !== 'VERIFICATION_OBSERVATION' ||
    value['sessionId'] !== observationKey(expectedSessionId, expectedFinalizationId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  const observation = parseVerificationObservation(value['observation']);
  if (!observation || observation.finalizationId !== expectedFinalizationId) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'VERIFICATION_OBSERVATION',
    ownerSessionId: expectedSessionId,
    finalizationId: expectedFinalizationId,
    observation,
    expiresAt: value['expiresAt'],
  };
}

function parseBitmapRecord(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): FinalizationBitmapRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { sessionId, finalizationId, ...bitmapValue } = value;
  if (sessionId !== expectedSessionId || finalizationId !== expectedFinalizationId) {
    return undefined;
  }
  const bitmap = finalizationBitmapDataCodec.decode(bitmapValue);
  if (!bitmap) {
    return undefined;
  }
  return {
    sessionId: expectedSessionId,
    finalizationId: expectedFinalizationId,
    ...bitmap,
  };
}

export function parseBitmapItem(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): BitmapItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, BITMAP_ITEM_KEYS) ||
    value['itemType'] !== 'FINALIZATION_BITMAP' ||
    value['sessionId'] !== bitmapKey(expectedSessionId, expectedFinalizationId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  const bitmap = parseBitmapRecord(value['bitmap'], expectedSessionId, expectedFinalizationId);
  if (!bitmap) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'FINALIZATION_BITMAP',
    ownerSessionId: expectedSessionId,
    finalizationId: expectedFinalizationId,
    bitmap,
    expiresAt: value['expiresAt'],
  };
}

export function parseRuntimeMetadataItem(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): RuntimeMetadataItem | undefined {
  if (
    !hasVersionedFinalizationHeader(
      value,
      expectedSessionId,
      expectedFinalizationId,
      METADATA_ITEM_KEYS,
      'FINALIZATION_RUNTIME',
      runtimeMetadataKey,
    )
  )
    return undefined;
  const metadata = parseAwsFinalizationRuntimeMetadata(value['metadata']);
  return metadata
    ? {
        sessionId: value['sessionId'],
        itemType: 'FINALIZATION_RUNTIME',
        ownerSessionId: expectedSessionId,
        finalizationId: expectedFinalizationId,
        metadata,
        revision: value['revision'],
        expiresAt: value['expiresAt'],
      }
    : undefined;
}

export function parseDeliveryMetadataItem(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): DeliveryMetadataItem | undefined {
  if (
    !hasVersionedFinalizationHeader(
      value,
      expectedSessionId,
      expectedFinalizationId,
      METADATA_ITEM_KEYS,
      'VERIFICATION_DELIVERY',
      deliveryMetadataKey,
    )
  )
    return undefined;
  const metadata = parseAwsVerificationDeliveryMetadata(value['metadata']);
  return metadata
    ? {
        sessionId: value['sessionId'],
        itemType: 'VERIFICATION_DELIVERY',
        ownerSessionId: expectedSessionId,
        finalizationId: expectedFinalizationId,
        metadata,
        revision: value['revision'],
        expiresAt: value['expiresAt'],
      }
    : undefined;
}

export function parseReceiptItem(
  value: unknown,
  expectedSessionId: SessionId,
  expectedFinalizationId: FinalizationId,
): ReceiptItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RECEIPT_ITEM_KEYS) ||
    value['itemType'] !== 'FINALIZATION_RECEIPT' ||
    value['sessionId'] !== receiptKey(expectedSessionId, expectedFinalizationId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    typeof value['receiptHash'] !== 'string' ||
    !isNonNegativeSafeInteger(value['boardIndex']) ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  let receipt: ReturnType<typeof admitSuccessfulFinalizationReceipt>;
  try {
    receipt = admitSuccessfulFinalizationReceipt(value['receipt']);
  } catch {
    return undefined;
  }
  if (!receipt || value['receiptHash'] !== computeSuccessfulFinalizationReceiptHash(receipt)) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'FINALIZATION_RECEIPT',
    ownerSessionId: expectedSessionId,
    finalizationId: expectedFinalizationId,
    receiptHash: value['receiptHash'],
    boardIndex: value['boardIndex'],
    receipt,
    expiresAt: value['expiresAt'],
  };
}

export function parseReceiptCounterItem(value: unknown): ReceiptCounterItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RECEIPT_COUNTER_KEYS) ||
    value['sessionId'] !== 'RECEIPT_BOARD_COUNTER' ||
    value['itemType'] !== 'RECEIPT_COUNTER' ||
    !isNonNegativeSafeInteger(value['nextBoardIndex'])
  ) {
    return undefined;
  }
  return {
    sessionId: 'RECEIPT_BOARD_COUNTER',
    itemType: 'RECEIPT_COUNTER',
    nextBoardIndex: value['nextBoardIndex'],
  };
}
