import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import {
  classifyFinalizedArtifactContract,
  isCurrentContractGeneration,
  isFailClosedCurrentArtifactState,
} from '@/lib/contract';
import type { FinalizationResultAuthority, SessionData, VoteData } from '@/types/server';
import { canonicalizeFinalizationResult } from '@/lib/finalize/finalization-result';
import { parseFinalizationResultAuthority } from '@/lib/finalize/finalization-storage';
import { applyCanonicalCtSessionProjection, buildCanonicalCtSessionProjection } from '@/lib/store/ctSessionState';
import { logger } from '@/lib/utils/logger';
import type { SerializableSessionData } from './types';

function serializeFinalizationResult(
  result: SessionData['finalizationResult'],
): FinalizationResultAuthority | undefined {
  if (!result?.journal) {
    return undefined;
  }

  return {
    tally: result.tally,
    s3BundleKey: result.s3BundleKey,
    s3UploadedAt: result.s3UploadedAt,
    receipt: result.receipt,
    receiptRaw: result.receiptRaw,
    receiptPublication: result.receiptPublication,
    imageId: result.imageId,
    tamperDetected: result.tamperDetected,
    scenarios: result.scenarios,
    journal: result.journal,
    publicInputArtifact: result.publicInputArtifact,
    electionManifest: result.electionManifest,
    closeStatement: result.closeStatement,
    bitmapProofSource: result.bitmapProofSource,
    bitmapData: result.bitmapData,
    verificationResult: result.verificationResult,
    verificationExecutionId: result.verificationExecutionId,
    tamperSummary: result.tamperSummary,
  };
}

function deserializeFinalizationResult(
  data: Pick<
    SerializableSessionData,
    | 'finalized'
    | 'finalizationArtifactState'
    | 'finalizationContractGeneration'
    | 'finalizationResult'
    | 'finalizationScenarioContext'
    | 'finalizationState'
  >,
): {
  finalizationResult: SessionData['finalizationResult'] | undefined;
  finalizationArtifactState: SessionData['finalizationArtifactState'] | undefined;
} {
  const persistedArtifactState = isFailClosedCurrentArtifactState(data.finalizationArtifactState)
    ? data.finalizationArtifactState
    : undefined;
  const authority = data.finalizationResult ? parseFinalizationResultAuthority(data.finalizationResult) : undefined;
  const canonicalAuthority = authority && canonicalizeFinalizationResult(authority, data.finalizationScenarioContext);
  const hasPersistedFinalizationResult = data.finalizationResult !== undefined;
  const hasPersistedNonResultPayload =
    data.finalizationState !== undefined || data.finalizationScenarioContext !== undefined;
  const hasPersistedFinalizationBranch =
    hasPersistedFinalizationResult || hasPersistedNonResultPayload || data.finalized;
  const resolvedArtifactState = classifyFinalizedArtifactContract({
    finalized: data.finalized,
    hasPersistedFinalizationBranch,
    payloadReadable: hasPersistedFinalizationResult
      ? authority !== undefined
      : hasPersistedFinalizationBranch
        ? hasPersistedNonResultPayload || !data.finalized
        : !data.finalized,
    persistedContractGeneration: data.finalizationContractGeneration,
    hasAuthoritativeFinalizationResult: data.finalized ? canonicalAuthority !== undefined : undefined,
  });
  let finalizationArtifactState =
    persistedArtifactState ??
    (resolvedArtifactState && resolvedArtifactState !== 'supported' ? resolvedArtifactState : undefined);
  if (
    finalizationArtifactState === undefined &&
    data.finalized &&
    isCurrentContractGeneration(data.finalizationContractGeneration) &&
    canonicalAuthority === undefined
  ) {
    finalizationArtifactState = 'corrupt_or_unreadable';
  }
  const canProjectCurrentFinalization = persistedArtifactState === undefined && resolvedArtifactState === 'supported';

  return {
    finalizationResult: canProjectCurrentFinalization ? canonicalAuthority : undefined,
    finalizationArtifactState,
  };
}

export function serializeSession(session: SessionData): SerializableSessionData {
  return {
    sessionId: session.sessionId,
    contractGeneration: session.contractGeneration,
    finalizationContractGeneration: session.finalizationContractGeneration,
    electionId: session.electionId,
    electionConfigHash: session.electionConfigHash,
    electionConfig: session.electionConfig,
    logId: session.logId,
    votes: Array.from(session.votes.entries()).map(([index, vote]) => [
      index,
      {
        ...vote,
        path: Array.isArray(vote.path) ? [...vote.path] : [],
      },
    ]),
    botCount: session.botCount,
    finalized: session.finalized,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    finalizationResult: serializeFinalizationResult(session.finalizationResult),
    finalizationState: session.finalizationState,
    finalizationScenarioContext: session.finalizationScenarioContext,
    finalizationArtifactState: session.finalizationArtifactState,
    userVoteIndex: session.userVoteIndex,
    bulletinRootHistory: session.bulletinRootHistory,
  };
}

export function deserializeSession(data: SerializableSessionData): SessionData {
  const bulletin = data.logId ? new SimpleBulletinBoard(data.logId) : undefined;

  // Restore votes map
  const votesMap = new Map<number, VoteData>(
    data.votes.map(([index, vote]) => [
      index,
      {
        ...vote,
        path: Array.isArray(vote.path) ? [...vote.path] : [],
      },
    ]),
  );

  // Rebuild bulletin state from votes
  const sortedVotes = Array.from(votesMap.entries()).sort((a, b) => a[0] - b[0]);
  for (const [, vote] of sortedVotes) {
    if (bulletin && vote.voteId) {
      const commitmentHex = vote.commit.slice(2);
      bulletin.appendVote(vote.voteId, commitmentHex);
    }
  }

  const { finalizationResult, finalizationArtifactState } = deserializeFinalizationResult(data);
  const canonicalProjection = buildCanonicalCtSessionProjection(
    {
      sessionId: data.sessionId,
      votes: votesMap,
      logId: data.logId,
      bulletin,
      bulletinRootHistory: data.bulletinRootHistory,
      userVoteIndex: data.userVoteIndex,
    },
    'FileMockSessionStore',
  );

  if (data.botCount !== canonicalProjection.botCount) {
    logger.warn('[FileMockStore] Reconciled stale botCount from persisted votes', {
      sessionId: data.sessionId,
      persistedBotCount: data.botCount,
      derivedBotCount: canonicalProjection.botCount,
    });
  }

  if (data.userVoteIndex !== canonicalProjection.userVoteIndex) {
    logger.warn('[FileMockStore] Reconciled stale userVoteIndex from persisted votes', {
      sessionId: data.sessionId,
      persistedUserVoteIndex: data.userVoteIndex,
      derivedUserVoteIndex: canonicalProjection.userVoteIndex,
    });
  }

  const session: SessionData = {
    ...data,
    finalizationResult,
    finalizationArtifactState,
    votes: votesMap,
    bulletin,
  };
  applyCanonicalCtSessionProjection(session, canonicalProjection);

  return session;
}
