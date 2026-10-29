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
import { SessionCommandStore, type VerificationWriteMode } from './session-command-store';
import { assertNoPrematureCommitArtifacts } from './successfulFinalizationReplay';
import {
  cloneSessionIdentity as cloneIdentity,
  cloneSessionVoting,
  createDefaultSessionRecords,
  cloneRuntimeMetadata,
} from './session-records';
import { assertSuccessfulFinalizationReplay, admitReplayArtifacts } from './successfulFinalizationReplay';
import {
  AWS_RUNNING_PAYLOAD_KEYS,
  AWS_FAILED_PAYLOAD_KEYS,
  AWS_TIMED_OUT_PAYLOAD_KEYS,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { assertAllowedFinalizationPayloadKeys } from '@stark-ballot/application/finalize/finalization-store';
/**
 * File-backed session store for local production-build tests.
 *
 * The file contains one exact snapshot with separate record families. It does
 * not serialize or reconstruct the retired aggregate session authority.
 */

import { encodeFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-storage';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  buildFinalizationCommand,
  requestedFinalizationStatus,
  type FinalizationBitmapRecord,
  type FinalizationQueuedPayload,
  type FinalizationStore,
  type SuccessfulFinalizationCommitInput,
  type SuccessfulFinalizationCommitResult,
} from '@stark-ballot/application/finalize/finalization-store';
import { admitPersistedFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-bitmap-admission';
import {
  admitSuccessfulFinalizationCommitRecord,
  assertSuccessfulFinalizationLifecycleAdmission,
  admitSuccessfulFinalizationEvidence,
  buildPublishedSuccessfulFinalization,
  cloneSuccessfulFinalizationRecord,
  isSuccessfulFinalizationRecord,
} from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
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
  evaluateFinalizationTransition,
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
import type {
  AwsFinalizationDeliveryMetadataStore,
  AwsVerificationDeliveryMetadataInput,
} from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import {
  admitOptionalAwsRuntimeMetadata,
  mergeRuntimeBundleDelivery,
  mergeFinalizationRuntimeMetadata,
  projectRuntimeBundleDelivery,
} from '@stark-ballot/aws-adapters/finalize/finalizationMetadataAdmission';
import {
  type AwsFinalizationFailedPayload,
  type AwsFinalizationRunningPayload,
  type AwsFinalizationRuntimeMetadata,
  type AwsFinalizationRuntimeMetadataStore,
  type AwsFinalizationRuntimeTransitionStore,
  type AwsFinalizationTimedOutPayload,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
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
import { assertReceiptPublicationCounter, prepareReceiptPublication } from './successfulFinalizationReceipt';
import {
  createEmptyFileStoreState,
  parseFileStoreSnapshot,
  serializeFileStoreState,
  type FileStoreState,
} from './fileMock/sessionSerde';

type AppliedFinalizationTransition = {
  record: FinalizationRecord;
  mutated: boolean;
  outcome: Exclude<FinalizationTransitionOutcome, { kind: 'invalid' }>;
  before: FinalizationRecord | null;
};

type MutationResult<T> = {
  value: T;
  dirty: boolean;
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

function scopedKey(sessionId: SessionId, finalizationId: string): string {
  return `${sessionId}\u0000${finalizationId}`;
}

function cloneVoting(voting: SessionVotingRecord): SessionVotingRecord {
  const bulletin = new SimpleBulletinBoard(voting.bulletin.getLogId());
  for (const [, vote] of Array.from(voting.votes.entries()).sort(([left], [right]) => left - right)) {
    bulletin.appendVote(vote.voteId, vote.commit.slice(2));
  }
  return cloneSessionVoting({ ...voting, bulletin });
}

function cloneDeliveryMetadata(metadata: AwsVerificationDeliveryMetadataInput): AwsVerificationDeliveryMetadataInput {
  return { ...metadata };
}

export class FileMockSessionStore
  extends SessionCommandStore
  implements
    VoteStore,
    SessionVoteMutationStore,
    FinalizationStore,
    VerificationResultStore,
    AwsFinalizationRuntimeTransitionStore,
    AwsFinalizationRuntimeMetadataStore,
    AwsFinalizationDeliveryMetadataStore
{
  private state: FileStoreState = createEmptyFileStoreState();
  private verificationRollbackSnapshots = new Map<string, VerificationResultRecord | null>();
  private loadedSignature: string | null = null;
  private snapshotAdmissionFailed = false;

  private readonly storageDir: string;
  private readonly snapshotFile: string;
  private readonly temporarySnapshotFile: string;
  private readonly lockDirectory: string;

  constructor() {
    super();
    const configuredDirectory = process.env['FILE_MOCK_STORE_DIR'];
    this.storageDir = configuredDirectory
      ? path.resolve(configuredDirectory)
      : path.join(process.cwd(), '.tmp', 'mock-sessions');
    this.snapshotFile = path.join(this.storageDir, 'sessions.json');
    this.temporarySnapshotFile = `${this.snapshotFile}.tmp`;
    this.lockDirectory = path.join(this.storageDir, 'sessions.lock');
    mkdirSync(this.storageDir, { recursive: true });
    this.loadFromDisk(true);
  }

  private computeSignature(): string | null {
    if (!existsSync(this.snapshotFile)) {
      return null;
    }
    const stats = statSync(this.snapshotFile);
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  }

  private loadFromDisk(force = false): void {
    const signature = this.computeSignature();
    if (!force && signature === this.loadedSignature) {
      return;
    }
    if (signature === null) {
      this.state = createEmptyFileStoreState();
      this.loadedSignature = null;
      this.snapshotAdmissionFailed = false;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.snapshotFile, 'utf8'));
      const admitted = parseFileStoreSnapshot(parsed);
      if (!admitted) {
        throw new Error('File store snapshot does not match the exact record layout');
      }
      this.state = admitted;
      this.snapshotAdmissionFailed = false;
    } catch (error) {
      logger.warn('[FileMockStore] File snapshot failed closed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.state = createEmptyFileStoreState();
      this.snapshotAdmissionFailed = true;
    }
    this.loadedSignature = signature;
  }

  private ensureFresh(): void {
    this.loadFromDisk(false);
  }

  private async persistState(): Promise<void> {
    const serialized = `${JSON.stringify(serializeFileStoreState(this.state), null, 2)}\n`;
    await writeFile(this.temporarySnapshotFile, serialized, 'utf8');
    await rename(this.temporarySnapshotFile, this.snapshotFile);
    this.loadedSignature = this.computeSignature();
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(this.storageDir, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await mkdir(this.lockDirectory);
        return () => rm(this.lockDirectory, { recursive: true, force: true });
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : '';
        if (code !== 'EEXIST' || Date.now() >= deadline) {
          throw error;
        }
        await wait(LOCK_RETRY_MS);
      }
    }
  }

  private async mutate<T>(mutation: () => MutationResult<T> | Promise<MutationResult<T>>): Promise<T> {
    const release = await this.acquireLock();
    try {
      this.loadFromDisk(true);
      const result = await mutation();
      if (result.dirty) {
        await this.persistState();
      }
      return result.value;
    } catch (error) {
      this.loadFromDisk(true);
      throw error;
    } finally {
      await release();
    }
  }

  private requireIdentity(sessionId: SessionId): SessionIdentityRecord {
    const identity = parseSessionIdentityRecord(this.state.identityRecords.get(sessionId));
    if (!identity || identity.sessionId !== sessionId) {
      throw new Error('Session identity is missing or invalid');
    }
    return identity;
  }

  private requireVoting(sessionId: SessionId): SessionVotingRecord {
    this.requireIdentity(sessionId);
    const voting = this.state.votingRecords.get(sessionId);
    if (!voting || voting.sessionId !== sessionId) {
      throw new Error('Session voting record is missing or invalid');
    }
    return voting;
  }

  private currentFinalization(sessionId: SessionId): FinalizationRecord | null {
    return readMappedFinalization(sessionId, this.state.currentFinalizationIdBySession, this.state.finalizationRecords);
  }

  private touchVotingRecord(sessionId: SessionId, atMs = Date.now()): void {
    const voting = this.requireVoting(sessionId);
    this.state.votingRecords.set(sessionId, {
      ...voting,
      lastActivityMs: atMs,
    });
  }

  async createSession(): Promise<SessionIdentityRecord> {
    return this.mutate(() => {
      const sessionId = asSessionId(
        typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      );
      const createdAtMs = Date.now();
      const records = createDefaultSessionRecords(sessionId, `file-mock-${sessionId}`, createdAtMs);
      const identity = parseSessionIdentityRecord(records.identity);
      if (!identity) {
        throw new Error('Session creation produced invalid lifecycle records');
      }
      this.state.identityRecords.set(sessionId, identity);
      this.state.votingRecords.set(sessionId, records.voting);
      logger.info('[FileMockStore] Created session', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
      return {
        value: cloneIdentity(identity),
        dirty: true,
      };
    });
  }

  async getSessionIdentity(sessionId: SessionId): Promise<SessionIdentityRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    const identity = parseSessionIdentityRecord(this.state.identityRecords.get(sessionId));
    return identity?.sessionId === sessionId ? cloneIdentity(identity) : null;
  }

  async getVotingRecord(sessionId: SessionId): Promise<SessionVotingRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    const identity = parseSessionIdentityRecord(this.state.identityRecords.get(sessionId));
    const voting = this.state.votingRecords.get(sessionId);
    return identity && voting?.sessionId === sessionId ? cloneVoting(voting) : null;
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

  async touchSession(sessionId: SessionId): Promise<void> {
    await this.mutate(() => {
      this.touchVotingRecord(sessionId);
      return { value: undefined, dirty: true };
    });
  }

  protected override mutateVotes<T>(
    sessionId: SessionId,
    command: SessionVoteCommand,
    prepareWrite: (mutation: SessionVoteMutation) => PreparedVoteWrite<T>,
  ): Promise<Result<T, SessionVoteStoreError>> {
    return this.mutate<Result<T, SessionVoteStoreError>>(() => {
      const identity = parseSessionIdentityRecord(this.state.identityRecords.get(sessionId));
      if (!identity || identity.sessionId !== sessionId) {
        if (this.snapshotAdmissionFailed) throw new Error('Session identity is missing or invalid');
        return { value: { ok: false, error: { code: ApplicationErrorCode.SESSION_NOT_FOUND } }, dirty: false };
      }
      const voting = this.requireVoting(sessionId);
      const outcome = evaluateStoredVoteCommand(identity, voting, this.currentFinalization(sessionId), command);
      if (!outcome.ok) return { value: outcome, dirty: false };
      const write = prepareWrite(outcome.value);
      if (!write.mutation) return { value: { ok: true, value: write.value }, dirty: false };
      installMappedVoteMutation(sessionId, write.mutation, this.state.votingRecords, this.state.voteIdIndex);
      if (write.mutation.kind === 'bot_votes_appended' && write.mutation.indexIntents.length > 0) {
        logger.info('[FileMockStore] Bot votes added', describeBotVoteAddition(write.mutation));
      }
      return { value: { ok: true, value: write.value }, dirty: true };
    });
  }

  async getActiveSessionCount(): Promise<number> {
    return this.mutate(() => {
      const now = Date.now();
      let dirty = false;
      for (const voting of this.state.votingRecords.values()) {
        if (now - voting.lastActivityMs > FIVE_MINUTES_MS) {
          this.deleteSessionRecords(voting.sessionId);
          dirty = true;
        }
      }
      let count = 0;
      for (const sessionId of this.state.identityRecords.keys()) {
        if (this.state.votingRecords.has(sessionId)) {
          count += 1;
        }
      }
      return { value: count, dirty };
    });
  }

  private deleteSessionRecords(sessionId: SessionId): void {
    this.state.identityRecords.delete(sessionId);
    this.state.votingRecords.delete(sessionId);
    this.state.currentFinalizationIdBySession.delete(sessionId);
    for (const map of [
      this.state.finalizationRecords,
      this.state.verificationResultRecords,
      this.state.verificationObservationRecords,
      this.state.bitmapRecords,
      this.state.runtimeMetadataRecords,
      this.state.deliveryMetadataRecords,
      this.state.receiptRecords,
    ]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${sessionId}\u0000`)) {
          map.delete(key);
        }
      }
    }
    for (const [voteId, owner] of this.state.voteIdIndex) {
      if (owner.sessionId === sessionId) {
        this.state.voteIdIndex.delete(voteId);
      }
    }
  }

  async getVoteById(
    sessionId: SessionId,
    voteId: string,
  ): Promise<{ voteData: StoredVoteRecord; index: number } | null> {
    await Promise.resolve();
    this.ensureFresh();
    const owner = this.state.voteIdIndex.get(voteId);
    if (!owner || owner.sessionId !== sessionId) {
      return null;
    }
    const voting = this.state.votingRecords.get(sessionId);
    const voteData = voting?.votes.get(owner.index);
    return voteData ? { voteData: { ...voteData }, index: owner.index } : null;
  }

  async getVoteByIdWithProof(sessionId: SessionId, voteId: string): Promise<VoteWithCtProof | null> {
    return readStoredVoteProof(this, sessionId, voteId);
  }

  async getVoteProof(voteId: string): Promise<TimestampedCtProof | null> {
    await Promise.resolve();
    this.ensureFresh();
    return readIndexedVoteProof(this, this.state.voteIdIndex.get(voteId), voteId);
  }

  override async getCurrentFinalizationRecord(sessionId: SessionId): Promise<FinalizationRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    this.requireIdentity(sessionId);
    return this.currentFinalization(sessionId);
  }

  async getFinalizationRecord(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<FinalizationRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    this.requireIdentity(sessionId);
    const record = finalizationRecordCodec.admit(
      this.state.finalizationRecords.get(scopedKey(sessionId, finalizationId)),
    );
    return record?.sessionId === sessionId && record.finalizationId === finalizationId ? record : null;
  }

  private publishTransitionMetadata(
    command: FinalizationTransitionCommand,
    record: FinalizationRecord,
    runtimeMetadata: AwsFinalizationRuntimeMetadata | undefined,
  ): boolean {
    if (
      !runtimeMetadata ||
      record.finalizationId !== command.finalizationId ||
      record.state.status !== requestedFinalizationStatus(command)
    )
      return false;
    const key = scopedKey(command.sessionId, command.finalizationId);
    this.state.runtimeMetadataRecords.set(key, cloneRuntimeMetadata(runtimeMetadata));
    const delivery = projectRuntimeBundleDelivery(runtimeMetadata);
    if (delivery) this.state.deliveryMetadataRecords.set(key, delivery);
    return true;
  }

  protected override async applyFinalizationCommand(
    command: FinalizationTransitionCommand,
    observability?: FinalizationQueuedPayload['observability'],
    runtimeMetadata?: AwsFinalizationRuntimeMetadata,
  ): Promise<AppliedFinalizationTransition> {
    const applied = await this.mutate(() => {
      this.requireIdentity(command.sessionId);
      const prepared = prepareMappedFinalizationCommand(
        command,
        this.state.currentFinalizationIdBySession,
        this.state.finalizationRecords,
      );
      const { record, mutated } = prepared;
      if (mutated) {
        this.state.finalizationRecords.set(scopedKey(command.sessionId, command.finalizationId), record);
        this.state.currentFinalizationIdBySession.set(command.sessionId, command.finalizationId);
        this.touchVotingRecord(command.sessionId);
      }
      let dirty = mutated;
      if (this.publishTransitionMetadata(command, record, runtimeMetadata)) dirty = true;
      return { value: prepared, dirty };
    });

    recordFinalizationStorePersistenceOutcome({
      sessionId: command.sessionId,
      requestedFinalizationId: command.finalizationId,
      requestedTo: requestedFinalizationStatus(command),
      ...(applied.before ? { before: applied.before.state } : {}),
      actual: applied.record.state,
      semanticReason: applied.outcome.reason,
      authoritativeWrite: applied.mutated,
      ...(observability ? { metadata: observability } : {}),
    });
    return applied;
  }

  async markAwsFinalizationRunning(
    sessionId: SessionId,
    payload: AwsFinalizationRunningPayload,
  ): Promise<FinalizationState> {
    assertAllowedFinalizationPayloadKeys(payload, AWS_RUNNING_PAYLOAD_KEYS, 'AWS running finalization');
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, 'start', semanticPayload),
      semanticPayload.observability,
      {
        ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
      },
    );
    return applied.record.state;
  }

  async markAwsFinalizationFailed(
    sessionId: SessionId,
    payload: AwsFinalizationFailedPayload,
  ): Promise<FinalizationState> {
    assertAllowedFinalizationPayloadKeys(payload, AWS_FAILED_PAYLOAD_KEYS, 'AWS failed finalization');
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, 'fail', semanticPayload),
      semanticPayload.observability,
      {
        ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
      },
    );
    return applied.record.state;
  }

  async markAwsFinalizationTimedOut(
    sessionId: SessionId,
    payload: AwsFinalizationTimedOutPayload,
  ): Promise<FinalizationState> {
    assertAllowedFinalizationPayloadKeys(payload, AWS_TIMED_OUT_PAYLOAD_KEYS, 'AWS timed-out finalization');
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, 'time_out', semanticPayload),
      semanticPayload.observability,
      {
        ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
      },
    );
    return applied.record.state;
  }

  async getAwsFinalizationRuntimeMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<AwsFinalizationRuntimeMetadata | undefined> {
    await Promise.resolve();
    this.ensureFresh();
    const metadata = this.state.runtimeMetadataRecords.get(scopedKey(sessionId, finalizationId));
    return metadata ? cloneRuntimeMetadata(metadata) : undefined;
  }

  override async recordAwsProofBundlePublication(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    await this.mutate(() => {
      this.requireIdentity(sessionId);
      this.state.deliveryMetadataRecords.set(scopedKey(sessionId, finalizationId), cloneDeliveryMetadata(metadata));
      return { value: undefined, dirty: true };
    });
  }

  async getAwsVerificationDeliveryMetadata(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<AwsVerificationDeliveryMetadataInput | undefined> {
    await Promise.resolve();
    this.ensureFresh();
    const metadata = this.state.deliveryMetadataRecords.get(scopedKey(sessionId, finalizationId));
    return metadata ? cloneDeliveryMetadata(metadata) : undefined;
  }

  private requireSucceededFinalization(sessionId: SessionId, finalizationId: FinalizationId): FinalizationRecord {
    return requireMappedSucceededFinalization(this.currentFinalization(sessionId), finalizationId);
  }

  async getVerificationResultRecord(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<VerificationResultRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    this.requireIdentity(sessionId);
    const record = parseVerificationResultRecord(
      this.state.verificationResultRecords.get(scopedKey(sessionId, finalizationId)),
    );
    return record?.sessionId === sessionId && record.finalizationId === finalizationId ? record : null;
  }

  protected override async writeVerificationResult(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
    mode: VerificationWriteMode,
  ): Promise<VerificationResultRecord> {
    return this.mutate(() => {
      this.requireSucceededFinalization(sessionId, finalizationId);
      const key = scopedKey(sessionId, finalizationId);
      const current = parseVerificationResultRecord(this.state.verificationResultRecords.get(key)) ?? null;
      if (current && isTerminalVerificationStatus(current.verificationResult.status)) {
        return { value: current, dirty: false };
      }
      if (mode === 'start') this.verificationRollbackSnapshots.set(key, current);
      const record = createVerificationResultRecord(sessionId, finalizationId, verificationResult);
      this.state.verificationResultRecords.set(key, record);
      if (mode === 'complete') this.verificationRollbackSnapshots.delete(key);
      this.touchVotingRecord(sessionId);
      return { value: record, dirty: true };
    });
  }

  async rollbackVerificationResult(sessionId: SessionId, finalizationId: FinalizationId): Promise<void> {
    await this.mutate(() => {
      this.requireSucceededFinalization(sessionId, finalizationId);
      const key = scopedKey(sessionId, finalizationId);
      restoreMappedVerificationSnapshot(key, this.verificationRollbackSnapshots, this.state.verificationResultRecords);
      this.touchVotingRecord(sessionId);
      return { value: undefined, dirty: true };
    });
  }

  async recordVerificationObservation(
    sessionId: SessionId,
    finalizationId: string,
    input: VerificationObservationWrite,
  ): Promise<RecordVerificationObservationResult> {
    return this.mutate<RecordVerificationObservationResult>(() => {
      this.requireIdentity(sessionId);
      const requested = admitMappedObservation(finalizationId, input);
      const key = scopedKey(sessionId, finalizationId);
      const existing = parseVerificationObservation(this.state.verificationObservationRecords.get(key));
      const resolution = resolveVerificationObservationRecord(
        this.state.currentFinalizationIdBySession.get(sessionId),
        existing,
        requested,
      );
      if (resolution.status !== 'recorded') {
        return { value: resolution, dirty: false };
      }
      this.state.verificationObservationRecords.set(key, requested);
      this.touchVotingRecord(sessionId, requested.observedAt);
      return { value: resolution, dirty: true };
    });
  }

  async getVerificationObservation(
    sessionId: SessionId,
    finalizationId: string,
  ): Promise<VerificationObservation | null> {
    await Promise.resolve();
    this.ensureFresh();
    const observation = parseVerificationObservation(
      this.state.verificationObservationRecords.get(scopedKey(sessionId, finalizationId)),
    );
    return observation ?? null;
  }

  async getBitmapData(sessionId: SessionId, finalizationId: FinalizationId): Promise<FinalizationBitmapRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    this.requireIdentity(sessionId);
    const key = scopedKey(sessionId, finalizationId);
    const finalization = finalizationRecordCodec.admit(this.state.finalizationRecords.get(key));
    if (!finalization || finalization.state.status !== 'succeeded' || !finalization.finalizationResult) {
      return null;
    }
    return admitPersistedFinalizationBitmapData(finalization, this.state.bitmapRecords.get(key)) ?? null;
  }

  private writeSuccessfulArtifacts(
    key: string,
    artifacts: Parameters<typeof assertSuccessfulFinalizationReplay>[1],
    receiptPublication: SuccessfulFinalizationCommitResult['receiptPublication'],
  ): void {
    const { record: successful, receipt, verification, bitmap, runtimeMetadata, deliveryMetadata } = artifacts;
    if (receipt && receiptPublication) {
      this.state.receiptRecords.set(key, {
        sessionId: successful.sessionId,
        finalizationId: successful.finalizationId,
        receiptHash: receiptPublication.receiptHash,
        boardIndex: receiptPublication.boardIndex,
        receipt: { ...receipt },
      });
      this.state.receiptCounter += 1;
    }
    if (verification) {
      this.state.verificationResultRecords.set(key, verification);
    }
    if (bitmap.availability === 'available') {
      this.state.bitmapRecords.set(key, {
        sessionId: successful.sessionId,
        finalizationId: successful.finalizationId,
        ...encodeFinalizationBitmapData(bitmap.data),
      });
    }
    if (runtimeMetadata) {
      this.state.runtimeMetadataRecords.set(key, cloneRuntimeMetadata(runtimeMetadata));
    }
    if (deliveryMetadata) {
      this.state.deliveryMetadataRecords.set(key, cloneDeliveryMetadata(deliveryMetadata));
    }
  }

  override async commitSuccessfulFinalization(
    input: SuccessfulFinalizationCommitInput & { runtimeMetadata?: AwsFinalizationRuntimeMetadata },
  ): Promise<SuccessfulFinalizationCommitResult> {
    const requested = admitSuccessfulFinalizationCommitRecord(input.record);
    const { bitmap, receipt, verification } = admitSuccessfulFinalizationEvidence(requested, input);
    const runtimePatch = admitOptionalAwsRuntimeMetadata(input.runtimeMetadata);
    const key = scopedKey(requested.sessionId, requested.finalizationId);
    const result = await this.mutate<{
      outcome: SuccessfulFinalizationCommitResult;
      published: boolean;
      before: FinalizationRecord | null;
    }>(() => {
      this.requireIdentity(requested.sessionId);
      const existingReceipt = this.state.receiptRecords.get(key);
      assertReceiptPublicationCounter(existingReceipt, receipt, this.state.receiptCounter);
      const existingRuntime = this.state.runtimeMetadataRecords.get(key);
      const runtimeMetadata = runtimePatch
        ? mergeFinalizationRuntimeMetadata(existingRuntime, runtimePatch)
        : undefined;
      const existingDelivery = this.state.deliveryMetadataRecords.get(key);
      const deliveryMetadata = mergeRuntimeBundleDelivery(existingDelivery, runtimeMetadata);
      const receiptPublication = prepareReceiptPublication(receipt, existingReceipt, this.state.receiptCounter);
      const committed = buildPublishedSuccessfulFinalization(requested, receiptPublication);
      const successful = committed;
      const outcome: SuccessfulFinalizationCommitResult = {
        record: successful,
        bitmap,
        ...(receiptPublication ? { receiptPublication } : {}),
      };
      const before = this.currentFinalization(requested.sessionId);
      assertSuccessfulFinalizationLifecycleAdmission(requested, before);
      const hasExistingBitmap = this.state.bitmapRecords.has(key);
      const hasExistingVerification = this.state.verificationResultRecords.has(key);
      if (isSuccessfulFinalizationRecord(before)) {
        const { existingBitmap, existingVerification } = admitReplayArtifacts(
          before,
          { present: hasExistingBitmap, value: this.state.bitmapRecords.get(key) },
          { present: hasExistingVerification, value: this.state.verificationResultRecords.get(key) },
        );
        assertSuccessfulFinalizationReplay(
          {
            record: before,
            receipt: existingReceipt?.receipt,
            bitmap: existingBitmap,
            verification: existingVerification,
            runtimeMetadata: existingRuntime,
            deliveryMetadata: existingDelivery,
          },
          { record: successful, receipt, bitmap, verification, runtimeMetadata, deliveryMetadata },
        );
        return { value: { outcome, published: false, before }, dirty: false };
      }
      assertNoPrematureCommitArtifacts(hasExistingBitmap, hasExistingVerification);
      const { finalizationId: _finalizationId, ...authority } = successful.finalizationResult;
      void _finalizationId;
      const transition = evaluateFinalizationTransition({
        authority: { currentRecord: before },
        command: {
          kind: 'succeed',
          sessionId: successful.sessionId,
          finalizationId: successful.finalizationId,
          queuedAtMs: successful.state.queuedAtMs,
          startedAtMs: successful.state.startedAtMs,
          completedAtMs: successful.state.completedAtMs,
          scenarioContext: successful.scenarioContext,
          finalizationResult: authority,
        },
        evaluatedAtMs: Date.now(),
      });
      if (transition.kind !== 'applied') {
        throw new Error('Successful finalization commit was not applied');
      }
      this.state.finalizationRecords.set(key, cloneSuccessfulFinalizationRecord(successful));
      this.state.currentFinalizationIdBySession.set(successful.sessionId, successful.finalizationId);
      this.writeSuccessfulArtifacts(
        key,
        { record: successful, receipt, verification, bitmap, runtimeMetadata, deliveryMetadata },
        receiptPublication,
      );
      this.touchVotingRecord(successful.sessionId);
      return { value: { outcome, published: true, before }, dirty: true };
    });
    if (result.published) {
      recordFinalizationStorePersistenceOutcome({
        sessionId: requested.sessionId,
        requestedFinalizationId: requested.finalizationId,
        requestedTo: 'succeeded',
        ...(result.before ? { before: result.before.state } : {}),
        actual: result.outcome.record.state,
        authoritativeWrite: true,
        metadata: input.observability ?? { source: 'finalize', reason: 'STATE_PERSISTED' },
      });
    }
    return result.outcome;
  }
}
