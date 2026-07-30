/**
 * File-based mock session store for testing in production mode
 * Persists session data to disk to enable sharing across server workers
 */

import type { VoteData, SessionData, AddVoteResult } from '@stark-ballot/domain/types/server';
import type {
  FinalizationFailedPayload,
  FinalizationQueuedPayload,
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
import { recordFinalizationStorePersistenceOutcome } from '@stark-ballot/aws-adapters/finalize/finalizationTransitionObservability';
import type { SessionStoreUpdate, VoteStore } from '@stark-ballot/domain/types/voteStore';
import crypto from 'crypto';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { createElectionId } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { generateLogId } from '@stark-ballot/zkvm-contract/zkvm/log-id';
import { deriveExactCtProof } from '@stark-ballot/aws-adapters/store/ct-proof';
import {
  applyCanonicalCtSessionProjection,
  assertCanonicalUserVoteIndexForBotVotes,
  buildCanonicalCtSessionProjection,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { stageCtVoteWrites } from '@stark-ballot/aws-adapters/store/stagedCtWrite';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging, hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import path from 'node:path';
import type {
  BitmapData,
  FileMockDiagnostics,
  ReceiptEntry,
  SerializableSessionData,
} from '@stark-ballot/aws-adapters/store/fileMock/types';
import { parseBitmapData, parseReceiptEntries } from '@stark-ballot/aws-adapters/store/fileMock/parsers';
import { deserializeSession, serializeSession } from '@stark-ballot/aws-adapters/store/fileMock/sessionSerde';
import { formatVoteData } from '@stark-ballot/aws-adapters/store/fileMock/voteUtils';
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
  rebuildSessionCacheFromSerialized,
  recordCacheAccess,
  snapshotCachedSessions,
  updateCacheDiagnostics,
  type FileMockCacheState,
} from '@stark-ballot/aws-adapters/store/fileMock/cache';
import {
  buildUnsupportedCurrentArtifactDetails,
  classifyAuthoritativeWriteContract,
  hasSessionFinalizationBranch,
  isRecoverableCurrentLiveSession,
  UnsupportedCurrentArtifactBoundaryError,
  resolveAuthoritativeWriteContractGeneration,
  resolveCurrentContractGeneration,
} from '@stark-ballot/domain/contract';
import {
  requireVerificationObservation,
  resolveVerificationObservationRecord,
  type RecordVerificationObservationResult,
  type VerificationObservation,
} from '@stark-ballot/domain/types/verificationObservation';

import * as fs from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';

type WriteJsonOptions = {
  spaces?: number;
};

function readJsonFileSync(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function stringifyJson(value: unknown, options: WriteJsonOptions = {}): string {
  return `${JSON.stringify(value, null, options.spaces ?? 0)}\n`;
}

async function writeJsonFile(filePath: string, value: unknown, options?: WriteJsonOptions): Promise<void> {
  await writeFile(filePath, stringifyJson(value, options), 'utf8');
}

async function moveFile(
  sourcePath: string,
  destinationPath: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  if (options.overwrite) {
    await rm(destinationPath, { force: true });
  }
  await rename(sourcePath, destinationPath);
}

async function acquireExclusiveFileLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out acquiring verification observation file lock');
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
}

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

type AwsMetadataMode = 'pure' | 'aws';

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
 * File-based implementation of a session store for E2E testing in production mode.
 * Persists sessions and voteId index to .tmp/mock-sessions/ (or FILE_MOCK_STORE_DIR override)
 * to enable sharing across workers.
 */
export class FileMockSessionStore
  implements VoteStore, AwsFinalizationRuntimeTransitionStore, AwsFinalizationDeliveryMetadataStore
{
  private static diagnostics: FileMockDiagnostics = {
    sessionDiskReads: 0,
    cacheSize: 0,
    cacheEvictions: 0,
  };

  private sessions: Map<string, SessionData> = new Map();
  private serializedSessions: Map<string, SerializableSessionData> = new Map();
  private dirtySessionIds: Set<string> = new Set();
  private voteIdIndex: Map<string, { sessionId: string; index: number }> = new Map();
  private deliveryMetadata = new InMemoryAwsVerificationDeliveryMetadataStore();
  private verificationRollbackSnapshots = new Map<
    string,
    {
      verificationResult?: AwsPersistedVerificationResult;
      verificationExecutionId?: string;
    }
  >();
  private readonly storageDir = (() => {
    const override = process.env['FILE_MOCK_STORE_DIR'];
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
  private readonly cacheEnabled = process.env['DISABLE_FILE_STORE_CACHE'] !== '1';
  private readonly cacheLimit = (() => {
    const raw = process.env['FILE_STORE_CACHE_LIMIT'];
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

    const debugEnabled = process.env['DEBUG_FILE_STORE'] === '1';

    try {
      fs.mkdirSync(this.storageDir, { recursive: true });

      if (debugEnabled) {
        logger.debug('[FileMockStore][DEBUG] loadSessionsFromDisk() called', {
          mapSizeBefore: this.sessions.size,
          sessionsFilePath: this.sessionsFile,
        });
      }

      if (fs.existsSync(this.sessionsFile)) {
        const fileStats = fs.statSync(this.sessionsFile);
        const data = readJsonFileSync(this.sessionsFile) as SerializableSessionData[];

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
          const data = readJsonFileSync(this.voteIdIndexFile) as Record<string, { sessionId: string; index: number }>;
          this.voteIdIndex = new Map(Object.entries(data));
          logger.info('[FileMockStore] Loaded voteId index from disk:', this.voteIdIndex.size);
        } catch {
          logger.warn('[FileMockStore] Failed to parse voteIdIndex.json, using empty state');
          this.voteIdIndex.clear();
        }
      }

      if (fs.existsSync(this.legacyBitmapFile)) {
        fs.rmSync(this.legacyBitmapFile, { force: true });
        logger.warn('[FileMockStore] Removed legacy bitmap.json artifact during reset');
      }

      this.loadBitmapsFromDiskSync();

      if (this.bitmapDataBySession.size > 0) {
        logger.info('[FileMockStore] Loaded bitmap data from disk:', this.bitmapDataBySession.size);
      }

      if (fs.existsSync(this.receiptsFile)) {
        try {
          const data = parseReceiptEntries(readJsonFileSync(this.receiptsFile));
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
      await mkdir(this.storageDir, { recursive: true });
      snapshotCachedSessions(this.getCacheState(), serializeSession);
      const serializable = Array.from(this.serializedSessions.values());
      const tempFile = `${this.sessionsFile}.tmp`;
      await writeJsonFile(tempFile, serializable, { spaces: 2 });
      await moveFile(tempFile, this.sessionsFile, { overwrite: true });
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
      await mkdir(this.storageDir, { recursive: true });
      const serializable = Object.fromEntries(this.voteIdIndex);
      const tempFile = `${this.voteIdIndexFile}.tmp`;
      await writeJsonFile(tempFile, serializable, { spaces: 2 });
      await moveFile(tempFile, this.voteIdIndexFile, { overwrite: true });
      logger.info('[FileMockStore] Saved voteId index to disk:', this.voteIdIndex.size);
    } catch (error) {
      logger.error('[FileMockStore] Failed to save voteId index:', error);
      throw error;
    }
  }

  private async saveReceipts(): Promise<void> {
    try {
      await mkdir(this.storageDir, { recursive: true });
      const tempFile = `${this.receiptsFile}.tmp`;
      await writeJsonFile(tempFile, Object.fromEntries(this.receipts), { spaces: 2 });
      await moveFile(tempFile, this.receiptsFile, { overwrite: true });
    } catch (error) {
      logger.error('[FileMockStore] Failed to save receipts:', error);
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
        logger.warn('[FileMockStore] Skipping invalid bitmap entry', {
          session_id_hash: hashSessionIdForLogging(sessionId),
        });
        continue;
      }
      if (bitmapData.sessionId !== sessionId) {
        logger.warn('[FileMockStore] Skipping bitmap entry with mismatched sessionId', {
          key_session_id_hash: hashSessionIdForLogging(sessionId),
          value_session_id_hash: hashSessionIdForLogging(bitmapData.sessionId),
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
      const raw: unknown = readJsonFileSync(this.bitmapsFile);
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
      const raw: unknown = await readJsonFile(this.bitmapsFile);
      this.bitmapDataBySession = this.parseBitmapMap(raw);
    } catch {
      logger.warn('[FileMockStore] Failed to parse bitmaps.json, resetting bitmap cache');
      this.bitmapDataBySession.clear();
    }
  }

  private async saveBitmaps(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    const tempFile = `${this.bitmapsFile}.tmp`;
    await writeJsonFile(tempFile, Object.fromEntries(this.bitmapDataBySession), { spaces: 2 });
    await moveFile(tempFile, this.bitmapsFile, { overwrite: true });
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

    const debugEnabled = process.env['DEBUG_FILE_STORE'] === '1';

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
    this.markSessionDirty(session.sessionId);
    return nextState;
  }

  private async observeFinalizationPersistence(
    sessionId: string,
    requestedTo: FinalizationState['status'],
    payload: Pick<FinalizationQueuedPayload, 'executionId' | 'observability'>,
    operation: () => Promise<FinalizationState>,
  ): Promise<FinalizationState> {
    this.ensureSessionsFresh();
    const before = parsePersistedFinalizationState(this.sessions.get(sessionId)?.finalizationState);
    const actual = await operation();
    recordFinalizationStorePersistenceOutcome({
      sessionId,
      requestedExecutionId: payload.executionId,
      requestedTo,
      ...(before ? { before } : {}),
      actual,
      authoritativeWrite: true,
      ...(payload.observability ? { metadata: payload.observability } : {}),
    });
    return actual;
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
    session.finalizationState = admitAwsPersistedFinalizationStateBranch(next);
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
    };

    recordCacheAccess(this.getCacheState(), sessionData, serializeSession);
    this.serializedSessions.set(sessionId, serializeSession(sessionData));
    this.markSessionDirty(sessionId);
    logger.info('[FileMockStore] Created session', {
      session_id_hash: hashSessionIdForLogging(sessionId),
    });

    await this.saveSessions();

    return sessionData;
  }

  getSession(sessionId: string): Promise<SessionData | null> {
    const debugEnabled = process.env['DEBUG_FILE_STORE'] === '1';

    if (debugEnabled) {
      logger.debug('[FileMockStore][DEBUG] getSession() called', {
        session_id_hash: hashSessionIdForLogging(sessionId),
        mapSizeBefore: this.sessions.size,
      });
    } else {
      logger.info('[FileMockStore] Getting session', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
    }

    this.ensureSessionsFresh();

    let session = this.sessions.get(sessionId);
    if (!session && this.serializedSessions.has(sessionId)) {
      const serialized = this.serializedSessions.get(sessionId);
      if (!serialized) {
        throw new Error('Serialized session missing for requested session');
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
          session_id_hash: hashSessionIdForLogging(sessionId),
          finalized: session.finalized,
          hasFinalizationResult: !!session.finalizationResult,
          votesCount: session.votes.size,
        });
      } else {
        logger.info('[FileMockStore] Session found', {
          session_id_hash: hashSessionIdForLogging(sessionId),
        });
      }
    } else {
      logger.info('[FileMockStore] Session not found', {
        session_id_hash: hashSessionIdForLogging(sessionId),
      });
      if (debugEnabled) {
        logger.debug('[FileMockStore][DEBUG] Available session count:', this.sessions.size);
      }
    }
    return Promise.resolve(session || null);
  }

  async addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult> {
    logger.info('[FileMockStore] addVote called for session', {
      session_id_hash: hashSessionIdForLogging(sessionId),
    });
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
      if (process.env['NODE_ENV'] === 'development') {
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
    if (!stagedWrite) {
      throw new Error('Finalization state invariant violated');
    }

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
    this.markSessionDirty(session.sessionId);

    logger.info('[FileMockStore] updateSession called:', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      hasPatch: Boolean(data),
    });

    await this.saveSessions();

    if (data) {
      return session;
    }
  }

  async recordVerificationObservation(
    sessionId: string,
    input: VerificationObservation,
  ): Promise<RecordVerificationObservationResult> {
    const observation = requireVerificationObservation(input);
    await mkdir(this.storageDir, { recursive: true });
    const lockPath = `${this.sessionsFile}.verification-observation.lock`;
    const lock = await acquireExclusiveFileLock(lockPath);
    try {
      this.loadSessionsFromDisk();
      const session = await this.getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      const currentExecutionId = parseAwsPersistedFinalizationResult(
        session.finalizationResult,
      )?.verificationExecutionId;
      const resolution = resolveVerificationObservationRecord(
        currentExecutionId,
        session.verificationObservation,
        observation,
      );
      if (resolution.status === 'recorded') {
        session.verificationObservation = observation;
        session.lastActivity = Date.now();
        this.markSessionDirty(session.sessionId);
        await this.saveSessions();
      }
      return resolution;
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
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
    this.markSessionDirty(session.sessionId);
    await this.saveSessions();
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
    this.markSessionDirty(session.sessionId);
    await this.saveSessions();
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
    await this.saveSessions();
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
    await this.saveSessions();
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
    await this.saveSessions();
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
    this.markSessionDirty(session.sessionId);
  }

  async markFinalizationQueued(
    sessionId: string,
    payload: FinalizationQueuedPayload & {
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'pending', payload, () =>
      this.applyFinalizationQueued(sessionId, payload),
    );
  }

  private async applyFinalizationQueued(
    sessionId: string,
    payload: FinalizationQueuedPayload & {
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
    return next;
  }

  async markFinalizationRunning(
    sessionId: string,
    payload: FinalizationRunningPayload & {
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'running', payload, () =>
      this.applyFinalizationRunning(sessionId, payload, 'pure'),
    );
  }

  async markAwsFinalizationRunning(
    sessionId: string,
    payload: AwsFinalizationRunningPayload,
  ): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'running', payload, () =>
      this.applyFinalizationRunning(sessionId, payload, 'aws'),
    );
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
    return next;
  }

  async markFinalizationSucceeded(
    sessionId: string,
    payload: FinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'succeeded', payload, () =>
      this.applyFinalizationSucceeded(sessionId, payload, 'pure'),
    );
  }

  async markAwsFinalizationSucceeded(
    sessionId: string,
    payload: AwsFinalizationSucceededPayload,
  ): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'succeeded', payload, () =>
      this.applyFinalizationSucceeded(sessionId, payload, 'aws'),
    );
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
    return next;
  }

  async markFinalizationFailed(sessionId: string, payload: FinalizationFailedPayload): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'failed', payload, () =>
      this.applyFinalizationFailed(sessionId, payload, 'pure'),
    );
  }

  async markAwsFinalizationFailed(
    sessionId: string,
    payload: AwsFinalizationFailedPayload,
  ): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'failed', payload, () =>
      this.applyFinalizationFailed(sessionId, payload, 'aws'),
    );
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
    return next;
  }

  async markFinalizationTimedOut(sessionId: string, payload: FinalizationTimedOutPayload): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'timeout', payload, () =>
      this.applyFinalizationTimedOut(sessionId, payload, 'pure'),
    );
  }

  async markAwsFinalizationTimedOut(
    sessionId: string,
    payload: AwsFinalizationTimedOutPayload,
  ): Promise<FinalizationState> {
    return this.observeFinalizationPersistence(sessionId, 'timeout', payload, () =>
      this.applyFinalizationTimedOut(sessionId, payload, 'aws'),
    );
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
      const next = this.failCurrentArtifactExecution(session, payload, artifactState);
      await this.saveSessions();
      return next;
    }
    if (this.hasContractGenerationMismatch(session, payload.contractGeneration)) {
      const next = this.failCurrentArtifactExecution(session, payload);
      await this.saveSessions();
      return next;
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
    await this.saveSessions();
    return next;
  }

  async getActiveSessionCount(): Promise<number> {
    this.ensureSessionsFresh();
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.serializedSessions.entries()) {
      if (now - session.lastActivity > 5 * 60 * 1000) {
        logger.info('[FileMockStore] Removing expired session', {
          session_id_hash: hashSessionIdForLogging(id),
        });
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
      isRecoverableCurrentLiveSession(omitUndefinedProperties(session)),
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

    const canonicalProjection = buildCanonicalCtSessionProjection(session);
    if (session.botCount !== canonicalProjection.botCount) {
      logger.warn('[FileMockStore] Reconciled stale botCount before appending bot votes', {
        session_id_hash: hashSessionIdForLogging(sessionId),
        persistedBotCount: session.botCount,
        derivedBotCount: canonicalProjection.botCount,
      });
    }
    if (session.userVoteIndex !== canonicalProjection.userVoteIndex) {
      logger.warn('[FileMockStore] Reconciled stale userVoteIndex before appending bot votes', {
        session_id_hash: hashSessionIdForLogging(sessionId),
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
    }

    session.botCount = canonicalProjection.botCount + stagedWrites.votes.length;
    const firstStagedWrite = stagedWrites.votes[0];
    const lastStagedWrite = stagedWrites.votes[stagedWrites.votes.length - 1];
    if (firstStagedWrite && lastStagedWrite) {
      logger.info('[FileMockStore] Bot votes added:', {
        addedCount: stagedWrites.votes.length,
        totalBotCount: session.botCount,
        firstBotIndex: firstStagedWrite.index,
        lastBotIndex: lastStagedWrite.index,
        bulletinSize: session.bulletin.getSize(),
        finalRoot: lastStagedWrite.storedVote.rootAtCast?.slice(0, 10),
      });
    }

    session.lastActivity = Date.now();
    this.markSessionDirty(session.sessionId);

    await this.saveSessions();
    await this.saveVoteIdIndex();
  }

  async finalizeSession(
    sessionId: string,
    result: FinalizationResultAuthority,
    contractGeneration: string,
    executionId: string,
  ): Promise<void> {
    const deliveryMetadata = this.deliveryMetadata.take(sessionId, executionId);
    const finalizationResult = requireAwsPersistedFinalizationResult(result, executionId, deliveryMetadata);
    const debugEnabled = process.env['DEBUG_FILE_STORE'] === '1';
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
        logger.warn('[FileMockStore] Failed to compute Merkle path for vote', index, error);
      }
    }

    const hadFinalizationBranch = hasSessionFinalizationBranch(session);
    session.finalized = true;
    if (!hadFinalizationBranch) {
      session.finalizationContractGeneration = contractGeneration;
    }
    session.finalizationResult = admitAwsPersistedFinalizationResultBranch(finalizationResult);
    session.lastActivity = Date.now();
    this.markSessionDirty(session.sessionId);
    const journalForLog = (
      finalizationResult as {
        journal?: {
          verifiedTally?: unknown;
          missingSlots?: unknown;
          invalidPresentedSlots?: unknown;
        };
      }
    ).journal;

    logger.info('[FileMockStore] Session finalized', {
      session_id_hash: hashSessionIdForLogging(sessionId),
    });
    logger.info('[FileMockStore] finalizationResult set:', {
      hasFinalizationResult: !!result,
      verifiedTally: journalForLog?.verifiedTally,
      missingSlots: journalForLog?.missingSlots,
      invalidPresentedSlots: journalForLog?.invalidPresentedSlots,
    });

    if (debugEnabled) {
      const finalizationState = parsePersistedFinalizationState(session.finalizationState);
      logger.debug('[FileMockStore][DEBUG] Attempting to save finalized session', {
        session_id_hash: hashSessionIdForLogging(sessionId),
        executionId: finalizationState?.executionId,
        finalized: session.finalized,
      });
    }

    await this.saveSessions();

    if (debugEnabled) {
      logger.debug('[FileMockStore][DEBUG] saveSessions() completed successfully', {
        session_id_hash: hashSessionIdForLogging(sessionId),
        file_path_hash: hashKeyPrefixForLogging(this.sessionsFile),
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
      session_id_hash: hashSessionIdForLogging(sessionId),
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
    logger.info('[FileMockStore] Getting bitmap data for session', {
      session_id_hash: hashSessionIdForLogging(sessionId),
    });
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
    await this.saveReceipts();

    logger.info('[FileMockStore] Atomically finalized receipt publication:', {
      session_id_hash: hashSessionIdForLogging(sessionId),
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
