/**
 * Mock session store for testing without external persistence
 */

import type { VoteData, SessionData, AddVoteResult } from '@stark-ballot/domain/types/server';
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
  admitAwsPersistedFinalizationResultBranch,
  admitAwsPersistedFinalizationStateBranch,
  mergeAwsProofBundleDeliveryMetadata,
  parseAwsFinalizationRuntimeState,
  parseAwsPersistedFinalizationResult,
  updateAwsFinalizationResultVerificationState,
  type AwsPersistedFinalizationResult,
  type AwsPersistedVerificationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import {
  InMemoryAwsVerificationDeliveryMetadataStore,
  type AwsFinalizationDeliveryMetadataStore,
  type AwsVerificationDeliveryMetadataInput,
} from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import {
  assertNoAwsRuntimeTransitionMetadata,
  type AwsFinalizationFailedPayload,
  type AwsFinalizationRunningPayload,
  type AwsFinalizationRuntimeTransitionStore,
  type AwsFinalizationSucceededPayload,
  type AwsFinalizationTimedOutPayload,
  type AwsRuntimeTransitionMetadata,
  type AwsSucceededTransitionMetadata,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import type { SessionStoreUpdate, VoteStore } from '@stark-ballot/domain/types/voteStore';
import crypto from 'crypto';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { computeCommitment, createElectionId } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { generateLogId } from '@stark-ballot/zkvm-contract/zkvm/log-id';
import {
  applyCanonicalCtSessionProjection,
  assertCanonicalUserVoteIndexForBotVotes,
  buildCanonicalCtSessionProjection,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { deriveExactCtProof } from '@stark-ballot/aws-adapters/store/ct-proof';
import { stageCtVoteWrites } from '@stark-ballot/aws-adapters/store/stagedCtWrite';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';
import {
  assertAdmissibleFinalizationArtifactPatch,
  assertWritableFinalizationArtifact,
  assertWritableBitmapSidecarOwner,
  buildFailClosedFinalizationState,
  canRecoverFinalizationArtifactWithPatch,
  clearRecoveredFinalizationArtifactState,
  resolveFailClosedFinalizationArtifactState,
} from '@stark-ballot/aws-adapters/store/finalizationArtifactAdmission';
import {
  buildUnsupportedCurrentArtifactDetails,
  classifyAuthoritativeWriteContract,
  hasSessionFinalizationBranch,
  isRecoverableCurrentLiveSession,
  UnsupportedCurrentArtifactBoundaryError,
  resolveAuthoritativeWriteContractGeneration,
  resolveCurrentContractGeneration,
} from '@stark-ballot/domain/contract';

interface ReceiptEntry {
  receiptHash: string;
  boardIndex: number;
  receipt: { receipt: string; timestamp: number };
}

type AwsMetadataMode = 'pure' | 'aws';

function requireAwsPersistedFinalizationResult(
  result: FinalizationResultAuthority | AwsPersistedFinalizationResult,
  executionId: string,
  deliveryMetadata?: AwsVerificationDeliveryMetadataInput,
): AwsPersistedFinalizationResult {
  const persisted = mergeAwsProofBundleDeliveryMetadata(result, { executionId, ...deliveryMetadata });
  if (!persisted) {
    throw new Error('Invalid finalization result persistence payload');
  }
  return persisted;
}

const SESSION_UPDATE_KEYS = new Set<keyof SessionStoreUpdate>([
  'electionId',
  'electionConfigHash',
  'electionConfig',
  'logId',
]);

function assertSessionUpdateContainsOnlyAllowedFields(data: SessionStoreUpdate): void {
  const record = data as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SESSION_UPDATE_KEYS.has(key as keyof SessionStoreUpdate)) {
      throw new Error(`Session field must be updated through a dedicated store capability: ${key}`);
    }
  }
}

function buildVerificationSnapshotKey(sessionId: string, executionId: string): string {
  return `${sessionId}:${executionId}`;
}

function isTerminalVerificationStatus(status: AwsPersistedVerificationResult['status'] | undefined): boolean {
  return status === 'success' || status === 'failed' || status === 'dev_mode';
}

function shouldIgnoreVerificationCompletion(current: AwsPersistedFinalizationResult, executionId: string): boolean {
  const currentExecutionId = current.verificationExecutionId ?? current.verificationResult?.executionId;
  if (currentExecutionId && currentExecutionId !== executionId) {
    return true;
  }
  return (
    current.verificationResult?.executionId === executionId &&
    isTerminalVerificationStatus(current.verificationResult.status)
  );
}

function parsePersistedFinalizationState(value: unknown): FinalizationState | undefined {
  return parseAwsFinalizationRuntimeState(value) ?? parseFinalizationState(value);
}

/**
 * Mock implementation of a session store for testing and development.
 * Provides in-memory storage with voteId indexing for quick lookups.
 */
export class MockSessionStore
  implements VoteStore, AwsFinalizationRuntimeTransitionStore, AwsFinalizationDeliveryMetadataStore
{
  private sessions: Map<string, SessionData> = new Map();
  // Index for O(1) vote lookups by voteId
  private voteIdIndex: Map<string, { sessionId: string; index: number }> = new Map();
  private deliveryMetadata = new InMemoryAwsVerificationDeliveryMetadataStore();
  private verificationRollbackSnapshots = new Map<
    string,
    {
      verificationResult?: AwsPersistedVerificationResult;
      verificationExecutionId?: string;
    }
  >();

  private updateFinalizationState(session: SessionData, nextState: FinalizationState | undefined): FinalizationState {
    const current = parsePersistedFinalizationState(session.finalizationState);
    if (!nextState) {
      throw new Error('Finalization state invariant violated');
    }
    const stickyTerminalState = this.getStickyTerminalFinalizationState(current, nextState.executionId);
    if (stickyTerminalState) {
      return stickyTerminalState;
    }
    if (current && current.executionId !== nextState.executionId) {
      return current;
    }
    session.finalizationState = admitAwsPersistedFinalizationStateBranch(nextState);
    session.lastActivity = Date.now();
    return nextState;
  }

  private getStickyTerminalFinalizationState(
    current: FinalizationState | undefined,
    executionId: string,
  ): FinalizationState | undefined {
    if (!current || current.executionId !== executionId) {
      return undefined;
    }
    return current.status === 'succeeded' || current.status === 'failed' || current.status === 'timeout'
      ? current
      : undefined;
  }

  private generateSessionId(): string {
    return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  }

  private hasContractGenerationMismatch(session: SessionData, contractGeneration: string | undefined): boolean {
    return (
      classifyAuthoritativeWriteContract(
        omitUndefinedProperties({
          persistedContractGeneration: resolveAuthoritativeWriteContractGeneration(session),
          carriedContractGeneration: contractGeneration,
        }),
      ) !== 'supported'
    );
  }

  private failCurrentArtifactExecution(
    session: SessionData,
    payload: {
      executionId: string;
      queuedAt: number;
      contractGeneration?: string;
      startedAt?: number;
      stepFunctionsArn?: string;
    },
    artifactState: NonNullable<SessionData['finalizationArtifactState']> = 'unsupported_current_artifact',
  ): FinalizationState {
    const next = buildFailClosedFinalizationState(session, payload, artifactState, Date.now());
    session.finalizationArtifactState = artifactState;
    session.finalizationState = admitAwsPersistedFinalizationStateBranch(next);
    session.lastActivity = Date.now();
    return next;
  }

  createSession(): Promise<SessionData> {
    const sessionId = this.generateSessionId();
    const electionId = createElectionId();
    const electionConfigHash = getDefaultElectionConfigHash();
    const logId = generateLogId(`mock-${sessionId}`);
    const bulletin = new SimpleBulletinBoard(logId);

    const sessionData: SessionData = {
      sessionId,
      contractGeneration: resolveCurrentContractGeneration(),
      electionId,
      electionConfigHash,
      electionConfig: buildDefaultElectionConfig(),
      logId,
      votes: new Map(),
      bulletin,
      bulletinRootHistory: [],
      botCount: 0,
      finalized: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.sessions.set(sessionId, sessionData);
    logger.info('[MockStore] Created session:', sessionId);

    return Promise.resolve(sessionData);
  }

  getSession(sessionId: string): Promise<SessionData | null> {
    logger.debug('[MockStore] Getting session:', sessionId);
    logger.debug('[MockStore] Available sessions:', Array.from(this.sessions.keys()));
    const session = this.sessions.get(sessionId);
    if (session) {
      // Why not rebuild canonical CT state here? Read-time repair would recreate
      // missing bulletin state and mask fail-closed conditions that callers must see.
      logger.debug('[MockStore] Session found:', sessionId);
    } else {
      logger.debug('[MockStore] Session not found:', sessionId);
    }
    return Promise.resolve(session || null);
  }

  async addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult> {
    logger.debug('[MockStore] addVote called for session:', sessionId);
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }
    if (session.finalized) {
      throw new Error('Session already finalized');
    }
    if (!isRecoverableCurrentLiveSession(session)) {
      throw new Error('Session not found');
    }

    const voteRecord: VoteData = { ...voteData };

    if (!voteRecord.voteId) {
      voteRecord.voteId = generateVoteId();
    }

    const formattedVote = this.formatVoteData(session, voteRecord);
    const voteId = formattedVote.voteId;
    if (!voteId) {
      throw new Error('Vote ID missing after formatting');
    }

    const index = session.votes.size;
    const stagedResult = stageCtVoteWrites(session, [{ index, vote: formattedVote }]);
    const stagedWrite = stagedResult.votes[0];
    const stagedBulletin = stagedResult.bulletin;
    const stagedBulletinRootHistory = stagedResult.bulletinRootHistory;

    let ctProof;
    try {
      const ctTreeSize = index + 1;
      ctProof = stagedBulletin.getInclusionProof(voteId, ctTreeSize);
    } catch (error) {
      if (process.env['NODE_ENV'] === 'development') {
        logger.warn('[MockStore] CT proof derivation failed', {
          voteId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      throw new Error('CT_PROOF_UNAVAILABLE');
    }

    if (!ctProof) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }

    const merklePath = ctProof.proofNodes.map((node) => normalizeHex(node, { allowEmpty: true }));
    if (!stagedWrite) {
      throw new Error('Finalization state invariant violated');
    }

    session.bulletin = stagedBulletin;
    session.bulletinRootHistory = stagedBulletinRootHistory;
    session.votes.set(index, stagedWrite.storedVote);
    if (index === 0) {
      session.userVoteIndex = index;
    }
    this.voteIdIndex.set(voteId, { sessionId, index });

    logger.debug('[MockStore] User vote Merkle tree insert:', {
      voteIndex: index,
      treePosition: 0, // User vote is always first in tree
      commitment: formattedVote.commit.slice(2, 10) + '...',
      root: ctProof.rootHash.slice(0, 8) + '...',
      pathLength: merklePath.length,
      treeSize: ctProof.treeSize,
    });

    session.lastActivity = Date.now();

    const bulletinRootAtCast = stagedWrite.storedVote.rootAtCast;
    if (!bulletinRootAtCast) {
      throw new Error('CT_PROOF_UNAVAILABLE');
    }

    return {
      leafIndex: index,
      merklePath,
      bulletinRootAtCast,
    };
  }

  async updateSession(sessionId: string, data?: SessionStoreUpdate): Promise<SessionData | void> {
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    if (data) {
      assertSessionUpdateContainsOnlyAllowedFields(data);
      Object.assign(session, data);
    }
    session.lastActivity = Date.now();

    if (data) {
      return session;
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
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    const currentArtifactState = resolveFailClosedFinalizationArtifactState(session);
    const admittedMetadata = omitUndefinedProperties(metadata);
    const repairingFailClosedArtifact =
      currentArtifactState !== null &&
      (canRecoverFinalizationArtifactWithPatch(session, admittedMetadata) ||
        admittedMetadata.finalizationContractGeneration !== undefined);
    if (!repairingFailClosedArtifact) {
      assertWritableFinalizationArtifact(session);
    }
    Object.assign(session, admittedMetadata);
    clearRecoveredFinalizationArtifactState(session, admittedMetadata);
    session.lastActivity = Date.now();
    return session;
  }

  recordAwsProofBundlePublication(
    sessionId: string,
    executionId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    this.deliveryMetadata.record(sessionId, executionId, metadata);
    return Promise.resolve();
  }

  recordAwsVerificationDeliveryMetadata(
    sessionId: string,
    executionId: string,
    metadata: AwsVerificationDeliveryMetadataInput,
  ): Promise<void> {
    this.deliveryMetadata.record(sessionId, executionId, metadata);
    return Promise.resolve();
  }

  async repairFinalizationResult(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const finalizationResult = parseAwsPersistedFinalizationResult(session.finalizationResult);
    if (!finalizationResult) {
      throw new Error('Invalid finalization result persistence payload');
    }
    assertWritableFinalizationArtifact(session);
    session.finalizationResult = admitAwsPersistedFinalizationResultBranch(finalizationResult);
    if (!session.finalizationContractGeneration) {
      if (session.contractGeneration) {
        session.finalizationContractGeneration = session.contractGeneration;
      }
    }
    clearRecoveredFinalizationArtifactState(session, { finalizationResult });
    session.lastActivity = Date.now();
  }

  async markVerificationRunning(sessionId: string, payload: MarkVerificationRunningPayload): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const current = parseAwsPersistedFinalizationResult(session.finalizationResult);
    if (!current) {
      throw new Error('Invalid finalization result persistence payload');
    }
    this.verificationRollbackSnapshots.set(buildVerificationSnapshotKey(sessionId, payload.executionId), {
      ...(current.verificationResult ? { verificationResult: current.verificationResult } : {}),
      ...(current.verificationExecutionId ? { verificationExecutionId: current.verificationExecutionId } : {}),
    });
    const deliveryMetadata = this.deliveryMetadata.get(sessionId, payload.executionId);
    const runningVerificationResult: AwsPersistedVerificationResult = {
      status: 'running',
      ...(payload.report ? { report: payload.report } : {}),
      executionId: payload.executionId,
      ...((deliveryMetadata?.s3BundleKey ?? current.s3BundleKey)
        ? { s3BundleKey: deliveryMetadata?.s3BundleKey ?? current.s3BundleKey }
        : {}),
      ...((deliveryMetadata?.s3UploadedAt ?? current.s3UploadedAt)
        ? { s3UploadedAt: deliveryMetadata?.s3UploadedAt ?? current.s3UploadedAt }
        : {}),
      ...(payload.verificationWorkQueuedAt ? { verificationWorkQueuedAt: payload.verificationWorkQueuedAt } : {}),
    };
    const finalizationResult = updateAwsFinalizationResultVerificationState(current, {
      verificationResult: runningVerificationResult,
      verificationExecutionId: payload.executionId,
      ...(runningVerificationResult.s3BundleKey ? { s3BundleKey: runningVerificationResult.s3BundleKey } : {}),
      ...(runningVerificationResult.s3UploadedAt ? { s3UploadedAt: runningVerificationResult.s3UploadedAt } : {}),
    });
    this.persistVerificationResultUpdate(session, finalizationResult);
  }

  async rollbackVerificationResult(sessionId: string, payload: RollbackVerificationResultPayload): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const current = parseAwsPersistedFinalizationResult(session.finalizationResult);
    if (!current) {
      throw new Error('Invalid finalization result persistence payload');
    }
    const snapshotKey = buildVerificationSnapshotKey(sessionId, payload.executionId);
    const snapshot = this.verificationRollbackSnapshots.get(snapshotKey);
    this.verificationRollbackSnapshots.delete(snapshotKey);
    const finalizationResult = updateAwsFinalizationResultVerificationState(
      current,
      omitUndefinedProperties({
        verificationResult: snapshot?.verificationResult,
        verificationExecutionId: snapshot?.verificationExecutionId,
      }),
    );
    this.persistVerificationResultUpdate(session, finalizationResult);
  }

  async completeVerificationResult(sessionId: string, payload: CompleteVerificationResultPayload): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const current = parseAwsPersistedFinalizationResult(session.finalizationResult);
    if (!current) {
      throw new Error('Invalid finalization result persistence payload');
    }
    if (shouldIgnoreVerificationCompletion(current, payload.executionId)) {
      return;
    }
    const deliveryMetadata = this.deliveryMetadata.take(sessionId, payload.executionId);
    const verificationResult: AwsPersistedVerificationResult = {
      ...payload.verificationResult,
      executionId: payload.executionId,
      ...((deliveryMetadata?.s3BundleKey ?? current.s3BundleKey)
        ? { s3BundleKey: deliveryMetadata?.s3BundleKey ?? current.s3BundleKey }
        : {}),
      ...(deliveryMetadata?.s3ReportKey ? { s3ReportKey: deliveryMetadata.s3ReportKey } : {}),
      ...((deliveryMetadata?.s3UploadedAt ?? current.s3UploadedAt)
        ? { s3UploadedAt: deliveryMetadata?.s3UploadedAt ?? current.s3UploadedAt }
        : {}),
    };
    const finalizationResult = updateAwsFinalizationResultVerificationState(current, {
      verificationResult,
      verificationExecutionId: payload.executionId,
      ...(verificationResult.s3BundleKey ? { s3BundleKey: verificationResult.s3BundleKey } : {}),
      ...(verificationResult.s3UploadedAt ? { s3UploadedAt: verificationResult.s3UploadedAt } : {}),
    });
    this.verificationRollbackSnapshots.delete(buildVerificationSnapshotKey(sessionId, payload.executionId));
    this.persistVerificationResultUpdate(session, finalizationResult);
  }

  private persistVerificationResultUpdate(
    session: SessionData,
    finalizationResult: AwsPersistedFinalizationResult,
  ): void {
    assertWritableFinalizationArtifact(session);
    session.finalizationResult = admitAwsPersistedFinalizationResultBranch(finalizationResult);
    if (!session.finalizationContractGeneration) {
      if (session.contractGeneration) {
        session.finalizationContractGeneration = session.contractGeneration;
      }
    }
    clearRecoveredFinalizationArtifactState(session, { finalizationResult });
    session.lastActivity = Date.now();
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
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const currentState = parsePersistedFinalizationState(session.finalizationState);
    const stickyTerminalState = this.getStickyTerminalFinalizationState(currentState, payload.executionId);
    if (stickyTerminalState) {
      return stickyTerminalState;
    }
    const hadFinalizationBranch = hasSessionFinalizationBranch(session);
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (currentState && currentState.executionId !== payload.executionId) {
      return currentState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);
    if (!hadFinalizationBranch) {
      session.finalizationContractGeneration = payload.contractGeneration;
    }
    if (payload.scenarioContext) {
      session.finalizationScenarioContext = payload.scenarioContext;
    }
    const next = this.updateFinalizationState(session, {
      status: 'pending',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
    });
    return next;
  }

  async markFinalizationRunning(
    sessionId: string,
    payload: FinalizationRunningPayload & {
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState> {
    return this.applyFinalizationRunning(sessionId, payload, 'pure');
  }

  async markAwsFinalizationRunning(
    sessionId: string,
    payload: AwsFinalizationRunningPayload,
  ): Promise<FinalizationState> {
    return this.applyFinalizationRunning(sessionId, payload, 'aws');
  }

  private async applyFinalizationRunning(
    sessionId: string,
    payload: FinalizationRunningPayload &
      AwsRuntimeTransitionMetadata & {
        scenarioContext?: SessionData['finalizationScenarioContext'] | null;
      },
    mode: AwsMetadataMode,
  ): Promise<FinalizationState> {
    if (mode === 'pure') {
      assertNoAwsRuntimeTransitionMetadata(payload);
    }
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const currentState = parsePersistedFinalizationState(session.finalizationState);
    const stickyTerminalState = this.getStickyTerminalFinalizationState(currentState, payload.executionId);
    if (stickyTerminalState) {
      return stickyTerminalState;
    }
    const hadFinalizationBranch = hasSessionFinalizationBranch(session);
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (currentState && currentState.executionId !== payload.executionId) {
      return currentState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);
    if (!hadFinalizationBranch) {
      session.finalizationContractGeneration = payload.contractGeneration;
    }
    if (payload.scenarioContext) {
      session.finalizationScenarioContext = payload.scenarioContext;
    }
    const next = this.updateFinalizationState(session, {
      status: 'running',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      ...(payload.stepFunctionsArn ? { stepFunctionsArn: payload.stepFunctionsArn } : {}),
    });
    return next;
  }

  async markFinalizationSucceeded(
    sessionId: string,
    payload: FinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    return this.applyFinalizationSucceeded(sessionId, payload, 'pure');
  }

  async markAwsFinalizationSucceeded(
    sessionId: string,
    payload: AwsFinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    return this.applyFinalizationSucceeded(sessionId, payload, 'aws');
  }

  private async applyFinalizationSucceeded(
    sessionId: string,
    payload: (FinalizationSucceededPayload | AwsFinalizationSucceededPayload) & AwsSucceededTransitionMetadata,
    mode: AwsMetadataMode,
  ): Promise<FinalizationState> {
    if (mode === 'pure') {
      assertNoAwsRuntimeTransitionMetadata(payload);
    }
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const currentState = parsePersistedFinalizationState(session.finalizationState);
    const stickyTerminalState = this.getStickyTerminalFinalizationState(currentState, payload.executionId);
    if (stickyTerminalState) {
      return stickyTerminalState;
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (currentState && currentState.executionId !== payload.executionId) {
      return currentState;
    }
    const deliveryMetadata = omitUndefinedProperties({
      ...payload.bundleMetadata,
      ...this.deliveryMetadata.take(sessionId, payload.executionId),
    });
    const finalizationResult = requireAwsPersistedFinalizationResult(
      payload.finalizationResult,
      payload.executionId,
      deliveryMetadata,
    );
    assertWritableFinalizationArtifact(session, payload.contractGeneration);
    assertAdmissibleFinalizationArtifactPatch(
      session,
      {
        finalized: true,
        finalizationResult,
        finalizationState: {
          status: 'succeeded',
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
          startedAt: payload.startedAt,
          completedAt: payload.completedAt,
          ...(payload.bundleMetadata ? { bundleMetadata: payload.bundleMetadata } : {}),
          ...(payload.stepFunctionsArn ? { stepFunctionsArn: payload.stepFunctionsArn } : {}),
        },
        finalizationContractGeneration: payload.contractGeneration,
      },
      payload.contractGeneration,
    );
    if (!hasSessionFinalizationBranch(session)) {
      session.finalizationContractGeneration = payload.contractGeneration;
    }
    session.finalized = true;
    session.finalizationResult = admitAwsPersistedFinalizationResultBranch(finalizationResult);
    const next = this.updateFinalizationState(session, {
      status: 'succeeded',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
      ...(payload.bundleMetadata ? { bundleMetadata: payload.bundleMetadata } : {}),
      ...(payload.stepFunctionsArn ? { stepFunctionsArn: payload.stepFunctionsArn } : {}),
    });
    return next;
  }

  async markFinalizationFailed(sessionId: string, payload: FinalizationFailedPayload): Promise<FinalizationState> {
    return this.applyFinalizationFailed(sessionId, payload, 'pure');
  }

  async markAwsFinalizationFailed(
    sessionId: string,
    payload: AwsFinalizationFailedPayload,
  ): Promise<FinalizationState> {
    return this.applyFinalizationFailed(sessionId, payload, 'aws');
  }

  private async applyFinalizationFailed(
    sessionId: string,
    payload: FinalizationFailedPayload & AwsRuntimeTransitionMetadata,
    mode: AwsMetadataMode,
  ): Promise<FinalizationState> {
    if (mode === 'pure') {
      assertNoAwsRuntimeTransitionMetadata(payload);
    }
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const currentState = parsePersistedFinalizationState(session.finalizationState);
    const stickyTerminalState = this.getStickyTerminalFinalizationState(currentState, payload.executionId);
    if (stickyTerminalState) {
      return stickyTerminalState;
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (currentState && currentState.executionId !== payload.executionId) {
      return currentState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);
    if (!hasSessionFinalizationBranch(session)) {
      session.finalizationContractGeneration = payload.contractGeneration;
    }
    const next = this.updateFinalizationState(session, {
      status: 'failed',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      failedAt: payload.failedAt,
      error: payload.error,
      ...(payload.stepFunctionsArn ? { stepFunctionsArn: payload.stepFunctionsArn } : {}),
    });
    return next;
  }

  async markFinalizationTimedOut(sessionId: string, payload: FinalizationTimedOutPayload): Promise<FinalizationState> {
    return this.applyFinalizationTimedOut(sessionId, payload, 'pure');
  }

  async markAwsFinalizationTimedOut(
    sessionId: string,
    payload: AwsFinalizationTimedOutPayload,
  ): Promise<FinalizationState> {
    return this.applyFinalizationTimedOut(sessionId, payload, 'aws');
  }

  private async applyFinalizationTimedOut(
    sessionId: string,
    payload: FinalizationTimedOutPayload & AwsRuntimeTransitionMetadata,
    mode: AwsMetadataMode,
  ): Promise<FinalizationState> {
    if (mode === 'pure') {
      assertNoAwsRuntimeTransitionMetadata(payload);
    }
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const currentState = parsePersistedFinalizationState(session.finalizationState);
    const stickyTerminalState = this.getStickyTerminalFinalizationState(currentState, payload.executionId);
    if (stickyTerminalState) {
      return stickyTerminalState;
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (currentState && currentState.executionId !== payload.executionId) {
      return currentState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);
    if (!hasSessionFinalizationBranch(session)) {
      session.finalizationContractGeneration = payload.contractGeneration;
    }
    const next = this.updateFinalizationState(session, {
      status: 'timeout',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      timeoutAt: payload.timeoutAt,
      ...(payload.stepFunctionsArn ? { stepFunctionsArn: payload.stepFunctionsArn } : {}),
    });
    return next;
  }

  getActiveSessionCount(): Promise<number> {
    // Clean up old sessions (5 minutes TTL)
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActivity > 5 * 60 * 1000) {
        logger.info('[MockStore] Removing expired session:', id);
        this.sessions.delete(id);
      }
    }

    const count = Array.from(this.sessions.values()).filter((session) =>
      isRecoverableCurrentLiveSession(session),
    ).length;
    logger.debug('[MockStore] Active session count:', count);
    return Promise.resolve(count);
  }

  async addBotVotes(sessionId: string, votes: VoteData[]): Promise<void> {
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }
    if (session.finalized) {
      throw new Error('Session already finalized');
    }
    if (!isRecoverableCurrentLiveSession(session)) {
      throw new Error('Session not found');
    }

    const canonicalProjection = buildCanonicalCtSessionProjection(session);
    if (session.botCount !== canonicalProjection.botCount) {
      logger.warn('[MockStore] Reconciled stale botCount before appending bot votes', {
        sessionId,
        persistedBotCount: session.botCount,
        derivedBotCount: canonicalProjection.botCount,
      });
    }
    if (session.userVoteIndex !== canonicalProjection.userVoteIndex) {
      logger.warn('[MockStore] Reconciled stale userVoteIndex before appending bot votes', {
        sessionId,
        persistedUserVoteIndex: session.userVoteIndex,
        derivedUserVoteIndex: canonicalProjection.userVoteIndex,
      });
    }
    applyCanonicalCtSessionProjection(session, canonicalProjection);
    assertCanonicalUserVoteIndexForBotVotes(session.votes, session.userVoteIndex);

    const stagedInputs = votes.map((voteData, offset) => {
      const index = canonicalProjection.nextIndex + offset;
      const record: VoteData = { ...voteData };
      if (!record.voteId) {
        record.voteId = generateVoteId();
      }
      const formattedVote = this.formatVoteData(session, record);
      const voteId = formattedVote.voteId;
      if (!voteId) {
        throw new Error('Vote ID missing after formatting');
      }
      return { index, vote: formattedVote };
    });
    const stagedWrites = stageCtVoteWrites(session, stagedInputs);

    session.bulletin = stagedWrites.bulletin;
    session.bulletinRootHistory = stagedWrites.bulletinRootHistory;

    for (const stagedWrite of stagedWrites.votes) {
      session.votes.set(stagedWrite.index, stagedWrite.storedVote);
      this.voteIdIndex.set(stagedWrite.voteId, { sessionId, index: stagedWrite.index });
    }

    session.botCount = canonicalProjection.botCount + stagedWrites.votes.length;
    const firstStagedWrite = stagedWrites.votes[0];
    const lastStagedWrite = stagedWrites.votes[stagedWrites.votes.length - 1];
    if (firstStagedWrite && lastStagedWrite) {
      logger.debug('[MockStore] Bot votes added:', {
        addedCount: stagedWrites.votes.length,
        totalBotCount: session.botCount,
        firstBotIndex: firstStagedWrite.index,
        lastBotIndex: lastStagedWrite.index,
        bulletinSize: session.bulletin.getSize(),
        finalRoot: lastStagedWrite.storedVote.rootAtCast?.slice(0, 10),
      });
    }

    session.lastActivity = Date.now();
  }

  async finalizeSession(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
    executionId: string,
  ): Promise<void> {
    const deliveryMetadata = this.deliveryMetadata.take(sessionId, executionId);
    const finalizationResult = requireAwsPersistedFinalizationResult(result, executionId, deliveryMetadata);
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    assertWritableFinalizationArtifact(session, contractGeneration);
    if (this.hasContractGenerationMismatch(session, contractGeneration)) {
      throw new UnsupportedCurrentArtifactBoundaryError(
        buildUnsupportedCurrentArtifactDetails(session, contractGeneration),
      );
    }
    assertAdmissibleFinalizationArtifactPatch(
      session,
      {
        finalized: true,
        finalizationResult,
        finalizationContractGeneration: contractGeneration,
      },
      contractGeneration,
    );

    for (const [index, vote] of session.votes.entries()) {
      try {
        if (!session.bulletin || !vote.voteId) {
          throw new Error('CT_PROOF_UNAVAILABLE');
        }
        const treeSize = session.bulletin.getSize();
        const ctProof = session.bulletin.getInclusionProof(vote.voteId, treeSize);
        if (!ctProof) {
          throw new Error('CT_PROOF_UNAVAILABLE');
        }
        vote.path = ctProof.proofNodes.map((node) => normalizeHex(node, { allowEmpty: true }));
        vote.treeSize = ctProof.treeSize;
      } catch (error) {
        logger.warn('[MockStore] Failed to compute Merkle path for vote', index, error);
      }
    }

    const hadFinalizationBranch = hasSessionFinalizationBranch(session);
    session.finalized = true;
    if (!hadFinalizationBranch) {
      session.finalizationContractGeneration = contractGeneration;
    }
    session.finalizationResult = admitAwsPersistedFinalizationResultBranch(finalizationResult);
    session.lastActivity = Date.now();

    logger.info('[MockStore] Session finalized:', sessionId);
  }

  /**
   * Retrieve a vote by its unique voteId.
   * Returns null if the vote doesn't exist or belongs to a different session.
   *
   * @param sessionId - The session ID to search within
   * @param voteId - The unique vote identifier
   * @returns Vote data with its index, or null if not found
   */
  async getVoteById(sessionId: string, voteId: string): Promise<{ voteData: VoteData; index: number } | null> {
    const indexInfo = this.voteIdIndex.get(voteId);

    // Check if voteId exists and belongs to the correct session
    if (!indexInfo || indexInfo.sessionId !== sessionId) {
      return null;
    }

    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    const voteData = session.votes.get(indexInfo.index);
    if (!voteData) {
      return null;
    }

    return {
      voteData,
      index: indexInfo.index,
    };
  }

  /**
   * Retrieve a vote by its unique voteId along with its Merkle proof.
   * This is used for the "Recorded-as-Cast" verification in the three-stage process.
   *
   * @param sessionId - The session ID to search within
   * @param voteId - The unique vote identifier
   * @returns Vote data with Merkle proof information, or null if not found
   */
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
    const exactCtProof = deriveExactCtProof(
      omitUndefinedProperties({
        bulletin: session.bulletin,
        voteId: voteInfo.voteData.voteId,
        leafIndex: voteInfo.index,
        rootAtCast: voteInfo.voteData.rootAtCast,
      }),
    );

    return {
      voteData: voteInfo.voteData,
      ...exactCtProof,
    };
  }

  /**
   * Get vote proof for optimized retrieval (O(log n) data)
   * This is an optimized endpoint that returns only the necessary data for verification
   *
   * @param voteId - The unique vote identifier
   * @returns Minimal proof data or null if not found
   */
  async getVoteProof(voteId: string): Promise<{
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
    timestamp: number;
  } | null> {
    // Search across all sessions for the vote
    for (const [sessionId] of this.sessions.entries()) {
      const voteInfo = await this.getVoteByIdWithProof(sessionId, voteId);

      if (voteInfo) {
        return {
          leafIndex: voteInfo.leafIndex,
          merklePath: voteInfo.merklePath,
          bulletinRootAtCast: voteInfo.bulletinRootAtCast,
          treeSize: voteInfo.treeSize,
          timestamp: Date.now(), // Mock timestamp
        };
      }
    }

    return null;
  }

  /**
   * Store bitmap data by session ID to prevent cross-session leakage.
   */
  private bitmapDataBySession: Map<
    string,
    {
      sessionId: string;
      includedBitmap: boolean[];
      includedBitmapRoot: string;
      seenBitmap?: boolean[];
      seenBitmapRoot?: string;
      treeSize: number;
      finalizedAt: number;
    }
  > = new Map();

  /**
   * Save bitmap data after finalization
   * @param sessionId - The session ID
   * @param bitmapData - The bitmap data to store
   */
  saveBitmapData(
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
    const session = this.sessions.get(sessionId);
    assertWritableBitmapSidecarOwner(session);

    const storedBitmapData = {
      sessionId,
      ...bitmapData,
      includedBitmap: [...bitmapData.includedBitmap],
      ...(bitmapData.seenBitmap ? { seenBitmap: [...bitmapData.seenBitmap] } : {}),
    };
    this.bitmapDataBySession.set(sessionId, storedBitmapData);

    session.lastActivity = Date.now();

    logger.info('[MockStore] Saved bitmap data:', {
      sessionId,
      bitmapSize: bitmapData.includedBitmap.length,
      root: bitmapData.includedBitmapRoot.substring(0, 10) + '...',
      ...(bitmapData.seenBitmapRoot ? { seenRoot: bitmapData.seenBitmapRoot.substring(0, 10) + '...' } : {}),
      treeSize: bitmapData.treeSize,
    });
    return Promise.resolve();
  }

  /**
   * Get stored bitmap data
   * @param sessionId - The session ID
   * @returns The stored bitmap data or null if not found
   */
  getBitmapData(sessionId: string): Promise<{
    sessionId: string;
    includedBitmap: boolean[];
    includedBitmapRoot: string;
    seenBitmap?: boolean[];
    seenBitmapRoot?: string;
    treeSize: number;
    finalizedAt: number;
  } | null> {
    logger.debug('[MockStore] Getting bitmap data for session:', sessionId);
    const bitmapData = this.bitmapDataBySession.get(sessionId);
    if (!bitmapData) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      ...bitmapData,
      includedBitmap: [...bitmapData.includedBitmap],
      ...(bitmapData.seenBitmap ? { seenBitmap: [...bitmapData.seenBitmap] } : {}),
    });
  }

  /**
   * Storage for receipts to ensure atomic publication
   */
  private receipts: Map<string, ReceiptEntry> = new Map();
  private receiptCounter = 100;

  async finalizeSessionWithReceiptPublication(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
    receipt: { receipt: string; timestamp: number },
    executionId: string,
  ): Promise<{ receiptHash: string; boardIndex: number }> {
    const hash = crypto.createHash('sha256');
    hash.update(receipt.receipt);
    hash.update(receipt.timestamp.toString());
    const receiptHash = '0x' + hash.digest('hex');
    const boardIndex = this.receiptCounter;
    const deliveryMetadata = this.deliveryMetadata.take(sessionId, executionId);
    const persisted = requireAwsPersistedFinalizationResult(result, executionId, deliveryMetadata);
    const resultWithPublication: AwsPersistedFinalizationResult = {
      ...persisted,
      receiptPublication: {
        receiptHash,
        boardIndex,
        timestamp: receipt.timestamp,
      },
    };

    await this.finalizeSession(sessionId, resultWithPublication, contractGeneration, executionId);

    this.receiptCounter += 1;
    this.receipts.set(sessionId, {
      receiptHash,
      boardIndex,
      receipt,
    });

    logger.info('[MockStore] Atomically finalized receipt publication:', {
      sessionId,
      receiptHash: receiptHash.substring(0, 10) + '...',
      boardIndex,
    });

    return { receiptHash, boardIndex };
  }

  private formatVoteData(session: SessionData, vote: VoteData): VoteData {
    if (!session.electionId) {
      throw new Error('Session missing electionId');
    }
    const electionId = session.electionId;
    const normalizedRandom = normalizeHex(vote.rand, { allowEmpty: true });
    const choiceNumber = vote.vote.charCodeAt(0) - 'A'.charCodeAt(0);
    const commitment = computeCommitment(electionId, choiceNumber, normalizedRandom);

    return {
      ...vote,
      voteId: vote.voteId ?? generateVoteId(),
      rand: normalizedRandom,
      commit: commitment,
      timestamp: vote.timestamp ?? Date.now(),
    };
  }
}
