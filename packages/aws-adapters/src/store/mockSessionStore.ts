/**
 * In-memory session store for local development and tests.
 *
 * Each lifecycle owns its own record index. This adapter never composes or
 * persists the retired all-purpose session aggregate.
 */

import { encodeFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-storage';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
  cloneSuccessfulFinalizationRecord,
  isSuccessfulFinalizationRecord,
} from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import {
  buildFinalizationCommand,
  requestedFinalizationStatus,
  type FinalizationBitmapRecord,
  type FinalizationFailedPayload,
  type FinalizationQueuedPayload,
  type FinalizationRunningPayload,
  type FinalizationStore,
  type SuccessfulFinalizationCommitInput,
  type SuccessfulFinalizationCommitResult,
  type FinalizationSucceededPayload,
  type FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import {
  finalizationRecordCodec,
  type FinalizationRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import {
  parseVerificationResultRecord,
  type VerificationResultRecord,
  type VerificationResultStore,
} from '@stark-ballot/application/finalize/finalization-result-store';
import {
  evaluateFinalizationTransition,
  type FinalizationTransitionCommand,
  type FinalizationTransitionOutcome,
} from '@stark-ballot/application/finalize/finalization-transition-policy';
import type { FinalizationId, FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import {
  buildSessionRecords,
  evaluateSessionVoteMutation,
} from '@stark-ballot/application/session/session-mutation-policy';
import type {
  SessionVoteMutationStore,
  SessionVoteStoreError,
} from '@stark-ballot/application/session/session-vote-store';
import { ApplicationErrorCode, type Result } from '@stark-ballot/application';
import {
  assertNoAwsRuntimeTransitionMetadata,
  type AwsFinalizationFailedPayload,
  type AwsFinalizationRuntimeMetadata,
  type AwsFinalizationRunningPayload,
  type AwsFinalizationRuntimeTransitionStore,
  type AwsFinalizationSucceededPayload,
  type AwsFinalizationTimedOutPayload,
  type AwsSucceededTransitionMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import {
  InMemoryAwsVerificationDeliveryMetadataStore,
  type AwsFinalizationDeliveryMetadataStore,
  type AwsVerificationDeliveryMetadataInput,
} from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import { parseAwsFinalizationRuntimeMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationMetadataAdmission';
import { recordFinalizationStorePersistenceOutcome } from '@stark-ballot/aws-adapters/finalize/finalizationTransitionObservability';
import { deriveExactCtProof } from '@stark-ballot/aws-adapters/store/ct-proof';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type {
  AddVoteResult,
  BotVoteCommand,
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
  UserVoteCommand,
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
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import { createElectionId } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { generateLogId } from '@stark-ballot/zkvm-contract/zkvm/log-id';
import { computeSuccessfulFinalizationReceiptHash } from './successfulFinalizationReceipt';

type AppliedFinalizationTransition = {
  record: FinalizationRecord;
  mutated: boolean;
  outcome: Exclude<FinalizationTransitionOutcome, { kind: 'invalid' }>;
};

interface ReceiptEntry {
  receiptHash: string;
  boardIndex: number;
  receipt: { receipt: string; timestamp: number };
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const VOTE_RECORD_KEYS = new Set(['voteId', 'vote', 'rand', 'commit', 'timestamp', 'rootAtCast']);
const VOTING_RECORD_KEYS = new Set([
  'sessionId',
  'votes',
  'bulletin',
  'bulletinRootHistory',
  'botCount',
  'userParticipation',
  'lastActivityMs',
]);
const NOT_CAST_KEYS = new Set(['status']);
const CAST_KEYS = new Set(['status', 'voteIndex']);
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
const AWS_SUCCEEDED_PAYLOAD_KEYS = new Set([
  ...FINALIZATION_SUCCEEDED_PAYLOAD_KEYS,
  'stepFunctionsArn',
  'bundleMetadata',
]);

function buildScopedKey(sessionId: SessionId, finalizationId: string): string {
  return `${sessionId}\u0000${finalizationId}`;
}

function deleteSessionScopedRecords<T>(records: Map<string, T>, sessionId: SessionId): void {
  const prefix = `${sessionId}\u0000`;
  for (const key of records.keys()) {
    if (key.startsWith(prefix)) {
      records.delete(key);
    }
  }
}

function hasExactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function assertAllowedPayloadKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`Invalid ${label} payload`);
  }
}

function isStoredVoteRecord(value: unknown): value is StoredVoteRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, VOTE_RECORD_KEYS)) {
    return false;
  }
  const vote = value as Record<string, unknown>;
  return (
    typeof vote['voteId'] === 'string' &&
    typeof vote['vote'] === 'string' &&
    typeof vote['rand'] === 'string' &&
    typeof vote['commit'] === 'string' &&
    typeof vote['timestamp'] === 'number' &&
    Number.isSafeInteger(vote['timestamp']) &&
    vote['timestamp'] >= 0 &&
    typeof vote['rootAtCast'] === 'string'
  );
}

function isVotingRecord(value: unknown, identity: SessionIdentityRecord): value is SessionVotingRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, VOTING_RECORD_KEYS)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const sessionId = candidate['sessionId'];
  const votes = candidate['votes'];
  const bulletin = candidate['bulletin'];
  const bulletinRootHistory = candidate['bulletinRootHistory'];
  const botCount = candidate['botCount'];
  const lastActivityMs = candidate['lastActivityMs'];
  const userParticipation = candidate['userParticipation'];
  if (
    sessionId !== identity.sessionId ||
    !(votes instanceof Map) ||
    !(bulletin instanceof SimpleBulletinBoard) ||
    bulletin.getLogId() !== identity.logId ||
    !Array.isArray(bulletinRootHistory) ||
    typeof botCount !== 'number' ||
    !Number.isSafeInteger(botCount) ||
    botCount < 0 ||
    typeof lastActivityMs !== 'number' ||
    !Number.isSafeInteger(lastActivityMs) ||
    lastActivityMs < 0 ||
    !userParticipation ||
    typeof userParticipation !== 'object' ||
    Array.isArray(userParticipation)
  ) {
    return false;
  }
  const participation = userParticipation as Record<string, unknown>;
  const participationStatus = participation['status'];
  if (
    (participationStatus === 'not_cast' && !hasExactKeys(participation, NOT_CAST_KEYS)) ||
    (participationStatus === 'cast' &&
      (!hasExactKeys(participation, CAST_KEYS) ||
        typeof participation['voteIndex'] !== 'number' ||
        !Number.isSafeInteger(participation['voteIndex']) ||
        participation['voteIndex'] < 0 ||
        !votes.has(participation['voteIndex']))) ||
    (participationStatus !== 'not_cast' && participationStatus !== 'cast')
  ) {
    return false;
  }
  for (const [index, vote] of votes) {
    if (!Number.isSafeInteger(index) || index < 0 || !isStoredVoteRecord(vote)) {
      return false;
    }
  }
  return true;
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

function cloneVoting(voting: SessionVotingRecord): SessionVotingRecord {
  return {
    ...voting,
    votes: new Map(Array.from(voting.votes, ([index, vote]) => [index, { ...vote }])),
    bulletinRootHistory: voting.bulletinRootHistory.map((snapshot) => ({ ...snapshot })),
    userParticipation: { ...voting.userParticipation },
  };
}

function isTerminalVerificationStatus(status: VerificationResult['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'dev_mode';
}

export class MockSessionStore
  implements
    VoteStore,
    SessionVoteMutationStore,
    FinalizationStore,
    VerificationResultStore,
    AwsFinalizationRuntimeTransitionStore,
    AwsFinalizationDeliveryMetadataStore
{
  private identityRecords = new Map<string, SessionIdentityRecord>();
  private votingRecords = new Map<string, SessionVotingRecord>();
  private finalizationRecords = new Map<string, FinalizationRecord>();
  private currentFinalizationIdBySession = new Map<string, FinalizationId>();
  private verificationResultRecords = new Map<string, VerificationResultRecord>();
  private verificationObservationRecords = new Map<string, VerificationObservation>();
  private bitmapRecords = new Map<string, FinalizationBitmapRecord>();
  private voteIdIndex = new Map<string, { sessionId: SessionId; index: number }>();

  private runtimeMetadataRecords = new Map<string, AwsFinalizationRuntimeMetadata>();
  private deliveryMetadata = new InMemoryAwsVerificationDeliveryMetadataStore();
  private verificationRollbackSnapshots = new Map<string, VerificationResultRecord | null>();
  private receipts = new Map<string, ReceiptEntry>();
  private receiptCounter = 100;

  private cloneForSuccessfulFinalizationMutation(): MockSessionStore {
    const staged = new MockSessionStore();
    staged.identityRecords = new Map(
      Array.from(this.identityRecords, ([sessionId, identity]) => [sessionId, cloneIdentity(identity)]),
    );
    staged.votingRecords = new Map(
      Array.from(this.votingRecords, ([sessionId, voting]) => [sessionId, cloneVoting(voting)]),
    );
    staged.finalizationRecords = new Map(this.finalizationRecords);
    staged.currentFinalizationIdBySession = new Map(this.currentFinalizationIdBySession);
    staged.verificationResultRecords = new Map(this.verificationResultRecords);
    staged.verificationObservationRecords = new Map(this.verificationObservationRecords);
    staged.bitmapRecords = new Map(
      Array.from(this.bitmapRecords, ([key, bitmap]) => [
        key,
        {
          sessionId: bitmap.sessionId,
          finalizationId: bitmap.finalizationId,
          ...encodeFinalizationBitmapData(bitmap),
        },
      ]),
    );
    staged.voteIdIndex = new Map(this.voteIdIndex);
    staged.runtimeMetadataRecords = new Map(
      Array.from(this.runtimeMetadataRecords, ([key, metadata]) => [
        key,
        {
          ...metadata,
          ...(metadata.bundleMetadata ? { bundleMetadata: { ...metadata.bundleMetadata } } : {}),
        },
      ]),
    );
    staged.deliveryMetadata = this.deliveryMetadata.clone();
    staged.verificationRollbackSnapshots = new Map(this.verificationRollbackSnapshots);
    staged.receipts = new Map(
      Array.from(this.receipts, ([key, entry]) => [key, { ...entry, receipt: { ...entry.receipt } }]),
    );
    staged.receiptCounter = this.receiptCounter;
    return staged;
  }

  private installSuccessfulFinalizationMutation(staged: MockSessionStore): void {
    this.votingRecords = staged.votingRecords;
    this.finalizationRecords = staged.finalizationRecords;
    this.currentFinalizationIdBySession = staged.currentFinalizationIdBySession;
    this.verificationResultRecords = staged.verificationResultRecords;
    this.bitmapRecords = staged.bitmapRecords;
    this.runtimeMetadataRecords = staged.runtimeMetadataRecords;
    this.deliveryMetadata = staged.deliveryMetadata;
    this.receipts = staged.receipts;
    this.receiptCounter = staged.receiptCounter;
  }

  private generateSessionId(): SessionId {
    return asSessionId(
      typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    );
  }

  private requireIdentity(sessionId: SessionId): SessionIdentityRecord {
    const identity = parseSessionIdentityRecord(this.identityRecords.get(sessionId));
    if (!identity || identity.sessionId !== sessionId) {
      throw new Error('Session identity is missing or invalid');
    }
    return identity;
  }

  private requireVoting(sessionId: SessionId): SessionVotingRecord {
    const identity = this.requireIdentity(sessionId);
    const voting = this.votingRecords.get(sessionId);
    if (!isVotingRecord(voting, identity)) {
      throw new Error('Session voting record is missing or invalid');
    }
    return voting;
  }

  private currentFinalization(sessionId: SessionId): FinalizationRecord | null {
    const finalizationId = this.currentFinalizationIdBySession.get(sessionId);
    if (!finalizationId) {
      return null;
    }
    const record = finalizationRecordCodec.admit(
      this.finalizationRecords.get(buildScopedKey(sessionId, finalizationId)),
    );
    if (!record || record.sessionId !== sessionId || record.finalizationId !== finalizationId) {
      throw new Error('Current finalization record is missing or invalid');
    }
    return record;
  }

  private touchVotingRecord(sessionId: SessionId, atMs = Date.now()): void {
    const voting = this.requireVoting(sessionId);
    this.votingRecords.set(sessionId, {
      ...voting,
      lastActivityMs: atMs,
    });
  }

  createSession(): Promise<SessionIdentityRecord> {
    const sessionId = this.generateSessionId();
    const createdAtMs = Date.now();
    const records = buildSessionRecords({
      sessionId,
      electionId: createElectionId(),
      electionConfigHash: getDefaultElectionConfigHash(),
      electionConfig: buildDefaultElectionConfig(),
      logId: generateLogId(`mock-${sessionId}`),
      createdAtMs,
      lastActivityMs: createdAtMs,
    });
    const identity = parseSessionIdentityRecord(records.identity);
    if (!identity || !isVotingRecord(records.voting, identity)) {
      throw new Error('Session creation produced invalid lifecycle records');
    }

    this.identityRecords.set(sessionId, identity);
    this.votingRecords.set(sessionId, records.voting);
    logger.info('[MockStore] Created session', {
      session_id_hash: hashSessionIdForLogging(sessionId),
    });
    return Promise.resolve(cloneIdentity(identity));
  }

  getSessionIdentity(sessionId: SessionId): Promise<SessionIdentityRecord | null> {
    const identity = parseSessionIdentityRecord(this.identityRecords.get(sessionId));
    return Promise.resolve(identity && identity.sessionId === sessionId ? cloneIdentity(identity) : null);
  }

  getVotingRecord(sessionId: SessionId): Promise<SessionVotingRecord | null> {
    const identity = parseSessionIdentityRecord(this.identityRecords.get(sessionId));
    const voting = this.votingRecords.get(sessionId);
    return Promise.resolve(identity && isVotingRecord(voting, identity) ? cloneVoting(voting) : null);
  }

  async getSessionVotingSummary(sessionId: SessionId): Promise<SessionVotingSummary | null> {
    const voting = await this.getVotingRecord(sessionId);
    return voting
      ? {
          sessionId,
          botCount: voting.botCount,
          userParticipation: voting.userParticipation,
        }
      : null;
  }

  touchSession(sessionId: SessionId): Promise<void> {
    this.touchVotingRecord(sessionId);
    return Promise.resolve();
  }

  async addVote(
    sessionId: SessionId,
    voteData: UserVoteCommand,
  ): Promise<Result<AddVoteResult, SessionVoteStoreError>> {
    await Promise.resolve();
    const identity = parseSessionIdentityRecord(this.identityRecords.get(sessionId));
    const voting = this.votingRecords.get(sessionId);
    if (!identity) {
      return { ok: false, error: { code: ApplicationErrorCode.SESSION_NOT_FOUND } };
    }
    if (!isVotingRecord(voting, identity)) {
      throw new Error('Session voting record is missing or invalid');
    }
    const outcome = evaluateSessionVoteMutation(
      {
        identity,
        voting,
        finalization: this.currentFinalization(sessionId),
      },
      { kind: 'append_user_vote', vote: voteData },
      {
        generateVoteId,
        nowMs: Date.now,
      },
    );
    if (!outcome.ok) {
      return outcome;
    }
    const mutation = outcome.value;
    if (mutation.kind === 'user_vote_replayed') {
      return { ok: true, value: mutation.castResult };
    }
    if (mutation.kind !== 'user_vote_appended') {
      throw new Error('Session vote mutation invariant violated');
    }

    this.votingRecords.set(sessionId, mutation.nextVoting);
    for (const intent of mutation.indexIntents) {
      this.voteIdIndex.set(intent.voteId, { sessionId, index: intent.index });
    }
    return { ok: true, value: mutation.castResult };
  }

  async addBotVotes(
    sessionId: SessionId,
    votes: readonly BotVoteCommand[],
  ): Promise<Result<void, SessionVoteStoreError>> {
    await Promise.resolve();
    const identity = parseSessionIdentityRecord(this.identityRecords.get(sessionId));
    const voting = this.votingRecords.get(sessionId);
    if (!identity) {
      return { ok: false, error: { code: ApplicationErrorCode.SESSION_NOT_FOUND } };
    }
    if (!isVotingRecord(voting, identity)) {
      throw new Error('Session voting record is missing or invalid');
    }
    const outcome = evaluateSessionVoteMutation(
      {
        identity,
        voting,
        finalization: this.currentFinalization(sessionId),
      },
      { kind: 'append_bot_votes', votes },
      {
        generateVoteId,
        nowMs: Date.now,
      },
    );
    if (!outcome.ok) {
      return outcome;
    }
    const mutation = outcome.value;
    if (mutation.kind !== 'bot_votes_appended') {
      throw new Error('Session vote mutation invariant violated');
    }

    this.votingRecords.set(sessionId, mutation.nextVoting);
    for (const intent of mutation.indexIntents) {
      this.voteIdIndex.set(intent.voteId, { sessionId, index: intent.index });
    }
    if (mutation.indexIntents.length > 0) {
      logger.debug('[MockStore] Bot votes added:', {
        addedCount: mutation.indexIntents.length,
        totalBotCount: mutation.nextVoting.botCount,
        firstBotIndex: mutation.indexIntents[0]?.index,
        lastBotIndex: mutation.indexIntents.at(-1)?.index,
        bulletinSize: mutation.nextVoting.bulletin.getSize(),
      });
    }
    return { ok: true, value: undefined };
  }

  getActiveSessionCount(): Promise<number> {
    const now = Date.now();
    for (const voting of this.votingRecords.values()) {
      if (now - voting.lastActivityMs > FIVE_MINUTES_MS) {
        this.deleteSessionRecords(voting.sessionId);
      }
    }
    let count = 0;
    for (const sessionId of this.identityRecords.keys()) {
      const identity = parseSessionIdentityRecord(this.identityRecords.get(sessionId));
      const voting = this.votingRecords.get(sessionId);
      if (identity && isVotingRecord(voting, identity)) {
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  private deleteSessionRecords(sessionId: SessionId): void {
    this.identityRecords.delete(sessionId);
    this.votingRecords.delete(sessionId);
    this.currentFinalizationIdBySession.delete(sessionId);
    deleteSessionScopedRecords(this.finalizationRecords, sessionId);
    deleteSessionScopedRecords(this.verificationResultRecords, sessionId);
    deleteSessionScopedRecords(this.verificationObservationRecords, sessionId);
    deleteSessionScopedRecords(this.bitmapRecords, sessionId);
    deleteSessionScopedRecords(this.runtimeMetadataRecords, sessionId);
    deleteSessionScopedRecords(this.verificationRollbackSnapshots, sessionId);
    deleteSessionScopedRecords(this.receipts, sessionId);
    this.deliveryMetadata.deleteSession(sessionId);
    for (const [voteId, owner] of this.voteIdIndex) {
      if (owner.sessionId === sessionId) {
        this.voteIdIndex.delete(voteId);
      }
    }
  }

  async getVoteById(
    sessionId: SessionId,
    voteId: string,
  ): Promise<{ voteData: StoredVoteRecord; index: number } | null> {
    const indexInfo = this.voteIdIndex.get(voteId);
    if (!indexInfo || indexInfo.sessionId !== sessionId) {
      return null;
    }
    const voting = await this.getVotingRecord(sessionId);
    const voteData = voting?.votes.get(indexInfo.index);
    return voteData ? { voteData: { ...voteData }, index: indexInfo.index } : null;
  }

  async getVoteByIdWithProof(
    sessionId: SessionId,
    voteId: string,
  ): Promise<{
    voteData: StoredVoteRecord;
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null> {
    const voteInfo = await this.getVoteById(sessionId, voteId);
    const voting = await this.getVotingRecord(sessionId);
    if (!voteInfo || !voting) {
      return null;
    }
    return {
      voteData: voteInfo.voteData,
      ...deriveExactCtProof({
        bulletin: voting.bulletin,
        voteId: voteInfo.voteData.voteId,
        leafIndex: voteInfo.index,
        rootAtCast: voteInfo.voteData.rootAtCast,
      }),
    };
  }

  async getVoteProof(voteId: string): Promise<{
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
    timestamp: number;
  } | null> {
    const owner = this.voteIdIndex.get(voteId);
    if (!owner) {
      return null;
    }
    const proof = await this.getVoteByIdWithProof(owner.sessionId, voteId);
    return proof
      ? {
          leafIndex: proof.leafIndex,
          merklePath: proof.merklePath,
          bulletinRootAtCast: proof.bulletinRootAtCast,
          treeSize: proof.treeSize,
          timestamp: proof.voteData.timestamp,
        }
      : null;
  }

  async getCurrentFinalizationRecord(sessionId: SessionId): Promise<FinalizationRecord | null> {
    await Promise.resolve();
    this.requireIdentity(sessionId);
    return this.currentFinalization(sessionId);
  }

  async getFinalizationRecord(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<FinalizationRecord | null> {
    await Promise.resolve();
    this.requireIdentity(sessionId);
    const record = finalizationRecordCodec.admit(
      this.finalizationRecords.get(buildScopedKey(sessionId, finalizationId)),
    );
    return record && record.sessionId === sessionId && record.finalizationId === finalizationId ? record : null;
  }

  private applyFinalizationCommand(
    command: FinalizationTransitionCommand,
    observability?: FinalizationQueuedPayload['observability'],
    options: { deferObservability?: boolean } = {},
  ): AppliedFinalizationTransition {
    this.requireIdentity(command.sessionId);
    const before = this.currentFinalization(command.sessionId);
    const outcome = evaluateFinalizationTransition({
      authority: { currentRecord: before },
      command,
      evaluatedAtMs: Date.now(),
    });
    if (outcome.kind === 'invalid') {
      throw new Error(`Invalid finalization transition: ${outcome.reason}`);
    }

    let record = before;
    let mutated = false;
    if (outcome.kind === 'applied') {
      record = finalizationRecordCodec.admit(outcome.mutations.nextRecord) ?? null;
      if (!record) {
        throw new Error('Finalization transition produced an invalid record');
      }
      this.finalizationRecords.set(buildScopedKey(command.sessionId, command.finalizationId), record);
      this.currentFinalizationIdBySession.set(command.sessionId, command.finalizationId);
      this.touchVotingRecord(command.sessionId);
      mutated = true;
    }
    if (!record) {
      throw new Error(`Finalization transition was not applied: ${outcome.reason}`);
    }

    if (!options.deferObservability) {
      recordFinalizationStorePersistenceOutcome({
        sessionId: command.sessionId,
        requestedFinalizationId: command.finalizationId,
        requestedTo: requestedFinalizationStatus(command),
        ...(before ? { before: before.state } : {}),
        actual: record.state,
        semanticReason: outcome.reason,
        authoritativeWrite: mutated,
        ...(observability ? { metadata: observability } : {}),
      });
    }
    return {
      record,
      mutated,
      outcome,
    };
  }

  async markFinalizationQueued(sessionId: SessionId, payload: FinalizationQueuedPayload): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedPayloadKeys(payload, FINALIZATION_QUEUED_PAYLOAD_KEYS, 'queued finalization');
    return this.applyFinalizationCommand(buildFinalizationCommand(sessionId, 'queue', payload), payload.observability)
      .record;
  }

  async markFinalizationRunning(
    sessionId: SessionId,
    payload: FinalizationRunningPayload,
  ): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedPayloadKeys(payload, FINALIZATION_RUNNING_PAYLOAD_KEYS, 'running finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return this.applyFinalizationCommand(buildFinalizationCommand(sessionId, 'start', payload), payload.observability)
      .record;
  }

  async markFinalizationSucceeded(
    sessionId: SessionId,
    payload: FinalizationSucceededPayload,
  ): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedPayloadKeys(payload, FINALIZATION_SUCCEEDED_PAYLOAD_KEYS, 'succeeded finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    assertDirectSuccessfulFinalizationPayload(payload);
    const current = this.currentFinalization(sessionId);
    const command = buildFinalizationCommand(sessionId, 'succeed', payload);
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
      return this.applyFinalizationCommand(command, payload.observability).record;
    }
    const committed = await this.commitSuccessfulFinalization({
      record: buildDirectSuccessfulFinalizationCommitRecord(sessionId, payload, current),
      bitmap: { availability: 'unavailable' },
      ...(payload.observability ? { observability: payload.observability } : {}),
    });
    return committed.record;
  }

  async markFinalizationFailed(sessionId: SessionId, payload: FinalizationFailedPayload): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedPayloadKeys(payload, FINALIZATION_FAILED_PAYLOAD_KEYS, 'failed finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    const command = buildFinalizationCommand(sessionId, 'fail', payload);
    return this.applyFinalizationCommand(command, payload.observability).record;
  }

  async markFinalizationTimedOut(
    sessionId: SessionId,
    payload: FinalizationTimedOutPayload,
  ): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedPayloadKeys(payload, FINALIZATION_TIMED_OUT_PAYLOAD_KEYS, 'timed-out finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, 'time_out', payload),
      payload.observability,
    ).record;
  }

  async markAwsFinalizationRunning(
    sessionId: SessionId,
    payload: AwsFinalizationRunningPayload,
  ): Promise<FinalizationState> {
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const record = await this.markFinalizationRunning(sessionId, semanticPayload);
    if (record.finalizationId === payload.finalizationId && record.state.status === 'running' && stepFunctionsArn) {
      this.runtimeMetadataRecords.set(buildScopedKey(sessionId, payload.finalizationId), { stepFunctionsArn });
    }
    return record.state;
  }

  async markAwsFinalizationSucceeded(
    sessionId: SessionId,
    payload: AwsFinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    assertAllowedPayloadKeys(payload, AWS_SUCCEEDED_PAYLOAD_KEYS, 'AWS succeeded finalization');
    const { stepFunctionsArn, bundleMetadata, finalizationResult, ...common } = payload;
    const current = this.currentFinalization(sessionId);
    if (
      current &&
      (current.finalizationId !== payload.finalizationId ||
        (current.state.status !== 'pending' &&
          current.state.status !== 'running' &&
          current.state.status !== 'succeeded'))
    ) {
      return current.state;
    }
    const bitmap =
      finalizationResult.artifacts.bitmap.availability === 'available'
        ? { availability: 'available' as const, data: finalizationResult.artifacts.bitmap.data }
        : { availability: 'unavailable' as const };
    const requested = finalizationRecordCodec.admit({
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
        ...finalizationResult,
      },
    });
    if (!requested || requested.state.status !== 'succeeded') {
      throw new Error('Invalid AWS succeeded finalization record');
    }
    const runtimeMetadata =
      stepFunctionsArn === undefined && bundleMetadata === undefined
        ? undefined
        : {
            ...(stepFunctionsArn === undefined ? {} : { stepFunctionsArn }),
            ...(bundleMetadata === undefined ? {} : { bundleMetadata }),
          };
    const committed = await this.commitSuccessfulFinalization({
      record: requested as Extract<FinalizationRecord, { state: { status: 'succeeded' } }>,
      bitmap,
      ...(runtimeMetadata ? { runtimeMetadata } : {}),
      ...(common.observability ? { observability: common.observability } : {}),
    });
    return committed.record.state;
  }

  async markAwsFinalizationFailed(
    sessionId: SessionId,
    payload: AwsFinalizationFailedPayload,
  ): Promise<FinalizationState> {
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const record = await this.markFinalizationFailed(sessionId, semanticPayload);
    if (record.finalizationId === payload.finalizationId && record.state.status === 'failed' && stepFunctionsArn) {
      this.runtimeMetadataRecords.set(buildScopedKey(sessionId, payload.finalizationId), { stepFunctionsArn });
    }
    return record.state;
  }

  async markAwsFinalizationTimedOut(
    sessionId: SessionId,
    payload: AwsFinalizationTimedOutPayload,
  ): Promise<FinalizationState> {
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const record = await this.markFinalizationTimedOut(sessionId, semanticPayload);
    if (record.finalizationId === payload.finalizationId && record.state.status === 'timeout' && stepFunctionsArn) {
      this.runtimeMetadataRecords.set(buildScopedKey(sessionId, payload.finalizationId), { stepFunctionsArn });
    }
    return record.state;
  }

  async getAwsFinalizationRuntimeMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<AwsFinalizationRuntimeMetadata | undefined> {
    await Promise.resolve();
    const metadata = this.runtimeMetadataRecords.get(buildScopedKey(sessionId, finalizationId));
    return metadata
      ? {
          ...metadata,
          ...(metadata.bundleMetadata ? { bundleMetadata: { ...metadata.bundleMetadata } } : {}),
        }
      : undefined;
  }

  recordAwsProofBundlePublication(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    this.requireIdentity(sessionId);
    this.deliveryMetadata.record(sessionId, finalizationId, metadata);
    return Promise.resolve();
  }

  recordAwsVerificationDeliveryMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    return this.recordAwsProofBundlePublication(sessionId, finalizationId, metadata);
  }

  async getAwsVerificationDeliveryMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<AwsVerificationDeliveryMetadataInput | undefined> {
    await Promise.resolve();
    const metadata = this.deliveryMetadata.get(sessionId, finalizationId);
    return metadata ? { ...metadata } : undefined;
  }

  private requireSucceededFinalization(sessionId: SessionId, finalizationId: FinalizationId): FinalizationRecord {
    const record = this.currentFinalization(sessionId);
    if (!record || record.finalizationId !== finalizationId || record.state.status !== 'succeeded') {
      throw new Error('Finalization is unavailable for verification');
    }
    return record;
  }

  getVerificationResultRecord(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<VerificationResultRecord | null> {
    this.requireIdentity(sessionId);
    const record = parseVerificationResultRecord(
      this.verificationResultRecords.get(buildScopedKey(sessionId, finalizationId)),
    );
    return Promise.resolve(
      record && record.sessionId === sessionId && record.finalizationId === finalizationId ? record : null,
    );
  }

  async markVerificationRunning(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<VerificationResultRecord> {
    this.requireSucceededFinalization(sessionId, finalizationId);
    const key = buildScopedKey(sessionId, finalizationId);
    const current = await this.getVerificationResultRecord(sessionId, finalizationId);
    if (current && isTerminalVerificationStatus(current.verificationResult.status)) {
      return current;
    }
    this.verificationRollbackSnapshots.set(key, current);
    const record = parseVerificationResultRecord({
      sessionId,
      finalizationId,
      verificationResult: {
        status: 'running',
      },
    });
    if (!record) {
      throw new Error('Invalid verification result record');
    }
    this.verificationResultRecords.set(key, record);
    this.touchVotingRecord(sessionId);
    return record;
  }

  rollbackVerificationResult(sessionId: SessionId, finalizationId: FinalizationId): Promise<void> {
    this.requireSucceededFinalization(sessionId, finalizationId);
    const key = buildScopedKey(sessionId, finalizationId);
    const snapshot = this.verificationRollbackSnapshots.get(key);
    this.verificationRollbackSnapshots.delete(key);
    if (snapshot) {
      this.verificationResultRecords.set(key, snapshot);
    } else {
      this.verificationResultRecords.delete(key);
    }
    this.touchVotingRecord(sessionId);
    return Promise.resolve();
  }

  async completeVerificationResult(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
  ): Promise<VerificationResultRecord> {
    this.requireSucceededFinalization(sessionId, finalizationId);
    const key = buildScopedKey(sessionId, finalizationId);
    const current = await this.getVerificationResultRecord(sessionId, finalizationId);
    if (current && isTerminalVerificationStatus(current.verificationResult.status)) {
      return current;
    }
    const record = parseVerificationResultRecord({
      sessionId,
      finalizationId,
      verificationResult,
    });
    if (!record) {
      throw new Error('Invalid verification result record');
    }
    this.verificationResultRecords.set(key, record);
    this.verificationRollbackSnapshots.delete(key);
    this.touchVotingRecord(sessionId);
    return record;
  }

  async recordVerificationObservation(
    sessionId: SessionId,
    finalizationId: string,
    input: VerificationObservationWrite,
  ): Promise<RecordVerificationObservationResult> {
    await Promise.resolve();
    this.requireIdentity(sessionId);
    const observationWrite = parseVerificationObservationWrite(input);
    if (!observationWrite) {
      throw new Error('Invalid verification observation');
    }
    const requested = parseVerificationObservation({
      finalizationId,
      ...observationWrite,
    });
    if (!requested) {
      throw new Error('Invalid verification observation');
    }
    const currentFinalizationId = this.currentFinalizationIdBySession.get(sessionId);
    const key = buildScopedKey(sessionId, finalizationId);
    const existing = parseVerificationObservation(this.verificationObservationRecords.get(key));
    const resolution = resolveVerificationObservationRecord(currentFinalizationId, existing, requested);
    if (resolution.status === 'recorded') {
      this.verificationObservationRecords.set(key, requested);
      this.touchVotingRecord(sessionId, requested.observedAt);
    }
    return resolution;
  }

  getVerificationObservation(sessionId: SessionId, finalizationId: string): VerificationObservation | null {
    const observation = parseVerificationObservation(
      this.verificationObservationRecords.get(buildScopedKey(sessionId, finalizationId)),
    );
    return observation ?? null;
  }

  getBitmapData(sessionId: SessionId, finalizationId: FinalizationId): Promise<FinalizationBitmapRecord | null> {
    this.requireIdentity(sessionId);
    const finalization = finalizationRecordCodec.admit(
      this.finalizationRecords.get(buildScopedKey(sessionId, finalizationId)),
    );
    if (!finalization || finalization.state.status !== 'succeeded' || !finalization.finalizationResult) {
      return Promise.resolve(null);
    }
    const bitmap = this.bitmapRecords.get(buildScopedKey(sessionId, finalizationId));
    return Promise.resolve(admitPersistedFinalizationBitmapData(finalization, bitmap) ?? null);
  }

  async commitSuccessfulFinalization(
    input: SuccessfulFinalizationCommitInput & { runtimeMetadata?: AwsFinalizationRuntimeMetadata },
  ): Promise<SuccessfulFinalizationCommitResult> {
    await Promise.resolve();
    const requested = admitSuccessfulFinalizationCommitRecord(input.record);
    this.requireVoting(requested.sessionId);
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
    const runtimePatch =
      input.runtimeMetadata === undefined ? undefined : parseAwsFinalizationRuntimeMetadata(input.runtimeMetadata);
    if (input.runtimeMetadata !== undefined && !runtimePatch) {
      throw new Error('Invalid AWS finalization runtime metadata');
    }

    const key = buildScopedKey(requested.sessionId, requested.finalizationId);
    const existingRuntime = this.runtimeMetadataRecords.get(key);
    const runtimeMetadata = runtimePatch
      ? {
          ...(existingRuntime ?? {}),
          ...runtimePatch,
          ...(existingRuntime?.bundleMetadata || runtimePatch.bundleMetadata
            ? {
                bundleMetadata: {
                  ...(existingRuntime?.bundleMetadata ?? {}),
                  ...(runtimePatch.bundleMetadata ?? {}),
                },
              }
            : {}),
        }
      : undefined;
    const existingDelivery = this.deliveryMetadata.get(requested.sessionId, requested.finalizationId);
    const deliveryMetadata = runtimeMetadata?.bundleMetadata
      ? {
          ...(existingDelivery ?? {}),
          ...(runtimeMetadata.bundleMetadata.s3BundleKey
            ? { s3BundleKey: runtimeMetadata.bundleMetadata.s3BundleKey }
            : {}),
          ...(runtimeMetadata.bundleMetadata.s3UploadedAtMs === undefined
            ? {}
            : { s3UploadedAtMs: runtimeMetadata.bundleMetadata.s3UploadedAtMs }),
        }
      : undefined;
    const existingReceipt = this.receipts.get(key);
    let existingReceiptBody: ReturnType<typeof admitSuccessfulFinalizationReceipt>;
    try {
      existingReceiptBody = existingReceipt ? admitSuccessfulFinalizationReceipt(existingReceipt.receipt) : undefined;
    } catch {
      throw new Error('Invalid persisted finalization receipt');
    }
    if (
      existingReceipt &&
      (!existingReceiptBody ||
        existingReceipt.receiptHash !== computeSuccessfulFinalizationReceiptHash(existingReceiptBody))
    ) {
      throw new Error('Invalid persisted finalization receipt');
    }
    if (
      existingReceipt &&
      receipt &&
      (!Number.isSafeInteger(this.receiptCounter) || this.receiptCounter <= existingReceipt.boardIndex)
    ) {
      throw new Error('Receipt board counter does not cover the persisted publication');
    }
    const receiptHash = receipt
      ? (existingReceipt?.receiptHash ?? computeSuccessfulFinalizationReceiptHash(receipt))
      : undefined;
    const boardIndex = receipt ? (existingReceipt?.boardIndex ?? this.receiptCounter) : undefined;
    const receiptPublication =
      receipt && receiptHash !== undefined && boardIndex !== undefined
        ? { receiptHash, boardIndex, timestamp: receipt.timestamp }
        : undefined;
    const committed = finalizationRecordCodec.admit({
      ...requested,
      finalizationResult: {
        ...requested.finalizationResult,
        artifacts: {
          ...requested.finalizationResult.artifacts,
          ...(receiptPublication
            ? { receiptPublication: { availability: 'available' as const, publication: receiptPublication } }
            : {}),
        },
      },
    });
    if (!committed || committed.state.status !== 'succeeded') {
      throw new Error('Invalid successful finalization commit');
    }
    const successful = committed as Extract<FinalizationRecord, { state: { status: 'succeeded' } }>;

    const current = this.currentFinalization(requested.sessionId);
    assertSuccessfulFinalizationLifecycleAdmission(requested, current);
    const hasExistingBitmap = this.bitmapRecords.has(key);
    const hasExistingVerification = this.verificationResultRecords.has(key);
    if (isSuccessfulFinalizationRecord(current)) {
      const existingBitmap = hasExistingBitmap
        ? admitPersistedFinalizationBitmapData(current, this.bitmapRecords.get(key))
        : undefined;
      if (hasExistingBitmap && !existingBitmap) {
        throw new Error('Invalid persisted finalization bitmap');
      }
      const expectedBitmap =
        bitmap.availability === 'available'
          ? { sessionId: requested.sessionId, finalizationId: requested.finalizationId, ...bitmap.data }
          : undefined;
      const existingVerification = hasExistingVerification
        ? parseVerificationResultRecord(this.verificationResultRecords.get(key))
        : undefined;
      if (hasExistingVerification && !existingVerification) {
        throw new Error('Invalid persisted verification result record');
      }
      if (
        !isDeepStrictEqual(current, successful) ||
        !isDeepStrictEqual(existingReceiptBody, receipt) ||
        !isDeepStrictEqual(existingBitmap, expectedBitmap) ||
        (verification !== undefined && !isDeepStrictEqual(existingVerification, verification)) ||
        (runtimeMetadata !== undefined && !isDeepStrictEqual(existingRuntime, runtimeMetadata)) ||
        (deliveryMetadata !== undefined && !isDeepStrictEqual(existingDelivery, deliveryMetadata))
      ) {
        throw new Error('Successful finalization commit conflicts with existing authority');
      }
      return {
        record: cloneSuccessfulFinalizationRecord(successful),
        bitmap,
        ...(receiptPublication ? { receiptPublication } : {}),
      };
    }
    if (hasExistingBitmap || hasExistingVerification) {
      throw new Error('Successful finalization artifacts exist before terminal authority');
    }
    if (existingReceipt) {
      throw new Error('Successful finalization receipt exists before terminal authority');
    }
    const { finalizationId: _finalizationId, ...authority } = successful.finalizationResult;
    void _finalizationId;
    const staged = this.cloneForSuccessfulFinalizationMutation();
    const applied = staged.applyFinalizationCommand(
      {
        kind: 'succeed',
        sessionId: successful.sessionId,
        finalizationId: successful.finalizationId,
        queuedAtMs: successful.state.queuedAtMs,
        startedAtMs: successful.state.startedAtMs,
        completedAtMs: successful.state.completedAtMs,
        scenarioContext: successful.scenarioContext,
        finalizationResult: authority,
      },
      input.observability,
      { deferObservability: true },
    );
    if (!applied.mutated || applied.record.state.status !== 'succeeded') {
      throw new Error('Successful finalization commit was not applied');
    }
    if (receipt && receiptPublication) {
      staged.receipts.set(key, {
        receiptHash: receiptPublication.receiptHash,
        boardIndex: receiptPublication.boardIndex,
        receipt: { ...receipt },
      });
      staged.receiptCounter += 1;
    }
    if (verification) {
      staged.verificationResultRecords.set(key, verification);
    }
    if (bitmap.availability === 'available') {
      staged.bitmapRecords.set(key, {
        sessionId: successful.sessionId,
        finalizationId: successful.finalizationId,
        ...encodeFinalizationBitmapData(bitmap.data),
      });
    }
    if (runtimeMetadata) {
      staged.runtimeMetadataRecords.set(key, runtimeMetadata);
    }
    if (deliveryMetadata) {
      staged.deliveryMetadata.record(requested.sessionId, requested.finalizationId, deliveryMetadata);
    }
    this.installSuccessfulFinalizationMutation(staged);
    recordFinalizationStorePersistenceOutcome({
      sessionId: successful.sessionId,
      requestedFinalizationId: successful.finalizationId,
      requestedTo: 'succeeded',
      ...(current ? { before: current.state } : {}),
      actual: applied.record.state,
      semanticReason: applied.outcome.reason,
      authoritativeWrite: applied.mutated,
      metadata: input.observability ?? { source: 'finalize', reason: 'STATE_PERSISTED' },
    });
    return {
      record: cloneSuccessfulFinalizationRecord(successful),
      bitmap,
      ...(receiptPublication ? { receiptPublication } : {}),
    };
  }
}
