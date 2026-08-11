/**
 * File-backed session store for local production-build tests.
 *
 * The file contains one exact snapshot with separate record families. It does
 * not serialize or reconstruct the retired aggregate session authority.
 */

import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
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
  cloneSuccessfulFinalizationRecord,
  isSuccessfulFinalizationRecord,
} from '@stark-ballot/application/finalize/successful-finalization-commit-admission';
import {
  parseFinalizationRecord,
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
  AwsFinalizationDeliveryMetadataStore,
  AwsVerificationDeliveryMetadataInput,
} from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import { parseAwsFinalizationRuntimeMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationMetadataAdmission';
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
import { deriveExactCtProof } from '@stark-ballot/aws-adapters/store/ct-proof';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type {
  AddVoteResult,
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
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
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import type { VerificationReport, VerificationResult } from '@stark-ballot/verification/shared/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { generateLogId } from '@stark-ballot/zkvm-contract/zkvm/log-id';
import { createElectionId } from '@stark-ballot/zkvm-contract/zkvm/types';
import { computeSuccessfulFinalizationReceiptHash } from './successfulFinalizationReceipt';
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

function scopedKey(sessionId: string, finalizationId: string): string {
  return `${sessionId}\u0000${finalizationId}`;
}

function assertAllowedPayloadKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`Invalid ${label} payload`);
  }
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
  const bulletin = new SimpleBulletinBoard(voting.bulletin.getLogId());
  for (const [, vote] of Array.from(voting.votes.entries()).sort(([left], [right]) => left - right)) {
    bulletin.appendVote(vote.voteId, vote.commit.slice(2));
  }
  return {
    ...voting,
    votes: new Map(Array.from(voting.votes, ([index, vote]) => [index, { ...vote }])),
    bulletin,
    bulletinRootHistory: voting.bulletinRootHistory.map((snapshot) => ({ ...snapshot })),
    userParticipation: { ...voting.userParticipation },
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

function isTerminalVerificationStatus(status: VerificationResult['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'dev_mode';
}

function cloneRuntimeMetadata(metadata: AwsFinalizationRuntimeMetadata): AwsFinalizationRuntimeMetadata {
  return {
    ...metadata,
    ...(metadata.bundleMetadata ? { bundleMetadata: { ...metadata.bundleMetadata } } : {}),
  };
}

function cloneDeliveryMetadata(metadata: AwsVerificationDeliveryMetadataInput): AwsVerificationDeliveryMetadataInput {
  return { ...metadata };
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

export class FileMockSessionStore
  implements
    VoteStore,
    FinalizationStore,
    VerificationResultStore,
    AwsFinalizationRuntimeTransitionStore,
    AwsFinalizationRuntimeMetadataStore,
    AwsFinalizationDeliveryMetadataStore
{
  private state: FileStoreState = createEmptyFileStoreState();
  private verificationRollbackSnapshots = new Map<string, VerificationResultRecord | null>();
  private loadedSignature: string | null = null;

  private readonly storageDir: string;
  private readonly snapshotFile: string;
  private readonly temporarySnapshotFile: string;
  private readonly lockDirectory: string;

  constructor() {
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
      return;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.snapshotFile, 'utf8'));
      const admitted = parseFileStoreSnapshot(parsed);
      if (!admitted) {
        throw new Error('File store snapshot does not match the exact record layout');
      }
      this.state = admitted;
    } catch (error) {
      logger.warn('[FileMockStore] File snapshot failed closed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.state = createEmptyFileStoreState();
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

  private requireIdentity(sessionId: string): SessionIdentityRecord {
    const identity = parseSessionIdentityRecord(this.state.identityRecords.get(sessionId));
    if (!identity || identity.sessionId !== sessionId) {
      throw new Error('Session identity is missing or invalid');
    }
    return identity;
  }

  private requireVoting(sessionId: string): SessionVotingRecord {
    this.requireIdentity(sessionId);
    const voting = this.state.votingRecords.get(sessionId);
    if (!voting || voting.sessionId !== sessionId) {
      throw new Error('Session voting record is missing or invalid');
    }
    return voting;
  }

  private currentFinalization(sessionId: string): FinalizationRecord | null {
    const finalizationId = this.state.currentFinalizationIdBySession.get(sessionId);
    if (!finalizationId) {
      return null;
    }
    const record = parseFinalizationRecord(this.state.finalizationRecords.get(scopedKey(sessionId, finalizationId)));
    if (!record || record.sessionId !== sessionId || record.finalizationId !== finalizationId) {
      throw new Error('Current finalization record is missing or invalid');
    }
    return record;
  }

  private touchVotingRecord(sessionId: string, atMs = Date.now()): void {
    const voting = this.requireVoting(sessionId);
    this.state.votingRecords.set(sessionId, {
      ...voting,
      lastActivityMs: atMs,
    });
  }

  async createSession(): Promise<SessionIdentityRecord> {
    return this.mutate(() => {
      const sessionId =
        typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const createdAtMs = Date.now();
      const records = buildSessionRecords({
        sessionId,
        electionId: createElectionId(),
        electionConfigHash: getDefaultElectionConfigHash(),
        electionConfig: buildDefaultElectionConfig(),
        logId: generateLogId(`file-mock-${sessionId}`),
        createdAtMs,
        lastActivityMs: createdAtMs,
      });
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

  async getSessionIdentity(sessionId: string): Promise<SessionIdentityRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    const identity = parseSessionIdentityRecord(this.state.identityRecords.get(sessionId));
    return identity?.sessionId === sessionId ? cloneIdentity(identity) : null;
  }

  async getVotingRecord(sessionId: string): Promise<SessionVotingRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    const identity = parseSessionIdentityRecord(this.state.identityRecords.get(sessionId));
    const voting = this.state.votingRecords.get(sessionId);
    return identity && voting?.sessionId === sessionId ? cloneVoting(voting) : null;
  }

  async getSessionVotingSummary(sessionId: string): Promise<SessionVotingSummary | null> {
    const voting = await this.getVotingRecord(sessionId);
    return voting
      ? {
          sessionId,
          botCount: voting.botCount,
          userParticipation: voting.userParticipation,
        }
      : null;
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.mutate(() => {
      this.touchVotingRecord(sessionId);
      return { value: undefined, dirty: true };
    });
  }

  async addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult> {
    return this.mutate(() => {
      const identity = this.requireIdentity(sessionId);
      const voting = this.requireVoting(sessionId);
      const mutation = evaluateSessionVoteMutation(
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
      if (mutation.kind !== 'user_vote_appended') {
        throw new Error('Session vote mutation invariant violated');
      }
      this.state.votingRecords.set(sessionId, mutation.nextVoting);
      for (const intent of mutation.indexIntents) {
        this.state.voteIdIndex.set(intent.voteId, { sessionId, index: intent.index });
      }
      return { value: mutation.castResult, dirty: true };
    });
  }

  async addBotVotes(sessionId: string, votes: VoteData[]): Promise<void> {
    await this.mutate(() => {
      const identity = this.requireIdentity(sessionId);
      const voting = this.requireVoting(sessionId);
      const mutation = evaluateSessionVoteMutation(
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
      if (mutation.kind !== 'bot_votes_appended') {
        throw new Error('Session vote mutation invariant violated');
      }
      this.state.votingRecords.set(sessionId, mutation.nextVoting);
      for (const intent of mutation.indexIntents) {
        this.state.voteIdIndex.set(intent.voteId, { sessionId, index: intent.index });
      }
      if (mutation.indexIntents.length > 0) {
        logger.info('[FileMockStore] Bot votes added', {
          addedCount: mutation.indexIntents.length,
          totalBotCount: mutation.nextVoting.botCount,
          firstBotIndex: mutation.indexIntents[0]?.index,
          lastBotIndex: mutation.indexIntents.at(-1)?.index,
          bulletinSize: mutation.nextVoting.bulletin.getSize(),
        });
      }
      return { value: undefined, dirty: true };
    });
  }

  async getActiveSessionCount(): Promise<number> {
    return this.mutate(() => {
      const now = Date.now();
      let dirty = false;
      for (const [sessionId, voting] of this.state.votingRecords) {
        if (now - voting.lastActivityMs > FIVE_MINUTES_MS) {
          this.deleteSessionRecords(sessionId);
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

  private deleteSessionRecords(sessionId: string): void {
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

  async getVoteById(sessionId: string, voteId: string): Promise<{ voteData: StoredVoteRecord; index: number } | null> {
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
    await Promise.resolve();
    this.ensureFresh();
    const owner = this.state.voteIdIndex.get(voteId);
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

  async getCurrentFinalizationRecord(sessionId: string): Promise<FinalizationRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    this.requireIdentity(sessionId);
    return this.currentFinalization(sessionId);
  }

  async getFinalizationRecord(sessionId: string, finalizationId: FinalizationId): Promise<FinalizationRecord | null> {
    await Promise.resolve();
    this.ensureFresh();
    this.requireIdentity(sessionId);
    const record = parseFinalizationRecord(this.state.finalizationRecords.get(scopedKey(sessionId, finalizationId)));
    return record?.sessionId === sessionId && record.finalizationId === finalizationId ? record : null;
  }

  private async applyFinalizationCommand(
    command: FinalizationTransitionCommand,
    observability?: FinalizationQueuedPayload['observability'],
    runtimeMetadata?: AwsFinalizationRuntimeMetadata,
  ): Promise<AppliedFinalizationTransition> {
    const applied = await this.mutate(() => {
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
      let dirty = false;
      if (outcome.kind === 'applied') {
        record = parseFinalizationRecord(outcome.mutations.nextRecord) ?? null;
        if (!record) {
          throw new Error('Finalization transition produced an invalid record');
        }
        this.state.finalizationRecords.set(scopedKey(command.sessionId, command.finalizationId), record);
        this.state.currentFinalizationIdBySession.set(command.sessionId, command.finalizationId);
        this.touchVotingRecord(command.sessionId);
        mutated = true;
        dirty = true;
      }
      if (!record) {
        throw new Error(`Finalization transition was not applied: ${outcome.reason}`);
      }
      if (
        runtimeMetadata &&
        record.finalizationId === command.finalizationId &&
        record.state.status === requestedStatus(command)
      ) {
        const key = scopedKey(command.sessionId, command.finalizationId);
        this.state.runtimeMetadataRecords.set(key, cloneRuntimeMetadata(runtimeMetadata));
        if (runtimeMetadata.bundleMetadata) {
          this.state.deliveryMetadataRecords.set(key, {
            ...(runtimeMetadata.bundleMetadata.s3BundleKey
              ? { s3BundleKey: runtimeMetadata.bundleMetadata.s3BundleKey }
              : {}),
            ...(runtimeMetadata.bundleMetadata.s3UploadedAtMs === undefined
              ? {}
              : { s3UploadedAtMs: runtimeMetadata.bundleMetadata.s3UploadedAtMs }),
          });
        }
        dirty = true;
      }
      return {
        value: {
          record,
          mutated,
          outcome,
          before,
        },
        dirty,
      };
    });

    recordFinalizationStorePersistenceOutcome({
      sessionId: command.sessionId,
      requestedFinalizationId: command.finalizationId,
      requestedTo: requestedStatus(command),
      ...(applied.before ? { before: applied.before.state } : {}),
      actual: applied.record.state,
      semanticReason: applied.outcome.reason,
      authoritativeWrite: applied.mutated,
      ...(observability ? { metadata: observability } : {}),
    });
    return applied;
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

  async markAwsFinalizationRunning(
    sessionId: string,
    payload: AwsFinalizationRunningPayload,
  ): Promise<FinalizationState> {
    assertAllowedPayloadKeys(payload, AWS_RUNNING_PAYLOAD_KEYS, 'AWS running finalization');
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, semanticPayload, 'start'),
      semanticPayload.observability,
      {
        ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
      },
    );
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
    const runtimeMetadata =
      stepFunctionsArn === undefined && bundleMetadata === undefined
        ? undefined
        : {
            ...(stepFunctionsArn === undefined ? {} : { stepFunctionsArn }),
            ...(bundleMetadata === undefined ? {} : { bundleMetadata }),
          };
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
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, semanticPayload, 'fail'),
      semanticPayload.observability,
      {
        ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
      },
    );
    return applied.record.state;
  }

  async markAwsFinalizationTimedOut(
    sessionId: string,
    payload: AwsFinalizationTimedOutPayload,
  ): Promise<FinalizationState> {
    assertAllowedPayloadKeys(payload, AWS_TIMED_OUT_PAYLOAD_KEYS, 'AWS timed-out finalization');
    const { stepFunctionsArn, ...semanticPayload } = payload;
    const applied = await this.applyFinalizationCommand(
      buildFinalizationCommand(sessionId, semanticPayload, 'time_out'),
      semanticPayload.observability,
      {
        ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
      },
    );
    return applied.record.state;
  }

  async getAwsFinalizationRuntimeMetadata(
    sessionId: string,
    finalizationId: string,
  ): Promise<AwsFinalizationRuntimeMetadata | undefined> {
    await Promise.resolve();
    this.ensureFresh();
    const metadata = this.state.runtimeMetadataRecords.get(scopedKey(sessionId, finalizationId));
    return metadata ? cloneRuntimeMetadata(metadata) : undefined;
  }

  async recordAwsProofBundlePublication(
    sessionId: string,
    finalizationId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    await this.mutate(() => {
      this.requireIdentity(sessionId);
      this.state.deliveryMetadataRecords.set(scopedKey(sessionId, finalizationId), cloneDeliveryMetadata(metadata));
      return { value: undefined, dirty: true };
    });
  }

  recordAwsVerificationDeliveryMetadata(
    sessionId: string,
    finalizationId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    return this.recordAwsProofBundlePublication(sessionId, finalizationId, metadata);
  }

  async getAwsVerificationDeliveryMetadata(
    sessionId: string,
    finalizationId: string,
  ): Promise<AwsVerificationDeliveryMetadataInput | undefined> {
    await Promise.resolve();
    this.ensureFresh();
    const metadata = this.state.deliveryMetadataRecords.get(scopedKey(sessionId, finalizationId));
    return metadata ? cloneDeliveryMetadata(metadata) : undefined;
  }

  private requireSucceededFinalization(sessionId: string, finalizationId: string): FinalizationRecord {
    const record = this.currentFinalization(sessionId);
    if (!record || record.finalizationId !== finalizationId || record.state.status !== 'succeeded') {
      throw new Error('Finalization is unavailable for verification');
    }
    return record;
  }

  async getVerificationResultRecord(
    sessionId: string,
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

  async markVerificationRunning(
    sessionId: string,
    finalizationId: FinalizationId,
    report?: VerificationReport,
  ): Promise<VerificationResultRecord> {
    return this.mutate(() => {
      this.requireSucceededFinalization(sessionId, finalizationId);
      const key = scopedKey(sessionId, finalizationId);
      const current = parseVerificationResultRecord(this.state.verificationResultRecords.get(key)) ?? null;
      if (current && isTerminalVerificationStatus(current.verificationResult.status)) {
        return { value: current, dirty: false };
      }
      this.verificationRollbackSnapshots.set(key, current);
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
      this.state.verificationResultRecords.set(key, record);
      this.touchVotingRecord(sessionId);
      return { value: record, dirty: true };
    });
  }

  async rollbackVerificationResult(sessionId: string, finalizationId: FinalizationId): Promise<void> {
    await this.mutate(() => {
      this.requireSucceededFinalization(sessionId, finalizationId);
      const key = scopedKey(sessionId, finalizationId);
      const snapshot = this.verificationRollbackSnapshots.get(key);
      this.verificationRollbackSnapshots.delete(key);
      if (snapshot) {
        this.state.verificationResultRecords.set(key, snapshot);
      } else {
        this.state.verificationResultRecords.delete(key);
      }
      this.touchVotingRecord(sessionId);
      return { value: undefined, dirty: true };
    });
  }

  async completeVerificationResult(
    sessionId: string,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
  ): Promise<VerificationResultRecord> {
    return this.mutate(() => {
      this.requireSucceededFinalization(sessionId, finalizationId);
      const key = scopedKey(sessionId, finalizationId);
      const current = parseVerificationResultRecord(this.state.verificationResultRecords.get(key)) ?? null;
      if (current && isTerminalVerificationStatus(current.verificationResult.status)) {
        return { value: current, dirty: false };
      }
      const record = parseVerificationResultRecord({
        sessionId,
        finalizationId,
        verificationResult,
      });
      if (!record) {
        throw new Error('Invalid verification result record');
      }
      this.state.verificationResultRecords.set(key, record);
      this.verificationRollbackSnapshots.delete(key);
      this.touchVotingRecord(sessionId);
      return { value: record, dirty: true };
    });
  }

  async recordVerificationObservation(
    sessionId: string,
    finalizationId: string,
    input: VerificationObservationWrite,
  ): Promise<RecordVerificationObservationResult> {
    return this.mutate<RecordVerificationObservationResult>(() => {
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

  async getVerificationObservation(sessionId: string, finalizationId: string): Promise<VerificationObservation | null> {
    await Promise.resolve();
    this.ensureFresh();
    const observation = parseVerificationObservation(
      this.state.verificationObservationRecords.get(scopedKey(sessionId, finalizationId)),
    );
    return observation ?? null;
  }

  async getBitmapData(sessionId: string, finalizationId: FinalizationId): Promise<FinalizationBitmapData | null> {
    await Promise.resolve();
    this.ensureFresh();
    this.requireIdentity(sessionId);
    const key = scopedKey(sessionId, finalizationId);
    const finalization = parseFinalizationRecord(this.state.finalizationRecords.get(key));
    if (!finalization || finalization.state.status !== 'succeeded' || !finalization.finalizationResult) {
      return null;
    }
    return admitPersistedFinalizationBitmapData(finalization, this.state.bitmapRecords.get(key)) ?? null;
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
    const runtimePatch =
      input.runtimeMetadata === undefined ? undefined : parseAwsFinalizationRuntimeMetadata(input.runtimeMetadata);
    if (input.runtimeMetadata !== undefined && !runtimePatch) {
      throw new Error('Invalid AWS finalization runtime metadata');
    }
    const key = scopedKey(requested.sessionId, requested.finalizationId);
    const result = await this.mutate<{
      outcome: SuccessfulFinalizationCommitResult;
      published: boolean;
      before: FinalizationRecord | null;
    }>(() => {
      this.requireIdentity(requested.sessionId);
      const existingReceipt = this.state.receiptRecords.get(key);
      if (
        existingReceipt &&
        receipt &&
        (!Number.isSafeInteger(this.state.receiptCounter) || this.state.receiptCounter <= existingReceipt.boardIndex)
      ) {
        throw new Error('Receipt board counter does not cover the persisted publication');
      }
      const existingRuntime = this.state.runtimeMetadataRecords.get(key);
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
      const existingDelivery = this.state.deliveryMetadataRecords.get(key);
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
      const receiptHash = receipt
        ? (existingReceipt?.receiptHash ?? computeSuccessfulFinalizationReceiptHash(receipt))
        : undefined;
      const boardIndex = receipt ? (existingReceipt?.boardIndex ?? this.state.receiptCounter) : undefined;
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
      const before = this.currentFinalization(requested.sessionId);
      assertSuccessfulFinalizationLifecycleAdmission(requested, before);
      const hasExistingBitmap = this.state.bitmapRecords.has(key);
      const hasExistingVerification = this.state.verificationResultRecords.has(key);
      if (isSuccessfulFinalizationRecord(before)) {
        const existingBitmap = hasExistingBitmap
          ? admitPersistedFinalizationBitmapData(before, this.state.bitmapRecords.get(key))
          : undefined;
        if (hasExistingBitmap && !existingBitmap) {
          throw new Error('Invalid persisted finalization bitmap');
        }
        const expectedBitmap =
          bitmap.availability === 'available'
            ? { sessionId: requested.sessionId, finalizationId: requested.finalizationId, ...bitmap.data }
            : undefined;
        const existingVerification = hasExistingVerification
          ? parseVerificationResultRecord(this.state.verificationResultRecords.get(key))
          : undefined;
        if (hasExistingVerification && !existingVerification) {
          throw new Error('Invalid persisted verification result record');
        }
        if (
          !isDeepStrictEqual(before, successful) ||
          !isDeepStrictEqual(existingReceipt?.receipt, receipt) ||
          !isDeepStrictEqual(existingBitmap, expectedBitmap) ||
          (verification !== undefined && !isDeepStrictEqual(existingVerification, verification)) ||
          (runtimeMetadata !== undefined && !isDeepStrictEqual(existingRuntime, runtimeMetadata)) ||
          (deliveryMetadata !== undefined && !isDeepStrictEqual(existingDelivery, deliveryMetadata))
        ) {
          throw new Error('Successful finalization commit conflicts with existing authority');
        }
        return { value: { outcome, published: false, before }, dirty: false };
      }
      if (hasExistingBitmap || hasExistingVerification) {
        throw new Error('Successful finalization artifacts exist before terminal authority');
      }
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
          ...bitmap.data,
          includedBitmap: [...bitmap.data.includedBitmap],
          ...(bitmap.data.seenBitmap ? { seenBitmap: [...bitmap.data.seenBitmap] } : {}),
        });
      }
      if (runtimeMetadata) {
        this.state.runtimeMetadataRecords.set(key, cloneRuntimeMetadata(runtimeMetadata));
      }
      if (deliveryMetadata) {
        this.state.deliveryMetadataRecords.set(key, cloneDeliveryMetadata(deliveryMetadata));
      }
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
