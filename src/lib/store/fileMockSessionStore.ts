/**
 * File-based mock session store for testing in production mode
 * Persists session data to disk to enable sharing across Next.js workers
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
import { createElectionId } from '@/lib/zkvm/types';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { generateLogId } from '@/lib/zkvm/log-id';
import { deriveExactCtProof } from '@/lib/store/ct-proof';
import {
  applyCanonicalCtSessionProjection,
  assertCanonicalUserVoteIndexForBotVotes,
  buildCanonicalCtSessionProjection,
} from '@/lib/store/ctSessionState';
import { stageCtVoteWrites } from '@/lib/store/stagedCtWrite';
import { normalizeHex } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';
import fs from 'fs-extra';
import path from 'path';
import type {
  BitmapData,
  FileMockDiagnostics,
  ReceiptEntry,
  SerializableSessionData,
} from '@/lib/store/fileMock/types';
import { parseBitmapData, parseReceiptEntries } from '@/lib/store/fileMock/parsers';
import { deserializeSession, serializeSession } from '@/lib/store/fileMock/sessionSerde';
import { formatVoteData } from '@/lib/store/fileMock/voteUtils';
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
  rebuildSessionCacheFromSerialized,
  recordCacheAccess,
  snapshotCachedSessions,
  updateCacheDiagnostics,
  type FileMockCacheState,
} from '@/lib/store/fileMock/cache';
import {
  buildUnsupportedCurrentArtifactDetails,
  classifyAuthoritativeWriteContract,
  hasSessionFinalizationBranch,
  isRecoverableCurrentLiveSession,
  UnsupportedCurrentArtifactBoundaryError,
  resolveAuthoritativeWriteContractGeneration,
  resolveCurrentContractGeneration,
} from '@/lib/contract';

/**
 * File-based implementation of a session store for E2E testing in production mode.
 * Persists sessions and voteId index to .tmp/mock-sessions/ (or FILE_MOCK_STORE_DIR override)
 * to enable sharing across workers.
 */
export class FileMockSessionStore implements VoteStore {
  private static diagnostics: FileMockDiagnostics = {
    sessionDiskReads: 0,
    cacheSize: 0,
    cacheEvictions: 0,
  };

  private sessions: Map<string, SessionData> = new Map();
  private serializedSessions: Map<string, SerializableSessionData> = new Map();
  private dirtySessionIds: Set<string> = new Set();
  private voteIdIndex: Map<string, { sessionId: string; index: number }> = new Map();
  private readonly storageDir = (() => {
    const override = process.env.FILE_MOCK_STORE_DIR;
    if (override && override.trim().length > 0) {
      return path.resolve(override);
    }
    return path.join(process.cwd(), '.tmp', 'mock-sessions');
  })();
  private readonly sessionsFile = path.join(this.storageDir, 'sessions.json');
  private readonly voteIdIndexFile = path.join(this.storageDir, 'voteIdIndex.json');

  // Storage for bitmap data by session ID
  private bitmapDataBySession: Map<string, BitmapData> = new Map();
  private readonly bitmapsFile = path.join(this.storageDir, 'bitmaps.json');
  private readonly legacyBitmapFile = path.join(this.storageDir, 'bitmap.json');

  // Storage for receipts
  private receipts: Map<string, ReceiptEntry> = new Map();
  private receiptCounter = 100;
  private readonly receiptsFile = path.join(this.storageDir, 'receipts.json');

  private lastKnownSessionSignature: string | null = null;
  private readonly cacheEnabled = process.env.DISABLE_FILE_STORE_CACHE !== '1';
  private readonly cacheLimit = (() => {
    const raw = process.env.FILE_STORE_CACHE_LIMIT;
    if (raw === undefined) {
      return 32;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 32;
    }
    return parsed;
  })();

  constructor() {
    this.loadSessionsFromDisk();
  }

  private getCacheState(): FileMockCacheState {
    return {
      sessions: this.sessions,
      serializedSessions: this.serializedSessions,
      dirtySessionIds: this.dirtySessionIds,
      cacheEnabled: this.cacheEnabled,
      cacheLimit: this.cacheLimit,
      diagnostics: FileMockSessionStore.diagnostics,
    };
  }

  /**
   * Load all data from disk on startup
   */
  private loadSessionsFromDisk(): void {
    FileMockSessionStore.diagnostics.sessionDiskReads++;

    const debugEnabled = process.env.DEBUG_FILE_STORE === '1';

    try {
      fs.ensureDirSync(this.storageDir);

      if (debugEnabled) {
        logger.debug('[FileMockStore][DEBUG] loadSessionsFromDisk() called', {
          mapSizeBefore: this.sessions.size,
          sessionsFilePath: this.sessionsFile,
        });
      }

      if (fs.existsSync(this.sessionsFile)) {
        const fileStats = fs.statSync(this.sessionsFile);
        const data = fs.readJsonSync(this.sessionsFile) as SerializableSessionData[];

        if (debugEnabled) {
          logger.debug('[FileMockStore][DEBUG] sessions.json metadata', {
            mtimeMs: fileStats.mtimeMs,
            mtime: fileStats.mtime.toISOString(),
            size: fileStats.size,
            sessionCount: data.length,
          });
        }

        this.serializedSessions = new Map(data.map((session) => [session.sessionId, session]));
        this.dirtySessionIds.clear();
        this.lastKnownSessionSignature = this.computeSessionsSignature(fileStats);

        if (this.cacheEnabled) {
          rebuildSessionCacheFromSerialized(this.getCacheState(), deserializeSession);
        } else {
          this.sessions.clear();
          for (const sessionData of data) {
            const session = deserializeSession(sessionData);
            this.sessions.set(session.sessionId, session);
          }
          updateCacheDiagnostics(this.getCacheState());
        }

        logger.info('[FileMockStore] Loaded sessions from disk:', this.serializedSessions.size);

        if (debugEnabled) {
          logger.debug('[FileMockStore][DEBUG] loadSessionsFromDisk() completed', {
            cachedSessions: this.sessions.size,
            serializedCount: this.serializedSessions.size,
          });
        }
      } else {
        this.serializedSessions.clear();
        this.sessions.clear();
        this.dirtySessionIds.clear();
        this.lastKnownSessionSignature = null;
        updateCacheDiagnostics(this.getCacheState());
      }

      if (fs.existsSync(this.voteIdIndexFile)) {
        try {
          const data = fs.readJsonSync(this.voteIdIndexFile) as Record<string, { sessionId: string; index: number }>;
          this.voteIdIndex = new Map(Object.entries(data));
          logger.info('[FileMockStore] Loaded voteId index from disk:', this.voteIdIndex.size);
        } catch {
          logger.warn('[FileMockStore] Failed to parse voteIdIndex.json, using empty state');
          this.voteIdIndex.clear();
        }
      }

      if (fs.existsSync(this.legacyBitmapFile)) {
        fs.removeSync(this.legacyBitmapFile);
        logger.warn('[FileMockStore] Removed legacy bitmap.json artifact during reset');
      }

      this.loadBitmapsFromDiskSync();

      if (this.bitmapDataBySession.size > 0) {
        logger.info('[FileMockStore] Loaded bitmap data from disk:', this.bitmapDataBySession.size);
      }

      if (fs.existsSync(this.receiptsFile)) {
        try {
          const data = parseReceiptEntries(fs.readJsonSync(this.receiptsFile));
          if (!data) {
            throw new Error('invalid receipt entries');
          }
          this.receipts = new Map(Object.entries(data));
          if (this.receipts.size > 0) {
            const maxIndex = Math.max(...Array.from(this.receipts.values()).map((r) => r.boardIndex));
            this.receiptCounter = maxIndex + 1;
          }
          logger.info('[FileMockStore] Loaded receipts from disk:', this.receipts.size);
        } catch {
          logger.warn('[FileMockStore] Failed to parse receipts.json, using empty state');
          this.receipts.clear();
        }
      }
    } catch (error) {
      logger.error('[FileMockStore] Failed to load from disk:', error);
      // Continue with empty state on error
    }
  }

  /**
   * Save sessions to disk (atomic write via temp file)
   */
  private async saveSessions(): Promise<void> {
    try {
      await fs.ensureDir(this.storageDir);
      snapshotCachedSessions(this.getCacheState(), serializeSession);
      const serializable = Array.from(this.serializedSessions.values());
      const tempFile = `${this.sessionsFile}.tmp`;
      await fs.writeJson(tempFile, serializable, { spaces: 2 });
      await fs.move(tempFile, this.sessionsFile, { overwrite: true });
      this.dirtySessionIds.clear();
      logger.info('[FileMockStore] Saved sessions to disk:', this.serializedSessions.size);
      this.refreshCacheAfterWrite();
    } catch (error) {
      logger.error('[FileMockStore] Failed to save sessions:', error);
      throw error;
    }
  }

  /**
   * Save voteId index to disk (atomic write via temp file)
   */
  private async saveVoteIdIndex(): Promise<void> {
    try {
      await fs.ensureDir(this.storageDir);
      const serializable = Object.fromEntries(this.voteIdIndex);
      const tempFile = `${this.voteIdIndexFile}.tmp`;
      await fs.writeJson(tempFile, serializable, { spaces: 2 });
      await fs.move(tempFile, this.voteIdIndexFile, { overwrite: true });
      logger.info('[FileMockStore] Saved voteId index to disk:', this.voteIdIndex.size);
    } catch (error) {
      logger.error('[FileMockStore] Failed to save voteId index:', error);
      throw error;
    }
  }

  private parseBitmapMap(raw: unknown): Map<string, BitmapData> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid bitmaps payload');
    }

    const parsed = new Map<string, BitmapData>();
    for (const [sessionId, value] of Object.entries(raw)) {
      const bitmapData = parseBitmapData(value);
      if (!bitmapData) {
        logger.warn('[FileMockStore] Skipping invalid bitmap entry', { sessionId });
        continue;
      }
      if (bitmapData.sessionId !== sessionId) {
        logger.warn('[FileMockStore] Skipping bitmap entry with mismatched sessionId', {
          keySessionId: sessionId,
          valueSessionId: bitmapData.sessionId,
        });
        continue;
      }

      parsed.set(sessionId, {
        ...bitmapData,
        includedBitmap: [...bitmapData.includedBitmap],
      });
    }

    return parsed;
  }

  private loadBitmapsFromDiskSync(): void {
    if (!fs.existsSync(this.bitmapsFile)) {
      this.bitmapDataBySession.clear();
      return;
    }

    try {
      const raw: unknown = fs.readJsonSync(this.bitmapsFile);
      this.bitmapDataBySession = this.parseBitmapMap(raw);
    } catch {
      logger.warn('[FileMockStore] Failed to parse bitmaps.json, resetting bitmap cache');
      this.bitmapDataBySession.clear();
    }
  }

  private async loadBitmapsFromDisk(): Promise<void> {
    if (!fs.existsSync(this.bitmapsFile)) {
      this.bitmapDataBySession.clear();
      return;
    }

    try {
      const raw: unknown = await fs.readJson(this.bitmapsFile);
      this.bitmapDataBySession = this.parseBitmapMap(raw);
    } catch {
      logger.warn('[FileMockStore] Failed to parse bitmaps.json, resetting bitmap cache');
      this.bitmapDataBySession.clear();
    }
  }

  private async saveBitmaps(): Promise<void> {
    await fs.ensureDir(this.storageDir);
    const tempFile = `${this.bitmapsFile}.tmp`;
    await fs.writeJson(tempFile, Object.fromEntries(this.bitmapDataBySession), { spaces: 2 });
    await fs.move(tempFile, this.bitmapsFile, { overwrite: true });
  }

  private refreshCacheAfterWrite(): void {
    if (!this.cacheEnabled) {
      return;
    }
    try {
      if (!fs.existsSync(this.sessionsFile)) {
        this.lastKnownSessionSignature = null;
        return;
      }
      const stats = fs.statSync(this.sessionsFile);
      this.lastKnownSessionSignature = this.computeSessionsSignature(stats);
    } catch (error) {
      logger.warn('[FileMockStore][Cache] Failed to refresh cache after write:', error);
    }
  }

  private ensureSessionsFresh(): void {
    if (!this.cacheEnabled) {
      this.loadSessionsFromDisk();
      return;
    }

    const debugEnabled = process.env.DEBUG_FILE_STORE === '1';

    try {
      if (!fs.existsSync(this.sessionsFile)) {
        if (debugEnabled) {
          logger.debug('[FileMockStore][Cache] sessions.json missing, clearing state');
        }
        this.serializedSessions.clear();
        this.sessions.clear();
        this.lastKnownSessionSignature = null;
        updateCacheDiagnostics(this.getCacheState());
        return;
      }

      const stats = fs.statSync(this.sessionsFile);
      const currentSignature = this.computeSessionsSignature(stats);

      if (this.lastKnownSessionSignature && this.lastKnownSessionSignature === currentSignature) {
        if (debugEnabled) {
          logger.debug('[FileMockStore][Cache] Cache hit (mtime unchanged)');
        }
        return;
      }

      if (debugEnabled) {
        logger.debug('[FileMockStore][Cache] Cache miss, reloading', {
          previous: this.lastKnownSessionSignature,
          current: currentSignature,
        });
      }

      this.loadSessionsFromDisk();
    } catch (error) {
      if (debugEnabled) {
        logger.warn('[FileMockStore][Cache] Failed to validate cache, forcing reload', error);
      }
      this.loadSessionsFromDisk();
    }
  }

  private computeSessionsSignature(stats: fs.Stats): string {
    return `${stats.mtimeMs}:${stats.size}`;
  }

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
    this.markSessionDirty(session.sessionId);
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

  private markSessionDirty(sessionId: string): void {
    this.dirtySessionIds.add(sessionId);
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
    this.markSessionDirty(session.sessionId);
    return next;
  }

  async createSession(): Promise<SessionData> {
    this.ensureSessionsFresh();
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

    recordCacheAccess(this.getCacheState(), sessionData, serializeSession);
    this.serializedSessions.set(sessionId, serializeSession(sessionData));
    this.markSessionDirty(sessionId);
    logger.info('[FileMockStore] Created session:', sessionId);

    await this.saveSessions();

    return sessionData;
  }

  getSession(sessionId: string): Promise<SessionData | null> {
    const debugEnabled = process.env.DEBUG_FILE_STORE === '1';

    if (debugEnabled) {
      logger.debug('[FileMockStore][DEBUG] getSession() called', {
        sessionId,
        mapSizeBefore: this.sessions.size,
      });
    } else {
      logger.info('[FileMockStore] Getting session:', sessionId);
    }

    this.ensureSessionsFresh();

    let session = this.sessions.get(sessionId);
    if (!session && this.serializedSessions.has(sessionId)) {
      const serialized = this.serializedSessions.get(sessionId);
      if (!serialized) {
        throw new Error(`Serialized session missing for ${sessionId}`);
      }
      session = deserializeSession(serialized);
      recordCacheAccess(this.getCacheState(), session, serializeSession);
    }

    if (session) {
      // Why not re-run canonical repair on every read? deserializeSession already
      // fixes persisted metadata, and more aggressive read-time repair would hide
      // broken in-memory CT state that should remain fail-closed.
      if (debugEnabled) {
        logger.debug('[FileMockStore][DEBUG] Session found', {
          sessionId,
          finalized: session.finalized,
          hasFinalizationResult: !!session.finalizationResult,
          votesCount: session.votes.size,
        });
      } else {
        logger.info('[FileMockStore] Session found:', sessionId);
      }
    } else {
      logger.info('[FileMockStore] Session not found:', sessionId);
      if (debugEnabled) {
        logger.debug('[FileMockStore][DEBUG] Available sessions:', Array.from(this.sessions.keys()));
      }
    }
    return Promise.resolve(session || null);
  }

  async addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult> {
    logger.info('[FileMockStore] addVote called for session:', sessionId);
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

    const formattedVote = formatVoteData(session, voteRecord);
    const voteId = formattedVote.voteId;
    if (!voteId) {
      throw new Error('Vote ID missing after formatting');
    }

    const index = session.votes.size;
    const stagedResult = stageCtVoteWrites(session, [{ index, vote: formattedVote }]);
    const stagedWrite = stagedResult.votes[0];

    let ctProof;
    try {
      const ctTreeSize = index + 1;
      ctProof = stagedResult.bulletin.getInclusionProof(voteId, ctTreeSize);
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        logger.warn('[FileMockStore] CT proof derivation failed', {
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

    session.bulletin = stagedResult.bulletin;
    session.bulletinRootHistory = stagedResult.bulletinRootHistory;
    session.votes.set(index, stagedWrite.storedVote);
    if (index === 0) {
      session.userVoteIndex = index;
    }
    this.voteIdIndex.set(voteId, { sessionId, index });

    logger.info('[FileMockStore] User vote Merkle tree insert:', {
      voteIndex: index,
      treePosition: 0,
      commitment: formattedVote.commit.slice(2, 10) + '...',
      root: ctProof.rootHash.slice(0, 8) + '...',
      pathLength: merklePath.length,
      treeSize: ctProof.treeSize,
    });

    session.lastActivity = Date.now();
    this.markSessionDirty(session.sessionId);

    await this.saveSessions();
    await this.saveVoteIdIndex();

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
    this.markSessionDirty(session.sessionId);

    logger.info('[FileMockStore] updateSession called:', {
      sessionId,
      hasFinalizationResult: !!data?.finalizationResult,
      finalized: data?.finalized,
    });

    await this.saveSessions();

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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
    return next;
  }

  async getActiveSessionCount(): Promise<number> {
    this.ensureSessionsFresh();
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.serializedSessions.entries()) {
      if (now - session.lastActivity > 5 * 60 * 1000) {
        logger.info('[FileMockStore] Removing expired session:', id);
        this.serializedSessions.delete(id);
        this.sessions.delete(id);
        this.dirtySessionIds.delete(id);
        removed += 1;
      }
    }

    if (removed > 0) {
      await this.saveSessions();
    }

    const count = Array.from(this.serializedSessions.values()).filter((session) =>
      isRecoverableCurrentLiveSession(session),
    ).length;
    logger.info('[FileMockStore] Active session count:', count);
    return count;
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

    const canonicalProjection = buildCanonicalCtSessionProjection(session, 'FileMockStore');
    if (session.botCount !== canonicalProjection.botCount) {
      logger.warn('[FileMockStore] Reconciled stale botCount before appending bot votes', {
        sessionId,
        persistedBotCount: session.botCount,
        derivedBotCount: canonicalProjection.botCount,
      });
    }
    if (session.userVoteIndex !== canonicalProjection.userVoteIndex) {
      logger.warn('[FileMockStore] Reconciled stale userVoteIndex before appending bot votes', {
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
      const formattedVote = formatVoteData(session, record);
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

      logger.info('[FileMockStore] Bot vote added:', {
        botIndex: stagedWrite.index,
        bulletinSize: session.bulletin.getSize(),
        commitment: stagedWrite.storedVote.commit.slice(2, 10) + '...',
        root: stagedWrite.storedVote.rootAtCast?.slice(0, 10),
      });
    }

    session.botCount = canonicalProjection.botCount + stagedWrites.votes.length;

    session.lastActivity = Date.now();
    this.markSessionDirty(session.sessionId);

    await this.saveSessions();
    await this.saveVoteIdIndex();
  }

  async finalizeSession(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
  ): Promise<void> {
    const debugEnabled = process.env.DEBUG_FILE_STORE === '1';
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
        logger.warn('[FileMockStore] Failed to compute Merkle path for vote', index, error);
      }
    }

    const hadFinalizationBranch = hasSessionFinalizationBranch(session);
    session.finalized = true;
    if (!hadFinalizationBranch) {
      session.finalizationContractGeneration = contractGeneration;
    }
    session.finalizationResult = result;
    session.lastActivity = Date.now();
    this.markSessionDirty(session.sessionId);
    const journalForLog = (
      result as {
        journal?: {
          verifiedTally?: unknown;
          missingSlots?: unknown;
          invalidPresentedSlots?: unknown;
        };
      }
    ).journal;

    logger.info('[FileMockStore] Session finalized:', sessionId);
    logger.info('[FileMockStore] finalizationResult set:', {
      hasFinalizationResult: !!result,
      verifiedTally: journalForLog?.verifiedTally,
      missingSlots: journalForLog?.missingSlots,
      invalidPresentedSlots: journalForLog?.invalidPresentedSlots,
    });

    if (debugEnabled) {
      logger.debug('[FileMockStore][DEBUG] Attempting to save finalized session', {
        sessionId,
        executionId: session.finalizationState?.executionId,
        finalized: session.finalized,
      });
    }

    await this.saveSessions();

    if (debugEnabled) {
      logger.debug('[FileMockStore][DEBUG] saveSessions() completed successfully', {
        sessionId,
        filePath: this.sessionsFile,
      });
    }
  }

  async getVoteById(sessionId: string, voteId: string): Promise<{ voteData: VoteData; index: number } | null> {
    const indexInfo = this.voteIdIndex.get(voteId);

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

  async getVoteProof(voteId: string): Promise<{
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
    timestamp: number;
  } | null> {
    this.ensureSessionsFresh();
    const sessionIds = Array.from(this.serializedSessions.keys());
    for (const sessionId of sessionIds) {
      const voteInfo = await this.getVoteByIdWithProof(sessionId, voteId);

      if (voteInfo) {
        return {
          leafIndex: voteInfo.leafIndex,
          merklePath: voteInfo.merklePath,
          bulletinRootAtCast: voteInfo.bulletinRootAtCast,
          treeSize: voteInfo.treeSize,
          timestamp: Date.now(),
        };
      }
    }

    return null;
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

    await this.loadBitmapsFromDisk();

    this.bitmapDataBySession.set(sessionId, {
      sessionId,
      ...bitmapData,
      includedBitmap: [...bitmapData.includedBitmap],
      ...(bitmapData.seenBitmap ? { seenBitmap: [...bitmapData.seenBitmap] } : {}),
    });
    await this.saveBitmaps();

    session.lastActivity = Date.now();
    this.markSessionDirty(session.sessionId);
    await this.saveSessions();

    logger.info('[FileMockStore] Saved bitmap data:', {
      sessionId,
      bitmapSize: bitmapData.includedBitmap.length,
      root: bitmapData.includedBitmapRoot.substring(0, 10) + '...',
      ...(bitmapData.seenBitmapRoot ? { seenRoot: bitmapData.seenBitmapRoot.substring(0, 10) + '...' } : {}),
      treeSize: bitmapData.treeSize,
    });
  }

  async getBitmapData(sessionId: string): Promise<{
    sessionId: string;
    includedBitmap: boolean[];
    includedBitmapRoot: string;
    seenBitmap?: boolean[];
    seenBitmapRoot?: string;
    treeSize: number;
    finalizedAt: number;
  } | null> {
    logger.info('[FileMockStore] Getting bitmap data for session:', sessionId);
    await this.loadBitmapsFromDisk();

    const bitmapData = this.bitmapDataBySession.get(sessionId);
    if (!bitmapData) {
      return null;
    }

    return {
      ...bitmapData,
      includedBitmap: [...bitmapData.includedBitmap],
      ...(bitmapData.seenBitmap ? { seenBitmap: [...bitmapData.seenBitmap] } : {}),
    };
  }

  async saveReceiptToBoard(
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

    await fs.ensureDir(this.storageDir);
    await fs.writeJson(this.receiptsFile, Object.fromEntries(this.receipts), { spaces: 2 });

    logger.info('[FileMockStore] Saved receipt to board:', {
      sessionId,
      receiptHash: receiptHash.substring(0, 10) + '...',
      boardIndex,
    });

    return { receiptHash, boardIndex };
  }

  static __getDiagnosticsForTests(): FileMockDiagnostics {
    return { ...FileMockSessionStore.diagnostics };
  }

  static __resetDiagnosticsForTests(): void {
    FileMockSessionStore.diagnostics = {
      sessionDiskReads: 0,
      cacheSize: 0,
      cacheEvictions: 0,
    };
  }
}
