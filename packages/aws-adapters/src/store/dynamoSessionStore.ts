/**
 * DynamoDB-backed exact-record session store.
 *
 * The sessions table has a single string partition key (`sessionId`). Record
 * families therefore use explicit key prefixes while the votes table retains
 * its `(sessionId, voteIndex)` key. No row serializes the retired aggregate
 * SessionData authority.
 */

import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  coordinateFinalizationTransition,
  type FinalizationTransitionCoordinationResult,
} from '@stark-ballot/application/finalize/finalization-transition-coordinator';
import {
  parseFinalizationRecord,
  type FinalizationRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import {
  parseVerificationResultRecord,
  type VerificationResultRecord,
  type VerificationResultStore,
} from '@stark-ballot/application/finalize/finalization-result-store';
import type {
  FinalizationBitmapData,
  FinalizationFailedPayload,
  FinalizationQueuedPayload,
  FinalizationRunningPayload,
  FinalizationStore,
  SuccessfulFinalizationCommitInput,
  SuccessfulFinalizationCommitResult,
  FinalizationSucceededPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import {
  admitFinalizationBitmapDisposition,
  admitPersistedFinalizationBitmapData,
} from '@stark-ballot/application/finalize/finalization-bitmap-admission';
import {
  admitSuccessfulFinalizationReceipt,
  admitSuccessfulFinalizationCommitRecord,
  assertSuccessfulFinalizationLifecycleAdmission,
  assertDirectSuccessfulFinalizationPayload,
  buildDirectSuccessfulFinalizationCommitRecord,
} from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import type {
  FinalizationLifecycleApplyResult,
  FinalizationLifecycleLoadResult,
  FinalizationLifecyclePersistencePort,
  FinalizationLifecycleRevision,
} from '@stark-ballot/application/finalize/finalization-transition-persistence';
import {
  evaluateFinalizationTransition,
  type FinalizationTransitionCommand,
} from '@stark-ballot/application/finalize/finalization-transition-policy';
import type { FinalizationId, FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import {
  buildSessionRecords,
  evaluateSessionVoteMutation,
} from '@stark-ballot/application/session/session-mutation-policy';
import {
  type AwsFinalizationDeliveryMetadataStore,
  type AwsVerificationDeliveryMetadataInput,
} from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import {
  parseAwsFinalizationRuntimeMetadata,
  parseAwsVerificationDeliveryMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationMetadataAdmission';
import {
  assertNoAwsRuntimeTransitionMetadata,
  type AwsFinalizationFailedPayload,
  type AwsFinalizationRunningPayload,
  type AwsFinalizationRuntimeMetadata,
  type AwsFinalizationRuntimeMetadataStore,
  type AwsFinalizationRuntimeTransitionStore,
  type AwsFinalizationSucceededPayload,
  type AwsFinalizationTimedOutPayload,
  type AwsSucceededTransitionMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { recordFinalizationStorePersistenceOutcome } from '@stark-ballot/aws-adapters/finalize/finalizationTransitionObservability';
import { decryptVoteSecret, encryptVoteSecret } from '@stark-ballot/aws-adapters/security/voteSecretCipher';
import { deriveExactCtProof } from '@stark-ballot/aws-adapters/store/ct-proof';
import { computeSuccessfulFinalizationReceiptHash } from './successfulFinalizationReceipt';
import { isValidHexString } from '@stark-ballot/crypto-primitives';
import { isFinalizationEventReason } from '@stark-ballot/diagnostics/canonicalEvents';
import { logger } from '@stark-ballot/diagnostics/logger';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { VOTE_CHOICES, type VoteChoice } from '@stark-ballot/domain/shared/constants';
import type {
  AddVoteResult,
  RootSnapshot,
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
  UserParticipation,
  VoteData,
} from '@stark-ballot/domain/types/sessionRecords';
import { parseSessionIdentityRecord } from '@stark-ballot/domain/types/sessionRecords';
import type { SessionVotingSummary, VoteStore } from '@stark-ballot/domain/types/voteStore';
import {
  parseVerificationObservation,
  parseVerificationObservationWrite,
  resolveVerificationObservationRecord,
  type RecordVerificationObservationResult,
  type VerificationObservation,
  type VerificationObservationWrite,
} from '@stark-ballot/domain/types/verificationObservation';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import type { VerificationReport, VerificationResult } from '@stark-ballot/verification/shared/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { generateLogId } from '@stark-ballot/zkvm-contract/zkvm/log-id';
import { computeCommitment, createElectionId } from '@stark-ballot/zkvm-contract/zkvm/types';

export interface DynamoSessionStoreConfig {
  sessionsTableName: string;
  votesTableName: string;
  documentClient: DynamoDBDocumentClient;
}

type TransactionItems = NonNullable<TransactWriteCommandInput['TransactItems']>;

interface IdentityItem {
  sessionId: string;
  itemType: 'SESSION_IDENTITY';
  identity: SessionIdentityRecord;
  expiresAt: number;
}

interface PersistedVotingRecord {
  sessionId: string;
  bulletinRootHistory: RootSnapshot[];
  botCount: number;
  userParticipation: UserParticipation;
  lastActivityMs: number;
}

interface VotingItem {
  sessionId: string;
  itemType: 'SESSION_VOTING';
  record: PersistedVotingRecord;
  revision: number;
  expiresAt: number;
}

interface VoteItem {
  sessionId: string;
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

interface CurrentFinalizationItem {
  sessionId: string;
  itemType: 'FINALIZATION_CURRENT';
  ownerSessionId: string;
  currentFinalizationId: string;
  revision: number;
  expiresAt: number;
}

interface FinalizationItem {
  sessionId: string;
  itemType: 'FINALIZATION';
  ownerSessionId: string;
  finalizationId: string;
  record: FinalizationRecord;
  revision: number;
  expiresAt: number;
}

interface VerificationItem {
  sessionId: string;
  itemType: 'VERIFICATION_RESULT';
  ownerSessionId: string;
  finalizationId: string;
  record: VerificationResultRecord;
  revision: number;
  expiresAt: number;
}

interface VerificationRollbackItem {
  sessionId: string;
  itemType: 'VERIFICATION_ROLLBACK';
  ownerSessionId: string;
  finalizationId: string;
  record: VerificationResultRecord | null;
  expiresAt: number;
}

interface ObservationItem {
  sessionId: string;
  itemType: 'VERIFICATION_OBSERVATION';
  ownerSessionId: string;
  finalizationId: string;
  observation: VerificationObservation;
  expiresAt: number;
}

interface BitmapItem {
  sessionId: string;
  itemType: 'FINALIZATION_BITMAP';
  ownerSessionId: string;
  finalizationId: string;
  bitmap: FinalizationBitmapData;
  expiresAt: number;
}

interface RuntimeMetadataItem {
  sessionId: string;
  itemType: 'FINALIZATION_RUNTIME';
  ownerSessionId: string;
  finalizationId: string;
  metadata: AwsFinalizationRuntimeMetadata;
  revision: number;
  expiresAt: number;
}

interface DeliveryMetadataItem {
  sessionId: string;
  itemType: 'VERIFICATION_DELIVERY';
  ownerSessionId: string;
  finalizationId: string;
  metadata: AwsVerificationDeliveryMetadataInput;
  revision: number;
  expiresAt: number;
}

interface ReceiptItem {
  sessionId: string;
  itemType: 'FINALIZATION_RECEIPT';
  ownerSessionId: string;
  finalizationId: string;
  receiptHash: string;
  boardIndex: number;
  receipt: {
    receipt: string;
    timestamp: number;
  };
  expiresAt: number;
}

interface ReceiptCounterItem {
  sessionId: 'RECEIPT_BOARD_COUNTER';
  itemType: 'RECEIPT_COUNTER';
  nextBoardIndex: number;
}

interface EncodedLifecycleRevision {
  currentFinalizationId: string | null;
  revision: number;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MAX_DYNAMODB_TRANSACTION_ITEMS = 100;
const MAX_CONDITIONAL_RETRIES = 3;
const FIRST_RECEIPT_BOARD_INDEX = 100;

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
const ROOT_SNAPSHOT_KEYS = new Set(['timestamp', 'root', 'treeSize']);
const ROOT_SNAPSHOT_WITH_SIGNATURE_KEYS = new Set(['timestamp', 'root', 'treeSize', 'signature']);
const USER_NOT_CAST_KEYS = new Set(['status']);
const USER_CAST_KEYS = new Set(['status', 'voteIndex']);
const FINALIZATION_QUEUED_PAYLOAD_KEYS = new Set(['finalizationId', 'queuedAtMs', 'scenarioContext', 'observability']);
const FINALIZATION_RUNNING_PAYLOAD_KEYS = new Set([
  'finalizationId',
  'queuedAtMs',
  'startedAtMs',
  'scenarioContext',
  'observability',
]);
const FINALIZATION_SUCCEEDED_PAYLOAD_KEYS = new Set([
  'finalizationId',
  'queuedAtMs',
  'startedAtMs',
  'completedAtMs',
  'scenarioContext',
  'finalizationResult',
  'observability',
]);
const FINALIZATION_FAILED_PAYLOAD_KEYS = new Set([
  'finalizationId',
  'queuedAtMs',
  'startedAtMs',
  'failedAtMs',
  'scenarioContext',
  'error',
  'observability',
]);
const FINALIZATION_TIMED_OUT_PAYLOAD_KEYS = new Set([
  'finalizationId',
  'queuedAtMs',
  'startedAtMs',
  'timeoutAtMs',
  'scenarioContext',
  'observability',
]);
const AWS_RUNNING_PAYLOAD_KEYS = new Set([...FINALIZATION_RUNNING_PAYLOAD_KEYS, 'stepFunctionsArn']);
const AWS_SUCCEEDED_PAYLOAD_KEYS = new Set([
  ...FINALIZATION_SUCCEEDED_PAYLOAD_KEYS,
  'stepFunctionsArn',
  'bundleMetadata',
]);
const AWS_FAILED_PAYLOAD_KEYS = new Set([...FINALIZATION_FAILED_PAYLOAD_KEYS, 'stepFunctionsArn']);
const AWS_TIMED_OUT_PAYLOAD_KEYS = new Set([...FINALIZATION_TIMED_OUT_PAYLOAD_KEYS, 'stepFunctionsArn']);

function requireTableName(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} must be set for DynamoDB session storage.`);
  }
  return trimmed;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${raw}. Expected a positive integer.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isExpiredItem(value: unknown): boolean {
  return (
    isRecord(value) && typeof value['expiresAt'] === 'number' && value['expiresAt'] <= Math.floor(Date.now() / 1000)
  );
}

function normalizeStrictHex32(value: unknown): string {
  if (typeof value !== 'string' || !isValidHexString(value, 32)) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }
  return normalizeHex(value, { allowOddLength: false });
}

function identityKey(sessionId: string): string {
  return sessionId;
}

function votingKey(sessionId: string): string {
  return `VOTING#${sessionId}`;
}

function currentFinalizationKey(sessionId: string): string {
  return `FINALIZATION_CURRENT#${sessionId}`;
}

function finalizationKey(sessionId: string, finalizationId: string): string {
  return `FINALIZATION#${sessionId}#${finalizationId}`;
}

function verificationKey(sessionId: string, finalizationId: string): string {
  return `VERIFICATION#${sessionId}#${finalizationId}`;
}

function verificationRollbackKey(sessionId: string, finalizationId: string): string {
  return `VERIFICATION_ROLLBACK#${sessionId}#${finalizationId}`;
}

function observationKey(sessionId: string, finalizationId: string): string {
  return `OBSERVATION#${sessionId}#${finalizationId}`;
}

function bitmapKey(sessionId: string, finalizationId: string): string {
  return `BITMAP#${sessionId}#${finalizationId}`;
}

function runtimeMetadataKey(sessionId: string, finalizationId: string): string {
  return `FINALIZATION_RUNTIME#${sessionId}#${finalizationId}`;
}

function deliveryMetadataKey(sessionId: string, finalizationId: string): string {
  return `VERIFICATION_DELIVERY#${sessionId}#${finalizationId}`;
}

function receiptKey(sessionId: string, finalizationId: string): string {
  return `RECEIPT#${sessionId}#${finalizationId}`;
}

function encodeLifecycleRevision(value: EncodedLifecycleRevision): FinalizationLifecycleRevision {
  return JSON.stringify(value);
}

function decodeLifecycleRevision(value: FinalizationLifecycleRevision): EncodedLifecycleRevision | undefined {
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
    return {
      currentFinalizationId: parsed['currentFinalizationId'],
      revision: parsed['revision'],
    };
  } catch {
    return undefined;
  }
}

function parseRootSnapshot(value: unknown): RootSnapshot | undefined {
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, ROOT_SNAPSHOT_KEYS) && !hasExactKeys(value, ROOT_SNAPSHOT_WITH_SIGNATURE_KEYS))
  ) {
    return undefined;
  }
  const timestamp = value['timestamp'];
  const root = value['root'];
  const treeSize = value['treeSize'];
  const signature = value['signature'];
  if (
    !isNonNegativeSafeInteger(timestamp) ||
    !isPositiveSafeInteger(treeSize) ||
    typeof root !== 'string' ||
    !isValidHexString(root, 32) ||
    (signature !== undefined && typeof signature !== 'string')
  ) {
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

function parseIdentityItem(value: unknown, expectedSessionId?: string): IdentityItem | undefined {
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
    sessionId: value['sessionId'],
    itemType: 'SESSION_IDENTITY',
    identity,
    expiresAt: value['expiresAt'],
  };
}

function parsePersistedVotingRecord(value: unknown, expectedSessionId: string): PersistedVotingRecord | undefined {
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
  const bulletinRootHistory: RootSnapshot[] = [];
  for (const entry of history) {
    const snapshot = parseRootSnapshot(entry);
    if (!snapshot) {
      return undefined;
    }
    bulletinRootHistory.push(snapshot);
  }
  return {
    sessionId: expectedSessionId,
    bulletinRootHistory,
    botCount,
    userParticipation,
    lastActivityMs,
  };
}

function parseVotingItem(value: unknown, expectedSessionId: string): VotingItem | undefined {
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

function parseVoteItem(value: unknown, expectedSessionId: string): VoteItem | undefined {
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

function parseCurrentFinalizationItem(value: unknown, expectedSessionId: string): CurrentFinalizationItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CURRENT_FINALIZATION_ITEM_KEYS) ||
    value['itemType'] !== 'FINALIZATION_CURRENT' ||
    value['sessionId'] !== currentFinalizationKey(expectedSessionId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    typeof value['currentFinalizationId'] !== 'string' ||
    !isPositiveSafeInteger(value['revision']) ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  return {
    sessionId: value['sessionId'],
    itemType: 'FINALIZATION_CURRENT',
    ownerSessionId: expectedSessionId,
    currentFinalizationId: value['currentFinalizationId'],
    revision: value['revision'],
    expiresAt: value['expiresAt'],
  };
}

function parseFinalizationItem(
  value: unknown,
  expectedSessionId: string,
  expectedFinalizationId: string,
): FinalizationItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, FINALIZATION_ITEM_KEYS) ||
    value['itemType'] !== 'FINALIZATION' ||
    value['sessionId'] !== finalizationKey(expectedSessionId, expectedFinalizationId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    !isPositiveSafeInteger(value['revision']) ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
  const record = parseFinalizationRecord(value['record']);
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

function parseVerificationItem(
  value: unknown,
  expectedSessionId: string,
  expectedFinalizationId: string,
): VerificationItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, VERIFICATION_ITEM_KEYS) ||
    value['itemType'] !== 'VERIFICATION_RESULT' ||
    value['sessionId'] !== verificationKey(expectedSessionId, expectedFinalizationId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    !isPositiveSafeInteger(value['revision']) ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
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

function parseRollbackItem(
  value: unknown,
  expectedSessionId: string,
  expectedFinalizationId: string,
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

function parseObservationItem(
  value: unknown,
  expectedSessionId: string,
  expectedFinalizationId: string,
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
  expectedSessionId: string,
  expectedFinalizationId: string,
): FinalizationBitmapData | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const expectedKeys = new Set([
    'sessionId',
    'finalizationId',
    'includedBitmap',
    'includedBitmapRoot',
    'treeSize',
    'finalizedAtMs',
    ...(Object.prototype.hasOwnProperty.call(value, 'seenBitmap') ? ['seenBitmap'] : []),
    ...(Object.prototype.hasOwnProperty.call(value, 'seenBitmapRoot') ? ['seenBitmapRoot'] : []),
  ]);
  if (!hasExactKeys(value, expectedKeys)) {
    return undefined;
  }
  const includedBitmap = value['includedBitmap'];
  const seenBitmap = value['seenBitmap'];
  if (
    value['sessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    !Array.isArray(includedBitmap) ||
    !includedBitmap.every((bit) => typeof bit === 'boolean') ||
    typeof value['includedBitmapRoot'] !== 'string' ||
    !isNonNegativeSafeInteger(value['treeSize']) ||
    !isNonNegativeSafeInteger(value['finalizedAtMs']) ||
    (seenBitmap !== undefined &&
      (!Array.isArray(seenBitmap) || !seenBitmap.every((bit) => typeof bit === 'boolean'))) ||
    (value['seenBitmapRoot'] !== undefined && typeof value['seenBitmapRoot'] !== 'string')
  ) {
    return undefined;
  }
  return {
    sessionId: expectedSessionId,
    finalizationId: expectedFinalizationId,
    includedBitmap: [...includedBitmap],
    includedBitmapRoot: value['includedBitmapRoot'],
    ...(Array.isArray(seenBitmap) ? { seenBitmap: [...seenBitmap] } : {}),
    ...(typeof value['seenBitmapRoot'] === 'string' ? { seenBitmapRoot: value['seenBitmapRoot'] } : {}),
    treeSize: value['treeSize'],
    finalizedAtMs: value['finalizedAtMs'],
  };
}

function parseBitmapItem(
  value: unknown,
  expectedSessionId: string,
  expectedFinalizationId: string,
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

function parseRuntimeMetadataItem(
  value: unknown,
  expectedSessionId: string,
  expectedFinalizationId: string,
): RuntimeMetadataItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, METADATA_ITEM_KEYS) ||
    value['itemType'] !== 'FINALIZATION_RUNTIME' ||
    value['sessionId'] !== runtimeMetadataKey(expectedSessionId, expectedFinalizationId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    !isPositiveSafeInteger(value['revision']) ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
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

function parseDeliveryMetadataItem(
  value: unknown,
  expectedSessionId: string,
  expectedFinalizationId: string,
): DeliveryMetadataItem | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, METADATA_ITEM_KEYS) ||
    value['itemType'] !== 'VERIFICATION_DELIVERY' ||
    value['sessionId'] !== deliveryMetadataKey(expectedSessionId, expectedFinalizationId) ||
    value['ownerSessionId'] !== expectedSessionId ||
    value['finalizationId'] !== expectedFinalizationId ||
    !isPositiveSafeInteger(value['revision']) ||
    !isNonNegativeSafeInteger(value['expiresAt']) ||
    isExpiredItem(value)
  ) {
    return undefined;
  }
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

function parseReceiptItem(
  value: unknown,
  expectedSessionId: string,
  expectedFinalizationId: string,
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

function parseReceiptCounterItem(value: unknown): ReceiptCounterItem | undefined {
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

function toPersistedVotingRecord(record: SessionVotingRecord): PersistedVotingRecord {
  return {
    sessionId: record.sessionId,
    bulletinRootHistory: record.bulletinRootHistory.map((snapshot) => ({ ...snapshot })),
    botCount: record.botCount,
    userParticipation: { ...record.userParticipation },
    lastActivityMs: record.lastActivityMs,
  };
}

function toVoteItem(
  sessionId: string,
  voteIndex: number,
  record: StoredVoteRecord,
  isUserVote: boolean,
  expiresAt: number,
): VoteItem {
  return {
    sessionId,
    voteIndex,
    itemType: 'VOTE',
    voteId: record.voteId,
    vote: encryptVoteSecret(record.vote),
    rand: encryptVoteSecret(record.rand),
    commit: record.commit,
    timestamp: record.timestamp,
    rootAtCast: record.rootAtCast,
    isUserVote,
    expiresAt,
  };
}

function toStoredVoteRecord(item: VoteItem): StoredVoteRecord {
  try {
    const vote = decryptVoteSecret(item.vote);
    const rand = normalizeHex(decryptVoteSecret(item.rand), { allowEmpty: true });
    if (!VOTE_CHOICES.includes(vote as VoteChoice)) {
      throw new Error('Invalid vote choice');
    }
    return {
      voteId: item.voteId,
      vote: vote as VoteChoice,
      rand,
      commit: normalizeStrictHex32(item.commit),
      timestamp: item.timestamp,
      rootAtCast: normalizeStrictHex32(item.rootAtCast),
    };
  } catch {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }
}

function restoreVotingRecord(
  identity: SessionIdentityRecord,
  persisted: PersistedVotingRecord,
  voteItems: readonly VoteItem[],
): SessionVotingRecord {
  const sorted = [...voteItems].sort((left, right) => left.voteIndex - right.voteIndex);
  const votes = new Map<number, StoredVoteRecord>();
  const bulletin = new SimpleBulletinBoard(identity.logId);
  const reconstructedHistory: RootSnapshot[] = [];
  const seenVoteIds = new Set<string>();

  for (const [expectedIndex, item] of sorted.entries()) {
    if (item.voteIndex !== expectedIndex || seenVoteIds.has(item.voteId)) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    seenVoteIds.add(item.voteId);
    const vote = toStoredVoteRecord(item);
    const choiceIndex = VOTE_CHOICES.indexOf(vote.vote);
    if (
      choiceIndex < 0 ||
      normalizeStrictHex32(computeCommitment(identity.electionId, choiceIndex, vote.rand)) !== vote.commit
    ) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    let append;
    try {
      append = bulletin.appendVote(vote.voteId, vote.commit.slice(2));
    } catch {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    const root = normalizeStrictHex32(append.rootAtAppend);
    if (append.index !== expectedIndex || root !== vote.rootAtCast) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    votes.set(expectedIndex, vote);
    reconstructedHistory.push({
      timestamp: vote.timestamp,
      root,
      treeSize: expectedIndex + 1,
    });
  }

  if (persisted.bulletinRootHistory.length !== reconstructedHistory.length) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }
  const bulletinRootHistory = reconstructedHistory.map((snapshot, index) => {
    const persistedSnapshot = persisted.bulletinRootHistory[index];
    if (
      !persistedSnapshot ||
      persistedSnapshot.treeSize !== snapshot.treeSize ||
      normalizeStrictHex32(persistedSnapshot.root) !== snapshot.root ||
      persistedSnapshot.timestamp !== votes.get(index)?.timestamp
    ) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    return { ...persistedSnapshot, root: snapshot.root };
  });

  const participation = persisted.userParticipation;
  const userVoteIndex = participation.status === 'cast' ? participation.voteIndex : undefined;
  if (
    (userVoteIndex === undefined && voteItems.length > 0) ||
    (userVoteIndex !== undefined &&
      (userVoteIndex !== 0 || !votes.has(userVoteIndex) || sorted[userVoteIndex]?.isUserVote !== true)) ||
    sorted.some((item, index) => item.isUserVote !== (index === userVoteIndex)) ||
    persisted.botCount !== voteItems.length - (userVoteIndex === undefined ? 0 : 1)
  ) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }

  return {
    sessionId: identity.sessionId,
    votes,
    bulletin,
    bulletinRootHistory,
    botCount: persisted.botCount,
    userParticipation: { ...persisted.userParticipation },
    lastActivityMs: persisted.lastActivityMs,
  };
}

function requestedStatus(command: FinalizationTransitionCommand): FinalizationState['status'] {
  switch (command.kind) {
    case 'queue':
      return 'pending';
    case 'start':
      return 'running';
    case 'succeed':
      return 'succeeded';
    case 'fail':
    case 'cancel':
      return 'failed';
    case 'time_out':
      return 'timeout';
  }
}

function assertAllowedPayloadKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`Invalid ${label} payload`);
  }
}

function buildFinalizationCommand(
  sessionId: string,
  payload:
    | FinalizationQueuedPayload
    | FinalizationRunningPayload
    | FinalizationSucceededPayload
    | FinalizationFailedPayload
    | FinalizationTimedOutPayload,
  kind: 'queue' | 'start' | 'succeed' | 'fail' | 'time_out',
): FinalizationTransitionCommand {
  const reason = payload.observability?.reason;
  switch (kind) {
    case 'queue': {
      const queued = payload as FinalizationQueuedPayload;
      return {
        kind,
        sessionId,
        finalizationId: queued.finalizationId,
        queuedAtMs: queued.queuedAtMs,
        scenarioContext: queued.scenarioContext,
        ...(reason ? { reason } : {}),
      };
    }
    case 'start': {
      const running = payload as FinalizationRunningPayload;
      return {
        kind,
        sessionId,
        finalizationId: running.finalizationId,
        queuedAtMs: running.queuedAtMs,
        startedAtMs: running.startedAtMs,
        ...(running.scenarioContext ? { scenarioContext: running.scenarioContext } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case 'succeed': {
      const succeeded = payload as FinalizationSucceededPayload;
      return {
        kind,
        sessionId,
        finalizationId: succeeded.finalizationId,
        queuedAtMs: succeeded.queuedAtMs,
        startedAtMs: succeeded.startedAtMs,
        completedAtMs: succeeded.completedAtMs,
        finalizationResult: succeeded.finalizationResult,
        ...(succeeded.scenarioContext ? { scenarioContext: succeeded.scenarioContext } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case 'fail': {
      const failed = payload as FinalizationFailedPayload;
      if (failed.error.code === 'USER_CANCELLED') {
        return {
          kind: 'cancel',
          sessionId,
          finalizationId: failed.finalizationId,
          queuedAtMs: failed.queuedAtMs,
          ...(failed.startedAtMs === undefined ? {} : { startedAtMs: failed.startedAtMs }),
          failedAtMs: failed.failedAtMs,
          message: failed.error.message,
          ...(failed.scenarioContext ? { scenarioContext: failed.scenarioContext } : {}),
          ...(reason ? { reason } : {}),
        };
      }
      return {
        kind,
        sessionId,
        finalizationId: failed.finalizationId,
        queuedAtMs: failed.queuedAtMs,
        ...(failed.startedAtMs === undefined ? {} : { startedAtMs: failed.startedAtMs }),
        failedAtMs: failed.failedAtMs,
        error: failed.error,
        ...(failed.scenarioContext ? { scenarioContext: failed.scenarioContext } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case 'time_out': {
      const timedOut = payload as FinalizationTimedOutPayload;
      return {
        kind,
        sessionId,
        finalizationId: timedOut.finalizationId,
        queuedAtMs: timedOut.queuedAtMs,
        ...(timedOut.startedAtMs === undefined ? {} : { startedAtMs: timedOut.startedAtMs }),
        timeoutAtMs: timedOut.timeoutAtMs,
        ...(timedOut.scenarioContext ? { scenarioContext: timedOut.scenarioContext } : {}),
        ...(reason ? { reason } : {}),
      };
    }
  }
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ConditionalCheckFailedException' ||
      error.name === 'TransactionCanceledException' ||
      error.message.includes('ConditionalCheckFailedException'))
  );
}

function isTerminalVerificationStatus(status: VerificationResult['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'dev_mode';
}

function cloneIdentity(identity: SessionIdentityRecord): SessionIdentityRecord {
  return {
    ...identity,
    electionConfig: {
      ...identity.electionConfig,
      choices: [...identity.electionConfig.choices],
    },
  };
}

function cloneVoting(record: SessionVotingRecord): SessionVotingRecord {
  return {
    ...record,
    votes: new Map(Array.from(record.votes, ([index, vote]) => [index, { ...vote }])),
    bulletinRootHistory: record.bulletinRootHistory.map((snapshot) => ({ ...snapshot })),
    userParticipation: { ...record.userParticipation },
  };
}

function cloneRuntimeMetadata(metadata: AwsFinalizationRuntimeMetadata): AwsFinalizationRuntimeMetadata {
  return {
    ...metadata,
    ...(metadata.bundleMetadata ? { bundleMetadata: { ...metadata.bundleMetadata } } : {}),
  };
}

function isSucceededFinalizationRecord(
  record: FinalizationRecord,
): record is Extract<FinalizationRecord, { state: { status: 'succeeded' } }> {
  return record.state.status === 'succeeded' && record.finalizationResult !== undefined;
}

type PostCommitActivityOperation =
  | 'verification_running'
  | 'verification_rollback'
  | 'verification_completion'
  | 'verification_observation'
  | 'bitmap_write';

export class DynamoSessionStore
  implements
    VoteStore,
    FinalizationStore,
    VerificationResultStore,
    AwsFinalizationRuntimeTransitionStore,
    AwsFinalizationRuntimeMetadataStore,
    AwsFinalizationDeliveryMetadataStore
{
  private readonly sessionsTableName: string;
  private readonly votesTableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(config: DynamoSessionStoreConfig) {
    this.sessionsTableName = requireTableName(config.sessionsTableName, 'DYNAMODB_SESSIONS_TABLE');
    this.votesTableName = requireTableName(config.votesTableName, 'DYNAMODB_VOTES_TABLE');
    this.client = config.documentClient;
  }

  private liveExpiresAt(): number {
    return Math.floor(Date.now() / 1000) + readPositiveIntegerEnv('SESSION_LIVE_TTL_SECONDS', 5 * 60);
  }

  private artifactExpiresAt(): number {
    return Math.floor(Date.now() / 1000) + readPositiveIntegerEnv('VERIFICATION_ARTIFACT_TTL_SECONDS', 2 * 60 * 60);
  }

  private async getSessionItem(key: string): Promise<unknown> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.sessionsTableName,
        Key: { sessionId: key },
        ConsistentRead: true,
      }),
    );
    return result.Item;
  }

  private async requireIdentity(sessionId: string): Promise<SessionIdentityRecord> {
    const identity = await this.getSessionIdentity(sessionId);
    if (!identity) {
      throw new Error('Session not found');
    }
    return identity;
  }

  private async loadVotingItem(sessionId: string): Promise<VotingItem | null> {
    const raw = await this.getSessionItem(votingKey(sessionId));
    if (raw === undefined || isExpiredItem(raw)) {
      return null;
    }
    const item = parseVotingItem(raw, sessionId);
    if (!item) {
      throw new Error('Session voting record is missing or invalid');
    }
    return item;
  }

  private async loadVoteItems(sessionId: string): Promise<VoteItem[]> {
    const items: VoteItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.votesTableName,
          KeyConditionExpression: '#sessionId = :sessionId',
          ExpressionAttributeNames: { '#sessionId': 'sessionId' },
          ExpressionAttributeValues: { ':sessionId': sessionId },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      for (const raw of result.Items ?? []) {
        const item = parseVoteItem(raw, sessionId);
        if (!item) {
          throw new Error('CT_PROOF_UNAVAILABLE');
        }
        items.push(item);
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    const seen = new Set<number>();
    for (const item of items) {
      if (seen.has(item.voteIndex)) {
        throw new Error('CT_PROOF_UNAVAILABLE');
      }
      seen.add(item.voteIndex);
    }
    return items;
  }

  private async loadSessionTtlAuthority(sessionId: string): Promise<{
    identity: IdentityItem;
    voting: VotingItem;
    votes: VoteItem[];
    expiresAt: number;
  }> {
    const identityRaw = await this.getSessionItem(identityKey(sessionId));
    const identity = parseIdentityItem(identityRaw, sessionId);
    if (!identity) {
      throw new Error('Session not found');
    }
    const voting = await this.loadVotingItem(sessionId);
    if (!voting) {
      throw new Error('Session voting record is missing or invalid');
    }
    const votes = await this.loadVoteItems(sessionId);
    const expectedVoteCount = voting.record.bulletinRootHistory.length;
    if (
      votes.length !== expectedVoteCount ||
      votes.some((vote) => vote.voteIndex < 0 || vote.voteIndex >= expectedVoteCount)
    ) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    const expiresAt = Math.max(
      this.liveExpiresAt(),
      identity.expiresAt,
      voting.expiresAt,
      ...votes.map((vote) => vote.expiresAt),
    );
    return { identity, voting, votes, expiresAt };
  }

  private buildSessionTtlUpdates(
    sessionId: string,
    authority: {
      identity: IdentityItem;
      votes: readonly VoteItem[];
      expiresAt: number;
    },
  ): TransactionItems {
    return [
      {
        Update: {
          TableName: this.sessionsTableName,
          Key: { sessionId: identityKey(sessionId) },
          UpdateExpression: 'SET #expiresAt = :expiresAt',
          ConditionExpression: '#itemType = :itemType AND #currentExpiresAt = :currentExpiresAt',
          ExpressionAttributeNames: {
            '#itemType': 'itemType',
            '#currentExpiresAt': 'expiresAt',
            '#expiresAt': 'expiresAt',
          },
          ExpressionAttributeValues: {
            ':itemType': 'SESSION_IDENTITY',
            ':currentExpiresAt': authority.identity.expiresAt,
            ':expiresAt': authority.expiresAt,
          },
        },
      },
      ...authority.votes.map((vote) => ({
        Update: {
          TableName: this.votesTableName,
          Key: { sessionId, voteIndex: vote.voteIndex },
          UpdateExpression: 'SET #expiresAt = :expiresAt',
          ConditionExpression: '#itemType = :itemType AND #currentExpiresAt = :currentExpiresAt',
          ExpressionAttributeNames: {
            '#itemType': 'itemType',
            '#currentExpiresAt': 'expiresAt',
            '#expiresAt': 'expiresAt',
          },
          ExpressionAttributeValues: {
            ':itemType': 'VOTE',
            ':currentExpiresAt': vote.expiresAt,
            ':expiresAt': authority.expiresAt,
          },
        },
      })),
    ];
  }

  private async buildArtifactTtlUpdatePlan(
    sessionId: string,
    requestedExpiresAt: number,
  ): Promise<{ expiresAt: number; items: TransactionItems }> {
    const authority = await this.loadSessionTtlAuthority(sessionId);
    const expiresAt = Math.max(requestedExpiresAt, authority.expiresAt);
    return {
      expiresAt,
      items: [
        ...this.buildSessionTtlUpdates(sessionId, { ...authority, expiresAt }),
        {
          Update: {
            TableName: this.sessionsTableName,
            Key: { sessionId: votingKey(sessionId) },
            UpdateExpression: 'SET #expiresAt = :expiresAt',
            ConditionExpression: '#revision = :expectedRevision AND #currentExpiresAt = :currentExpiresAt',
            ExpressionAttributeNames: {
              '#revision': 'revision',
              '#currentExpiresAt': 'expiresAt',
              '#expiresAt': 'expiresAt',
            },
            ExpressionAttributeValues: {
              ':expectedRevision': authority.voting.revision,
              ':currentExpiresAt': authority.voting.expiresAt,
              ':expiresAt': expiresAt,
            },
          },
        },
      ],
    };
  }

  private assertTransactionSize(items: TransactionItems): void {
    if (items.length > MAX_DYNAMODB_TRANSACTION_ITEMS) {
      throw new Error('DynamoDB transaction item limit exceeded');
    }
  }

  async createSession(): Promise<SessionIdentityRecord> {
    const sessionId =
      typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const nowMs = Date.now();
    const records = buildSessionRecords({
      sessionId,
      electionId: createElectionId(),
      electionConfigHash: getDefaultElectionConfigHash(),
      electionConfig: buildDefaultElectionConfig(),
      logId: generateLogId(`dynamo-${sessionId}`),
      createdAtMs: nowMs,
      lastActivityMs: nowMs,
    });
    const identity = parseSessionIdentityRecord(records.identity);
    if (!identity) {
      throw new Error('Session creation produced invalid identity authority');
    }
    const expiresAt = this.liveExpiresAt();
    const items: TransactionItems = [
      {
        Put: {
          TableName: this.sessionsTableName,
          Item: {
            sessionId: identityKey(sessionId),
            itemType: 'SESSION_IDENTITY',
            identity,
            expiresAt,
          } satisfies IdentityItem,
          ConditionExpression: 'attribute_not_exists(#sessionId)',
          ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        },
      },
      {
        Put: {
          TableName: this.sessionsTableName,
          Item: {
            sessionId: votingKey(sessionId),
            itemType: 'SESSION_VOTING',
            record: toPersistedVotingRecord(records.voting),
            revision: 0,
            expiresAt,
          } satisfies VotingItem,
          ConditionExpression: 'attribute_not_exists(#sessionId)',
          ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        },
      },
    ];
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    return cloneIdentity(identity);
  }

  async getSessionIdentity(sessionId: string): Promise<SessionIdentityRecord | null> {
    const raw = await this.getSessionItem(identityKey(sessionId));
    if (raw === undefined || isExpiredItem(raw)) {
      return null;
    }
    const item = parseIdentityItem(raw, sessionId);
    if (!item) {
      throw new Error('Session identity is missing or invalid');
    }
    return cloneIdentity(item.identity);
  }

  async getVotingRecord(sessionId: string): Promise<SessionVotingRecord | null> {
    const identity = await this.getSessionIdentity(sessionId);
    if (!identity) {
      return null;
    }
    const votingItem = await this.loadVotingItem(sessionId);
    if (!votingItem) {
      throw new Error('Session voting record is missing or invalid');
    }
    const voteItems = await this.loadVoteItems(sessionId);
    const record = restoreVotingRecord(identity, votingItem.record, voteItems);
    const current = await this.getCurrentFinalizationRecord(sessionId);
    if (current && isSucceededFinalizationRecord(current) && record.bulletinRootHistory.length > 0) {
      const finalRoot = record.bulletinRootHistory.at(-1)?.root;
      if (
        !finalRoot ||
        normalizeStrictHex32(current.finalizationResult.journal.bulletinRoot) !== normalizeStrictHex32(finalRoot)
      ) {
        throw new Error('CT_PROOF_UNAVAILABLE');
      }
    }
    return cloneVoting(record);
  }

  async getSessionVotingSummary(sessionId: string): Promise<SessionVotingSummary | null> {
    const voting = await this.getVotingRecord(sessionId);
    return voting
      ? {
          sessionId,
          botCount: voting.botCount,
          userParticipation: { ...voting.userParticipation },
        }
      : null;
  }

  private async persistVoteMutation(
    sessionId: string,
    authority: {
      identity: IdentityItem;
      voting: VotingItem;
      votes: VoteItem[];
      expiresAt: number;
    },
    next: SessionVotingRecord,
  ): Promise<void> {
    const newVotes = Array.from(next.votes.entries()).filter(
      ([index]) => index >= authority.voting.record.bulletinRootHistory.length,
    );
    const items: TransactionItems = [
      ...this.buildSessionTtlUpdates(sessionId, authority),
      {
        Put: {
          TableName: this.sessionsTableName,
          Item: {
            sessionId: votingKey(sessionId),
            itemType: 'SESSION_VOTING',
            record: toPersistedVotingRecord(next),
            revision: authority.voting.revision + 1,
            expiresAt: authority.expiresAt,
          } satisfies VotingItem,
          ConditionExpression: '#revision = :expectedRevision AND #expiresAt = :expectedExpiresAt',
          ExpressionAttributeNames: { '#revision': 'revision', '#expiresAt': 'expiresAt' },
          ExpressionAttributeValues: {
            ':expectedRevision': authority.voting.revision,
            ':expectedExpiresAt': authority.voting.expiresAt,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: this.sessionsTableName,
          Key: { sessionId: currentFinalizationKey(sessionId) },
          ConditionExpression: 'attribute_not_exists(#sessionId)',
          ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        },
      },
      ...newVotes.map(([index, vote]) => ({
        Put: {
          TableName: this.votesTableName,
          Item: toVoteItem(
            sessionId,
            index,
            vote,
            next.userParticipation.status === 'cast' && next.userParticipation.voteIndex === index,
            authority.expiresAt,
          ),
          ConditionExpression: 'attribute_not_exists(#sessionId)',
          ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        },
      })),
    ];
    this.assertTransactionSize(items);
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
  }

  private async loadVoteMutationAuthority(sessionId: string): Promise<{
    identity: SessionIdentityRecord;
    identityItem: IdentityItem;
    votingItem: VotingItem;
    voteItems: VoteItem[];
    expiresAt: number;
    voting: SessionVotingRecord;
    finalization: FinalizationRecord | null;
  }> {
    const ttlAuthority = await this.loadSessionTtlAuthority(sessionId);
    const identity = ttlAuthority.identity.identity;
    const voting = restoreVotingRecord(identity, ttlAuthority.voting.record, ttlAuthority.votes);
    const finalization = await this.getCurrentFinalizationRecord(sessionId);
    return {
      identity,
      identityItem: ttlAuthority.identity,
      votingItem: ttlAuthority.voting,
      voteItems: ttlAuthority.votes,
      expiresAt: ttlAuthority.expiresAt,
      voting,
      finalization,
    };
  }

  async addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult> {
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const authority = await this.loadVoteMutationAuthority(sessionId);
      const mutation = evaluateSessionVoteMutation(
        {
          identity: authority.identity,
          voting: authority.voting,
          finalization: authority.finalization,
        },
        { kind: 'append_user_vote', vote: voteData },
        { generateVoteId, nowMs: Date.now },
      );
      if (mutation.kind !== 'user_vote_appended') {
        throw new Error('Session vote mutation invariant violated');
      }
      try {
        await this.persistVoteMutation(
          sessionId,
          {
            identity: authority.identityItem,
            voting: authority.votingItem,
            votes: authority.voteItems,
            expiresAt: authority.expiresAt,
          },
          mutation.nextVoting,
        );
        return mutation.castResult;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
      }
    }
    throw new Error('Vote mutation contention limit exceeded');
  }

  async addBotVotes(sessionId: string, votes: VoteData[]): Promise<void> {
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const authority = await this.loadVoteMutationAuthority(sessionId);
      const mutation = evaluateSessionVoteMutation(
        {
          identity: authority.identity,
          voting: authority.voting,
          finalization: authority.finalization,
        },
        { kind: 'append_bot_votes', votes },
        { generateVoteId, nowMs: Date.now },
      );
      if (mutation.kind !== 'bot_votes_appended') {
        throw new Error('Session vote mutation invariant violated');
      }
      try {
        await this.persistVoteMutation(
          sessionId,
          {
            identity: authority.identityItem,
            voting: authority.votingItem,
            votes: authority.voteItems,
            expiresAt: authority.expiresAt,
          },
          mutation.nextVoting,
        );
        return;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
      }
    }
    throw new Error('Vote mutation contention limit exceeded');
  }

  async touchSession(sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const authority = await this.loadSessionTtlAuthority(sessionId);
      const next: VotingItem = {
        ...authority.voting,
        record: {
          ...authority.voting.record,
          lastActivityMs: Date.now(),
        },
        revision: authority.voting.revision + 1,
        expiresAt: authority.expiresAt,
      };
      const items: TransactionItems = [
        ...this.buildSessionTtlUpdates(sessionId, authority),
        {
          Put: {
            TableName: this.sessionsTableName,
            Item: next,
            ConditionExpression: '#revision = :expectedRevision AND #expiresAt = :expectedExpiresAt',
            ExpressionAttributeNames: { '#revision': 'revision', '#expiresAt': 'expiresAt' },
            ExpressionAttributeValues: {
              ':expectedRevision': authority.voting.revision,
              ':expectedExpiresAt': authority.voting.expiresAt,
            },
          },
        },
      ];
      this.assertTransactionSize(items);
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: items }));
        return;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
      }
    }
    throw new Error('Session activity contention limit exceeded');
  }

  private async touchSessionAfterCommit(sessionId: string, operation: PostCommitActivityOperation): Promise<void> {
    try {
      await this.touchSession(sessionId);
    } catch (error) {
      if (!isConditionalFailure(error)) {
        logger.warn('[DynamoSessionStore] Post-commit activity touch failed', {
          operation,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
  }

  async getActiveSessionCount(): Promise<number> {
    const now = Date.now();
    let count = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new ScanCommand({
          TableName: this.sessionsTableName,
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      for (const raw of result.Items ?? []) {
        if (!isRecord(raw) || raw['itemType'] !== 'SESSION_IDENTITY') {
          continue;
        }
        const identity = parseIdentityItem(raw);
        if (!identity) {
          continue;
        }
        const voting = await this.loadVotingItem(identity.identity.sessionId);
        if (voting && now - voting.record.lastActivityMs <= FIVE_MINUTES_MS) {
          count += 1;
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return count;
  }

  async getVoteById(sessionId: string, voteId: string): Promise<{ voteData: StoredVoteRecord; index: number } | null> {
    if (!(await this.getSessionIdentity(sessionId))) {
      return null;
    }
    const matches = (await this.loadVoteItems(sessionId)).filter((item) => item.voteId === voteId);
    if (matches.length > 1) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }
    const item = matches[0];
    return item ? { voteData: toStoredVoteRecord(item), index: item.voteIndex } : null;
  }

  async getVoteByIdWithProof(
    sessionId: string,
    voteId: string,
  ): Promise<{
    voteData: StoredVoteRecord;
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null> {
    const vote = await this.getVoteById(sessionId, voteId);
    const voting = await this.getVotingRecord(sessionId);
    if (!vote || !voting) {
      return null;
    }
    return {
      voteData: vote.voteData,
      ...deriveExactCtProof({
        bulletin: voting.bulletin,
        voteId,
        leafIndex: vote.index,
        rootAtCast: vote.voteData.rootAtCast,
      }),
    };
  }

  getVoteProof(voteId: string): Promise<{
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null> {
    void voteId;
    return Promise.resolve(null);
  }

  private readonly lifecyclePersistence: FinalizationLifecyclePersistencePort = {
    loadFinalizationLifecycle: (sessionId, finalizationId) => this.loadFinalizationLifecycle(sessionId, finalizationId),
    applyFinalizationLifecycleMutation: (input) => this.applyFinalizationLifecycleMutation(input),
  };

  private async loadFinalizationLifecycle(
    sessionId: string,
    finalizationId: string,
  ): Promise<FinalizationLifecycleLoadResult> {
    try {
      if (!(await this.getSessionIdentity(sessionId))) {
        return { status: 'missing' };
      }
      const rawPointer = await this.getSessionItem(currentFinalizationKey(sessionId));
      if (rawPointer === undefined || isExpiredItem(rawPointer)) {
        return {
          status: 'loaded',
          lifecycle: {
            authority: { currentRecord: null },
            revision: encodeLifecycleRevision({ currentFinalizationId: null, revision: 0 }),
          },
        };
      }
      const pointer = parseCurrentFinalizationItem(rawPointer, sessionId);
      if (!pointer) {
        return { status: 'invalid_record', error: new Error('Invalid current finalization pointer') };
      }
      const rawRecord = await this.getSessionItem(finalizationKey(sessionId, pointer.currentFinalizationId));
      const item = parseFinalizationItem(rawRecord, sessionId, pointer.currentFinalizationId);
      if (!item || item.revision !== pointer.revision) {
        return { status: 'invalid_record', error: new Error('Invalid current finalization record') };
      }
      void finalizationId;
      return {
        status: 'loaded',
        lifecycle: {
          authority: { currentRecord: item.record },
          revision: encodeLifecycleRevision({
            currentFinalizationId: pointer.currentFinalizationId,
            revision: pointer.revision,
          }),
        },
      };
    } catch (error) {
      return { status: 'persistence_failure', error };
    }
  }

  private async applyFinalizationLifecycleMutation(input: {
    sessionId: string;
    finalizationId: string;
    expectedRevision: FinalizationLifecycleRevision;
    mutations: { nextRecord: FinalizationRecord };
  }): Promise<FinalizationLifecycleApplyResult> {
    const expected = decodeLifecycleRevision(input.expectedRevision);
    const nextRecord = parseFinalizationRecord(input.mutations.nextRecord);
    if (
      !expected ||
      !nextRecord ||
      nextRecord.sessionId !== input.sessionId ||
      nextRecord.finalizationId !== input.finalizationId
    ) {
      return { status: 'invalid_record', error: new Error('Invalid finalization lifecycle mutation') };
    }
    const nextRevision = expected.revision + 1;
    try {
      const ttlPlan = await this.buildArtifactTtlUpdatePlan(input.sessionId, this.artifactExpiresAt());
      const { expiresAt } = ttlPlan;
      const pointerCondition =
        expected.currentFinalizationId === null
          ? {
              ConditionExpression: 'attribute_not_exists(#sessionId)',
              ExpressionAttributeNames: { '#sessionId': 'sessionId' },
            }
          : {
              ConditionExpression: '#revision = :expectedRevision AND #currentFinalizationId = :expectedFinalizationId',
              ExpressionAttributeNames: {
                '#revision': 'revision',
                '#currentFinalizationId': 'currentFinalizationId',
              },
              ExpressionAttributeValues: {
                ':expectedRevision': expected.revision,
                ':expectedFinalizationId': expected.currentFinalizationId,
              },
            };
      const recordCondition =
        expected.currentFinalizationId === null
          ? {
              ConditionExpression: 'attribute_not_exists(#sessionId)',
              ExpressionAttributeNames: { '#sessionId': 'sessionId' },
            }
          : {
              ConditionExpression: '#revision = :expectedRevision',
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':expectedRevision': expected.revision },
            };
      const items: TransactionItems = [
        {
          Put: {
            TableName: this.sessionsTableName,
            Item: {
              sessionId: currentFinalizationKey(input.sessionId),
              itemType: 'FINALIZATION_CURRENT',
              ownerSessionId: input.sessionId,
              currentFinalizationId: input.finalizationId,
              revision: nextRevision,
              expiresAt,
            } satisfies CurrentFinalizationItem,
            ...pointerCondition,
          },
        },
        {
          Put: {
            TableName: this.sessionsTableName,
            Item: {
              sessionId: finalizationKey(input.sessionId, input.finalizationId),
              itemType: 'FINALIZATION',
              ownerSessionId: input.sessionId,
              finalizationId: input.finalizationId,
              record: nextRecord,
              revision: nextRevision,
              expiresAt,
            } satisfies FinalizationItem,
            ...recordCondition,
          },
        },
        ...ttlPlan.items,
      ];
      this.assertTransactionSize(items);
      await this.client.send(new TransactWriteCommand({ TransactItems: items }));
      return {
        status: 'applied',
        lifecycle: {
          authority: { currentRecord: nextRecord },
          revision: encodeLifecycleRevision({
            currentFinalizationId: input.finalizationId,
            revision: nextRevision,
          }),
        },
      };
    } catch (error) {
      if (!isConditionalFailure(error)) {
        return { status: 'persistence_failure', error };
      }
      const reloaded = await this.loadFinalizationLifecycle(input.sessionId, input.finalizationId);
      if (reloaded.status !== 'loaded') {
        return reloaded.status === 'missing'
          ? { status: 'missing' }
          : reloaded.status === 'invalid_record'
            ? reloaded
            : { status: 'persistence_failure', error: reloaded.error };
      }
      if (isDeepStrictEqual(reloaded.lifecycle.authority.currentRecord, nextRecord)) {
        return { status: 'already_applied', lifecycle: reloaded.lifecycle };
      }
      return { status: 'stale', lifecycle: reloaded.lifecycle };
    }
  }

  private resolveCoordinatedRecord(result: FinalizationTransitionCoordinationResult): FinalizationRecord {
    switch (result.status) {
      case 'applied':
      case 'already_applied':
      case 'rejected': {
        const record = result.lifecycle.authority.currentRecord;
        if (!record) {
          throw new Error(`Finalization transition was not applied: ${result.outcome.reason}`);
        }
        return record;
      }
      case 'invalid':
        throw new Error(`Invalid finalization transition: ${result.outcome.reason}`);
      case 'missing':
        throw new Error('Session not found');
      case 'stale': {
        const record = result.lifecycle.authority.currentRecord;
        if (!record) {
          throw new Error('Finalization lifecycle changed concurrently');
        }
        return record;
      }
      case 'invalid_record':
        throw new Error('Invalid persisted finalization record', { cause: result.error });
      case 'persistence_failure':
        throw new Error('Failed to persist finalization transition', { cause: result.error });
    }
  }

  private async applyFinalizationCommand(
    command: FinalizationTransitionCommand,
    observability?: FinalizationQueuedPayload['observability'],
  ): Promise<{
    record: FinalizationRecord;
    coordination: FinalizationTransitionCoordinationResult;
    before: FinalizationRecord | null;
  }> {
    const observed = { before: null as FinalizationRecord | null };
    const observingPersistence: FinalizationLifecyclePersistencePort = {
      loadFinalizationLifecycle: async (sessionId, finalizationId) => {
        const loaded = await this.lifecyclePersistence.loadFinalizationLifecycle(sessionId, finalizationId);
        if (loaded.status === 'loaded') {
          observed.before = loaded.lifecycle.authority.currentRecord;
        }
        return loaded;
      },
      applyFinalizationLifecycleMutation: (input) =>
        this.lifecyclePersistence.applyFinalizationLifecycleMutation(input),
    };
    const coordination = await coordinateFinalizationTransition({
      command,
      evaluatedAtMs: Date.now(),
      persistence: observingPersistence,
      staleRetryLimit: 2,
    });
    const record = this.resolveCoordinatedRecord(coordination);
    const policyReason =
      coordination.status === 'missing' ||
      coordination.status === 'persistence_failure' ||
      coordination.status === 'invalid_record'
        ? undefined
        : coordination.outcome.reason;
    recordFinalizationStorePersistenceOutcome({
      sessionId: command.sessionId,
      requestedFinalizationId: command.finalizationId,
      requestedTo: requestedStatus(command),
      ...(observed.before ? { before: observed.before.state } : {}),
      actual: record.state,
      ...(policyReason && isFinalizationEventReason(policyReason) ? { semanticReason: policyReason } : {}),
      authoritativeWrite: coordination.status === 'applied',
      ...(observability ? { metadata: observability } : {}),
    });
    return { record, coordination, before: observed.before };
  }

  async getCurrentFinalizationRecord(sessionId: string): Promise<FinalizationRecord | null> {
    const loaded = await this.loadFinalizationLifecycle(sessionId, '');
    if (loaded.status === 'missing') {
      return null;
    }
    if (loaded.status !== 'loaded') {
      throw new Error('Failed to load current finalization record', {
        cause: loaded.error,
      });
    }
    return loaded.lifecycle.authority.currentRecord;
  }

  async getFinalizationRecord(sessionId: string, finalizationId: FinalizationId): Promise<FinalizationRecord | null> {
    if (!(await this.getSessionIdentity(sessionId))) {
      return null;
    }
    const raw = await this.getSessionItem(finalizationKey(sessionId, finalizationId));
    if (raw === undefined || isExpiredItem(raw)) {
      return null;
    }
    const item = parseFinalizationItem(raw, sessionId, finalizationId);
    if (!item) {
      throw new Error('Invalid persisted finalization record');
    }
    return item.record;
  }

  async markFinalizationQueued(sessionId: string, payload: FinalizationQueuedPayload): Promise<FinalizationRecord> {
    assertAllowedPayloadKeys(payload, FINALIZATION_QUEUED_PAYLOAD_KEYS, 'queued finalization');
    return (
      await this.applyFinalizationCommand(buildFinalizationCommand(sessionId, payload, 'queue'), payload.observability)
    ).record;
  }

  async markFinalizationRunning(sessionId: string, payload: FinalizationRunningPayload): Promise<FinalizationRecord> {
    assertAllowedPayloadKeys(payload, FINALIZATION_RUNNING_PAYLOAD_KEYS, 'running finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return (
      await this.applyFinalizationCommand(buildFinalizationCommand(sessionId, payload, 'start'), payload.observability)
    ).record;
  }

  async markFinalizationSucceeded(
    sessionId: string,
    payload: FinalizationSucceededPayload,
  ): Promise<FinalizationRecord> {
    assertAllowedPayloadKeys(payload, FINALIZATION_SUCCEEDED_PAYLOAD_KEYS, 'succeeded finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    assertDirectSuccessfulFinalizationPayload(payload);
    const current = await this.getCurrentFinalizationRecord(sessionId);
    const command = buildFinalizationCommand(sessionId, payload, 'succeed');
    const admission = evaluateFinalizationTransition({
      authority: { currentRecord: current },
      command,
      evaluatedAtMs: Date.now(),
    });
    if (admission.kind === 'invalid') {
      throw new Error(`Invalid finalization transition: ${admission.reason}`);
    }
    if (
      current &&
      (current.finalizationId !== payload.finalizationId ||
        current.state.status === 'failed' ||
        current.state.status === 'timeout')
    ) {
      return (await this.applyFinalizationCommand(command, payload.observability)).record;
    }
    const committed = await this.commitSuccessfulFinalization({
      record: buildDirectSuccessfulFinalizationCommitRecord(sessionId, payload, current),
      bitmap: { availability: 'unavailable' },
      ...(payload.observability ? { observability: payload.observability } : {}),
    });
    return committed.record;
  }

  async markFinalizationFailed(sessionId: string, payload: FinalizationFailedPayload): Promise<FinalizationRecord> {
    assertAllowedPayloadKeys(payload, FINALIZATION_FAILED_PAYLOAD_KEYS, 'failed finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return (
      await this.applyFinalizationCommand(buildFinalizationCommand(sessionId, payload, 'fail'), payload.observability)
    ).record;
  }

  async markFinalizationTimedOut(sessionId: string, payload: FinalizationTimedOutPayload): Promise<FinalizationRecord> {
    assertAllowedPayloadKeys(payload, FINALIZATION_TIMED_OUT_PAYLOAD_KEYS, 'timed-out finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return (
      await this.applyFinalizationCommand(
        buildFinalizationCommand(sessionId, payload, 'time_out'),
        payload.observability,
      )
    ).record;
  }

  private async mergeRuntimeMetadata(
    sessionId: string,
    finalizationId: string,
    patch: AwsFinalizationRuntimeMetadata,
  ): Promise<void> {
    const admittedPatch = parseAwsFinalizationRuntimeMetadata(patch);
    if (!admittedPatch) {
      throw new Error('Invalid AWS finalization runtime metadata');
    }
    const key = runtimeMetadataKey(sessionId, finalizationId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const raw = await this.getSessionItem(key);
      const current =
        raw === undefined || isExpiredItem(raw) ? undefined : parseRuntimeMetadataItem(raw, sessionId, finalizationId);
      if (raw !== undefined && !current) {
        throw new Error('Invalid persisted AWS finalization runtime metadata');
      }
      const metadata: AwsFinalizationRuntimeMetadata = {
        ...(current?.metadata ?? {}),
        ...admittedPatch,
        ...(current?.metadata.bundleMetadata || admittedPatch.bundleMetadata
          ? {
              bundleMetadata: {
                ...(current?.metadata.bundleMetadata ?? {}),
                ...(admittedPatch.bundleMetadata ?? {}),
              },
            }
          : {}),
      };
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.sessionsTableName,
            Item: {
              sessionId: key,
              itemType: 'FINALIZATION_RUNTIME',
              ownerSessionId: sessionId,
              finalizationId,
              metadata,
              revision: (current?.revision ?? 0) + 1,
              expiresAt: this.artifactExpiresAt(),
            } satisfies RuntimeMetadataItem,
            ConditionExpression: current ? '#revision = :expectedRevision' : 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: current ? { '#revision': 'revision' } : { '#sessionId': 'sessionId' },
            ...(current ? { ExpressionAttributeValues: { ':expectedRevision': current.revision } } : {}),
          }),
        );
        return;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
      }
    }
  }

  private admitRuntimeMetadata(value: unknown): AwsFinalizationRuntimeMetadata {
    const metadata = parseAwsFinalizationRuntimeMetadata(value);
    if (!metadata) {
      throw new Error('Invalid AWS finalization runtime metadata');
    }
    return metadata;
  }

  private async mergeDeliveryMetadata(
    sessionId: string,
    finalizationId: string,
    patch: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    const admittedPatch = parseAwsVerificationDeliveryMetadata(patch);
    if (!admittedPatch) {
      throw new Error('Invalid AWS verification delivery metadata');
    }
    await this.requireIdentity(sessionId);
    const key = deliveryMetadataKey(sessionId, finalizationId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const raw = await this.getSessionItem(key);
      const current =
        raw === undefined || isExpiredItem(raw) ? undefined : parseDeliveryMetadataItem(raw, sessionId, finalizationId);
      if (raw !== undefined && !current) {
        throw new Error('Invalid persisted AWS verification delivery metadata');
      }
      const metadata = { ...(current?.metadata ?? {}), ...admittedPatch };
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.sessionsTableName,
            Item: {
              sessionId: key,
              itemType: 'VERIFICATION_DELIVERY',
              ownerSessionId: sessionId,
              finalizationId,
              metadata,
              revision: (current?.revision ?? 0) + 1,
              expiresAt: this.artifactExpiresAt(),
            } satisfies DeliveryMetadataItem,
            ConditionExpression: current ? '#revision = :expectedRevision' : 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: current ? { '#revision': 'revision' } : { '#sessionId': 'sessionId' },
            ...(current ? { ExpressionAttributeValues: { ':expectedRevision': current.revision } } : {}),
          }),
        );
        return;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
      }
    }
  }

  async markAwsFinalizationRunning(
    sessionId: string,
    payload: AwsFinalizationRunningPayload,
  ): Promise<FinalizationState> {
    assertAllowedPayloadKeys(payload, AWS_RUNNING_PAYLOAD_KEYS, 'AWS running finalization');
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const runtimeMetadata =
      stepFunctionsArn === undefined ? undefined : this.admitRuntimeMetadata({ stepFunctionsArn });
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, semanticPayload, 'start'),
      semanticPayload.observability,
    );
    if (
      applied.record.finalizationId === payload.finalizationId &&
      applied.record.state.status === 'running' &&
      runtimeMetadata
    ) {
      await this.mergeRuntimeMetadata(sessionId, payload.finalizationId, runtimeMetadata);
    }
    return applied.record.state;
  }

  async markAwsFinalizationSucceeded(
    sessionId: string,
    payload: AwsFinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    assertAllowedPayloadKeys(payload, AWS_SUCCEEDED_PAYLOAD_KEYS, 'AWS succeeded finalization');
    const { stepFunctionsArn, bundleMetadata, finalizationResult, ...common } = payload;
    const current = await this.getCurrentFinalizationRecord(sessionId);
    if (
      current &&
      (current.finalizationId !== payload.finalizationId ||
        (current.state.status !== 'pending' &&
          current.state.status !== 'running' &&
          current.state.status !== 'succeeded'))
    ) {
      return current.state;
    }
    const runtimeMetadata =
      stepFunctionsArn === undefined && bundleMetadata === undefined
        ? undefined
        : this.admitRuntimeMetadata({
            ...(stepFunctionsArn === undefined ? {} : { stepFunctionsArn }),
            ...(bundleMetadata === undefined ? {} : { bundleMetadata }),
          });
    const { bitmapData, ...semanticFinalizationResult } = finalizationResult;
    const requested = parseFinalizationRecord({
      sessionId,
      finalizationId: payload.finalizationId,
      scenarioContext: common.scenarioContext ?? current?.scenarioContext,
      state: {
        status: 'succeeded',
        finalizationId: payload.finalizationId,
        queuedAtMs: common.queuedAtMs,
        startedAtMs: common.startedAtMs,
        completedAtMs: common.completedAtMs,
      },
      finalizationResult: {
        finalizationId: payload.finalizationId,
        ...semanticFinalizationResult,
      },
    });
    if (!requested || requested.state.status !== 'succeeded') {
      throw new Error('Invalid AWS succeeded finalization record');
    }
    const committed = await this.commitSuccessfulFinalization({
      record: requested as Extract<FinalizationRecord, { state: { status: 'succeeded' } }>,
      bitmap: bitmapData ? { availability: 'available', data: bitmapData } : { availability: 'unavailable' },
      ...(runtimeMetadata ? { runtimeMetadata } : {}),
      ...(common.observability ? { observability: common.observability } : {}),
    });
    return committed.record.state;
  }

  async markAwsFinalizationFailed(
    sessionId: string,
    payload: AwsFinalizationFailedPayload,
  ): Promise<FinalizationState> {
    assertAllowedPayloadKeys(payload, AWS_FAILED_PAYLOAD_KEYS, 'AWS failed finalization');
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const runtimeMetadata =
      stepFunctionsArn === undefined ? undefined : this.admitRuntimeMetadata({ stepFunctionsArn });
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, semanticPayload, 'fail'),
      semanticPayload.observability,
    );
    if (
      applied.record.finalizationId === payload.finalizationId &&
      applied.record.state.status === 'failed' &&
      runtimeMetadata
    ) {
      await this.mergeRuntimeMetadata(sessionId, payload.finalizationId, runtimeMetadata);
    }
    return applied.record.state;
  }

  async markAwsFinalizationTimedOut(
    sessionId: string,
    payload: AwsFinalizationTimedOutPayload,
  ): Promise<FinalizationState> {
    assertAllowedPayloadKeys(payload, AWS_TIMED_OUT_PAYLOAD_KEYS, 'AWS timed-out finalization');
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const runtimeMetadata =
      stepFunctionsArn === undefined ? undefined : this.admitRuntimeMetadata({ stepFunctionsArn });
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, semanticPayload, 'time_out'),
      semanticPayload.observability,
    );
    if (
      applied.record.finalizationId === payload.finalizationId &&
      applied.record.state.status === 'timeout' &&
      runtimeMetadata
    ) {
      await this.mergeRuntimeMetadata(sessionId, payload.finalizationId, runtimeMetadata);
    }
    return applied.record.state;
  }

  async getAwsFinalizationRuntimeMetadata(
    sessionId: string,
    finalizationId: string,
  ): Promise<AwsFinalizationRuntimeMetadata | undefined> {
    const raw = await this.getSessionItem(runtimeMetadataKey(sessionId, finalizationId));
    if (raw === undefined || isExpiredItem(raw)) {
      return undefined;
    }
    const item = parseRuntimeMetadataItem(raw, sessionId, finalizationId);
    if (!item) {
      throw new Error('Invalid persisted AWS finalization runtime metadata');
    }
    return cloneRuntimeMetadata(item.metadata);
  }

  recordAwsProofBundlePublication(
    sessionId: string,
    finalizationId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    return this.mergeDeliveryMetadata(sessionId, finalizationId, metadata);
  }

  recordAwsVerificationDeliveryMetadata(
    sessionId: string,
    finalizationId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    return this.mergeDeliveryMetadata(sessionId, finalizationId, metadata);
  }

  async getAwsVerificationDeliveryMetadata(
    sessionId: string,
    finalizationId: string,
  ): Promise<AwsVerificationDeliveryMetadataInput | undefined> {
    const raw = await this.getSessionItem(deliveryMetadataKey(sessionId, finalizationId));
    if (raw === undefined || isExpiredItem(raw)) {
      return undefined;
    }
    const item = parseDeliveryMetadataItem(raw, sessionId, finalizationId);
    if (!item) {
      throw new Error('Invalid persisted AWS verification delivery metadata');
    }
    return { ...item.metadata };
  }

  private async requireSucceededFinalization(
    sessionId: string,
    finalizationId: string,
  ): Promise<Extract<FinalizationRecord, { state: { status: 'succeeded' } }>> {
    const record = await this.getFinalizationRecord(sessionId, finalizationId);
    if (!record || !isSucceededFinalizationRecord(record)) {
      throw new Error('Finalization is unavailable for verification');
    }
    return record;
  }

  async getVerificationResultRecord(
    sessionId: string,
    finalizationId: FinalizationId,
  ): Promise<VerificationResultRecord | null> {
    await this.requireIdentity(sessionId);
    const raw = await this.getSessionItem(verificationKey(sessionId, finalizationId));
    if (raw === undefined || isExpiredItem(raw)) {
      return null;
    }
    const item = parseVerificationItem(raw, sessionId, finalizationId);
    if (!item) {
      throw new Error('Invalid persisted verification result record');
    }
    return item.record;
  }

  private async putVerificationRecord(
    sessionId: string,
    finalizationId: string,
    record: VerificationResultRecord,
    current: VerificationItem | undefined,
    extraItems: TransactionItems = [],
  ): Promise<void> {
    const items: TransactionItems = [
      {
        Put: {
          TableName: this.sessionsTableName,
          Item: {
            sessionId: verificationKey(sessionId, finalizationId),
            itemType: 'VERIFICATION_RESULT',
            ownerSessionId: sessionId,
            finalizationId,
            record,
            revision: (current?.revision ?? 0) + 1,
            expiresAt: this.artifactExpiresAt(),
          } satisfies VerificationItem,
          ConditionExpression: current ? '#revision = :expectedRevision' : 'attribute_not_exists(#sessionId)',
          ExpressionAttributeNames: current ? { '#revision': 'revision' } : { '#sessionId': 'sessionId' },
          ...(current ? { ExpressionAttributeValues: { ':expectedRevision': current.revision } } : {}),
        },
      },
      ...extraItems,
    ];
    this.assertTransactionSize(items);
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
  }

  private async loadVerificationItem(sessionId: string, finalizationId: string): Promise<VerificationItem | undefined> {
    const raw = await this.getSessionItem(verificationKey(sessionId, finalizationId));
    if (raw === undefined || isExpiredItem(raw)) {
      return undefined;
    }
    const item = parseVerificationItem(raw, sessionId, finalizationId);
    if (!item) {
      throw new Error('Invalid persisted verification result record');
    }
    return item;
  }

  async markVerificationRunning(
    sessionId: string,
    finalizationId: FinalizationId,
    report?: VerificationReport,
  ): Promise<VerificationResultRecord> {
    await this.requireSucceededFinalization(sessionId, finalizationId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const current = await this.loadVerificationItem(sessionId, finalizationId);
      if (current && isTerminalVerificationStatus(current.record.verificationResult.status)) {
        return current.record;
      }
      const record = parseVerificationResultRecord({
        sessionId,
        finalizationId,
        verificationResult: {
          status: 'running',
          ...(report ? { report } : {}),
        },
      });
      if (!record) {
        throw new Error('Invalid verification result record');
      }
      const rollbackRaw = await this.getSessionItem(verificationRollbackKey(sessionId, finalizationId));
      const rollback =
        rollbackRaw === undefined || isExpiredItem(rollbackRaw)
          ? undefined
          : parseRollbackItem(rollbackRaw, sessionId, finalizationId);
      if (rollbackRaw !== undefined && !rollback) {
        throw new Error('Invalid verification rollback record');
      }
      const extraItems: TransactionItems = rollback
        ? []
        : [
            {
              Put: {
                TableName: this.sessionsTableName,
                Item: {
                  sessionId: verificationRollbackKey(sessionId, finalizationId),
                  itemType: 'VERIFICATION_ROLLBACK',
                  ownerSessionId: sessionId,
                  finalizationId,
                  record: current?.record ?? null,
                  expiresAt: this.artifactExpiresAt(),
                } satisfies VerificationRollbackItem,
                ConditionExpression: 'attribute_not_exists(#sessionId)',
                ExpressionAttributeNames: { '#sessionId': 'sessionId' },
              },
            },
          ];
      try {
        await this.putVerificationRecord(sessionId, finalizationId, record, current, extraItems);
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
        continue;
      }
      await this.touchSessionAfterCommit(sessionId, 'verification_running');
      return record;
    }
    throw new Error('Verification result contention limit exceeded');
  }

  async rollbackVerificationResult(sessionId: string, finalizationId: FinalizationId): Promise<void> {
    await this.requireSucceededFinalization(sessionId, finalizationId);
    const current = await this.loadVerificationItem(sessionId, finalizationId);
    const rollbackRaw = await this.getSessionItem(verificationRollbackKey(sessionId, finalizationId));
    if (rollbackRaw === undefined || isExpiredItem(rollbackRaw)) {
      return;
    }
    const rollback = parseRollbackItem(rollbackRaw, sessionId, finalizationId);
    if (!rollback) {
      throw new Error('Invalid verification rollback record');
    }
    const condition = current
      ? {
          ConditionExpression: '#revision = :expectedRevision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':expectedRevision': current.revision },
        }
      : {
          ConditionExpression: 'attribute_not_exists(#sessionId)',
          ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        };
    const verificationMutation = rollback.record
      ? {
          Put: {
            TableName: this.sessionsTableName,
            Item: {
              sessionId: verificationKey(sessionId, finalizationId),
              itemType: 'VERIFICATION_RESULT',
              ownerSessionId: sessionId,
              finalizationId,
              record: rollback.record,
              revision: (current?.revision ?? 0) + 1,
              expiresAt: this.artifactExpiresAt(),
            } satisfies VerificationItem,
            ...condition,
          },
        }
      : {
          Delete: {
            TableName: this.sessionsTableName,
            Key: { sessionId: verificationKey(sessionId, finalizationId) },
            ...condition,
          },
        };
    const items: TransactionItems = [
      verificationMutation,
      {
        Delete: {
          TableName: this.sessionsTableName,
          Key: { sessionId: verificationRollbackKey(sessionId, finalizationId) },
          ConditionExpression: 'attribute_exists(#sessionId)',
          ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        },
      },
    ];
    await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    await this.touchSessionAfterCommit(sessionId, 'verification_rollback');
  }

  async completeVerificationResult(
    sessionId: string,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
  ): Promise<VerificationResultRecord> {
    await this.requireSucceededFinalization(sessionId, finalizationId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const current = await this.loadVerificationItem(sessionId, finalizationId);
      if (current && isTerminalVerificationStatus(current.record.verificationResult.status)) {
        return current.record;
      }
      const record = parseVerificationResultRecord({ sessionId, finalizationId, verificationResult });
      if (!record) {
        throw new Error('Invalid verification result record');
      }
      const rollbackRaw = await this.getSessionItem(verificationRollbackKey(sessionId, finalizationId));
      const extraItems: TransactionItems =
        rollbackRaw === undefined
          ? []
          : [
              {
                Delete: {
                  TableName: this.sessionsTableName,
                  Key: { sessionId: verificationRollbackKey(sessionId, finalizationId) },
                },
              },
            ];
      try {
        await this.putVerificationRecord(sessionId, finalizationId, record, current, extraItems);
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
        continue;
      }
      await this.touchSessionAfterCommit(sessionId, 'verification_completion');
      return record;
    }
    throw new Error('Verification result contention limit exceeded');
  }

  async recordVerificationObservation(
    sessionId: string,
    finalizationId: string,
    input: VerificationObservationWrite,
  ): Promise<RecordVerificationObservationResult> {
    await this.requireIdentity(sessionId);
    const write = parseVerificationObservationWrite(input);
    const requested = write ? parseVerificationObservation({ finalizationId, ...write }) : undefined;
    if (!requested) {
      throw new Error('Invalid verification observation');
    }
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const current = await this.getCurrentFinalizationRecord(sessionId);
      const existing = await this.getVerificationObservation(sessionId, finalizationId);
      const resolution = resolveVerificationObservationRecord(
        current?.finalizationId,
        existing ?? undefined,
        requested,
      );
      if (resolution.status !== 'recorded') {
        return resolution;
      }
      const item: ObservationItem = {
        sessionId: observationKey(sessionId, finalizationId),
        itemType: 'VERIFICATION_OBSERVATION',
        ownerSessionId: sessionId,
        finalizationId,
        observation: requested,
        expiresAt: this.artifactExpiresAt(),
      };
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.sessionsTableName,
                  Item: item,
                  ConditionExpression: 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: { '#sessionId': 'sessionId' },
                },
              },
              {
                ConditionCheck: {
                  TableName: this.sessionsTableName,
                  Key: { sessionId: currentFinalizationKey(sessionId) },
                  ConditionExpression: '#currentFinalizationId = :finalizationId',
                  ExpressionAttributeNames: {
                    '#currentFinalizationId': 'currentFinalizationId',
                  },
                  ExpressionAttributeValues: { ':finalizationId': finalizationId },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
        continue;
      }
      await this.touchSessionAfterCommit(sessionId, 'verification_observation');
      return { status: 'recorded' };
    }
    throw new Error('Verification observation contention limit exceeded');
  }

  async getVerificationObservation(sessionId: string, finalizationId: string): Promise<VerificationObservation | null> {
    const raw = await this.getSessionItem(observationKey(sessionId, finalizationId));
    if (raw === undefined || isExpiredItem(raw)) {
      return null;
    }
    const item = parseObservationItem(raw, sessionId, finalizationId);
    if (!item) {
      throw new Error('Invalid persisted verification observation');
    }
    return { ...item.observation };
  }

  async getBitmapData(sessionId: string, finalizationId: FinalizationId): Promise<FinalizationBitmapData | null> {
    const finalization = await this.getFinalizationRecord(sessionId, finalizationId);
    if (!finalization || !isSucceededFinalizationRecord(finalization)) {
      return null;
    }
    const raw = await this.getSessionItem(bitmapKey(sessionId, finalizationId));
    if (raw === undefined || isExpiredItem(raw)) {
      return null;
    }
    const item = parseBitmapItem(raw, sessionId, finalizationId);
    if (!item) {
      return null;
    }
    return admitPersistedFinalizationBitmapData(finalization, item.bitmap) ?? null;
  }

  async commitSuccessfulFinalization(
    input: SuccessfulFinalizationCommitInput & { runtimeMetadata?: AwsFinalizationRuntimeMetadata },
  ): Promise<SuccessfulFinalizationCommitResult> {
    const requested = admitSuccessfulFinalizationCommitRecord(input.record);
    const bitmap = admitFinalizationBitmapDisposition(requested, input.bitmap);
    const receipt = admitSuccessfulFinalizationReceipt(input.receipt);
    const verification = input.verificationResult
      ? parseVerificationResultRecord({
          sessionId: requested.sessionId,
          finalizationId: requested.finalizationId,
          verificationResult: input.verificationResult,
        })
      : undefined;
    if (input.verificationResult && !verification) {
      throw new Error('Invalid verification result record');
    }
    const runtimePatch = input.runtimeMetadata ? this.admitRuntimeMetadata(input.runtimeMetadata) : undefined;

    await this.requireIdentity(requested.sessionId);
    const key = receiptKey(requested.sessionId, requested.finalizationId);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const loaded = await this.loadFinalizationLifecycle(requested.sessionId, requested.finalizationId);
      if (loaded.status !== 'loaded') {
        throw new Error('Finalization lifecycle unavailable for successful commit');
      }
      const revision = decodeLifecycleRevision(loaded.lifecycle.revision);
      const current = loaded.lifecycle.authority.currentRecord;
      if (!revision) {
        throw new Error('Stale successful finalization commit');
      }
      assertSuccessfulFinalizationLifecycleAdmission(requested, current);

      const existingReceiptRaw = await this.getSessionItem(key);
      const existingReceipt =
        existingReceiptRaw === undefined || isExpiredItem(existingReceiptRaw)
          ? undefined
          : parseReceiptItem(existingReceiptRaw, requested.sessionId, requested.finalizationId);
      if (existingReceiptRaw !== undefined && !isExpiredItem(existingReceiptRaw) && !existingReceipt) {
        throw new Error('Invalid persisted finalization receipt');
      }
      const counterRaw = receipt ? await this.getSessionItem('RECEIPT_BOARD_COUNTER') : undefined;
      const counter = counterRaw === undefined ? undefined : parseReceiptCounterItem(counterRaw);
      if (counterRaw !== undefined && !counter) {
        throw new Error('Receipt board counter is corrupt');
      }
      if (existingReceipt && receipt && (!counter || counter.nextBoardIndex <= existingReceipt.boardIndex)) {
        throw new Error('Receipt board counter does not cover the persisted publication');
      }
      const runtimeRaw = runtimePatch
        ? await this.getSessionItem(runtimeMetadataKey(requested.sessionId, requested.finalizationId))
        : undefined;
      const existingRuntime =
        runtimeRaw === undefined || isExpiredItem(runtimeRaw)
          ? undefined
          : parseRuntimeMetadataItem(runtimeRaw, requested.sessionId, requested.finalizationId);
      if (runtimeRaw !== undefined && !isExpiredItem(runtimeRaw) && !existingRuntime) {
        throw new Error('Invalid persisted AWS finalization runtime metadata');
      }
      const runtimeMetadata = runtimePatch
        ? {
            ...(existingRuntime?.metadata ?? {}),
            ...runtimePatch,
            ...(existingRuntime?.metadata.bundleMetadata || runtimePatch.bundleMetadata
              ? {
                  bundleMetadata: {
                    ...(existingRuntime?.metadata.bundleMetadata ?? {}),
                    ...(runtimePatch.bundleMetadata ?? {}),
                  },
                }
              : {}),
          }
        : undefined;
      const deliveryPatch: AwsVerificationDeliveryMetadataInput | undefined = runtimeMetadata?.bundleMetadata
        ? {
            ...(runtimeMetadata.bundleMetadata.s3BundleKey
              ? { s3BundleKey: runtimeMetadata.bundleMetadata.s3BundleKey }
              : {}),
            ...(runtimeMetadata.bundleMetadata.s3UploadedAtMs === undefined
              ? {}
              : { s3UploadedAtMs: runtimeMetadata.bundleMetadata.s3UploadedAtMs }),
          }
        : undefined;
      const deliveryRaw = deliveryPatch
        ? await this.getSessionItem(deliveryMetadataKey(requested.sessionId, requested.finalizationId))
        : undefined;
      const existingDelivery =
        deliveryRaw === undefined || isExpiredItem(deliveryRaw)
          ? undefined
          : parseDeliveryMetadataItem(deliveryRaw, requested.sessionId, requested.finalizationId);
      if (deliveryRaw !== undefined && !isExpiredItem(deliveryRaw) && !existingDelivery) {
        throw new Error('Invalid persisted AWS verification delivery metadata');
      }
      const deliveryMetadata = deliveryPatch ? { ...(existingDelivery?.metadata ?? {}), ...deliveryPatch } : undefined;
      const [bitmapRaw, verificationRaw] = await Promise.all([
        this.getSessionItem(bitmapKey(requested.sessionId, requested.finalizationId)),
        this.getSessionItem(verificationKey(requested.sessionId, requested.finalizationId)),
      ]);
      const bitmapActive = bitmapRaw !== undefined && !isExpiredItem(bitmapRaw);
      const verificationActive = verificationRaw !== undefined && !isExpiredItem(verificationRaw);
      const existingBitmapItem = bitmapActive
        ? parseBitmapItem(bitmapRaw, requested.sessionId, requested.finalizationId)
        : undefined;
      const existingVerificationItem = verificationActive
        ? parseVerificationItem(verificationRaw, requested.sessionId, requested.finalizationId)
        : undefined;
      if (bitmapActive && !existingBitmapItem) {
        throw new Error('Invalid persisted finalization bitmap');
      }
      if (verificationActive && !existingVerificationItem) {
        throw new Error('Invalid persisted verification result record');
      }
      const receiptHash = receipt
        ? (existingReceipt?.receiptHash ?? computeSuccessfulFinalizationReceiptHash(receipt))
        : undefined;
      const boardIndex = receipt
        ? (existingReceipt?.boardIndex ?? counter?.nextBoardIndex ?? FIRST_RECEIPT_BOARD_INDEX)
        : undefined;
      const receiptPublication =
        receipt && receiptHash !== undefined && boardIndex !== undefined
          ? { receiptHash, boardIndex, timestamp: receipt.timestamp }
          : undefined;
      const committed = parseFinalizationRecord({
        ...requested,
        finalizationResult: {
          ...requested.finalizationResult,
          ...(receiptPublication ? { receiptPublication } : {}),
        },
      });
      if (!committed || committed.state.status !== 'succeeded') {
        throw new Error('Invalid successful finalization commit');
      }
      const successful = committed as Extract<FinalizationRecord, { state: { status: 'succeeded' } }>;
      const outcome: SuccessfulFinalizationCommitResult = {
        record: successful,
        bitmap,
        ...(receiptPublication ? { receiptPublication } : {}),
      };

      if (current?.state.status === 'succeeded') {
        const existingBitmap = existingBitmapItem?.bitmap;
        const existingVerification = existingVerificationItem?.record;
        const expectedBitmap =
          bitmap.availability === 'available'
            ? {
                sessionId: requested.sessionId,
                finalizationId: requested.finalizationId,
                ...bitmap.data,
              }
            : undefined;
        if (
          !isDeepStrictEqual(current, committed) ||
          !isDeepStrictEqual(existingReceipt?.receipt, receipt) ||
          !isDeepStrictEqual(existingBitmap, expectedBitmap) ||
          (verification !== undefined && !isDeepStrictEqual(existingVerification, verification)) ||
          (runtimeMetadata !== undefined && !isDeepStrictEqual(existingRuntime?.metadata, runtimeMetadata)) ||
          (deliveryMetadata !== undefined && !isDeepStrictEqual(existingDelivery?.metadata, deliveryMetadata))
        ) {
          throw new Error('Successful finalization commit conflicts with existing authority');
        }
        return outcome;
      }

      if (bitmapActive || verificationActive) {
        throw new Error('Successful finalization artifacts exist before terminal authority');
      }
      if (existingReceipt || existingReceiptRaw !== undefined) {
        throw new Error('Successful finalization receipt exists before terminal authority');
      }

      const nextRevision = revision.revision + 1;
      const ttlPlan = await this.buildArtifactTtlUpdatePlan(requested.sessionId, this.artifactExpiresAt());
      const { expiresAt } = ttlPlan;
      const pointerCondition =
        revision.currentFinalizationId === null
          ? {
              ConditionExpression: 'attribute_not_exists(#sessionId)',
              ExpressionAttributeNames: { '#sessionId': 'sessionId' },
            }
          : {
              ConditionExpression: '#revision = :expectedRevision AND #currentFinalizationId = :finalizationId',
              ExpressionAttributeNames: {
                '#revision': 'revision',
                '#currentFinalizationId': 'currentFinalizationId',
              },
              ExpressionAttributeValues: {
                ':expectedRevision': revision.revision,
                ':finalizationId': requested.finalizationId,
              },
            };
      const items: TransactionItems = [
        {
          Put: {
            TableName: this.sessionsTableName,
            Item: {
              sessionId: currentFinalizationKey(requested.sessionId),
              itemType: 'FINALIZATION_CURRENT',
              ownerSessionId: requested.sessionId,
              currentFinalizationId: requested.finalizationId,
              revision: nextRevision,
              expiresAt,
            } satisfies CurrentFinalizationItem,
            ...pointerCondition,
          },
        },
        {
          Put: {
            TableName: this.sessionsTableName,
            Item: {
              sessionId: finalizationKey(requested.sessionId, requested.finalizationId),
              itemType: 'FINALIZATION',
              ownerSessionId: requested.sessionId,
              finalizationId: requested.finalizationId,
              record: committed,
              revision: nextRevision,
              expiresAt,
            } satisfies FinalizationItem,
            ConditionExpression:
              revision.currentFinalizationId === null
                ? 'attribute_not_exists(#sessionId)'
                : '#revision = :expectedRevision',
            ExpressionAttributeNames:
              revision.currentFinalizationId === null ? { '#sessionId': 'sessionId' } : { '#revision': 'revision' },
            ...(revision.currentFinalizationId === null
              ? {}
              : { ExpressionAttributeValues: { ':expectedRevision': revision.revision } }),
          },
        },
        ...(receipt && receiptPublication
          ? [
              {
                Put: {
                  TableName: this.sessionsTableName,
                  Item: {
                    sessionId: key,
                    itemType: 'FINALIZATION_RECEIPT',
                    ownerSessionId: requested.sessionId,
                    finalizationId: requested.finalizationId,
                    receiptHash: receiptPublication.receiptHash,
                    boardIndex: receiptPublication.boardIndex,
                    receipt: { ...receipt },
                    expiresAt,
                  } satisfies ReceiptItem,
                  ConditionExpression: 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: { '#sessionId': 'sessionId' },
                },
              },
              {
                Put: {
                  TableName: this.sessionsTableName,
                  Item: {
                    sessionId: 'RECEIPT_BOARD_COUNTER',
                    itemType: 'RECEIPT_COUNTER',
                    nextBoardIndex: receiptPublication.boardIndex + 1,
                  } satisfies ReceiptCounterItem,
                  ConditionExpression: counter
                    ? '#nextBoardIndex = :expectedNextBoardIndex'
                    : 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: counter
                    ? { '#nextBoardIndex': 'nextBoardIndex' }
                    : { '#sessionId': 'sessionId' },
                  ...(counter
                    ? { ExpressionAttributeValues: { ':expectedNextBoardIndex': counter.nextBoardIndex } }
                    : {}),
                },
              },
            ]
          : []),
        ...(verification
          ? [
              {
                Put: {
                  TableName: this.sessionsTableName,
                  Item: {
                    sessionId: verificationKey(requested.sessionId, requested.finalizationId),
                    itemType: 'VERIFICATION_RESULT',
                    ownerSessionId: requested.sessionId,
                    finalizationId: requested.finalizationId,
                    record: verification,
                    revision: 1,
                    expiresAt,
                  } satisfies VerificationItem,
                  ConditionExpression: 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: { '#sessionId': 'sessionId' },
                },
              },
            ]
          : [
              {
                ConditionCheck: {
                  TableName: this.sessionsTableName,
                  Key: { sessionId: verificationKey(requested.sessionId, requested.finalizationId) },
                  ConditionExpression: 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: { '#sessionId': 'sessionId' },
                },
              },
            ]),
        ...(bitmap.availability === 'available'
          ? [
              {
                Put: {
                  TableName: this.sessionsTableName,
                  Item: {
                    sessionId: bitmapKey(requested.sessionId, requested.finalizationId),
                    itemType: 'FINALIZATION_BITMAP',
                    ownerSessionId: requested.sessionId,
                    finalizationId: requested.finalizationId,
                    bitmap: {
                      sessionId: requested.sessionId,
                      finalizationId: requested.finalizationId,
                      ...bitmap.data,
                    },
                    expiresAt,
                  } satisfies BitmapItem,
                  ConditionExpression: 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: { '#sessionId': 'sessionId' },
                },
              },
            ]
          : [
              {
                ConditionCheck: {
                  TableName: this.sessionsTableName,
                  Key: { sessionId: bitmapKey(requested.sessionId, requested.finalizationId) },
                  ConditionExpression: 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: { '#sessionId': 'sessionId' },
                },
              },
            ]),
        ...(runtimeMetadata
          ? [
              {
                Put: {
                  TableName: this.sessionsTableName,
                  Item: {
                    sessionId: runtimeMetadataKey(requested.sessionId, requested.finalizationId),
                    itemType: 'FINALIZATION_RUNTIME',
                    ownerSessionId: requested.sessionId,
                    finalizationId: requested.finalizationId,
                    metadata: runtimeMetadata,
                    revision: (existingRuntime?.revision ?? 0) + 1,
                    expiresAt,
                  } satisfies RuntimeMetadataItem,
                  ConditionExpression: existingRuntime
                    ? '#revision = :expectedRevision'
                    : 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: existingRuntime
                    ? { '#revision': 'revision' }
                    : { '#sessionId': 'sessionId' },
                  ...(existingRuntime
                    ? { ExpressionAttributeValues: { ':expectedRevision': existingRuntime.revision } }
                    : {}),
                },
              },
            ]
          : []),
        ...(deliveryMetadata
          ? [
              {
                Put: {
                  TableName: this.sessionsTableName,
                  Item: {
                    sessionId: deliveryMetadataKey(requested.sessionId, requested.finalizationId),
                    itemType: 'VERIFICATION_DELIVERY',
                    ownerSessionId: requested.sessionId,
                    finalizationId: requested.finalizationId,
                    metadata: deliveryMetadata,
                    revision: (existingDelivery?.revision ?? 0) + 1,
                    expiresAt,
                  } satisfies DeliveryMetadataItem,
                  ConditionExpression: existingDelivery
                    ? '#revision = :expectedRevision'
                    : 'attribute_not_exists(#sessionId)',
                  ExpressionAttributeNames: existingDelivery
                    ? { '#revision': 'revision' }
                    : { '#sessionId': 'sessionId' },
                  ...(existingDelivery
                    ? { ExpressionAttributeValues: { ':expectedRevision': existingDelivery.revision } }
                    : {}),
                },
              },
            ]
          : []),
        ...ttlPlan.items,
      ];
      this.assertTransactionSize(items);
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: items }));
        recordFinalizationStorePersistenceOutcome({
          sessionId: requested.sessionId,
          requestedFinalizationId: requested.finalizationId,
          requestedTo: 'succeeded',
          ...(current ? { before: current.state } : {}),
          actual: committed.state,
          authoritativeWrite: true,
          metadata: input.observability ?? { source: 'finalize', reason: 'STATE_PERSISTED' },
        });
        return outcome;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt + 1 === MAX_CONDITIONAL_RETRIES) {
          throw error;
        }
      }
    }
    throw new Error('Successful finalization commit contention limit exceeded');
  }
}
