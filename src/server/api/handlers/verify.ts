import { ErrorCode } from '@/lib/errors/apiErrors';
import { BOT_COUNT, VOTE_CHOICES } from '@/shared/constants';
import type { VoteReceipt } from '@/types/receipt';
import type { SessionData, VoteData } from '@/types/server';
import type { ApiContext } from '@/server/api/context';
import { errorResponse, jsonResponse } from '@/server/http/response';
import { handleApiErrorPayload } from '@/lib/errors/errorPayload';
import { allowInsecureZkvmInProduction, isProductionEnv, resolveZkvmMode } from '@/lib/zkvm/zkvm-mode';
import { getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { createElectionId } from '@/lib/zkvm/types';
import { generateLogId } from '@/lib/zkvm/log-id';
import { VerifyResponseSchema } from '@/lib/validation/apiSchemas';
import { respondWithSchema } from '@/server/api/utils/responseSchema';
import { buildVerificationSteps } from '@/lib/verification/build-verification-steps';
import {
  buildVerificationChecksFromResults,
  evaluateVerificationCheckResults,
  type BuildVerificationChecksInput,
} from '@/lib/verification/build-verification-checks';
import type { VerificationPublicInputAuthority } from '@/lib/verification/engine/types';
import { normalizeHexString } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';
import type { VerificationCheck } from '@/lib/verification/verification-checks';
import { validateSessionWithCapability } from '@/server/api/middleware/session';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@/lib/session/capability';
import { projectFinalizationResultForPublicResponse } from '@/lib/finalize/finalization-result';
import { deriveVerificationSummary } from '@/lib/verification/verification-summary';
import { resolveConfiguredSthSources } from '@/lib/verification/sth-verifier';
import { sanitizeVerificationReportForPublicResponse } from '@/lib/verification/public-verification-result';
import type { VoteStore } from '@/types/voteStore';
import {
  buildFailClosedVerifyResponse,
  resolveSupportedFinalizedRead,
} from '@/server/api/utils/currentArtifactAdmission';

/**
 * Return verification data for a finalized session.
 */
export async function getVerifyHandler({ request, store }: ApiContext): Promise<Response> {
  try {
    const debugEnabled = process.env.DEBUG_FILE_STORE === '1';
    const sessionResult = await validateSessionWithCapability(request.headers, store, { updateActivity: false });
    if (sessionResult instanceof Response) {
      return sessionResult;
    }
    const { sessionId, session } = sessionResult;
    const sessionCapability = request.headers.get(SESSION_CAPABILITY_HEADER);
    const sessionAuthHeaders: Record<string, string> = {
      [SESSION_ID_HEADER]: sessionId,
    };
    if (sessionCapability) {
      sessionAuthHeaders[SESSION_CAPABILITY_HEADER] = sessionCapability;
    }

    const url = new URL(request.url);
    const includeJournal = url.searchParams.get('includeJournal') === '1';

    if (debugEnabled) {
      logger.debug('[API][verify][DEBUG] Request started', {
        sessionId,
        timestamp: new Date().toISOString(),
      });
    }

    if (debugEnabled) {
      logger.debug('[API][verify][DEBUG] Session retrieved', {
        sessionId,
        finalized: session.finalized,
        hasFinalizationResult: !!session.finalizationResult,
        hasFinalizationState: !!session.finalizationState,
        votesCount: session.votes.size,
        userVoteIndex: session.userVoteIndex,
      });
    }

    // Check if session is finalized
    if (!session.finalized) {
      return errorResponse(ErrorCode.SESSION_NOT_FINALIZED);
    }

    const finalizedRead = resolveSupportedFinalizedRead(session);
    if (finalizedRead.artifactState) {
      return buildFailClosedVerifyResponse(finalizedRead.artifactState);
    }

    const sessionUpdates: Partial<SessionData> = {};
    if (!session.electionId) {
      session.electionId = createElectionId();
      sessionUpdates.electionId = session.electionId;
    }
    if (!session.electionConfigHash) {
      session.electionConfigHash = getDefaultElectionConfigHash();
      sessionUpdates.electionConfigHash = session.electionConfigHash;
    }
    if (!session.logId) {
      session.logId = generateLogId(`legacy-${sessionId}`);
      sessionUpdates.logId = session.logId;
    }
    if (Object.keys(sessionUpdates).length > 0) {
      await store.updateSession(sessionId, sessionUpdates);
    }

    // Check if user has voted
    if (session.userVoteIndex === undefined) {
      return errorResponse(ErrorCode.USER_NOT_VOTED);
    }

    // Get user vote data
    const userVote = session.votes.get(session.userVoteIndex);
    if (!userVote) {
      return errorResponse(ErrorCode.INTERNAL_ERROR, {
        details: 'User vote data not found',
      });
    }

    const finalizationResult = finalizedRead.finalizationResult;
    if (!finalizationResult) {
      return buildFailClosedVerifyResponse('corrupt_or_unreadable');
    }
    session.finalizationResult = finalizationResult;
    const projectedFinalizationResult = projectFinalizationResultForPublicResponse(finalizationResult);
    const { tally, imageId, scenarios = [], tamperDetected, journal, verificationResult } = finalizationResult;

    const verificationStatus = verificationResult?.status;
    const zkvmMode = resolveZkvmMode();
    const allowDevModeVerification =
      verificationStatus === 'dev_mode' &&
      (!isProductionEnv() || allowInsecureZkvmInProduction()) &&
      (process.env.ALLOW_DEV_MODE_VERIFICATION === 'true' || zkvmMode.insecure);

    const bulletinRootRaw = journal.bulletinRoot;
    const exactUserVoteArtifacts = await resolveExactRecordedVoteArtifacts({
      store,
      sessionId,
      session,
      userVote,
      inputCommitment: journal.inputCommitment,
      debugEnabled,
    });
    const voteReceipt = exactUserVoteArtifacts.voteReceipt;

    const excludedSlots = projectedFinalizationResult.excludedSlots;

    const verificationUserVote = {
      commitment: exactUserVoteArtifacts.commitment,
      voteId: exactUserVoteArtifacts.voteId,
      proof: exactUserVoteArtifacts.proof,
    };

    const verifiedTallyForChecks = projectedFinalizationResult.verifiedTally;
    // Ensure verifiedTally is always a number[] in [A, B, C, D, E] order (response compatibility)
    // Use explicit mapping instead of Object.values to guarantee order.
    // If verifiedTally is missing, do not substitute claimed counts.
    const verifiedTallyArray: number[] = Array.isArray(verifiedTallyForChecks)
      ? VOTE_CHOICES.map((_, index) =>
          Number.isFinite(verifiedTallyForChecks[index]) ? verifiedTallyForChecks[index] : 0,
        )
      : VOTE_CHOICES.map(() => 0);
    const tallyCounts = VOTE_CHOICES.reduce(
      (acc, choice) => {
        acc[choice] = tally.counts[choice];
        return acc;
      },
      {} as Record<(typeof VOTE_CHOICES)[number], number>,
    );
    const tallyTotalVotes =
      typeof tally.totalVotes === 'number'
        ? tally.totalVotes
        : Object.values(tallyCounts).reduce((sum, v) => sum + v, 0);
    const resolvedTreeSize = projectedFinalizationResult.treeSize;
    const resolvedTotalExpected = projectedFinalizationResult.totalExpected;
    const inputCommitment = projectedFinalizationResult.inputCommitment;
    const publicInputAuthority = resolvePublicInputAuthority(finalizationResult.publicInputArtifact, {
      executionId: finalizationResult.verificationExecutionId,
      bundleKey: finalizationResult.s3BundleKey,
      bulletinRoot: bulletinRootRaw,
      treeSize: resolvedTreeSize,
    });
    const electionManifest = finalizationResult.electionManifest;
    const closeStatement = finalizationResult.closeStatement;
    const bitmapProofEndpoint = new URL('/api/bitmap-proof', request.url).toString();

    const verificationChecksBaseInput = {
      electionId: journal.electionId,
      electionConfigHash: publicInputAuthority?.electionConfigHash ?? journal.electionConfigHash,
      logId: publicInputAuthority?.logId ?? session.logId,
      voteReceipt,
      userVote: verificationUserVote,
      journal,
      electionManifest,
      closeStatement,
      sthDigest: projectedFinalizationResult.sthDigest,
      sthBaseUrl: new URL(request.url).origin,
      missingSlots: projectedFinalizationResult.missingSlots,
      invalidPresentedSlots: projectedFinalizationResult.invalidPresentedSlots,
      rejectedRecords: projectedFinalizationResult.rejectedRecords,
      excludedSlots: projectedFinalizationResult.excludedSlots,
      bulletinRoot: bulletinRootRaw,
      treeSize: resolvedTreeSize,
      tally: {
        counts: tallyCounts,
        totalVotes: tallyTotalVotes,
      },
      verifiedTally: verifiedTallyForChecks,
      totalExpected: resolvedTotalExpected,
      inputCommitment,
      publicInputAuthority,
      seenBitmapRoot: projectedFinalizationResult.seenBitmapRoot,
      includedBitmapRoot: projectedFinalizationResult.includedBitmapRoot,
      claimedImageId: imageId,
      comparisonImageId: journal.imageId,
      bitmapProofSource: finalizationResult.bitmapProofSource,
      bitmapProofEndpoint,
      allowDevModeVerification,
      bulletin: session.bulletin,
      sessionId,
      sessionAuthHeaders,
    };
    const allowedStatuses = new Set(['success', 'failed', 'not_run', 'running']);
    const forceFailClosedVerification =
      verificationResult && verificationStatus && !allowedStatuses.has(verificationStatus) && !allowDevModeVerification;

    const scenarioTamperCount =
      (finalizationResult.tamperSummary?.ignoredVotes ?? 0) + (finalizationResult.tamperSummary?.recountedVotes ?? 0);
    const tamperDetectedBool: boolean = Boolean(tamperDetected);
    const effectiveTamperDetected = tamperDetectedBool || excludedSlots > 0 || scenarioTamperCount > 0;

    if (excludedSlots > 0 && debugEnabled) {
      logger.debug('[API][verify][DEBUG] Tamper detected in verification payload', {
        sessionId,
        excludedSlots,
        missingSlots: projectedFinalizationResult.missingSlots,
        invalidPresentedSlots: projectedFinalizationResult.invalidPresentedSlots,
      });
    }

    const effectiveVerificationResult = verificationResult;

    // Prepare response data (STARK verification status only).
    // The overall user-facing verdict is derived from verification checks + summary,
    // so missing evidence can still downgrade the page while this remains "success".
    const computedVerificationStatus = effectiveVerificationResult?.status ?? verificationStatus ?? 'not_run';
    const presentationVerificationStatus = forceFailClosedVerification ? 'failed' : computedVerificationStatus;
    const presentationVerificationReportStatus = forceFailClosedVerification
      ? 'failed'
      : effectiveVerificationResult?.report?.status;
    const refreshedFinalizationResult = session.finalizationResult ?? finalizationResult;
    const effectiveExecutionId = resolveVerificationExecutionId(refreshedFinalizationResult);

    const scenarioIdCandidate = scenarios.length > 0 ? scenarios[0] : 'S0';
    const allowedScenarioIds = new Set(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
    const scenarioId = allowedScenarioIds.has(scenarioIdCandidate) ? scenarioIdCandidate : 'S0';
    const bulletinRoot = ensureHex64(bulletinRootRaw);
    const voteReceiptPayload = voteReceipt
      ? {
          voteId: voteReceipt.voteId,
          commitment: ensureHex64(voteReceipt.commitment),
          bulletinIndex: voteReceipt.bulletinIndex,
          bulletinRootAtCast: ensureHex64(voteReceipt.bulletinRootAtCast),
          timestamp: voteReceipt.timestamp,
          inputCommitment: inputCommitment ? ensureHex64(inputCommitment) : undefined,
        }
      : undefined;

    const userProofPayload = exactUserVoteArtifacts.proof
      ? {
          leafIndex: exactUserVoteArtifacts.proof.leafIndex,
          treeSize: exactUserVoteArtifacts.proof.treeSize,
          merklePath: exactUserVoteArtifacts.proof.merklePath,
          bulletinRootAtCast: ensureHex64(exactUserVoteArtifacts.proof.bulletinRootAtCast),
        }
      : undefined;

    const userVotePayload = {
      commitment: ensureHex64(exactUserVoteArtifacts.commitment),
      ...(exactUserVoteArtifacts.voteId ? { voteId: exactUserVoteArtifacts.voteId } : {}),
      ...(userProofPayload ? { proof: userProofPayload } : {}),
    };

    const journalStatus = includeJournal ? 'available' : 'omitted';
    const journalPayload = includeJournal ? journal : undefined;
    const tamperSummary = finalizationResult.tamperSummary;
    const affectedBotIds =
      tamperSummary && Array.isArray(tamperSummary.affectedBotIds) ? tamperSummary.affectedBotIds : undefined;
    const botVotesSummary =
      (scenarioId === 'S3' || scenarioId === 'S4') && affectedBotIds && affectedBotIds.length > 0
        ? { total: BOT_COUNT, affectedBotIds, source: 'scenario_simulation' }
        : undefined;

    const verificationPresentation = await buildVerificationPresentation({
      ...verificationChecksBaseInput,
      castSource: 'client',
      verificationStatus: presentationVerificationStatus,
      verificationReportStatus: presentationVerificationReportStatus,
      verificationReport: effectiveVerificationResult?.report,
      allowDevModeVerification,
    });
    const { verificationSteps, verificationChecks } = verificationPresentation;
    const summary = deriveVerificationSummary(verificationChecks, {
      missingSlots: projectedFinalizationResult.missingSlots,
      invalidPresentedSlots: projectedFinalizationResult.invalidPresentedSlots,
      excludedSlots: projectedFinalizationResult.excludedSlots,
      sthSourcesConfigured: resolveConfiguredSthSources().length > 0,
    });
    logVerificationFailures(verificationChecks);

    const responseVerificationStatus =
      presentationVerificationStatus === 'success' && summary?.tone === 'failed'
        ? 'failed'
        : presentationVerificationStatus;

    const responseData = {
      electionId: journal.electionId,
      electionConfigHash: journal.electionConfigHash,
      logId: session.logId,
      tally: {
        counts: tallyCounts,
        totalVotes: tallyTotalVotes,
        tamperedCount: tally.tamperedCount || 0,
      },
      bulletinRoot,
      scenarioId,
      verificationStatus: responseVerificationStatus,
      verificationReport: sanitizeVerificationReportForPublicResponse(effectiveVerificationResult?.report),
      verificationSteps,
      verificationChecks,
      imageId: ensureHex64(imageId),
      tamperDetected: effectiveTamperDetected,
      verifiedTally: verifiedTallyArray,
      missingSlots: projectedFinalizationResult.missingSlots,
      invalidPresentedSlots: projectedFinalizationResult.invalidPresentedSlots,
      rejectedRecords: projectedFinalizationResult.rejectedRecords,
      totalExpected: resolvedTotalExpected,
      treeSize: resolvedTreeSize,
      excludedSlots,
      sthDigest: ensureHex64(projectedFinalizationResult.sthDigest),
      ...(projectedFinalizationResult.seenBitmapRoot
        ? { seenBitmapRoot: ensureHex64(projectedFinalizationResult.seenBitmapRoot) }
        : {}),
      includedBitmapRoot: ensureHex64(projectedFinalizationResult.includedBitmapRoot),
      inputCommitment: ensureHex64(inputCommitment),
      seenIndicesCount: projectedFinalizationResult.seenIndicesCount,
      journalStatus,
      journal: journalPayload,
      voteReceipt: voteReceiptPayload,
      userVote: userVotePayload,
      botVotesSummary,
      verificationExecutionId: effectiveExecutionId,
      tamperSummary: finalizationResult.tamperSummary,
    };

    return respondWithSchema(
      VerifyResponseSchema,
      { data: responseData },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (error) {
    const payload = handleApiErrorPayload(error);
    return jsonResponse(payload, { status: payload.statusCode });
  }
}

function logVerificationFailures(checks: VerificationCheck[]): void {
  const failed = checks.filter((check) => check.status === 'failed');
  if (failed.length === 0) {
    return;
  }

  for (const check of failed) {
    const [stage] = check.id.split('_');
    logger.warn('verification check failed', {
      event: 'verification_failed',
      verification: {
        stage,
        check_id: check.id,
        reason: check.noteKey ?? 'failed',
      },
    });
  }
}

function ensureHex64(value: string | undefined | null): string {
  if (!value) {
    return '0x' + '0'.repeat(64);
  }
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  return `0x${clean.padStart(64, '0').toLowerCase()}`;
}

type ExactRecordedVoteArtifacts = {
  commitment: string;
  voteId?: string;
  voteReceipt?: VoteReceipt;
  proof?: {
    leafIndex: number;
    treeSize: number;
    merklePath: string[];
    bulletinRootAtCast: string;
  };
};

async function resolveExactRecordedVoteArtifacts(params: {
  store: VoteStore;
  sessionId: string;
  session: SessionData;
  userVote: VoteData;
  inputCommitment?: string;
  debugEnabled: boolean;
}): Promise<ExactRecordedVoteArtifacts> {
  const { store, sessionId, session, userVote, inputCommitment, debugEnabled } = params;
  const fallback: ExactRecordedVoteArtifacts = {
    commitment: userVote.commit,
    voteId: userVote.voteId,
  };

  if (!userVote.voteId) {
    return fallback;
  }

  let exactVoteProof;
  try {
    exactVoteProof = await store.getVoteByIdWithProof(sessionId, userVote.voteId);
  } catch (error) {
    if (error instanceof Error && error.message === 'CT_PROOF_UNAVAILABLE') {
      if (debugEnabled) {
        logger.debug('[API][verify][DEBUG] Exact CT proof unavailable for user vote', {
          sessionId,
          voteId: userVote.voteId,
        });
      }
      return fallback;
    }
    throw error;
  }

  if (!exactVoteProof) {
    return fallback;
  }

  const voteId = exactVoteProof.voteData.voteId ?? userVote.voteId;
  const commitment = exactVoteProof.voteData.commit || userVote.commit;
  const voteReceipt: VoteReceipt = {
    voteId,
    commitment,
    bulletinIndex: exactVoteProof.leafIndex,
    bulletinRootAtCast: exactVoteProof.bulletinRootAtCast,
    timestamp: exactVoteProof.voteData.timestamp ?? userVote.timestamp ?? session.createdAt,
    ...(inputCommitment ? { inputCommitment } : {}),
  };

  return {
    commitment,
    voteId,
    voteReceipt,
    proof: {
      leafIndex: exactVoteProof.leafIndex,
      treeSize: exactVoteProof.treeSize,
      merklePath: exactVoteProof.merklePath,
      bulletinRootAtCast: exactVoteProof.bulletinRootAtCast,
    },
  };
}

function resolvePublicInputAuthority(
  artifact: NonNullable<NonNullable<SessionData['finalizationResult']>['publicInputArtifact']> | undefined,
  options: {
    executionId?: string;
    bundleKey?: string;
    bulletinRoot?: string;
    treeSize?: number;
  },
): VerificationPublicInputAuthority | undefined {
  if (!artifact) {
    return undefined;
  }

  const { executionId, bundleKey, bulletinRoot, treeSize } = options;
  const { provenance, typedAuthority } = artifact;

  if (executionId) {
    if (!provenance.executionId || provenance.executionId !== executionId) {
      return undefined;
    }
  }

  if (bundleKey) {
    if (!provenance.bundleKey || provenance.bundleKey !== bundleKey) {
      return undefined;
    }
  }

  if (bulletinRoot && normalizeHexString(typedAuthority.bulletinRoot) !== normalizeHexString(bulletinRoot)) {
    return undefined;
  }
  if (typeof treeSize === 'number' && typedAuthority.treeSize !== treeSize) {
    return undefined;
  }

  return {
    ...typedAuthority,
    source: provenance.source,
    ...(provenance.executionId ? { executionId: provenance.executionId } : {}),
    ...(provenance.bundleKey ? { bundleKey: provenance.bundleKey } : {}),
  };
}

function isSafeBundleSegment(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value);
}

function resolveVerificationExecutionId(
  finalizationResult: NonNullable<SessionData['finalizationResult']>,
): string | undefined {
  const executionId = finalizationResult.verificationExecutionId;
  if (executionId && isSafeBundleSegment(executionId)) {
    return executionId;
  }
  return undefined;
}

async function buildVerificationPresentation(input: BuildVerificationChecksInput): Promise<{
  verificationSteps: Awaited<ReturnType<typeof buildVerificationSteps>>;
  verificationChecks: ReturnType<typeof buildVerificationChecksFromResults>;
}> {
  const checkResults = await evaluateVerificationCheckResults(input);
  const verificationSteps = await buildVerificationSteps({
    ...input,
    checkResults,
  });
  const verificationChecks = buildVerificationChecksFromResults(input, checkResults);

  return {
    verificationSteps,
    verificationChecks,
  };
}
