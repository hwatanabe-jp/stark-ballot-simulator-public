import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { BOT_COUNT, VOTE_CHOICES } from '@stark-ballot/domain/shared/constants';
import type { VoteReceipt } from '@stark-ballot/domain/types/receipt';
import type { SessionData, VoteData } from '@stark-ballot/domain/types/server';
import type { SessionStoreUpdate } from '@stark-ballot/domain/types/voteStore';
import type { ApiContext } from '../context';
import { errorResponse, jsonResponse } from '../../http/response';
import { handleApiErrorPayload } from '@stark-ballot/api-contract/errors/errorPayload';
import {
  allowInsecureZkvmInProduction,
  isProductionEnv,
  resolveZkvmMode,
} from '@stark-ballot/node-adapters/zkvm/zkvm-mode';
import { getDefaultElectionConfigHash } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { createElectionId } from '@stark-ballot/zkvm-contract/zkvm/types';
import { generateLogId } from '@stark-ballot/zkvm-contract/zkvm/log-id';
import { VerifyResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import type { BitmapProofResponse } from '@stark-ballot/api-contract/types/api/bitmap-proof';
import { respondWithSchema } from '../utils/responseSchema';
import { buildVerificationSteps } from '@stark-ballot/verification/steps';
import {
  buildVerificationChecksFromResults,
  evaluateVerificationCheckResults,
  type BuildVerificationChecksInput,
} from '@stark-ballot/verification/check-results';
import type { BitmapProofRequest } from '@stark-ballot/verification/bitmap-verifier';
import type { VerificationPublicInputAuthority } from '@stark-ballot/verification/engine-types';
import { normalizeHexString } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';
import type { VerificationCheck } from '@stark-ballot/verification/checks';
import { validateSessionWithCapability } from '../middleware/session';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { resolveNodeSthPublicRuntimeConfig } from '@stark-ballot/runtime-config/env/nodeSthPublicRuntimeConfig';
import { sanitizeVerificationReportForPublicResponse } from '@stark-ballot/verification/public-result';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { SupportedPublicInputArtifact } from '@stark-ballot/verification/public-input';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import { buildFailClosedVerifyResponse, resolveSupportedFinalizedRead } from '../utils/currentArtifactAdmission';
import { projectFinalizationResultForPublicResponse } from '../utils/finalizationResultProjection';
import { resolveSthVerificationFromProviders } from '../adapters/sthProvider';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { resolveBitmapProofResponse } from './bitmapProof';
import type { AwsPersistedFinalizationResult } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import type { FinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-store';

type BitmapReadableVoteStore = VoteStore & {
  getBitmapData?: (sessionId: string) => Promise<FinalizationBitmapData | null>;
};

function asVerificationResult(value: unknown): VerificationResult | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const status = (value as { status?: unknown }).status;
  return status === 'success' ||
    status === 'failed' ||
    status === 'dev_mode' ||
    status === 'not_run' ||
    status === 'running'
    ? (value as VerificationResult)
    : undefined;
}

/**
 * Return verification data for a finalized session.
 */
export async function getVerifyHandler({ request, store }: ApiContext): Promise<Response> {
  try {
    const debugEnabled = process.env['DEBUG_FILE_STORE'] === '1';
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

    const sessionUpdates: SessionStoreUpdate = {};
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
    const projectedFinalizationResult = projectFinalizationResultForPublicResponse(finalizationResult);
    const { tally, imageId, scenarios = [], tamperDetected, journal } = finalizationResult;
    const verificationResult = asVerificationResult(finalizationResult.verificationResult);

    const verificationStatus = verificationResult?.status;
    const zkvmMode = resolveZkvmMode();
    const allowDevModeVerification =
      verificationStatus === 'dev_mode' &&
      (!isProductionEnv() || allowInsecureZkvmInProduction()) &&
      (process.env['ALLOW_DEV_MODE_VERIFICATION'] === 'true' || zkvmMode.insecure);

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
      ...omitUndefinedProperties({ voteId: exactUserVoteArtifacts.voteId }),
      ...omitUndefinedProperties({ proof: exactUserVoteArtifacts.proof }),
    };

    const verifiedTallyForChecks = projectedFinalizationResult.verifiedTally;
    // Ensure verifiedTally is always a number[] in [A, B, C, D, E] order (response compatibility)
    // Use explicit mapping instead of Object.values to guarantee order.
    // If verifiedTally is missing, do not substitute claimed counts.
    const verifiedTallyArray: number[] = Array.isArray(verifiedTallyForChecks)
      ? VOTE_CHOICES.map((_, index) =>
          Number.isFinite(verifiedTallyForChecks[index]) ? (verifiedTallyForChecks[index] ?? 0) : 0,
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
      ...omitUndefinedProperties({ executionId: finalizationResult.verificationExecutionId }),
      ...omitUndefinedProperties({ bundleKey: finalizationResult.s3BundleKey }),
      bulletinRoot: bulletinRootRaw,
      treeSize: resolvedTreeSize,
    });
    const electionManifest = finalizationResult.electionManifest;
    const closeStatement = finalizationResult.closeStatement;
    const bitmapProofEndpoint = new URL('/api/bitmap-proof', request.url).toString();
    const sthPublicRuntimeConfig = resolveNodeSthPublicRuntimeConfig();
    const sthVerification =
      sthPublicRuntimeConfig.sources.length > 0
        ? await resolveSthVerificationFromProviders({
            sources: sthPublicRuntimeConfig.sources,
            journal: {
              sthDigest: projectedFinalizationResult.sthDigest,
              bulletinRoot: bulletinRootRaw,
              treeSize: resolvedTreeSize,
            },
            minMatchingSources: sthPublicRuntimeConfig.minMatchingSources,
            sameOriginOrigin: new URL(request.url).origin,
            sameOriginHeaders: sessionAuthHeaders,
            sameOriginProvider: createSameOriginSthProvider({
              finalizationResult,
              session,
            }),
          })
        : undefined;

    const verificationChecksBaseInput = {
      electionId: journal.electionId,
      electionConfigHash: publicInputAuthority?.electionConfigHash ?? journal.electionConfigHash,
      logId: publicInputAuthority?.logId ?? session.logId,
      ...omitUndefinedProperties({ voteReceipt }),
      userVote: verificationUserVote,
      journal,
      ...omitUndefinedProperties({ electionManifest }),
      ...omitUndefinedProperties({ closeStatement }),
      sthDigest: projectedFinalizationResult.sthDigest,
      sthSources: sthPublicRuntimeConfig.sources,
      sthMinMatchingSources: sthPublicRuntimeConfig.minMatchingSources,
      sthBaseUrl: new URL(request.url).origin,
      ...omitUndefinedProperties({ sthVerification }),
      ...omitUndefinedProperties({ missingSlots: projectedFinalizationResult.missingSlots }),
      ...omitUndefinedProperties({ invalidPresentedSlots: projectedFinalizationResult.invalidPresentedSlots }),
      ...omitUndefinedProperties({ rejectedRecords: projectedFinalizationResult.rejectedRecords }),
      ...omitUndefinedProperties({ excludedSlots: projectedFinalizationResult.excludedSlots }),
      bulletinRoot: bulletinRootRaw,
      treeSize: resolvedTreeSize,
      tally: {
        counts: tallyCounts,
        totalVotes: tallyTotalVotes,
      },
      ...omitUndefinedProperties({ verifiedTally: verifiedTallyForChecks }),
      ...omitUndefinedProperties({ totalExpected: resolvedTotalExpected }),
      ...omitUndefinedProperties({ inputCommitment }),
      ...omitUndefinedProperties({ publicInputAuthority }),
      ...omitUndefinedProperties({ seenBitmapRoot: projectedFinalizationResult.seenBitmapRoot }),
      ...omitUndefinedProperties({ includedBitmapRoot: projectedFinalizationResult.includedBitmapRoot }),
      claimedImageId: imageId,
      ...omitUndefinedProperties({ comparisonImageId: journal.imageId }),
      ...omitUndefinedProperties({ bitmapProofSource: finalizationResult.bitmapProofSource }),
      bitmapProofEndpoint,
      bitmapProofProvider: createBitmapProofProvider({
        store,
        sessionId,
        finalizationResult,
      }),
      allowDevModeVerification,
      ...omitUndefinedProperties({ bulletin: session.bulletin }),
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
    const effectiveExecutionId = resolveVerificationExecutionId(finalizationResult);

    const scenarioIdCandidate = scenarios.length > 0 ? (scenarios[0] ?? 'S0') : 'S0';
    const allowedScenarioIds = new Set(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
    const scenarioId = allowedScenarioIds.has(scenarioIdCandidate) ? scenarioIdCandidate : 'S0';
    const bulletinRoot = ensureHex64(bulletinRootRaw);
    const voteReceiptPayload = voteReceipt
      ? {
          ...omitUndefinedProperties({ voteId: voteReceipt.voteId }),
          commitment: ensureHex64(voteReceipt.commitment),
          bulletinIndex: voteReceipt.bulletinIndex,
          bulletinRootAtCast: ensureHex64(voteReceipt.bulletinRootAtCast),
          timestamp: voteReceipt.timestamp,
          ...(inputCommitment ? { inputCommitment: ensureHex64(inputCommitment) } : {}),
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
      ...omitUndefinedProperties({ voteReceipt }),
      ...omitUndefinedProperties({ verificationReportStatus: presentationVerificationReportStatus }),
      ...omitUndefinedProperties({ verificationReport: effectiveVerificationResult?.report }),
      allowDevModeVerification,
    });
    const { verificationSteps, verificationChecks } = verificationPresentation;
    logVerificationFailures(verificationChecks);

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
      verificationStatus: presentationVerificationStatus,
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

function createBitmapProofProvider(options: {
  store: VoteStore;
  sessionId: string;
  finalizationResult: AwsPersistedFinalizationResult;
}): (request: BitmapProofRequest) => Promise<BitmapProofResponse> {
  return (request) => resolveBitmapProofForSession(options, request);
}

async function resolveBitmapProofForSession(
  options: {
    store: VoteStore;
    sessionId: string;
    finalizationResult: AwsPersistedFinalizationResult;
  },
  request: BitmapProofRequest,
): Promise<BitmapProofResponse> {
  const bitmapStore = options.store as BitmapReadableVoteStore;
  const bitmapData = bitmapStore.getBitmapData ? await bitmapStore.getBitmapData(options.sessionId) : null;
  if (!bitmapData) {
    throw new Error('Bitmap data not found. Ensure finalization has completed.');
  }
  const resolution = resolveBitmapProofResponse({
    bitmapData,
    finalizationResult: options.finalizationResult,
    index: request.bitIndex,
    kind: request.kind,
  });
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }
  return resolution.response;
}

function createSameOriginSthProvider(options: {
  finalizationResult: AwsPersistedFinalizationResult;
  session: SessionData;
}): (source: string) => unknown {
  return (source: string): unknown => {
    const sourcePath = resolveSameOriginSourcePath(source);
    if (sourcePath !== '/api/sth') {
      return undefined;
    }

    return {
      sth: {
        sthDigest: options.finalizationResult.journal.sthDigest,
        bulletinRoot: options.finalizationResult.journal.bulletinRoot,
        treeSize: options.finalizationResult.journal.treeSize,
        timestamp: options.session.lastActivity,
        logId: options.session.logId ?? '',
      },
    };
  };
}

function resolveSameOriginSourcePath(source: string): string | null {
  try {
    return new URL(source, 'https://same-origin.local').pathname;
  } catch {
    return null;
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
    ...omitUndefinedProperties({ voteId: userVote.voteId }),
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
          ...omitUndefinedProperties({ voteId: userVote.voteId }),
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
    ...omitUndefinedProperties({ voteId: voteId }),
    commitment,
    bulletinIndex: exactVoteProof.leafIndex,
    bulletinRootAtCast: exactVoteProof.bulletinRootAtCast,
    timestamp: exactVoteProof.voteData.timestamp ?? userVote.timestamp ?? session.createdAt,
    ...(inputCommitment ? { inputCommitment } : {}),
  };

  return {
    commitment,
    ...omitUndefinedProperties({ voteId: voteId }),
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
  artifact: SupportedPublicInputArtifact | undefined,
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

function resolveVerificationExecutionId(finalizationResult: unknown): string | undefined {
  const executionId =
    finalizationResult && typeof finalizationResult === 'object'
      ? (finalizationResult as { verificationExecutionId?: unknown }).verificationExecutionId
      : undefined;
  if (typeof executionId === 'string' && isSafeBundleSegment(executionId)) {
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
