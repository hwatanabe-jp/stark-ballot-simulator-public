import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import {
  classifyFinalizedArtifactContract,
  isCurrentContractGeneration,
  isFailClosedCurrentArtifactState,
} from '@stark-ballot/domain/contract';
import type { SessionData, VoteData } from '@stark-ballot/domain/types/server';
import { parseFinalizationState } from '@stark-ballot/application/finalize/finalization-storage';
import {
  admitAwsPersistedFinalizationResultBranch,
  admitAwsPersistedFinalizationStateBranch,
  parseAwsPersistedFinalizationResult,
  parseAwsFinalizationRuntimeState,
  type AwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import {
  applyCanonicalCtSessionProjection,
  buildCanonicalCtSessionProjection,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { logger } from '@stark-ballot/diagnostics/logger';
import type { SerializableSessionData } from './types';

function serializeFinalizationResult(
  result: SessionData['finalizationResult'],
): AwsPersistedFinalizationResult | undefined {
  const authority = parseAwsPersistedFinalizationResult(result);
  if (!authority?.journal) {
    return undefined;
  }

  return {
    tally: authority.tally,
    ...(authority.s3BundleKey ? { s3BundleKey: authority.s3BundleKey } : {}),
    ...(authority.s3UploadedAt ? { s3UploadedAt: authority.s3UploadedAt } : {}),
    ...(authority.receiptPublication ? { receiptPublication: authority.receiptPublication } : {}),
    imageId: authority.imageId,
    ...(authority.tamperDetected !== undefined ? { tamperDetected: authority.tamperDetected } : {}),
    ...(authority.scenarios ? { scenarios: authority.scenarios } : {}),
    journal: authority.journal,
    ...(authority.publicInputArtifact ? { publicInputArtifact: authority.publicInputArtifact } : {}),
    ...(authority.electionManifest ? { electionManifest: authority.electionManifest } : {}),
    ...(authority.closeStatement ? { closeStatement: authority.closeStatement } : {}),
    ...(authority.bitmapProofSource ? { bitmapProofSource: authority.bitmapProofSource } : {}),
    ...(authority.bitmapData ? { bitmapData: authority.bitmapData } : {}),
    ...(authority.verificationResult ? { verificationResult: authority.verificationResult } : {}),
    ...(authority.verificationExecutionId ? { verificationExecutionId: authority.verificationExecutionId } : {}),
    ...(authority.tamperSummary ? { tamperSummary: authority.tamperSummary } : {}),
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
  finalizationResult: SessionData['finalizationResult'];
  finalizationArtifactState: SessionData['finalizationArtifactState'] | undefined;
} {
  const persistedArtifactState = isFailClosedCurrentArtifactState(data.finalizationArtifactState)
    ? data.finalizationArtifactState
    : undefined;
  const authority = data.finalizationResult ? parseAwsPersistedFinalizationResult(data.finalizationResult) : undefined;
  const hasPersistedFinalizationResult = data.finalizationResult !== undefined;
  const hasPersistedNonResultPayload =
    data.finalizationState !== undefined || data.finalizationScenarioContext !== undefined;
  const hasPersistedFinalizationBranch =
    hasPersistedFinalizationResult || hasPersistedNonResultPayload || data.finalized;
  const resolvedArtifactState = classifyFinalizedArtifactContract(
    omitUndefinedProperties({
      finalized: data.finalized,
      hasPersistedFinalizationBranch,
      payloadReadable: hasPersistedFinalizationResult
        ? authority !== undefined
        : hasPersistedFinalizationBranch
          ? hasPersistedNonResultPayload || !data.finalized
          : !data.finalized,
      persistedContractGeneration: data.finalizationContractGeneration,
      hasAuthoritativeFinalizationResult: data.finalized ? authority !== undefined : undefined,
    }),
  );
  let finalizationArtifactState =
    persistedArtifactState ??
    (resolvedArtifactState && resolvedArtifactState !== 'supported' ? resolvedArtifactState : undefined);
  if (
    finalizationArtifactState === undefined &&
    data.finalized &&
    isCurrentContractGeneration(data.finalizationContractGeneration) &&
    authority === undefined
  ) {
    finalizationArtifactState = 'corrupt_or_unreadable';
  }
  const canProjectCurrentFinalization = persistedArtifactState === undefined && resolvedArtifactState === 'supported';

  return {
    finalizationResult:
      canProjectCurrentFinalization && authority ? admitAwsPersistedFinalizationResultBranch(authority) : undefined,
    finalizationArtifactState,
  };
}

export function serializeSession(session: SessionData): SerializableSessionData {
  return omitUndefinedProperties({
    sessionId: session.sessionId,
    contractGeneration: session.contractGeneration,
    finalizationContractGeneration: session.finalizationContractGeneration,
    electionId: session.electionId,
    electionConfigHash: session.electionConfigHash,
    electionConfig: session.electionConfig,
    logId: session.logId,
    votes: Array.from(session.votes.entries()).map(([index, vote]): [number, VoteData] => [
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
    finalizationState:
      parseAwsFinalizationRuntimeState(session.finalizationState) ?? parseFinalizationState(session.finalizationState),
    finalizationScenarioContext: session.finalizationScenarioContext,
    finalizationArtifactState: session.finalizationArtifactState,
    userVoteIndex: session.userVoteIndex,
    bulletinRootHistory: session.bulletinRootHistory,
  });
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
  const finalizationState =
    parseAwsFinalizationRuntimeState(data.finalizationState) ?? parseFinalizationState(data.finalizationState);
  const canonicalProjection = buildCanonicalCtSessionProjection(
    omitUndefinedProperties({
      sessionId: data.sessionId,
      ...omitUndefinedProperties({ votes: votesMap }),
      logId: data.logId,
      bulletin,
      bulletinRootHistory: data.bulletinRootHistory,
      userVoteIndex: data.userVoteIndex,
    }),
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

  const session: SessionData = omitUndefinedProperties({
    ...data,
    finalizationResult,
    finalizationState: finalizationState ? admitAwsPersistedFinalizationStateBranch(finalizationState) : undefined,
    finalizationArtifactState,
    ...omitUndefinedProperties({ votes: votesMap }),
    bulletin,
  });
  applyCanonicalCtSessionProjection(session, canonicalProjection);

  return session;
}
