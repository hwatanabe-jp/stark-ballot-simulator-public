import crypto from 'crypto';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSharedDynamoDocumentClient } from '@stark-ballot/aws-adapters/aws/dynamodbConfig';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { deriveExactCtProof } from '@stark-ballot/aws-adapters/store/ct-proof';
import { assertWritableBitmapSidecarOwner } from '@stark-ballot/aws-adapters/store/finalizationArtifactAdmission';
import { deserializeSession, serializeSession } from '@stark-ballot/aws-adapters/store/fileMock/sessionSerde';
import type {
  BitmapData,
  ReceiptEntry,
  SerializableSessionData,
} from '@stark-ballot/aws-adapters/store/fileMock/types';
import { MockSessionStore } from '@stark-ballot/aws-adapters/store/mockSessionStore';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { isRecoverableCurrentLiveSession } from '@stark-ballot/domain/contract';
import { encryptVoteSecret, decryptVoteSecret } from '@stark-ballot/aws-adapters/security/voteSecretCipher';
import { isValidHexString, normalizeHex } from '@stark-ballot/domain/utils/hex';
import { VOTE_CHOICES, type VoteChoice } from '@stark-ballot/domain/shared/constants';
import type { AddVoteResult, RootSnapshot, SessionData, VoteData } from '@stark-ballot/domain/types/server';
import type {
  FinalizationFailedPayload,
  FinalizationRunningPayload,
  FinalizationSucceededPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type {
  CompleteVerificationResultPayload,
  MarkVerificationRunningPayload,
  RollbackVerificationResultPayload,
} from '@stark-ballot/application/finalize/finalization-result-store';
import type {
  FinalizationResultAuthority,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import { parseFinalizationState } from '@stark-ballot/application/finalize/finalization-storage';
import {
  parseAwsFinalizationRuntimeState,
  parseAwsPersistedFinalizationResult,
  type AwsPersistedFinalizationResult,
  type AwsPersistedVerificationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import type {
  AwsFinalizationFailedPayload,
  AwsFinalizationRunningPayload,
  AwsFinalizationSucceededPayload,
  AwsFinalizationTimedOutPayload,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import type { SessionStoreUpdate, SessionSummary } from '@stark-ballot/domain/types/voteStore';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

type MockSessionStoreInternals = {
  sessions: Map<string, SessionData>;
  voteIdIndex: Map<string, { sessionId: string; index: number }>;
};

interface DynamoSessionStoreConfig {
  sessionsTableName?: string;
  votesTableName?: string;
  documentClient?: DynamoDBDocumentClient;
}

interface SessionItem {
  sessionId: string;
  itemType: 'SESSION';
  session: SerializableSessionData;
  createdAt: number;
  lastActivity: number;
  finalized: boolean;
  botCount: number;
  contractGeneration?: string;
  finalizationContractGeneration?: string;
  finalizationArtifactState?: SessionData['finalizationArtifactState'];
  expiresAt: number;
}

interface VoteItem {
  sessionId: string;
  voteIndex: number;
  voteId: string;
  vote: string;
  rand: string;
  commit: string;
  path?: string[];
  timestamp?: number;
  rootAtCast?: string;
  treeSize?: number;
  isUserVote: boolean;
  expiresAt: number;
}

const MAX_DYNAMODB_TRANSACTION_ITEMS = 100;
const MAX_RECEIPT_BOARD_COUNTER_RETRIES = 3;
type DynamoPutTransactionItem = {
  Put: {
    TableName: string;
    Item: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
};
type DynamoUpdateTransactionItem = {
  Update: {
    TableName: string;
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
};
type DynamoTransactionItem = DynamoPutTransactionItem | DynamoUpdateTransactionItem;

interface ReceiptPublicationTransaction {
  receiptHash: string;
  boardIndex: number;
  items: DynamoTransactionItem[];
}

interface PersistSessionOptions {
  rejectExistingUserVote?: boolean;
  finalizationGuard?: FinalizationPersistGuard;
  additionalTransactItems?: DynamoTransactionItem[];
}

interface TransactionCancellationReason {
  Code?: string;
}

interface TransactionCanceledWithReasons extends Error {
  CancellationReasons?: TransactionCancellationReason[];
}

interface StrictDynamoCtState {
  bulletin?: SimpleBulletinBoard;
  bulletinRootHistory: RootSnapshot[];
}

interface DynamoCondition {
  expression: string;
  names: Record<string, string>;
  values?: Record<string, unknown>;
}

interface FinalizationPersistGuard {
  voteCount: number;
  botCount: number;
  userVoteIndex?: number;
  bulletinRootHistory: RootSnapshot[];
  finalized: boolean;
  contractGeneration?: string;
  finalizationContractGeneration?: string;
  finalizationArtifactState?: SessionData['finalizationArtifactState'];
  finalizationState?: {
    status: FinalizationState['status'];
    executionId: string;
  };
  verificationExecutionId?: string;
}

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

function cloneBitmapData(bitmapData: BitmapData): BitmapData {
  return {
    ...bitmapData,
    includedBitmap: [...bitmapData.includedBitmap],
    ...(bitmapData.seenBitmap ? { seenBitmap: [...bitmapData.seenBitmap] } : {}),
  };
}

function buildBitmapDataSidecarPut(
  session: SessionData,
  sessionsTableName: string,
  expiresAt: number,
): DynamoTransactionItem | null {
  const bitmapData = parseAwsPersistedFinalizationResult(session.finalizationResult)?.bitmapData;
  if (!bitmapData) {
    return null;
  }

  const storedBitmapData: BitmapData = cloneBitmapData({ sessionId: session.sessionId, ...bitmapData });
  return {
    Put: {
      TableName: sessionsTableName,
      Item: {
        sessionId: `BITMAP#${session.sessionId}`,
        itemType: 'BITMAP',
        bitmapData: storedBitmapData,
        expiresAt,
      },
    },
  };
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isExpiredItem(value: { expiresAt?: unknown } | null | undefined): boolean {
  return typeof value?.expiresAt === 'number' && value.expiresAt <= nowEpochSeconds();
}

function throwCtProofUnavailable(): never {
  throw new Error('CT_PROOF_UNAVAILABLE');
}

function computeReceiptHash(receipt: { receipt: string; timestamp: number }): string {
  const hash = crypto.createHash('sha256');
  hash.update(receipt.receipt);
  hash.update(receipt.timestamp.toString());
  return `0x${hash.digest('hex')}`;
}

function isDynamoConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ConditionalCheckFailedException' || error.message.includes('ConditionalCheckFailedException'))
  );
}

function getTransactionCancellationReasons(error: unknown): TransactionCancellationReason[] | null {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') {
    return null;
  }
  const reasons = (error as TransactionCanceledWithReasons).CancellationReasons;
  return Array.isArray(reasons) ? reasons : null;
}

function isVerifiedReceiptCounterContention(error: unknown, counterReasonIndex: number): boolean {
  const reasons = getTransactionCancellationReasons(error);
  if (!reasons || counterReasonIndex < 0 || counterReasonIndex >= reasons.length) {
    return false;
  }
  return reasons.every((reason, index) => {
    const code = reason.Code ?? 'None';
    if (index === counterReasonIndex) {
      return code === 'ConditionalCheckFailed';
    }
    return code === 'None';
  });
}

function normalizeStrictHex32(value: unknown): string {
  if (typeof value !== 'string' || !isValidHexString(value, 32)) {
    throwCtProofUnavailable();
  }
  return normalizeHex(value, { allowOddLength: false });
}

function normalizeOptionalHex32(value: unknown): string | null {
  if (typeof value !== 'string' || !isValidHexString(value, 32)) {
    return null;
  }
  return normalizeHex(value, { allowOddLength: false });
}

function resolvePositiveTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  throwCtProofUnavailable();
}

function parsePersistedFinalizationState(value: unknown): FinalizationState | undefined {
  return parseAwsFinalizationRuntimeState(value) ?? parseFinalizationState(value);
}

function validateRootHistorySnapshot(value: unknown): RootSnapshot {
  if (typeof value !== 'object' || value === null) {
    throwCtProofUnavailable();
  }
  const snapshot = value as { root?: unknown; treeSize?: unknown; timestamp?: unknown; signature?: unknown };
  const root = normalizeStrictHex32(snapshot.root);
  const treeSize = snapshot.treeSize;
  if (typeof treeSize !== 'number' || !Number.isInteger(treeSize) || treeSize <= 0) {
    throwCtProofUnavailable();
  }
  const normalized: RootSnapshot = {
    root,
    treeSize,
    timestamp: resolvePositiveTimestamp(snapshot.timestamp),
  };
  if (typeof snapshot.signature === 'string') {
    normalized.signature = snapshot.signature;
  }
  return normalized;
}

function resolveFinalizationBulletinRoot(sessionData: SerializableSessionData): string | undefined {
  const finalizationResult = sessionData.finalizationResult;
  if (!finalizationResult) {
    return undefined;
  }
  const journalRoot = finalizationResult.journal.bulletinRoot;
  if (typeof journalRoot === 'string' && journalRoot.length > 0) {
    return journalRoot;
  }
  const mirroredFinalizationResult = finalizationResult as { bulletinRoot?: unknown };
  const mirroredRoot = mirroredFinalizationResult.bulletinRoot;
  return typeof mirroredRoot === 'string' && mirroredRoot.length > 0 ? mirroredRoot : undefined;
}

function validateStrictDynamoCtState(
  sessionData: SerializableSessionData,
  voteRows: Array<[number, VoteData]>,
): StrictDynamoCtState {
  if (voteRows.length === 0) {
    if (Array.isArray(sessionData.bulletinRootHistory) && sessionData.bulletinRootHistory.length > 0) {
      throwCtProofUnavailable();
    }
    return { bulletinRootHistory: [] };
  }

  if (!sessionData.logId) {
    throwCtProofUnavailable();
  }

  const bulletin = new SimpleBulletinBoard(sessionData.logId);
  const reconstructedHistory: RootSnapshot[] = [];
  for (const [index, vote] of voteRows) {
    if (!Number.isInteger(index) || index !== reconstructedHistory.length) {
      throwCtProofUnavailable();
    }
    const voteId = vote.voteId;
    if (!voteId) {
      throwCtProofUnavailable();
    }
    const commitment = normalizeStrictHex32(vote.commit);
    const expectedRootAtCast = normalizeStrictHex32(vote.rootAtCast);
    let appendResult;
    try {
      appendResult = bulletin.appendVote(voteId, commitment.slice(2));
    } catch {
      throwCtProofUnavailable();
    }
    const reconstructedRoot = normalizeStrictHex32(appendResult.rootAtAppend);
    if (appendResult.index !== index || reconstructedRoot !== expectedRootAtCast) {
      throwCtProofUnavailable();
    }
    reconstructedHistory.push({
      timestamp:
        typeof vote.timestamp === 'number' && Number.isInteger(vote.timestamp) && vote.timestamp > 0
          ? vote.timestamp
          : appendResult.timestamp,
      treeSize: appendResult.index + 1,
      root: reconstructedRoot,
    });
  }

  if (!Array.isArray(sessionData.bulletinRootHistory)) {
    throwCtProofUnavailable();
  }
  const persistedHistory = sessionData.bulletinRootHistory.map(validateRootHistorySnapshot);
  if (persistedHistory.length !== reconstructedHistory.length) {
    throwCtProofUnavailable();
  }

  const restoredHistory = reconstructedHistory.map((snapshot, index) => {
    const persistedSnapshot = persistedHistory[index];
    if (!persistedSnapshot) {
      throwCtProofUnavailable();
    }
    if (persistedSnapshot.treeSize !== snapshot.treeSize || persistedSnapshot.root !== snapshot.root) {
      throwCtProofUnavailable();
    }
    return {
      ...snapshot,
      timestamp: persistedSnapshot.timestamp,
      ...(typeof persistedSnapshot.signature === 'string' ? { signature: persistedSnapshot.signature } : {}),
    };
  });

  const finalSnapshot = restoredHistory[restoredHistory.length - 1];
  if (!finalSnapshot) {
    throwCtProofUnavailable();
  }
  if (
    finalSnapshot.treeSize !== bulletin.getSize() ||
    finalSnapshot.root !== normalizeStrictHex32(bulletin.getCurrentRoot())
  ) {
    throwCtProofUnavailable();
  }

  const finalizationBulletinRoot = resolveFinalizationBulletinRoot(sessionData);
  if (finalizationBulletinRoot && normalizeStrictHex32(finalizationBulletinRoot) !== finalSnapshot.root) {
    throwCtProofUnavailable();
  }

  return {
    bulletin,
    bulletinRootHistory: restoredHistory,
  };
}

function toBoundedVerificationResult(
  result: AwsPersistedVerificationResult | undefined,
): AwsPersistedVerificationResult | undefined {
  if (!result) {
    return undefined;
  }
  return {
    status: result.status,
    ...(result.s3BundleKey ? { s3BundleKey: result.s3BundleKey } : {}),
    ...(result.s3ReportKey ? { s3ReportKey: result.s3ReportKey } : {}),
    ...(result.s3UploadedAt ? { s3UploadedAt: result.s3UploadedAt } : {}),
    ...(result.executionId ? { executionId: result.executionId } : {}),
  };
}

function toBoundedFinalizationResult(
  result: SessionData['finalizationResult'],
): AwsPersistedFinalizationResult | undefined {
  const authority = parseAwsPersistedFinalizationResult(result);
  if (!authority?.journal) {
    return undefined;
  }

  const verificationResult = toBoundedVerificationResult(authority.verificationResult);
  return omitUndefinedProperties({
    tally: authority.tally,
    ...(authority.s3BundleKey ? { s3BundleKey: authority.s3BundleKey } : {}),
    ...(authority.s3UploadedAt ? { s3UploadedAt: authority.s3UploadedAt } : {}),
    ...(authority.receiptPublication ? { receiptPublication: authority.receiptPublication } : {}),
    imageId: authority.imageId,
    ...(authority.tamperDetected !== undefined ? { tamperDetected: authority.tamperDetected } : {}),
    ...(authority.scenarios ? { scenarios: authority.scenarios } : {}),
    journal: authority.journal,
    ...(authority.publicInputArtifact ? { publicInputArtifact: authority.publicInputArtifact } : {}),
    ...(authority.electionManifest ? { electionManifest: authority.electionManifest } : {}),
    ...(authority.closeStatement ? { closeStatement: authority.closeStatement } : {}),
    ...(authority.bitmapProofSource ? { bitmapProofSource: authority.bitmapProofSource } : {}),
    ...(verificationResult ? { verificationResult } : {}),
    ...(authority.verificationExecutionId ? { verificationExecutionId: authority.verificationExecutionId } : {}),
    ...(authority.tamperSummary ? { tamperSummary: authority.tamperSummary } : {}),
  });
}

function toSessionItem(session: SessionData, expiresAt: number): SessionItem {
  const serializedSession = serializeSession(session);
  return {
    sessionId: session.sessionId,
    itemType: 'SESSION',
    session: omitUndefinedProperties({
      ...serializedSession,
      finalizationResult: toBoundedFinalizationResult(session.finalizationResult),
      votes: [],
    }),
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    finalized: session.finalized,
    botCount: session.botCount,
    ...omitUndefinedProperties({
      contractGeneration: session.contractGeneration,
      finalizationContractGeneration: session.finalizationContractGeneration,
      finalizationArtifactState: session.finalizationArtifactState,
    }),
    expiresAt,
  };
}

function buildFinalizationPersistCondition(guard: FinalizationPersistGuard): DynamoCondition {
  const names: Record<string, string> = {
    '#session': 'session',
    '#botCount': 'botCount',
    '#userVoteIndex': 'userVoteIndex',
    '#bulletinRootHistory': 'bulletinRootHistory',
    '#finalized': 'finalized',
    '#contractGeneration': 'contractGeneration',
    '#finalizationContractGeneration': 'finalizationContractGeneration',
    '#finalizationArtifactState': 'finalizationArtifactState',
    '#finalizationState': 'finalizationState',
  };
  const values: Record<string, unknown> = {
    ':expectedVoteCount': guard.voteCount,
    ':expectedBotCount': guard.botCount,
    ':expectedFinalized': guard.finalized,
  };
  const parts = [
    '#botCount = :expectedBotCount',
    'size(#session.#bulletinRootHistory) = :expectedVoteCount',
    '#finalized = :expectedFinalized',
  ];

  if (guard.userVoteIndex !== undefined) {
    parts.push('#session.#userVoteIndex = :expectedUserVoteIndex');
    values[':expectedUserVoteIndex'] = guard.userVoteIndex;
  } else {
    parts.push('attribute_not_exists(#session.#userVoteIndex)');
  }

  if (guard.contractGeneration) {
    parts.push('#session.#contractGeneration = :expectedContractGeneration');
    values[':expectedContractGeneration'] = guard.contractGeneration;
  } else {
    parts.push('attribute_not_exists(#session.#contractGeneration)');
  }

  if (guard.finalizationContractGeneration) {
    parts.push('#session.#finalizationContractGeneration = :expectedFinalizationContractGeneration');
    values[':expectedFinalizationContractGeneration'] = guard.finalizationContractGeneration;
  } else {
    parts.push('attribute_not_exists(#session.#finalizationContractGeneration)');
  }

  if (guard.finalizationArtifactState) {
    parts.push('#session.#finalizationArtifactState = :expectedFinalizationArtifactState');
    values[':expectedFinalizationArtifactState'] = guard.finalizationArtifactState;
  } else {
    parts.push('attribute_not_exists(#session.#finalizationArtifactState)');
  }

  if (guard.finalizationState) {
    names['#status'] = 'status';
    names['#executionId'] = 'executionId';
    parts.push('#session.#finalizationState.#status = :expectedFinalizationStateStatus');
    parts.push('#session.#finalizationState.#executionId = :expectedFinalizationStateExecutionId');
    values[':expectedFinalizationStateStatus'] = guard.finalizationState.status;
    values[':expectedFinalizationStateExecutionId'] = guard.finalizationState.executionId;
  } else {
    parts.push('attribute_not_exists(#session.#finalizationState)');
  }

  names['#finalizationResult'] = 'finalizationResult';
  names['#verificationExecutionId'] = 'verificationExecutionId';
  if (guard.verificationExecutionId) {
    parts.push('#session.#finalizationResult.#verificationExecutionId = :expectedVerificationExecutionId');
    values[':expectedVerificationExecutionId'] = guard.verificationExecutionId;
  } else {
    parts.push('attribute_not_exists(#session.#finalizationResult.#verificationExecutionId)');
  }

  return {
    expression: parts.map((part) => `(${part})`).join(' AND '),
    names,
    values,
  };
}

function toVoteItem(sessionId: string, voteIndex: number, voteData: VoteData, expiresAt: number): VoteItem {
  if (!voteData.voteId) {
    throw new Error('Vote ID missing for DynamoDB vote persistence.');
  }
  return omitUndefinedProperties({
    sessionId,
    voteIndex,
    voteId: voteData.voteId,
    vote: encryptVoteSecret(voteData.vote),
    rand: encryptVoteSecret(voteData.rand),
    commit: voteData.commit,
    path: Array.isArray(voteData.path) ? [...voteData.path] : [],
    timestamp: voteData.timestamp,
    rootAtCast: voteData.rootAtCast,
    treeSize: voteData.treeSize,
    isUserVote: voteIndex === 0,
    expiresAt,
  });
}

function toDomainVoteData(item: VoteItem): VoteData {
  try {
    const decryptedVote = decryptVoteSecret(item.vote);
    if (!VOTE_CHOICES.includes(decryptedVote as VoteChoice)) {
      throwCtProofUnavailable();
    }

    return omitUndefinedProperties({
      voteId: item.voteId,
      vote: decryptedVote as VoteChoice,
      rand: normalizeHex(decryptVoteSecret(item.rand), { allowEmpty: true }),
      commit: item.commit,
      path: Array.isArray(item.path) ? [...item.path] : [],
      timestamp: item.timestamp,
      rootAtCast: item.rootAtCast,
      treeSize: item.treeSize,
    });
  } catch {
    throwCtProofUnavailable();
  }
}

function persistedVoteMatchesSessionVote(existingItem: VoteItem, voteData: VoteData, voteIndex: number): boolean {
  const existingVote = toDomainVoteData(existingItem);
  return (
    existingItem.voteIndex === voteIndex &&
    existingItem.isUserVote === (voteIndex === 0) &&
    existingVote.voteId === voteData.voteId &&
    existingVote.vote === voteData.vote &&
    existingVote.rand === voteData.rand &&
    existingVote.commit === voteData.commit &&
    existingVote.timestamp === voteData.timestamp &&
    existingVote.rootAtCast === voteData.rootAtCast
  );
}

function addExpectedVoteAttribute(
  parts: string[],
  names: Record<string, string>,
  values: Record<string, unknown>,
  attributeName: keyof VoteItem,
  placeholder: string,
  expectedValue: unknown,
): void {
  const namePlaceholder = `#${String(attributeName)}`;
  names[namePlaceholder] = String(attributeName);
  if (expectedValue === undefined) {
    parts.push(`attribute_not_exists(${namePlaceholder})`);
    return;
  }
  parts.push(`${namePlaceholder} = ${placeholder}`);
  values[placeholder] = expectedValue;
}

function buildExistingVoteRowCondition(existingItem: VoteItem): DynamoCondition {
  const names: Record<string, string> = {
    '#sessionId': 'sessionId',
  };
  const values: Record<string, unknown> = {};
  const parts = ['attribute_exists(#sessionId)'];

  addExpectedVoteAttribute(parts, names, values, 'voteId', ':expectedVoteId', existingItem.voteId);
  addExpectedVoteAttribute(parts, names, values, 'vote', ':expectedVote', existingItem.vote);
  addExpectedVoteAttribute(parts, names, values, 'rand', ':expectedRand', existingItem.rand);
  addExpectedVoteAttribute(parts, names, values, 'commit', ':expectedCommit', existingItem.commit);
  addExpectedVoteAttribute(parts, names, values, 'timestamp', ':expectedTimestamp', existingItem.timestamp);
  addExpectedVoteAttribute(parts, names, values, 'rootAtCast', ':expectedRootAtCast', existingItem.rootAtCast);
  addExpectedVoteAttribute(parts, names, values, 'treeSize', ':expectedTreeSize', existingItem.treeSize);
  addExpectedVoteAttribute(parts, names, values, 'isUserVote', ':expectedIsUserVote', existingItem.isUserVote);

  return {
    expression: parts.map((part) => `(${part})`).join(' AND '),
    names,
    values,
  };
}

function isSessionItem(value: unknown): value is SessionItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { itemType?: unknown }).itemType === 'SESSION' &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    typeof (value as { session?: unknown }).session === 'object'
  );
}

function isVoteItem(value: unknown): value is VoteItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    typeof (value as { voteIndex?: unknown }).voteIndex === 'number' &&
    typeof (value as { voteId?: unknown }).voteId === 'string' &&
    typeof (value as { vote?: unknown }).vote === 'string' &&
    typeof (value as { rand?: unknown }).rand === 'string' &&
    typeof (value as { commit?: unknown }).commit === 'string'
  );
}

export class DynamoSessionStore extends MockSessionStore {
  private readonly sessionsTableName: string;
  private readonly votesTableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(config: DynamoSessionStoreConfig = {}) {
    super();
    this.sessionsTableName = requireTableName(
      config.sessionsTableName ?? process.env['DYNAMODB_SESSIONS_TABLE'],
      'DYNAMODB_SESSIONS_TABLE',
    );
    this.votesTableName = requireTableName(
      config.votesTableName ?? process.env['DYNAMODB_VOTES_TABLE'],
      'DYNAMODB_VOTES_TABLE',
    );
    this.client = config.documentClient ?? getSharedDynamoDocumentClient();
  }

  private liveSessionTtlSeconds(): number {
    return readPositiveIntegerEnv('SESSION_LIVE_TTL_SECONDS', 5 * 60);
  }

  private verificationArtifactTtlSeconds(): number {
    return readPositiveIntegerEnv('VERIFICATION_ARTIFACT_TTL_SECONDS', 2 * 60 * 60);
  }

  private resolveExpiresAt(session: Pick<SessionData, 'finalized'>): number {
    const ttlSeconds = session.finalized ? this.verificationArtifactTtlSeconds() : this.liveSessionTtlSeconds();
    return Math.floor(Date.now() / 1000) + ttlSeconds;
  }

  private internals(): MockSessionStoreInternals {
    return this as unknown as MockSessionStoreInternals;
  }

  private rememberSession(session: SessionData): void {
    const internals = this.internals();
    internals.sessions.set(session.sessionId, session);
    for (const [index, voteData] of session.votes.entries()) {
      if (voteData.voteId) {
        internals.voteIdIndex.set(voteData.voteId, { sessionId: session.sessionId, index });
      }
    }
  }

  private forgetSession(sessionId: string): void {
    const internals = this.internals();
    internals.sessions.delete(sessionId);
    for (const [voteId, entry] of internals.voteIdIndex.entries()) {
      if (entry.sessionId === sessionId) {
        internals.voteIdIndex.delete(voteId);
      }
    }
  }

  private async requireSession(sessionId: string): Promise<SessionData> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    return session;
  }

  private buildFinalizationGuard(session: SessionData): FinalizationPersistGuard {
    const finalizationState = parsePersistedFinalizationState(session.finalizationState);
    const finalizationResult = parseAwsPersistedFinalizationResult(session.finalizationResult);
    return omitUndefinedProperties({
      voteCount: session.votes.size,
      botCount: session.botCount,
      userVoteIndex: session.userVoteIndex,
      bulletinRootHistory: session.bulletinRootHistory ? structuredClone(session.bulletinRootHistory) : [],
      finalized: session.finalized,
      ...omitUndefinedProperties({ contractGeneration: session.contractGeneration }),
      finalizationContractGeneration: session.finalizationContractGeneration,
      finalizationArtifactState: session.finalizationArtifactState,
      verificationExecutionId: finalizationResult?.verificationExecutionId,
      ...(finalizationState
        ? {
            finalizationState: {
              status: finalizationState.status,
              executionId: finalizationState.executionId,
            },
          }
        : {}),
    });
  }

  private async reloadPersistedSessionAfterFailedWrite(sessionId: string): Promise<SessionData | null> {
    this.forgetSession(sessionId);
    return this.getPersistedSession(sessionId);
  }

  private async persistFinalizationTransition(
    sessionId: string,
    guard: FinalizationPersistGuard,
  ): Promise<SessionData | null> {
    const session = await super.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    try {
      await this.persistSession(session, { finalizationGuard: guard });
      return null;
    } catch (error) {
      const persisted = await this.reloadPersistedSessionAfterFailedWrite(sessionId);
      if (isDynamoConditionalCheckFailed(error)) {
        if (persisted) {
          return persisted;
        }
        throw error;
      }
      throw error;
    }
  }

  private async loadVoteItems(sessionId: string): Promise<Map<number, VoteItem>> {
    const rows = new Map<number, VoteItem>();
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.votesTableName,
          KeyConditionExpression: '#sessionId = :sessionId',
          ExpressionAttributeNames: {
            '#sessionId': 'sessionId',
          },
          ExpressionAttributeValues: {
            ':sessionId': sessionId,
          },
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      for (const item of result.Items ?? []) {
        if (!isVoteItem(item)) {
          throw new Error('CT_PROOF_UNAVAILABLE');
        }
        if (isExpiredItem(item)) {
          throw new Error('CT_PROOF_UNAVAILABLE');
        }
        if (rows.has(item.voteIndex)) {
          throwCtProofUnavailable();
        }
        rows.set(item.voteIndex, item);
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    const sortedRows = Array.from(rows.entries()).sort(([a], [b]) => a - b);
    for (const [expectedIndex, [actualIndex]] of sortedRows.entries()) {
      if (!Number.isInteger(actualIndex) || actualIndex < 0 || actualIndex !== expectedIndex) {
        throwCtProofUnavailable();
      }
    }

    return rows;
  }

  private async loadVoteRows(sessionId: string): Promise<Array<[number, VoteData]>> {
    const rows = await this.loadVoteItems(sessionId);
    return Array.from(rows.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, item]) => [index, toDomainVoteData(item)]);
  }

  private async persistSession(session: SessionData, options: PersistSessionOptions = {}): Promise<void> {
    const expiresAt = this.resolveExpiresAt(session);
    const existingVoteItems = await this.loadVoteItems(session.sessionId);
    let sessionCondition = options.rejectExistingUserVote
      ? 'attribute_exists(#sessionId) AND attribute_not_exists(#session.#userVoteIndex)'
      : 'attribute_exists(#sessionId)';
    const expressionAttributeNames: Record<string, string> = {
      '#sessionId': 'sessionId',
      ...(options.rejectExistingUserVote ? { '#session': 'session', '#userVoteIndex': 'userVoteIndex' } : {}),
    };
    let expressionAttributeValues: Record<string, unknown> | undefined;
    if (options.finalizationGuard) {
      const guardCondition = buildFinalizationPersistCondition(options.finalizationGuard);
      sessionCondition = `${sessionCondition} AND ${guardCondition.expression}`;
      Object.assign(expressionAttributeNames, guardCondition.names);
      expressionAttributeValues = {
        ...(expressionAttributeValues ?? {}),
        ...(guardCondition.values ?? {}),
      };
    }
    const transactItems: DynamoTransactionItem[] = [
      {
        Put: {
          TableName: this.sessionsTableName,
          Item: toSessionItem(session, expiresAt) as unknown as Record<string, unknown>,
          ConditionExpression: sessionCondition,
          ExpressionAttributeNames: expressionAttributeNames,
          ...(expressionAttributeValues ? { ExpressionAttributeValues: expressionAttributeValues } : {}),
        },
      },
    ];

    for (const [voteIndex, voteData] of session.votes.entries()) {
      const existingVoteItem = existingVoteItems.get(voteIndex);
      if (existingVoteItem) {
        if (!persistedVoteMatchesSessionVote(existingVoteItem, voteData, voteIndex)) {
          throw new Error('DynamoDB vote row conflict for existing vote index.');
        }
        const condition = buildExistingVoteRowCondition(existingVoteItem);
        transactItems.push({
          Put: {
            TableName: this.votesTableName,
            Item: { ...existingVoteItem, expiresAt },
            ConditionExpression: condition.expression,
            ...omitUndefinedProperties({
              ExpressionAttributeNames: condition.names,
              ExpressionAttributeValues: condition.values,
            }),
          },
        });
        continue;
      }
      transactItems.push({
        Put: {
          TableName: this.votesTableName,
          Item: toVoteItem(session.sessionId, voteIndex, voteData, expiresAt) as unknown as Record<string, unknown>,
          ConditionExpression: 'attribute_not_exists(#sessionId)',
          ExpressionAttributeNames: {
            '#sessionId': 'sessionId',
          },
        },
      });
    }
    transactItems.push(...(options.additionalTransactItems ?? []));
    const bitmapDataSidecarPut = buildBitmapDataSidecarPut(session, this.sessionsTableName, expiresAt);
    if (bitmapDataSidecarPut) {
      transactItems.push(bitmapDataSidecarPut);
    }

    if (transactItems.length > MAX_DYNAMODB_TRANSACTION_ITEMS) {
      throw new Error('DynamoDB transaction item limit exceeded for session persistence.');
    }

    await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }));
  }

  private async getPersistedSession(sessionId: string): Promise<SessionData | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.sessionsTableName,
        Key: { sessionId },
        ConsistentRead: true,
      }),
    );

    if (!isSessionItem(result.Item)) {
      this.forgetSession(sessionId);
      return null;
    }

    if (isExpiredItem(result.Item)) {
      this.forgetSession(sessionId);
      return null;
    }

    const votes = await this.loadVoteRows(sessionId);
    const sessionData: SerializableSessionData = {
      ...result.Item.session,
      votes,
    };
    const strictCtState = validateStrictDynamoCtState(sessionData, votes);
    const session = deserializeSession({
      ...sessionData,
      bulletinRootHistory: strictCtState.bulletinRootHistory,
    });
    if (strictCtState.bulletin) {
      session.bulletin = strictCtState.bulletin;
    }
    session.bulletinRootHistory = strictCtState.bulletinRootHistory;
    this.rememberSession(session);
    return session;
  }

  async createSession(): Promise<SessionData> {
    const session = await super.createSession();
    const expiresAt = this.resolveExpiresAt(session);
    await this.client.send(
      new PutCommand({
        TableName: this.sessionsTableName,
        Item: toSessionItem(session, expiresAt),
        ConditionExpression: 'attribute_not_exists(#sessionId)',
        ExpressionAttributeNames: {
          '#sessionId': 'sessionId',
        },
      }),
    );
    return session;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    return this.getPersistedSession(sessionId);
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    return omitUndefinedProperties({
      sessionId: session.sessionId,
      botCount: session.botCount,
      ...omitUndefinedProperties({ contractGeneration: session.contractGeneration }),
      finalizationArtifactState: session.finalizationArtifactState,
      userVoteIndex: session.userVoteIndex,
      finalized: session.finalized,
    });
  }

  async addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult> {
    await this.requireSession(sessionId);
    const result = await super.addVote(sessionId, voteData);
    const session = await super.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    await this.persistSession(session, { rejectExistingUserVote: true });
    return result;
  }

  async addBotVotes(sessionId: string, votes: VoteData[]): Promise<void> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    await super.addBotVotes(sessionId, votes);
    const session = await super.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    try {
      await this.persistSession(session, { finalizationGuard: guard });
    } catch (error) {
      await this.reloadPersistedSessionAfterFailedWrite(sessionId);
      throw error;
    }
  }

  async updateSession(sessionId: string, data?: SessionStoreUpdate): Promise<SessionData | void> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const result = await super.updateSession(sessionId, data);
    const session = await super.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    try {
      await this.persistSession(session, { finalizationGuard: guard });
    } catch (error) {
      const persisted = await this.reloadPersistedSessionAfterFailedWrite(sessionId);
      if (isDynamoConditionalCheckFailed(error)) {
        if (data) {
          return persisted ?? undefined;
        }
        return undefined;
      }
      throw error;
    }
    return result;
  }

  async repairFinalizationResult(sessionId: string): Promise<void> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    await super.repairFinalizationResult(sessionId);
    await this.persistFinalizationCommandResult(sessionId, guard);
  }

  async markVerificationRunning(sessionId: string, payload: MarkVerificationRunningPayload): Promise<void> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    await super.markVerificationRunning(sessionId, payload);
    await this.persistFinalizationCommandResult(sessionId, guard);
  }

  async rollbackVerificationResult(sessionId: string, payload: RollbackVerificationResultPayload): Promise<void> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    await super.rollbackVerificationResult(sessionId, payload);
    await this.persistFinalizationCommandResult(sessionId, guard);
  }

  async completeVerificationResult(sessionId: string, payload: CompleteVerificationResultPayload): Promise<void> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    await super.completeVerificationResult(sessionId, payload);
    await this.persistFinalizationCommandResult(sessionId, guard);
  }

  private async persistFinalizationCommandResult(sessionId: string, guard: FinalizationPersistGuard): Promise<void> {
    const session = await super.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    try {
      await this.persistSession(session, { finalizationGuard: guard });
    } catch (error) {
      await this.reloadPersistedSessionAfterFailedWrite(sessionId);
      throw error;
    }
  }

  async updateFinalizationArtifactMetadata(
    sessionId: string,
    metadata: {
      finalizationContractGeneration?: string;
      hasPersistedFinalizationBranch?: boolean;
      finalizationArtifactState?: SessionData['finalizationArtifactState'];
    },
  ): Promise<SessionData | void> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const result = await super.updateFinalizationArtifactMetadata(sessionId, metadata);
    const session = await super.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    try {
      await this.persistSession(session, { finalizationGuard: guard });
    } catch (error) {
      const persisted = await this.reloadPersistedSessionAfterFailedWrite(sessionId);
      if (isDynamoConditionalCheckFailed(error)) {
        return persisted ?? undefined;
      }
      throw error;
    }
    return result;
  }

  async markFinalizationQueued(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      contractGeneration: string;
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markFinalizationQueued(sessionId, payload);
    const current = await this.persistFinalizationTransition(sessionId, guard);
    const persistedState = parsePersistedFinalizationState(current?.finalizationState);
    if (persistedState) {
      return persistedState;
    }
    return state;
  }

  async markFinalizationRunning(
    sessionId: string,
    payload: FinalizationRunningPayload & {
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markFinalizationRunning(sessionId, payload);
    return this.persistFinalizationTransitionState(sessionId, guard, state);
  }

  override async markAwsFinalizationRunning(
    sessionId: string,
    payload: AwsFinalizationRunningPayload,
  ): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markAwsFinalizationRunning(sessionId, payload);
    return this.persistFinalizationTransitionState(sessionId, guard, state);
  }

  async markFinalizationSucceeded(
    sessionId: string,
    payload: FinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markFinalizationSucceeded(sessionId, payload);
    return this.persistFinalizationTransitionState(sessionId, guard, state);
  }

  override async markAwsFinalizationSucceeded(
    sessionId: string,
    payload: AwsFinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markAwsFinalizationSucceeded(sessionId, payload);
    return this.persistFinalizationTransitionState(sessionId, guard, state);
  }

  async markFinalizationFailed(sessionId: string, payload: FinalizationFailedPayload): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markFinalizationFailed(sessionId, payload);
    return this.persistFinalizationTransitionState(sessionId, guard, state);
  }

  override async markAwsFinalizationFailed(
    sessionId: string,
    payload: AwsFinalizationFailedPayload,
  ): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markAwsFinalizationFailed(sessionId, payload);
    return this.persistFinalizationTransitionState(sessionId, guard, state);
  }

  async markFinalizationTimedOut(sessionId: string, payload: FinalizationTimedOutPayload): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markFinalizationTimedOut(sessionId, payload);
    return this.persistFinalizationTransitionState(sessionId, guard, state);
  }

  override async markAwsFinalizationTimedOut(
    sessionId: string,
    payload: AwsFinalizationTimedOutPayload,
  ): Promise<FinalizationState> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    const state = await super.markAwsFinalizationTimedOut(sessionId, payload);
    return this.persistFinalizationTransitionState(sessionId, guard, state);
  }

  private async persistFinalizationTransitionState(
    sessionId: string,
    guard: FinalizationPersistGuard,
    state: FinalizationState,
  ): Promise<FinalizationState> {
    const current = await this.persistFinalizationTransition(sessionId, guard);
    const persistedState = parsePersistedFinalizationState(current?.finalizationState);
    if (persistedState) {
      return persistedState;
    }
    return state;
  }

  async getActiveSessionCount(): Promise<number> {
    const cutoff = Date.now() - this.liveSessionTtlSeconds() * 1000;
    let count = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(
        new ScanCommand({
          TableName: this.sessionsTableName,
          FilterExpression: '#itemType = :session AND #lastActivity > :cutoff',
          ExpressionAttributeNames: {
            '#itemType': 'itemType',
            '#lastActivity': 'lastActivity',
          },
          ExpressionAttributeValues: {
            ':session': 'SESSION',
            ':cutoff': cutoff,
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      for (const item of result.Items ?? []) {
        if (!isSessionItem(item)) {
          continue;
        }
        if (isExpiredItem(item)) {
          continue;
        }
        const session = deserializeSession(item.session);
        if (isRecoverableCurrentLiveSession(session)) {
          count += 1;
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return count;
  }

  async finalizeSession(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string | undefined,
    executionId: string,
  ): Promise<void> {
    const guard = this.buildFinalizationGuard(await this.requireSession(sessionId));
    if (!contractGeneration) {
      throw new Error('contractGeneration is required to finalize a DynamoDB session');
    }
    await super.finalizeSession(sessionId, result, contractGeneration, executionId);
    const session = await super.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    try {
      await this.persistSession(session, { finalizationGuard: guard });
    } catch (error) {
      await this.reloadPersistedSessionAfterFailedWrite(sessionId);
      throw error;
    }
  }

  async finalizeSessionWithReceiptPublication(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
    receipt: { receipt: string; timestamp: number },
    executionId: string,
  ): Promise<{ receiptHash: string; boardIndex: number }> {
    const existingSession = await this.requireSession(sessionId);
    const guard = this.buildFinalizationGuard(existingSession);
    let lastPublication: ReceiptPublicationTransaction | null = null;

    for (let attempt = 0; attempt <= MAX_RECEIPT_BOARD_COUNTER_RETRIES; attempt += 1) {
      const sessionForAttempt = await this.requireSession(sessionId);
      const publication = await this.buildReceiptPublicationTransaction(
        sessionId,
        receipt,
        this.resolveExpiresAt(sessionForAttempt),
      );
      lastPublication = publication;
      const persisted = parseAwsPersistedFinalizationResult(result);
      if (!persisted) {
        throw new Error('Invalid finalization result persistence payload');
      }
      const resultWithPublication: AwsPersistedFinalizationResult = {
        ...persisted,
        receiptPublication: {
          receiptHash: publication.receiptHash,
          boardIndex: publication.boardIndex,
          timestamp: receipt.timestamp,
        },
      };
      await super.finalizeSession(sessionId, resultWithPublication, contractGeneration, executionId);
      const session = await super.getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      try {
        await this.persistSession(session, {
          finalizationGuard: guard,
          additionalTransactItems: publication.items,
        });
        return {
          receiptHash: publication.receiptHash,
          boardIndex: publication.boardIndex,
        };
      } catch (error) {
        await this.reloadPersistedSessionAfterFailedWrite(sessionId);
        const counterReasonIndex = 1 + session.votes.size;
        if (
          attempt < MAX_RECEIPT_BOARD_COUNTER_RETRIES &&
          isVerifiedReceiptCounterContention(error, counterReasonIndex)
        ) {
          continue;
        }
        throw error;
      }
    }

    if (!lastPublication) {
      throw new Error('Receipt publication was not attempted.');
    }
    return {
      receiptHash: lastPublication.receiptHash,
      boardIndex: lastPublication.boardIndex,
    };
  }

  async getVoteById(sessionId: string, voteId: string): Promise<{ voteData: VoteData; index: number } | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    for (const [index, voteData] of session.votes.entries()) {
      if (voteData.voteId === voteId) {
        return { voteData, index };
      }
    }
    return null;
  }

  async getVoteByIdWithProof(
    sessionId: string,
    voteId: string,
  ): Promise<{
    voteData: VoteData;
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null> {
    const voteInfo = await this.getVoteById(sessionId, voteId);
    if (!voteInfo) {
      return null;
    }
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    return {
      voteData: voteInfo.voteData,
      ...deriveExactCtProof(
        omitUndefinedProperties({
          bulletin: session.bulletin,
          voteId: voteInfo.voteData.voteId,
          leafIndex: voteInfo.index,
          rootAtCast: voteInfo.voteData.rootAtCast,
        }),
      ),
    };
  }

  getVoteProof(voteId: string): Promise<null> {
    void voteId;
    return Promise.resolve(null);
  }

  async saveBitmapData(
    sessionId: string,
    bitmapData: {
      includedBitmap: boolean[];
      includedBitmapRoot: string;
      seenBitmap?: boolean[];
      seenBitmapRoot?: string;
      treeSize: number;
      finalizedAt: number;
    },
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    assertWritableBitmapSidecarOwner(session);
    const storedBitmapData: BitmapData = cloneBitmapData({ sessionId, ...bitmapData });
    await this.client.send(
      new PutCommand({
        TableName: this.sessionsTableName,
        Item: {
          sessionId: `BITMAP#${sessionId}`,
          itemType: 'BITMAP',
          bitmapData: storedBitmapData,
          expiresAt: this.resolveExpiresAt(session),
        },
      }),
    );
  }

  private validateBitmapDataForFinalizedJournal(session: SessionData, bitmapData: BitmapData): BitmapData | null {
    const journal = parseAwsPersistedFinalizationResult(session.finalizationResult)?.journal;
    if (!journal || bitmapData.sessionId !== session.sessionId) {
      return null;
    }
    if (bitmapData.treeSize !== journal.treeSize || bitmapData.includedBitmap.length !== journal.treeSize) {
      return null;
    }

    const journalIncludedRoot = normalizeOptionalHex32(journal.includedBitmapRoot);
    const storedIncludedRoot = normalizeOptionalHex32(bitmapData.includedBitmapRoot);
    const computedIncludedRoot = normalizeOptionalHex32(computeIncludedBitmapRoot(bitmapData.includedBitmap));
    if (
      !journalIncludedRoot ||
      !storedIncludedRoot ||
      !computedIncludedRoot ||
      storedIncludedRoot !== journalIncludedRoot ||
      computedIncludedRoot !== journalIncludedRoot
    ) {
      return null;
    }

    if (bitmapData.seenBitmap || bitmapData.seenBitmapRoot) {
      const journalSeenRoot = normalizeOptionalHex32(journal.seenBitmapRoot);
      const storedSeenRoot = normalizeOptionalHex32(bitmapData.seenBitmapRoot);
      if (!journalSeenRoot || !storedSeenRoot || !bitmapData.seenBitmap) {
        return null;
      }
      if (bitmapData.seenBitmap.length !== journal.treeSize) {
        return null;
      }
      const computedSeenRoot = normalizeOptionalHex32(computeIncludedBitmapRoot(bitmapData.seenBitmap));
      if (!computedSeenRoot || storedSeenRoot !== journalSeenRoot || computedSeenRoot !== journalSeenRoot) {
        return null;
      }
    }

    return cloneBitmapData(bitmapData);
  }

  async getBitmapData(sessionId: string): Promise<BitmapData | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    const result = await this.client.send(
      new GetCommand({
        TableName: this.sessionsTableName,
        Key: { sessionId: `BITMAP#${sessionId}` },
        ConsistentRead: true,
      }),
    );
    if (isExpiredItem(result.Item)) {
      return null;
    }
    const bitmapData = (result.Item as { bitmapData?: BitmapData } | undefined)?.bitmapData;
    if (bitmapData?.sessionId !== session.sessionId) {
      return null;
    }
    return this.validateBitmapDataForFinalizedJournal(session, bitmapData);
  }

  private async buildReceiptPublicationTransaction(
    sessionId: string,
    receipt: { receipt: string; timestamp: number },
    expiresAt: number,
  ): Promise<ReceiptPublicationTransaction> {
    const receiptHash = computeReceiptHash(receipt);
    const counterResult = await this.client.send(
      new GetCommand({
        TableName: this.sessionsTableName,
        Key: { sessionId: 'RECEIPT_BOARD_COUNTER' },
        ConsistentRead: true,
      }),
    );
    const currentCounter = (counterResult.Item as { value?: unknown } | undefined)?.value;
    if (currentCounter !== undefined && typeof currentCounter !== 'number') {
      throw new Error('Receipt board counter is corrupt.');
    }
    const boardIndex = currentCounter === undefined ? 100 : currentCounter + 1;
    const receiptEntry: ReceiptEntry = {
      receiptHash,
      boardIndex,
      receipt,
    };
    const counterExpressionAttributeValues: Record<string, unknown> = {
      ':nextValue': boardIndex,
      ':itemType': 'RECEIPT_COUNTER',
    };
    let counterCondition = 'attribute_not_exists(#value)';
    if (currentCounter !== undefined) {
      counterCondition = '#value = :currentValue';
      counterExpressionAttributeValues[':currentValue'] = currentCounter;
    }

    return {
      receiptHash,
      boardIndex,
      items: [
        {
          Update: {
            TableName: this.sessionsTableName,
            Key: { sessionId: 'RECEIPT_BOARD_COUNTER' },
            UpdateExpression: 'SET #value = :nextValue, #itemType = :itemType',
            ConditionExpression: counterCondition,
            ExpressionAttributeNames: {
              '#value': 'value',
              '#itemType': 'itemType',
            },
            ExpressionAttributeValues: counterExpressionAttributeValues,
          },
        },
        {
          Put: {
            TableName: this.sessionsTableName,
            Item: {
              sessionId: `RECEIPT#${sessionId}`,
              itemType: 'RECEIPT',
              receiptEntry,
              expiresAt,
            },
            ConditionExpression: 'attribute_not_exists(#sessionId)',
            ExpressionAttributeNames: {
              '#sessionId': 'sessionId',
            },
          },
        },
      ],
    };
  }
}
