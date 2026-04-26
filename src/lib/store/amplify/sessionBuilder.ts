import { VOTE_CHOICES } from '@/shared/constants';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { normalizeHex } from '@/lib/utils/hex';
import { isRecord } from '@/lib/utils/guards';
import { logger } from '@/lib/utils/logger';
import { decryptVoteSecret } from '@/lib/security/voteSecretCipher';
import { hasMatchingElectionConfigHash, isElectionConfig } from '@/lib/zkvm/election-config';
import { canonicalizeFinalizationResult, hasConsistentPublicAuditArtifacts } from '@/lib/finalize/finalization-result';
import type { SessionSummary } from '@/types/voteStore';
import type { FinalizationState, RootSnapshot, SessionData, VoteData } from '@/types/server';
import type { VoteChoice } from '@/shared/constants';
import { assertCanonicalCtVoteIndices } from '@/lib/store/ctSessionState';
import {
  classifyFinalizedArtifactContract,
  isFailClosedCurrentArtifactState,
  isCurrentContractGeneration,
  type CurrentArtifactState,
} from '@/lib/contract';
import { isNonNegativeInteger, isReceiptWithImageId, isZkVMJournal, parseJsonField, toNumber } from './guards';
import type { AmplifySessionRecord, AmplifyVoteRecord } from './graphql';
import { buildTimestamp } from './sessionUtils';
import { parseStoredFinalizationEnvelope, parseStoredFinalizationPayload } from './finalization';

function isVoteChoice(value: string): value is VoteChoice {
  return VOTE_CHOICES.includes(value as VoteChoice);
}

type ResolvedPersistedFinalization = {
  finalizationResult?: SessionData['finalizationResult'];
  finalizationState?: FinalizationState;
  finalizationScenarioContext?: SessionData['finalizationScenarioContext'];
  finalizationContractGeneration?: SessionData['finalizationContractGeneration'];
  finalizationArtifactState?: SessionData['finalizationArtifactState'];
  resolvedArtifactState?: CurrentArtifactState;
  hasPersistedFinalizationBranch: boolean;
  canProjectCurrentFinalization: boolean;
};

function resolvePersistedFinalization(session: AmplifySessionRecord): ResolvedPersistedFinalization {
  const hasPersistedFinalizationStorage =
    session.finalizationResultJson !== null && session.finalizationResultJson !== undefined;
  const hasPersistedFinalizationBranch = hasPersistedFinalizationStorage || Boolean(session.finalized);
  const finalizationStorage = parseJsonField<unknown>(session.finalizationResultJson);
  let finalizationResult: SessionData['finalizationResult'] | undefined;
  let finalizationState: FinalizationState | undefined;
  let finalizationScenarioContext: SessionData['finalizationScenarioContext'] | undefined;
  let finalizationContractGeneration: SessionData['finalizationContractGeneration'];
  let finalizationArtifactState: SessionData['finalizationArtifactState'];
  const persistedArtifactState = isFailClosedCurrentArtifactState(session.finalizationArtifactState)
    ? session.finalizationArtifactState
    : undefined;

  const envelope = parseStoredFinalizationEnvelope(finalizationStorage);
  const payload = parseStoredFinalizationPayload(finalizationStorage);
  if (payload) {
    finalizationResult = payload.finalizationResult ?? undefined;
    finalizationState = payload.finalizationState ?? undefined;
    finalizationScenarioContext = payload.finalizationScenarioContext ?? undefined;
    finalizationContractGeneration = payload.contractGeneration;
  } else if (envelope) {
    finalizationContractGeneration = envelope.contractGeneration;
  } else if (finalizationStorage !== undefined) {
    logger.warn('[AmplifySessionStore] Ignoring unsupported finalizationResultJson payload', {
      sessionId: session.id,
    });
  }

  const resolvedArtifactState = classifyFinalizedArtifactContract({
    finalized: session.finalized ?? false,
    hasPersistedFinalizationBranch,
    payloadReadable: hasPersistedFinalizationStorage ? payload !== undefined : !(session.finalized ?? false),
    persistedContractGeneration: finalizationContractGeneration,
    hasAuthoritativeFinalizationResult: session.finalized ? finalizationResult != null : undefined,
  });
  finalizationArtifactState =
    persistedArtifactState ??
    (resolvedArtifactState && resolvedArtifactState !== 'supported' ? resolvedArtifactState : undefined);

  return {
    finalizationResult,
    finalizationState,
    finalizationScenarioContext,
    finalizationContractGeneration,
    finalizationArtifactState,
    resolvedArtifactState: finalizationArtifactState ?? resolvedArtifactState ?? undefined,
    hasPersistedFinalizationBranch,
    canProjectCurrentFinalization:
      persistedArtifactState === undefined && resolvedArtifactState === 'supported' && payload !== undefined,
  };
}

function normalizePersistedRootSnapshot(value: unknown): RootSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const root = typeof value.root === 'string' ? value.root : undefined;
  const treeSize = toNumber(
    typeof value.treeSize === 'string' || typeof value.treeSize === 'number' ? value.treeSize : undefined,
  );
  const timestamp = toNumber(
    typeof value.timestamp === 'string' || typeof value.timestamp === 'number' ? value.timestamp : undefined,
  );

  if (!root || !isNonNegativeInteger(treeSize) || treeSize <= 0 || !isNonNegativeInteger(timestamp) || timestamp <= 0) {
    return null;
  }

  try {
    return {
      root: normalizeHex(root, { allowEmpty: true }),
      treeSize,
      timestamp,
      ...(typeof value.signature === 'string' ? { signature: value.signature } : {}),
    };
  } catch {
    return null;
  }
}

function parsePersistedRootHistory(value: unknown, sessionId: string): RootSnapshot[] | undefined {
  const parsed = parseJsonField<unknown>(value);
  if (parsed === undefined) {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    logger.warn('[AmplifySessionStore] Ignoring invalid persisted bulletin root history', {
      sessionId,
      reason: 'not_array',
    });
    return undefined;
  }

  const normalized: RootSnapshot[] = [];
  for (const [index, snapshot] of parsed.entries()) {
    const normalizedSnapshot = normalizePersistedRootSnapshot(snapshot);
    if (!normalizedSnapshot) {
      logger.warn('[AmplifySessionStore] Ignoring invalid persisted bulletin root history', {
        sessionId,
        reason: 'invalid_snapshot',
        index,
      });
      return undefined;
    }
    normalized.push(normalizedSnapshot);
  }

  return normalized;
}

function deriveUserVoteIndexFromRecords(
  votes: AmplifyVoteRecord[],
  fallbackUserVoteIndex: number | undefined,
): number | undefined {
  const explicitUserVote = votes.find((vote) => vote.isUserVote === true);
  if (explicitUserVote && isNonNegativeInteger(explicitUserVote.voteIndex)) {
    return explicitUserVote.voteIndex;
  }
  return fallbackUserVoteIndex;
}

function deriveBotCountFromVoteRecords(votes: AmplifyVoteRecord[], userVoteIndex: number | undefined): number {
  if (votes.length === 0) {
    return 0;
  }

  if (userVoteIndex !== undefined) {
    return votes.filter((vote) => vote.voteIndex !== userVoteIndex).length;
  }

  const hasExplicitUserVote = votes.some((vote) => vote.isUserVote === true);
  if (hasExplicitUserVote) {
    return votes.filter((vote) => vote.isUserVote !== true).length;
  }

  return Math.max(votes.length - 1, 0);
}

function assertCanonicalCtVoteRecordIndices(votes: AmplifyVoteRecord[]): void {
  assertCanonicalCtVoteIndices(votes.map((vote) => vote.voteIndex));
}

function mergePersistedRootHistory(
  sessionId: string,
  reconstructedHistory: RootSnapshot[],
  persistedHistory: RootSnapshot[] | undefined,
): RootSnapshot[] {
  if (reconstructedHistory.length === 0) {
    return persistedHistory ?? [];
  }
  if (!persistedHistory) {
    return reconstructedHistory;
  }
  if (persistedHistory.length !== reconstructedHistory.length) {
    logger.warn('[AmplifySessionStore] Rebuilt stale bulletin root history from persisted votes', {
      sessionId,
      reason: 'length_mismatch',
      persistedLength: persistedHistory.length,
      reconstructedLength: reconstructedHistory.length,
    });
    return reconstructedHistory;
  }

  for (const [index, reconstructedSnapshot] of reconstructedHistory.entries()) {
    const persistedSnapshot = persistedHistory[index];
    if (!persistedSnapshot) {
      logger.warn('[AmplifySessionStore] Rebuilt stale bulletin root history from persisted votes', {
        sessionId,
        reason: 'missing_snapshot',
        index,
      });
      return reconstructedHistory;
    }

    if (
      persistedSnapshot.treeSize !== reconstructedSnapshot.treeSize ||
      persistedSnapshot.root !== reconstructedSnapshot.root
    ) {
      logger.warn('[AmplifySessionStore] Rebuilt stale bulletin root history from persisted votes', {
        sessionId,
        reason: 'snapshot_mismatch',
        index,
        persistedTreeSize: persistedSnapshot.treeSize,
        reconstructedTreeSize: reconstructedSnapshot.treeSize,
        persistedRoot: persistedSnapshot.root,
        reconstructedRoot: reconstructedSnapshot.root,
      });
      return reconstructedHistory;
    }
  }

  return reconstructedHistory.map((snapshot, index) => {
    const persistedSnapshot = persistedHistory[index];
    return {
      ...snapshot,
      timestamp: persistedSnapshot?.timestamp ?? snapshot.timestamp,
      ...(typeof persistedSnapshot?.signature === 'string' ? { signature: persistedSnapshot.signature } : {}),
    };
  });
}

export function buildSessionSummaryFromRecord(
  sessionId: string,
  sessionRecord: AmplifySessionRecord,
  votes?: AmplifyVoteRecord[],
): SessionSummary | null {
  if (votes !== undefined) {
    assertCanonicalCtVoteRecordIndices(votes);
  }
  const persistedBotCount = isNonNegativeInteger(sessionRecord.botCount ?? undefined)
    ? (sessionRecord.botCount ?? 0)
    : 0;
  const persistedUserVoteIndex = isNonNegativeInteger(sessionRecord.userVoteIndex ?? undefined)
    ? (sessionRecord.userVoteIndex ?? undefined)
    : undefined;
  const userVoteIndex =
    votes !== undefined ? deriveUserVoteIndexFromRecords(votes, persistedUserVoteIndex) : persistedUserVoteIndex;
  const botCount = votes !== undefined ? deriveBotCountFromVoteRecords(votes, userVoteIndex) : persistedBotCount;
  const { resolvedArtifactState } = resolvePersistedFinalization(sessionRecord);

  if (votes !== undefined && persistedBotCount !== botCount) {
    logger.warn('[AmplifySessionStore] Reconciled stale botCount from persisted votes', {
      sessionId,
      persistedBotCount,
      derivedBotCount: botCount,
    });
  }

  return {
    sessionId,
    botCount,
    contractGeneration: sessionRecord.contractGeneration ?? undefined,
    finalizationArtifactState: resolvedArtifactState,
    userVoteIndex,
    finalized: sessionRecord.finalized ?? false,
  };
}

export async function buildSessionDataFromRecords(
  session: AmplifySessionRecord,
  votes: AmplifyVoteRecord[],
): Promise<SessionData> {
  const createdAt = toNumber(session.createdAt) ?? buildTimestamp();
  const lastActivity = toNumber(session.lastActivity) ?? createdAt;
  assertCanonicalCtVoteRecordIndices(votes);

  const voteMap = new Map<number, VoteData>();
  const bulletin = session.logId ? new SimpleBulletinBoard(session.logId) : undefined;
  const reconstructedBulletinRootHistory: RootSnapshot[] = [];

  const sortedVotes = [...votes].sort((a, b) => a.voteIndex - b.voteIndex);
  for (const vote of sortedVotes) {
    const decryptedChoice = decryptVoteSecret(vote.choice);
    if (!isVoteChoice(decryptedChoice)) {
      throw new Error(`Invalid vote choice in persisted record: ${decryptedChoice}`);
    }

    const decryptedRandom = decryptVoteSecret(vote.random);
    const commitHex = normalizeHex(vote.commitment, { allowEmpty: true });
    if (bulletin) {
      const appendResult = bulletin.appendVote(vote.id, commitHex.slice(2));
      reconstructedBulletinRootHistory.push({
        timestamp: toNumber(vote.timestamp) ?? createdAt,
        root: normalizeHex(appendResult.rootAtAppend, { allowEmpty: true }),
        treeSize: appendResult.index + 1,
      });
    }
    const voteData: VoteData = {
      voteId: vote.id,
      vote: decryptedChoice,
      rand: normalizeHex(decryptedRandom, { allowEmpty: true }),
      commit: commitHex,
      path: [],
      timestamp: toNumber(vote.timestamp) ?? createdAt,
      rootAtCast: vote.rootAtCast ? normalizeHex(vote.rootAtCast, { allowEmpty: true }) : undefined,
    };
    voteMap.set(vote.voteIndex, voteData);
  }

  const persistedUserVoteIndex = isNonNegativeInteger(session.userVoteIndex ?? undefined)
    ? (session.userVoteIndex ?? undefined)
    : undefined;
  const derivedUserVoteIndex = deriveUserVoteIndexFromRecords(sortedVotes, persistedUserVoteIndex);
  const bulletinRootHistory = mergePersistedRootHistory(
    session.id,
    reconstructedBulletinRootHistory,
    parsePersistedRootHistory(session.bulletinRootHistoryJson, session.id),
  );
  const derivedBotCount = deriveBotCountFromVoteRecords(sortedVotes, derivedUserVoteIndex);
  if (isNonNegativeInteger(session.botCount ?? undefined) && session.botCount !== derivedBotCount) {
    logger.warn('[AmplifySessionStore] Reconciled stale botCount from persisted votes', {
      sessionId: session.id,
      persistedBotCount: session.botCount,
      derivedBotCount,
    });
  }

  let {
    finalizationResult,
    finalizationState,
    finalizationScenarioContext,
    finalizationContractGeneration,
    finalizationArtifactState,
    hasPersistedFinalizationBranch,
    canProjectCurrentFinalization,
  } = resolvePersistedFinalization(session);

  // Restore receipt and journal from S3 when available.
  // finalizationResultにs3BundleKeyがあり、receipt/journalが無い場合、S3から復元
  if (canProjectCurrentFinalization && shouldRestoreBundleArtifacts(finalizationResult)) {
    try {
      const { restoreReceiptFromS3 } = await import('@/lib/aws/bundle-restore');
      const restored = await restoreReceiptFromS3(finalizationResult.s3BundleKey);
      if (isReceiptWithImageId(restored.receipt)) {
        finalizationResult.receipt = restored.receipt;
      }
      if (!finalizationResult.receiptRaw) {
        finalizationResult.receiptRaw = restored.receiptRaw;
      }
      if (isZkVMJournal(restored.journal)) {
        finalizationResult.journal = restored.journal;
      }
      if (restored.publicInputArtifact) {
        finalizationResult.publicInputArtifact = restored.publicInputArtifact;
      }
      if (restored.electionManifest) {
        finalizationResult.electionManifest = restored.electionManifest;
      }
      if (restored.closeStatement) {
        finalizationResult.closeStatement = restored.closeStatement;
      }
      if (!finalizationResult.bitmapData && restored.includedBitmapArtifact) {
        finalizationResult.bitmapData = {
          includedBitmap: [...restored.includedBitmapArtifact.includedBitmap],
          includedBitmapRoot: restored.includedBitmapArtifact.includedBitmapRoot,
          ...(restored.seenBitmapArtifact
            ? {
                seenBitmap: [...restored.seenBitmapArtifact.seenBitmap],
                seenBitmapRoot: restored.seenBitmapArtifact.seenBitmapRoot,
              }
            : {}),
          treeSize: restored.includedBitmapArtifact.treeSize,
          finalizedAt: Date.now(),
        };
        finalizationResult.bitmapProofSource = finalizationResult.bitmapProofSource ?? 'real';
      } else if (
        finalizationResult.bitmapData &&
        !finalizationResult.bitmapData.seenBitmap &&
        restored.seenBitmapArtifact
      ) {
        finalizationResult.bitmapData = {
          ...finalizationResult.bitmapData,
          seenBitmap: [...restored.seenBitmapArtifact.seenBitmap],
          seenBitmapRoot: restored.seenBitmapArtifact.seenBitmapRoot,
        };
      }
      logger.info('[AmplifySessionStore] Receipt and journal restored from S3:', finalizationResult.s3BundleKey);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[AmplifySessionStore] Failed to restore from S3:', errorMessage);
      // エラーでも処理を継続（receipt/journalが無いままの可能性あり）
    }
  }

  if (canProjectCurrentFinalization) {
    finalizationResult = canonicalizeFinalizationResult(finalizationResult, finalizationScenarioContext);
  }

  if (
    finalizationArtifactState === undefined &&
    session.finalized === true &&
    isCurrentContractGeneration(finalizationContractGeneration) &&
    finalizationResult === undefined
  ) {
    finalizationArtifactState = 'corrupt_or_unreadable';
  }

  if (session.finalized === true && finalizationArtifactState === 'corrupt_or_unreadable') {
    finalizationState = undefined;
  }

  const parsedElectionConfig = parseJsonField<unknown>(session.electionConfigJson);
  if (parsedElectionConfig !== undefined && !isElectionConfig(parsedElectionConfig)) {
    throw new Error('Persisted electionConfigJson did not match expected shape');
  }
  const electionConfig =
    parsedElectionConfig && isElectionConfig(parsedElectionConfig) ? parsedElectionConfig : undefined;
  if (
    electionConfig &&
    session.electionConfigHash &&
    !hasMatchingElectionConfigHash(electionConfig, session.electionConfigHash)
  ) {
    throw new Error('Persisted electionConfigJson did not match electionConfigHash');
  }

  return {
    sessionId: session.id,
    contractGeneration: session.contractGeneration ?? undefined,
    finalizationContractGeneration,
    hasPersistedFinalizationBranch,
    finalizationArtifactState,
    electionId: session.electionId,
    electionConfigHash: session.electionConfigHash ?? undefined,
    electionConfig,
    logId: session.logId ?? undefined,
    votes: voteMap,
    bulletin,
    botCount: derivedBotCount,
    finalized: session.finalized ?? false,
    createdAt,
    lastActivity,
    userVoteIndex: derivedUserVoteIndex,
    bulletinRootHistory,
    finalizationResult: finalizationResult ?? undefined,
    finalizationState: finalizationState ?? undefined,
    finalizationScenarioContext: finalizationScenarioContext ?? undefined,
  };
}

function shouldRestoreBundleArtifacts(
  finalizationResult: SessionData['finalizationResult'] | undefined,
): finalizationResult is NonNullable<SessionData['finalizationResult']> & { s3BundleKey: string } {
  if (!finalizationResult?.s3BundleKey) {
    return false;
  }

  if (!finalizationResult.receipt || !hasConsistentPublicAuditArtifacts(finalizationResult)) {
    return true;
  }

  const expectedExecutionId = extractExecutionIdFromBundleKey(finalizationResult.s3BundleKey);
  const publicInputArtifact = finalizationResult.publicInputArtifact;
  if (!publicInputArtifact) {
    return true;
  }
  if (
    !publicInputArtifact.provenance.bundleKey ||
    publicInputArtifact.provenance.bundleKey !== finalizationResult.s3BundleKey
  ) {
    return true;
  }
  if (
    expectedExecutionId &&
    (!publicInputArtifact.provenance.executionId || publicInputArtifact.provenance.executionId !== expectedExecutionId)
  ) {
    return true;
  }

  return false;
}

function extractExecutionIdFromBundleKey(bundleKey: string): string | undefined {
  const segments = bundleKey.split('/').filter(Boolean);
  if (segments.length < 2 || segments[segments.length - 1] !== 'bundle.zip') {
    return undefined;
  }
  return segments[segments.length - 2];
}
