import { SessionCommandStore, type VerificationWriteMode } from './session-command-store';
import { evaluateStoredVoteCommand, type PreparedVoteWrite } from './session-vote-writes';
import {
  admitMappedObservation,
  restoreMappedVerificationSnapshot,
  readMappedFinalization,
  requireMappedSucceededFinalization,
  prepareMappedFinalizationCommand,
  installMappedVoteMutation,
  describeBotVoteAddition,
} from './mapped-session-records';
import { assertNoPrematureCommitArtifacts } from './successfulFinalizationReplay';
import {
  cloneSessionIdentity as cloneIdentity,
  cloneSessionVoting,
  createDefaultSessionRecords,
  cloneRuntimeMetadata,
} from './session-records';
import {
  isNonArrayObject as isRecord,
  hasExactOwnKeys as hasExactKeys,
  isNonNegativeSafeInteger,
} from '@stark-ballot/validation/unknown-value-guards';
import { assertSuccessfulFinalizationReplay, admitReplayArtifacts } from './successfulFinalizationReplay';
import {
  FINALIZATION_QUEUED_PAYLOAD_KEYS,
  FINALIZATION_RUNNING_PAYLOAD_KEYS,
  FINALIZATION_SUCCEEDED_PAYLOAD_KEYS,
  FINALIZATION_FAILED_PAYLOAD_KEYS,
  FINALIZATION_TIMED_OUT_PAYLOAD_KEYS,
  assertAllowedFinalizationPayloadKeys,
} from '@stark-ballot/application/finalize/finalization-store';
/**
 * In-memory session store for local development and tests.
 *
 * Each lifecycle owns its own record index. This adapter never composes or
 * persists the retired all-purpose session aggregate.
 */

import { encodeFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-storage';
import crypto from 'node:crypto';
import { admitPersistedFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-bitmap-admission';
import {
  admitSuccessfulFinalizationCommitRecord,
  assertSuccessfulFinalizationLifecycleAdmission,
  assertDirectSuccessfulFinalizationPayload,
  prepareDirectSuccessfulFinalization,
  admitSuccessfulFinalizationEvidence,
  buildPublishedSuccessfulFinalization,
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
  isTerminalVerificationStatus,
  createVerificationResultRecord,
  type VerificationResultRecord,
  type VerificationResultStore,
} from '@stark-ballot/application/finalize/finalization-result-store';
import {
  type FinalizationTransitionCommand,
  type FinalizationTransitionOutcome,
} from '@stark-ballot/application/finalize/finalization-transition-policy';
import type { FinalizationId, FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import {
  type SessionVoteMutation,
  type SessionVoteCommand,
} from '@stark-ballot/application/session/session-mutation-policy';
import type {
  SessionVoteMutationStore,
  SessionVoteStoreError,
} from '@stark-ballot/application/session/session-vote-store';
import { ApplicationErrorCode, type Result } from '@stark-ballot/application';
import {
  assertNoAwsRuntimeTransitionMetadata,
  admitAwsSuccessInput,
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
import {
  admitOptionalAwsRuntimeMetadata,
  mergeRuntimeBundleDelivery,
  mergeFinalizationRuntimeMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationMetadataAdmission';
import { recordFinalizationStorePersistenceOutcome } from '@stark-ballot/aws-adapters/finalize/finalizationTransitionObservability';
import {
  readStoredVoteProof,
  readIndexedVoteProof,
  type VoteWithCtProof,
  type TimestampedCtProof,
} from '@stark-ballot/aws-adapters/store/ct-proof';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { parseSessionIdentityRecord } from '@stark-ballot/domain/types/sessionRecords';
import type { SessionVotingSummary, VoteStore } from '@stark-ballot/domain/types/voteStore';
import {
  parseVerificationObservation,
  resolveVerificationObservationRecord,
  type RecordVerificationObservationResult,
  type VerificationObservation,
  type VerificationObservationWrite,
} from '@stark-ballot/domain/types/verificationObservation';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import {
  assertReceiptPublicationCounter,
  prepareReceiptPublication,
  admitPersistedReceiptBody,
} from './successfulFinalizationReceipt';

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

function cloneSuccessfulCommitOutcome(
  record: SuccessfulFinalizationCommitResult['record'],
  bitmap: SuccessfulFinalizationCommitResult['bitmap'],
  receiptPublication: SuccessfulFinalizationCommitResult['receiptPublication'],
): SuccessfulFinalizationCommitResult {
  return {
    record: cloneSuccessfulFinalizationRecord(record),
    bitmap,
    ...(receiptPublication ? { receiptPublication } : {}),
  };
}

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

function isStoredVoteRecord(value: unknown): value is StoredVoteRecord {
  if (!isRecord(value) || !hasExactKeys(value, VOTE_RECORD_KEYS)) {
    return false;
  }
  const vote = value;
  return (
    typeof vote['voteId'] === 'string' &&
    typeof vote['vote'] === 'string' &&
    typeof vote['rand'] === 'string' &&
    typeof vote['commit'] === 'string' &&
    isNonNegativeSafeInteger(vote['timestamp']) &&
    typeof vote['rootAtCast'] === 'string'
  );
}

function isCurrentParticipation(value: unknown, votes: Map<unknown, unknown>): boolean {
  if (!isRecord(value)) return false;
  const participation = value;
  const participationStatus = participation['status'];
  switch (participationStatus) {
    case 'not_cast':
      return hasExactKeys(participation, NOT_CAST_KEYS);
    case 'cast':
      return (
        hasExactKeys(participation, CAST_KEYS) &&
        isNonNegativeSafeInteger(participation['voteIndex']) &&
        votes.has(participation['voteIndex'])
      );
    default:
      return false;
  }
}

function hasStoredVotes(votes: Map<unknown, unknown>): boolean {
  for (const [index, vote] of votes) {
    if (!isNonNegativeSafeInteger(index) || !isStoredVoteRecord(vote)) {
      return false;
    }
  }
  return true;
}

function hasSessionBulletin(value: unknown, identity: SessionIdentityRecord): value is SimpleBulletinBoard {
  return value instanceof SimpleBulletinBoard && value.getLogId() === identity.logId;
}

function hasVotingActivityFields(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value['bulletinRootHistory']) &&
    isNonNegativeSafeInteger(value['botCount']) &&
    isNonNegativeSafeInteger(value['lastActivityMs'])
  );
}

function isVotingRecord(value: unknown, identity: SessionIdentityRecord): value is SessionVotingRecord {
  if (!isRecord(value) || !hasExactKeys(value, VOTING_RECORD_KEYS)) {
    return false;
  }
  const candidate = value;
  const sessionId = candidate['sessionId'];
  const votes = candidate['votes'];
  const bulletin = candidate['bulletin'];
  const userParticipation = candidate['userParticipation'];
  if (
    sessionId !== identity.sessionId ||
    !(votes instanceof Map) ||
    !hasSessionBulletin(bulletin, identity) ||
    !hasVotingActivityFields(candidate)
  ) {
    return false;
  }
  return isCurrentParticipation(userParticipation, votes) && hasStoredVotes(votes);
}

export class MockSessionStore
  extends SessionCommandStore
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
      Array.from(this.votingRecords, ([sessionId, voting]) => [sessionId, cloneSessionVoting(voting)]),
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
      Array.from(this.runtimeMetadataRecords, ([key, metadata]) => [key, cloneRuntimeMetadata(metadata)]),
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
    return readMappedFinalization(sessionId, this.currentFinalizationIdBySession, this.finalizationRecords);
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
    const records = createDefaultSessionRecords(sessionId, `mock-${sessionId}`, createdAtMs);
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
    return Promise.resolve(identity && isVotingRecord(voting, identity) ? cloneSessionVoting(voting) : null);
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

  protected override async mutateVotes<T>(
    sessionId: SessionId,
    command: SessionVoteCommand,
    prepareWrite: (mutation: SessionVoteMutation) => PreparedVoteWrite<T>,
  ): Promise<Result<T, SessionVoteStoreError>> {
    await Promise.resolve();
    const identity = parseSessionIdentityRecord(this.identityRecords.get(sessionId));
    const voting = this.votingRecords.get(sessionId);
    if (!identity) return { ok: false, error: { code: ApplicationErrorCode.SESSION_NOT_FOUND } };
    if (!isVotingRecord(voting, identity)) throw new Error('Session voting record is missing or invalid');
    const outcome = evaluateStoredVoteCommand(identity, voting, this.currentFinalization(sessionId), command);
    if (!outcome.ok) return outcome;
    const write = prepareWrite(outcome.value);
    if (!write.mutation) return { ok: true, value: write.value };
    installMappedVoteMutation(sessionId, write.mutation, this.votingRecords, this.voteIdIndex);
    if (write.mutation.kind === 'bot_votes_appended' && write.mutation.indexIntents.length > 0) {
      logger.debug('[MockStore] Bot votes added:', describeBotVoteAddition(write.mutation));
    }
    return { ok: true, value: write.value };
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

  async getVoteByIdWithProof(sessionId: SessionId, voteId: string): Promise<VoteWithCtProof | null> {
    return readStoredVoteProof(this, sessionId, voteId);
  }

  async getVoteProof(voteId: string): Promise<TimestampedCtProof | null> {
    return readIndexedVoteProof(this, this.voteIdIndex.get(voteId), voteId);
  }

  override async getCurrentFinalizationRecord(sessionId: SessionId): Promise<FinalizationRecord | null> {
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

  protected override applyFinalizationCommand(
    command: FinalizationTransitionCommand,
    observability?: FinalizationQueuedPayload['observability'],
    options: { deferObservability?: boolean } = {},
  ): AppliedFinalizationTransition {
    this.requireIdentity(command.sessionId);
    const { before, record, mutated, outcome } = prepareMappedFinalizationCommand(
      command,
      this.currentFinalizationIdBySession,
      this.finalizationRecords,
    );
    if (mutated) {
      this.finalizationRecords.set(buildScopedKey(command.sessionId, command.finalizationId), record);
      this.currentFinalizationIdBySession.set(command.sessionId, command.finalizationId);
      this.touchVotingRecord(command.sessionId);
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

  override async markFinalizationQueued(
    sessionId: SessionId,
    payload: FinalizationQueuedPayload,
  ): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_QUEUED_PAYLOAD_KEYS, 'queued finalization');
    return this.applyFinalizationCommand(buildFinalizationCommand(sessionId, 'queue', payload), payload.observability)
      .record;
  }

  override async markFinalizationRunning(
    sessionId: SessionId,
    payload: FinalizationRunningPayload,
  ): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_RUNNING_PAYLOAD_KEYS, 'running finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    return this.applyFinalizationCommand(buildFinalizationCommand(sessionId, 'start', payload), payload.observability)
      .record;
  }

  override async markFinalizationSucceeded(
    sessionId: SessionId,
    payload: FinalizationSucceededPayload,
  ): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_SUCCEEDED_PAYLOAD_KEYS, 'succeeded finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    assertDirectSuccessfulFinalizationPayload(payload);
    const current = this.currentFinalization(sessionId);
    const prepared = prepareDirectSuccessfulFinalization(sessionId, payload, current, Date.now());
    if (prepared.kind === 'transition')
      return this.applyFinalizationCommand(prepared.command, payload.observability).record;
    return this.publishDirectFinalization(prepared.record, payload);
  }

  override async markFinalizationFailed(
    sessionId: SessionId,
    payload: FinalizationFailedPayload,
  ): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_FAILED_PAYLOAD_KEYS, 'failed finalization');
    assertNoAwsRuntimeTransitionMetadata(payload as AwsSucceededTransitionMetadata);
    const command = buildFinalizationCommand(sessionId, 'fail', payload);
    return this.applyFinalizationCommand(command, payload.observability).record;
  }

  override async markFinalizationTimedOut(
    sessionId: SessionId,
    payload: FinalizationTimedOutPayload,
  ): Promise<FinalizationRecord> {
    await Promise.resolve();
    assertAllowedFinalizationPayloadKeys(payload, FINALIZATION_TIMED_OUT_PAYLOAD_KEYS, 'timed-out finalization');
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

  override async markAwsFinalizationSucceeded(
    sessionId: SessionId,
    payload: AwsFinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    const input = admitAwsSuccessInput(payload);
    return this.commitAwsSuccess(sessionId, input, this.currentFinalization(sessionId));
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
    return metadata ? cloneRuntimeMetadata(metadata) : undefined;
  }

  override recordAwsProofBundlePublication(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    this.requireIdentity(sessionId);
    this.deliveryMetadata.record(sessionId, finalizationId, metadata);
    return Promise.resolve();
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
    return requireMappedSucceededFinalization(this.currentFinalization(sessionId), finalizationId);
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

  protected override async writeVerificationResult(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
    mode: VerificationWriteMode,
  ): Promise<VerificationResultRecord> {
    this.requireSucceededFinalization(sessionId, finalizationId);
    const key = buildScopedKey(sessionId, finalizationId);
    const current = await this.getVerificationResultRecord(sessionId, finalizationId);
    if (current && isTerminalVerificationStatus(current.verificationResult.status)) {
      return current;
    }
    if (mode === 'start') this.verificationRollbackSnapshots.set(key, current);
    const record = createVerificationResultRecord(sessionId, finalizationId, verificationResult);
    this.verificationResultRecords.set(key, record);
    if (mode === 'complete') this.verificationRollbackSnapshots.delete(key);
    this.touchVotingRecord(sessionId);
    return record;
  }

  rollbackVerificationResult(sessionId: SessionId, finalizationId: FinalizationId): Promise<void> {
    this.requireSucceededFinalization(sessionId, finalizationId);
    const key = buildScopedKey(sessionId, finalizationId);
    restoreMappedVerificationSnapshot(key, this.verificationRollbackSnapshots, this.verificationResultRecords);
    this.touchVotingRecord(sessionId);
    return Promise.resolve();
  }

  async recordVerificationObservation(
    sessionId: SessionId,
    finalizationId: string,
    input: VerificationObservationWrite,
  ): Promise<RecordVerificationObservationResult> {
    await Promise.resolve();
    this.requireIdentity(sessionId);
    const requested = admitMappedObservation(finalizationId, input);
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

  private writeSuccessfulArtifacts(
    key: string,
    artifacts: Parameters<typeof assertSuccessfulFinalizationReplay>[1],
    receiptPublication: SuccessfulFinalizationCommitResult['receiptPublication'],
  ): void {
    const { record: successful, receipt, verification, bitmap, runtimeMetadata, deliveryMetadata } = artifacts;
    if (receipt && receiptPublication) {
      this.receipts.set(key, {
        receiptHash: receiptPublication.receiptHash,
        boardIndex: receiptPublication.boardIndex,
        receipt: { ...receipt },
      });
      this.receiptCounter += 1;
    }
    if (verification) {
      this.verificationResultRecords.set(key, verification);
    }
    if (bitmap.availability === 'available') {
      this.bitmapRecords.set(key, {
        sessionId: successful.sessionId,
        finalizationId: successful.finalizationId,
        ...encodeFinalizationBitmapData(bitmap.data),
      });
    }
    if (runtimeMetadata) {
      this.runtimeMetadataRecords.set(key, runtimeMetadata);
    }
    if (deliveryMetadata) {
      this.deliveryMetadata.record(successful.sessionId, successful.finalizationId, deliveryMetadata);
    }
  }

  override async commitSuccessfulFinalization(
    input: SuccessfulFinalizationCommitInput & { runtimeMetadata?: AwsFinalizationRuntimeMetadata },
  ): Promise<SuccessfulFinalizationCommitResult> {
    await Promise.resolve();
    const requested = admitSuccessfulFinalizationCommitRecord(input.record);
    this.requireVoting(requested.sessionId);
    const { bitmap, receipt, verification } = admitSuccessfulFinalizationEvidence(requested, input);
    const runtimePatch = admitOptionalAwsRuntimeMetadata(input.runtimeMetadata);

    const key = buildScopedKey(requested.sessionId, requested.finalizationId);
    const existingRuntime = this.runtimeMetadataRecords.get(key);
    const runtimeMetadata = runtimePatch ? mergeFinalizationRuntimeMetadata(existingRuntime, runtimePatch) : undefined;
    const existingDelivery = this.deliveryMetadata.get(requested.sessionId, requested.finalizationId);
    const deliveryMetadata = mergeRuntimeBundleDelivery(existingDelivery, runtimeMetadata);
    const existingReceipt = this.receipts.get(key);
    const existingReceiptBody = admitPersistedReceiptBody(existingReceipt);
    assertReceiptPublicationCounter(existingReceipt, receipt, this.receiptCounter);
    const receiptPublication = prepareReceiptPublication(receipt, existingReceipt, this.receiptCounter);
    const committed = buildPublishedSuccessfulFinalization(requested, receiptPublication);
    const successful = committed;

    const current = this.currentFinalization(requested.sessionId);
    assertSuccessfulFinalizationLifecycleAdmission(requested, current);
    const hasExistingBitmap = this.bitmapRecords.has(key);
    const hasExistingVerification = this.verificationResultRecords.has(key);
    if (isSuccessfulFinalizationRecord(current)) {
      const { existingBitmap, existingVerification } = admitReplayArtifacts(
        current,
        { present: hasExistingBitmap, value: this.bitmapRecords.get(key) },
        { present: hasExistingVerification, value: this.verificationResultRecords.get(key) },
      );
      assertSuccessfulFinalizationReplay(
        {
          record: current,
          receipt: existingReceiptBody,
          bitmap: existingBitmap,
          verification: existingVerification,
          runtimeMetadata: existingRuntime,
          deliveryMetadata: existingDelivery,
        },
        { record: successful, receipt, bitmap, verification, runtimeMetadata, deliveryMetadata },
      );
      return cloneSuccessfulCommitOutcome(successful, bitmap, receiptPublication);
    }
    assertNoPrematureCommitArtifacts(hasExistingBitmap, hasExistingVerification, Boolean(existingReceipt));
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
    staged.writeSuccessfulArtifacts(
      key,
      { record: successful, receipt, verification, bitmap, runtimeMetadata, deliveryMetadata },
      receiptPublication,
    );
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
    return cloneSuccessfulCommitOutcome(successful, bitmap, receiptPublication);
  }
}
