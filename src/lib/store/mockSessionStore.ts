/**
 * Mock session store for testing without external persistence
 */

import type {
  VoteData,
  SessionData,
  AddVoteResult,
  FinalizationResultAuthority,
  FinalizationState,
} from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import crypto from 'crypto';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { generateVoteId } from '@/lib/vote/voteId';
import { computeCommitment, createElectionId } from '@/lib/zkvm/types';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { generateLogId } from '@/lib/zkvm/log-id';
import {
  applyCanonicalCtSessionProjection,
  assertCanonicalUserVoteIndexForBotVotes,
  buildCanonicalCtSessionProjection,
} from '@/lib/store/ctSessionState';
import { deriveExactCtProof } from '@/lib/store/ct-proof';
import { stageCtVoteWrites } from '@/lib/store/stagedCtWrite';
import { normalizeHex } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';
import {
  assertAdmissibleFinalizationArtifactPatch,
  assertWritableFinalizationArtifact,
  assertWritableBitmapSidecarOwner,
  buildFailClosedFinalizationState,
  canRecoverFinalizationArtifactWithPatch,
  clearRecoveredFinalizationArtifactState,
  isFinalizationBranchPatch,
  resolveFailClosedFinalizationArtifactState,
} from '@/lib/store/finalizationArtifactAdmission';
import {
  buildUnsupportedCurrentArtifactDetails,
  classifyAuthoritativeWriteContract,
  hasSessionFinalizationBranch,
  isRecoverableCurrentLiveSession,
  UnsupportedCurrentArtifactBoundaryError,
  resolveAuthoritativeWriteContractGeneration,
  resolveCurrentContractGeneration,
} from '@/lib/contract';

interface ReceiptEntry {
  receiptHash: string;
  boardIndex: number;
  receipt: { receipt: string; timestamp: number };
}

/**
 * Mock implementation of a session store for testing and development.
 * Provides in-memory storage with voteId indexing for quick lookups.
 */
export class MockSessionStore implements VoteStore {
  private sessions: Map<string, SessionData> = new Map();
  // Index for O(1) vote lookups by voteId
  private voteIdIndex: Map<string, { sessionId: string; index: number }> = new Map();

  private updateFinalizationState(
    session: SessionData,
    nextState: SessionData['finalizationState'],
  ): FinalizationState {
    const current = session.finalizationState;
    if (current && nextState && current.executionId !== nextState.executionId) {
      return current;
    }
    session.finalizationState = nextState;
    session.lastActivity = Date.now();
    if (!session.finalizationState) {
      throw new Error('Finalization state invariant violated');
    }
    return session.finalizationState;
  }

  private generateSessionId(): string {
    return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  }

  private hasContractGenerationMismatch(session: SessionData, contractGeneration: string | undefined): boolean {
    return (
      classifyAuthoritativeWriteContract({
        persistedContractGeneration: resolveAuthoritativeWriteContractGeneration(session),
        carriedContractGeneration: contractGeneration,
      }) !== 'supported'
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
    session.finalizationState = next;
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
      finalizationState: undefined,
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
      if (process.env.NODE_ENV === 'development') {
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

  async updateSession(sessionId: string, data?: Partial<SessionData>): Promise<SessionData | void> {
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    const hadFinalizationBranch = hasSessionFinalizationBranch(session);
    if (data) {
      if (isFinalizationBranchPatch(data)) {
        const repairingFailClosedArtifact =
          resolveFailClosedFinalizationArtifactState(session) !== null &&
          canRecoverFinalizationArtifactWithPatch(session, data);
        if (!repairingFailClosedArtifact) {
          assertWritableFinalizationArtifact(session);
        }
      }
      Object.assign(session, data);
      if (!hadFinalizationBranch && hasSessionFinalizationBranch(session) && !session.finalizationContractGeneration) {
        session.finalizationContractGeneration = data.finalizationContractGeneration ?? session.contractGeneration;
      }
      clearRecoveredFinalizationArtifactState(session, data);
    }
    session.lastActivity = Date.now();

    if (data) {
      return session;
    }
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
    const hadFinalizationBranch = hasSessionFinalizationBranch(session);
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
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
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt: number;
      contractGeneration: string;
      stepFunctionsArn?: string;
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const hadFinalizationBranch = hasSessionFinalizationBranch(session);
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
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
      stepFunctionsArn: payload.stepFunctionsArn,
    });
    return next;
  }

  async markFinalizationSucceeded(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt: number;
      completedAt: number;
      contractGeneration: string;
      bundleMetadata?: Extract<SessionData['finalizationState'], { status: 'succeeded' }>['bundleMetadata'];
      stepFunctionsArn?: string;
      finalizationResult: FinalizationResultAuthority;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);
    assertAdmissibleFinalizationArtifactPatch(
      session,
      {
        finalized: true,
        finalizationResult: payload.finalizationResult,
        finalizationState: {
          status: 'succeeded',
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
          startedAt: payload.startedAt,
          completedAt: payload.completedAt,
          bundleMetadata: payload.bundleMetadata,
          stepFunctionsArn: payload.stepFunctionsArn,
        },
        finalizationContractGeneration: payload.contractGeneration,
      },
      payload.contractGeneration,
    );
    if (!hasSessionFinalizationBranch(session)) {
      session.finalizationContractGeneration = payload.contractGeneration;
    }
    session.finalized = true;
    session.finalizationResult = payload.finalizationResult;
    const next = this.updateFinalizationState(session, {
      status: 'succeeded',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
      bundleMetadata: payload.bundleMetadata,
      stepFunctionsArn: payload.stepFunctionsArn,
    });
    return next;
  }

  async markFinalizationFailed(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      failedAt: number;
      contractGeneration: string;
      error: Extract<SessionData['finalizationState'], { status: 'failed' }>['error'];
      stepFunctionsArn?: string;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);
    if (!hasSessionFinalizationBranch(session)) {
      session.finalizationContractGeneration = payload.contractGeneration;
    }
    const next = this.updateFinalizationState(session, {
      status: 'failed',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      failedAt: payload.failedAt,
      error: payload.error,
      stepFunctionsArn: payload.stepFunctionsArn,
    });
    return next;
  }

  async markFinalizationTimedOut(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      timeoutAt: number;
      contractGeneration: string;
      stepFunctionsArn?: string;
    },
  ): Promise<FinalizationState> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    const artifactState = resolveFailClosedFinalizationArtifactState(session);
    if (artifactState) {
      return this.failCurrentArtifactExecution(session, payload, artifactState);
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      return this.failCurrentArtifactExecution(session, payload);
    }
    if (session.finalizationState && session.finalizationState.executionId !== payload.executionId) {
      return session.finalizationState;
    }
    assertWritableFinalizationArtifact(session, payload.contractGeneration);
    if (!hasSessionFinalizationBranch(session)) {
      session.finalizationContractGeneration = payload.contractGeneration;
    }
    const next = this.updateFinalizationState(session, {
      status: 'timeout',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      timeoutAt: payload.timeoutAt,
      stepFunctionsArn: payload.stepFunctionsArn,
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

    const canonicalProjection = buildCanonicalCtSessionProjection(session, 'MockStore');
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

      logger.debug('[MockStore] Bot vote added:', {
        botIndex: stagedWrite.index,
        bulletinSize: session.bulletin.getSize(),
        commitment: stagedWrite.storedVote.commit.slice(2, 10) + '...',
        root: stagedWrite.storedVote.rootAtCast?.slice(0, 10),
      });
    }

    session.botCount = canonicalProjection.botCount + stagedWrites.votes.length;

    session.lastActivity = Date.now();
  }

  async finalizeSession(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
  ): Promise<void> {
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
        finalizationResult: result,
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
    session.finalizationResult = result;
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
    const exactCtProof = deriveExactCtProof({
      bulletin: session.bulletin,
      voteId: voteInfo.voteData.voteId,
      leafIndex: voteInfo.index,
      rootAtCast: voteInfo.voteData.rootAtCast,
    });

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

  /**
   * Save receipt to bulletin board atomically
   * This ensures the receipt is publicly available before returning to the client
   *
   * @param sessionId - The session ID
   * @param receipt - The receipt data to save
   * @returns Receipt hash and board index
   */
  saveReceiptToBoard(
    sessionId: string,
    receipt: { receipt: string; timestamp: number },
  ): Promise<{ receiptHash: string; boardIndex: number }> {
    const hash = crypto.createHash('sha256');
    hash.update(receipt.receipt);
    hash.update(receipt.timestamp.toString());
    const receiptHash = '0x' + hash.digest('hex');

    const boardIndex = this.receiptCounter++;

    this.receipts.set(sessionId, {
      receiptHash,
      boardIndex,
      receipt,
    });

    logger.info('[MockStore] Saved receipt to board:', {
      sessionId,
      receiptHash: receiptHash.substring(0, 10) + '...',
      boardIndex,
    });

    return Promise.resolve({ receiptHash, boardIndex });
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
