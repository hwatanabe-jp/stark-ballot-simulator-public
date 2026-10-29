import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { normalizeHexString } from '@stark-ballot/crypto-primitives';
import { BOT_COUNT, VOTE_CHOICES } from '@stark-ballot/domain/shared/constants';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import type {
  ApiContextStore,
  ApiHandlerArguments,
  RouteBoundResponse,
  SessionFinalizationAdmittedContext,
} from '../context';
import { handleApiError } from '../../http/errorHandler';
import { verificationRoute } from '@stark-ballot/api-contract/routes';
import { availableVerificationResourceSchema } from '@stark-ballot/api-contract/schemas/verification';
import { admitRouteErrorResponse, respondWithRoute, respondWithRouteError } from '../utils/responseSchema';
import { buildVerificationSteps } from '@stark-ballot/verification/steps';
import {
  buildVerificationChecksFromResults,
  evaluateVerificationCheckResults,
  type BuildVerificationChecksInput,
} from '@stark-ballot/verification/check-results';
import { admitVerifierOutcome } from '@stark-ballot/verification/check-evaluator';
import type {
  VerificationOutcomeInput,
  VerificationPublicInputAuthority,
} from '@stark-ballot/verification/engine-types';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { VerificationCheck } from '@stark-ballot/verification/checks';
import { resolveNodeSthPublicRuntimeConfig } from '@stark-ballot/runtime-config/env/nodeSthPublicRuntimeConfig';
import { sanitizeVerificationReportForPublicResponse } from '@stark-ballot/verification/public-result';
import type { SupportedPublicInputArtifact } from '@stark-ballot/verification/public-input';
import { buildVerificationReadFailureResponse } from '../utils/verificationReadFailureResponse';
import { projectFinalizationResultForPublicResponse } from '../utils/finalizationResultProjection';
import { resolveSthVerificationFromProviders } from '../adapters/sthProvider';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { acquireBitmapProofEvidence, acquireConsistencyProofEvidence } from '../adapters/verificationEvidence';
import { projectSessionSthData } from './sth';
import {
  prepareVerificationRead,
  type VerificationReadPort,
  type AvailableVerificationVoterEvidence,
} from '@stark-ballot/application/verification/prepare-verification-read';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import {
  resolveFinalizationTamperDetected,
  resolveScenarioTamperCount,
} from '@stark-ballot/verification/finalization-tamper';
import { admitPersistedFinalizationBitmapData } from '@stark-ballot/application/finalize/finalization-bitmap-admission';
import type {
  VerificationFailureCategory,
  VerificationReport,
  VerificationStatus,
  VerificationResult,
} from '@stark-ballot/verification/shared/types';

const INCOHERENT_VERIFIER_OUTCOME = {
  status: 'failed',
  failureCategory: 'unknown',
} satisfies VerificationOutcomeInput;

export function admitVerificationPresentationOutcome(input: {
  verificationStatus: VerificationStatus;
  verificationReportStatus?: VerificationStatus;
  verificationReport?: VerificationReport;
  failureCategory?: VerificationFailureCategory;
}): VerificationOutcomeInput {
  return admitVerifierOutcome(input) ?? INCOHERENT_VERIFIER_OUTCOME;
}

function logExactProofUnavailable(debugEnabled: boolean, sessionId: string, voteId: string): void {
  if (debugEnabled) {
    logger.debug('[API][verify][DEBUG] Exact CT proof unavailable for user vote', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      voteId,
    });
  }
}

function createVerificationReadPort(params: {
  session: SessionReadModel;
  store: ApiContextStore;
  debugEnabled: boolean;
}): VerificationReadPort {
  const { session, store, debugEnabled } = params;
  return {
    readCurrent: (sessionId) => {
      if (sessionId !== session.identity.sessionId || sessionId !== session.voting.sessionId) {
        return Promise.resolve({
          availability: 'corrupt',
          reason: 'session_identity_mismatch',
        });
      }
      const finalization = session.finalization;
      if (finalization?.state.status !== 'succeeded' || !finalization.finalizationResult) {
        return Promise.resolve({
          availability: 'unavailable',
          reason: 'finalization_not_current',
        });
      }
      if (session.voting.userParticipation.status !== 'cast') {
        return Promise.resolve({
          availability: 'unavailable',
          reason: 'user_vote_unavailable',
        });
      }
      const userVoteIndex = session.voting.userParticipation.voteIndex;
      const userVote = session.voting.votes.get(userVoteIndex);
      if (!userVote) {
        return Promise.resolve({
          availability: 'corrupt',
          reason: 'invalid_artifact',
        });
      }
      return Promise.resolve({
        availability: 'available',
        source: {
          sessionId: session.identity.sessionId,
          electionId: session.identity.electionId,
          electionConfigHash: session.identity.electionConfigHash,
          logId: session.identity.logId,
          createdAtMs: session.identity.createdAtMs,
          lastActivityAtMs: session.voting.lastActivityMs,
          userVote: {
            index: userVoteIndex,
            voteId: userVote.voteId,
            commitment: userVote.commit,
          },
          finalization: {
            finalizationId: finalization.finalizationId,
            authority: finalization.finalizationResult,
          },
        },
      });
    },
    readExactVoterEvidence: async ({ sessionId, voteId, voteIndex, expectedCommitment }) => {
      let exactVoteProof;
      try {
        exactVoteProof = await store.getVoteByIdWithProof(sessionId, voteId);
      } catch (error) {
        if (error instanceof Error && error.message === 'CT_PROOF_UNAVAILABLE') {
          logExactProofUnavailable(debugEnabled, sessionId, voteId);
          return {
            availability: 'unavailable',
            reason: 'exact_proof_unavailable',
          };
        }
        throw error;
      }
      if (!exactVoteProof) {
        return {
          availability: 'unavailable',
          reason: 'exact_proof_unavailable',
        };
      }
      const finalization = session.finalization;
      if (finalization?.state.status !== 'succeeded' || !finalization.finalizationResult) {
        return {
          availability: 'corrupt',
          reason: 'invalid_artifact',
        };
      }
      const commitment = exactVoteProof.voteData.commit;
      const exactVoteId = exactVoteProof.voteData.voteId;
      if (
        exactVoteProof.leafIndex !== voteIndex ||
        normalizeHexString(commitment) !== normalizeHexString(expectedCommitment)
      ) {
        return {
          availability: 'corrupt',
          reason: 'voter_evidence_mismatch',
        };
      }
      return {
        availability: 'available',
        voteReceipt: {
          voteId: exactVoteId,
          commitment,
          bulletinIndex: exactVoteProof.leafIndex,
          bulletinRootAtCast: exactVoteProof.bulletinRootAtCast,
          castAtMs: exactVoteProof.voteData.timestamp,
          inputCommitment: finalization.finalizationResult.journal.inputCommitment,
        },
        userVote: {
          commitment,
          voteId: exactVoteId,
          proof: {
            leafIndex: exactVoteProof.leafIndex,
            treeSize: exactVoteProof.treeSize,
            merklePath: exactVoteProof.merklePath,
            bulletinRootAtCast: exactVoteProof.bulletinRootAtCast,
          },
        },
      };
    },
  };
}

/**
 * Return verification data for a finalized session.
 */
export async function getVerifyHandler({
  input,
  context,
}: ApiHandlerArguments<typeof verificationRoute, SessionFinalizationAdmittedContext>): Promise<
  RouteBoundResponse<typeof verificationRoute>
> {
  try {
    const debugEnabled = process.env['DEBUG_FILE_STORE'] === '1';
    const { sessionId, finalizationId: requestedFinalizationId, session, store, runtimeProfile } = context;
    const includeJournal = input.query.include === 'journal';

    logVerificationRead(session, debugEnabled);

    // Check if session is finalized
    if (session.finalization?.state.status !== 'succeeded' || !session.finalization.finalizationResult) {
      return respondWithRouteError(verificationRoute, { code: ErrorCode.SESSION_NOT_FINALIZED, status: 400 });
    }

    if (session.voting.userParticipation.status !== 'cast') {
      return respondWithRouteError(verificationRoute, { code: ErrorCode.USER_NOT_VOTED, status: 400 });
    }
    const userVoteIndex = session.voting.userParticipation.voteIndex;

    const preparedRead = await prepareVerificationRead(
      {
        sessionId,
        finalizationId: requestedFinalizationId,
      },
      createVerificationReadPort({
        session,
        store,
        debugEnabled,
      }),
    );
    if (preparedRead.availability !== 'available') {
      return admitRouteErrorResponse(
        verificationRoute,
        buildVerificationReadFailureResponse(requestedFinalizationId, preparedRead),
      );
    }
    const finalizationResult = session.finalization.finalizationResult;
    const [verificationRecord, deliveryMetadata, persistedBitmapData] = await Promise.all([
      store.getVerificationResultRecord(sessionId, requestedFinalizationId),
      store.getAwsVerificationDeliveryMetadata(sessionId, requestedFinalizationId),
      store.getBitmapData(sessionId, requestedFinalizationId),
    ]);
    const verificationResult = verificationRecord?.verificationResult;
    const bitmapData = admitPersistedFinalizationBitmapData(session.finalization, persistedBitmapData);

    const projectedFinalizationResult = projectFinalizationResultForPublicResponse(finalizationResult, undefined, {
      ...omitUndefinedProperties({ verificationResult }),
      ...omitUndefinedProperties({ deliveryMetadata }),
      ...omitUndefinedProperties({ bitmapData: bitmapData ?? undefined }),
    });
    const presentation = projectedFinalizationResult.presentation;
    const { tally, imageId, journal } = finalizationResult;

    const { allowDevModeVerification, verifierOutcome, publicVerificationReport } = projectVerifierOutcome(
      verificationResult,
      runtimeProfile,
    );

    const bulletinRootRaw = journal.bulletinRoot;
    const exactVoterEvidence =
      preparedRead.voterEvidence.availability === 'available' ? preparedRead.voterEvidence : undefined;
    const voteReceipt = projectReadVoteReceipt(exactVoterEvidence);

    const excludedSlots = presentation.excludedSlots;

    const verificationUserVote = preparedRead.voterEvidence.userVote;

    const verifiedTallyForChecks = presentation.verifiedTally;
    const { verifiedTallyArray, tallyCounts, tallyTotalVotes } = projectVerificationTally(
      tally,
      verifiedTallyForChecks,
    );
    const resolvedTreeSize = presentation.treeSize;
    const resolvedTotalExpected = presentation.totalExpected;
    const inputCommitment = presentation.inputCommitment;
    const { publicInputAuthority, electionManifest, closeStatement } = resolveReadPublicAudit(
      finalizationResult,
      deliveryMetadata?.s3BundleKey,
      bulletinRootRaw,
      resolvedTreeSize,
    );
    const consistencyProof = acquireConsistencyProofEvidence({
      session: session.voting,
      ...omitUndefinedProperties({ fromTreeSize: exactVoterEvidence?.userVote.proof.treeSize }),
      toTreeSize: resolvedTreeSize,
      generatedAtMs: Date.now(),
    });
    const bitmapProofEvidence = await acquireBitmapProofEvidence({
      store,
      sessionId,
      finalizationId: finalizationResult.finalizationId,
      finalizationResult,
      voteIndex: userVoteIndex,
    });
    const { sthVerification, sthSourcesConfigured } = await acquireReadSthVerification(
      sessionId,
      session,
      finalizationResult,
      presentation,
      preparedRead.source.logId,
    );

    const verificationChecksBaseInput = {
      ...resolveVerificationCheckIdentity(journal, publicInputAuthority, preparedRead.source.logId),
      ...omitUndefinedProperties({ voteReceipt }),
      userVote: verificationUserVote,
      journal,
      ...omitUndefinedProperties({ electionManifest }),
      ...omitUndefinedProperties({ closeStatement }),
      sthDigest: presentation.sthDigest,
      sthSourcesConfigured,
      ...omitUndefinedProperties({ sthVerification }),
      ...omitUndefinedProperties({ missingSlots: presentation.missingSlots }),
      ...omitUndefinedProperties({ invalidPresentedSlots: presentation.invalidPresentedSlots }),
      ...omitUndefinedProperties({ rejectedRecords: presentation.rejectedRecords }),
      ...omitUndefinedProperties({ excludedSlots: presentation.excludedSlots }),
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
      ...omitUndefinedProperties({ seenBitmapRoot: presentation.seenBitmapRoot }),
      ...omitUndefinedProperties({ includedBitmapRoot: presentation.includedBitmapRoot }),
      claimedImageId: imageId,
      ...omitUndefinedProperties({ comparisonImageId: journal.imageId }),
      ...omitUndefinedProperties({
        bitmapProofSource:
          finalizationResult.artifacts.bitmap.availability === 'available'
            ? finalizationResult.artifacts.bitmap.proofSource
            : undefined,
      }),
      consistencyProof,
      includedBitmapProof: bitmapProofEvidence.included,
      ...omitUndefinedProperties({ seenBitmapProof: bitmapProofEvidence.seen }),
      allowDevModeVerification,
    };
    const { effectiveTamperDetected, scenarioId, tamperSummary, botVotesSummary } = projectVerificationScenario(
      finalizationResult,
      presentation,
    );

    logTamperEvidence(sessionId, presentation, debugEnabled);

    const verificationPresentation = await buildVerificationPresentation({
      ...verificationChecksBaseInput,
      castSource: 'client',
      verifierOutcome,
      ...omitUndefinedProperties({ voteReceipt }),
      allowDevModeVerification,
    });
    const { verificationSteps, verificationChecks } = verificationPresentation;
    logVerificationFailures(verificationChecks);

    const admittedVerificationReportStatus = verifierOutcome.report?.status;
    const policy = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: verificationChecks,
      context: {
        missingSlots: presentation.missingSlots,
        invalidPresentedSlots: presentation.invalidPresentedSlots,
        rejectedRecords: presentation.rejectedRecords,
        excludedSlots: presentation.excludedSlots,
        devModeEvidence:
          verifierOutcome.status === 'dev_mode' ||
          admittedVerificationReportStatus === 'dev_mode' ||
          verifierOutcome.report?.dev_mode_receipt === true,
        sthSourcesConfigured,
      },
      verificationStatus: verifierOutcome.status,
      ...omitUndefinedProperties({ verificationReportStatus: admittedVerificationReportStatus }),
    });

    const responseData = {
      availability: 'available' as const,
      finalizationId: requestedFinalizationId,
      proofAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        logId: preparedRead.source.logId,
        imageId: ensureHex64(imageId),
        bulletinRoot: ensureHex64(bulletinRootRaw),
        verifiedTally: verifiedTallyArray,
        missingSlots: presentation.missingSlots,
        invalidPresentedSlots: presentation.invalidPresentedSlots,
        rejectedRecords: presentation.rejectedRecords,
        totalExpected: resolvedTotalExpected,
        treeSize: resolvedTreeSize,
        excludedSlots,
        sthDigest: ensureHex64(presentation.sthDigest),
        ...omitUndefinedProperties({
          seenBitmapRoot: presentation.seenBitmapRoot ? ensureHex64(presentation.seenBitmapRoot) : undefined,
        }),
        includedBitmapRoot: ensureHex64(presentation.includedBitmapRoot),
        inputCommitment: ensureHex64(inputCommitment),
        seenIndicesCount: presentation.seenIndicesCount,
      },
      presentation: {
        tally: {
          counts: tallyCounts,
          totalVotes: tallyTotalVotes,
          tamperedCount: tally.tamperedCount || 0,
        },
        scenarioId,
        tamperDetected: effectiveTamperDetected,
        ...omitUndefinedProperties({ botVotesSummary }),
        ...omitUndefinedProperties({ tamperSummary }),
        policy,
      },
      verifierResult: {
        status: verifierOutcome.status,
        ...omitUndefinedProperties({ report: publicVerificationReport }),
      },
      verification: {
        checks: verificationChecks,
        steps: verificationSteps.map((step) => ({
          ...step,
          status: policy.stageStatuses[step.id],
        })),
      },
      voterEvidence: preparedRead.voterEvidence,
      journal: includeJournal
        ? {
            representation: 'included' as const,
            value: journal,
          }
        : {
            representation: 'omitted' as const,
          },
    };

    const admittedResponseData = availableVerificationResourceSchema.parse(responseData);
    return respondWithRoute(
      verificationRoute,
      { status: 200, content: 'json', body: { data: admittedResponseData } },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (error) {
    return admitRouteErrorResponse(verificationRoute, handleApiError(error));
  }
}

function resolveVerificationCheckIdentity(
  journal: FinalizationResultAuthority['journal'],
  publicInputAuthority: VerificationPublicInputAuthority | undefined,
  logId: string,
) {
  return {
    electionId: journal.electionId,
    electionConfigHash: publicInputAuthority?.electionConfigHash ?? journal.electionConfigHash,
    logId: publicInputAuthority?.logId ?? logId,
  };
}

function resolveReadPublicAudit(
  finalizationResult: FinalizationResultAuthority & { finalizationId: string },
  bundleKey: string | undefined,
  bulletinRootRaw: string,
  resolvedTreeSize: number,
) {
  const publicAuditArtifacts = finalizationResult.artifacts.publicAudit;
  const publicInputAuthority = resolvePublicInputAuthority(
    publicAuditArtifacts.availability === 'available' ? publicAuditArtifacts.publicInputArtifact : undefined,
    {
      finalizationId: finalizationResult.finalizationId,
      ...omitUndefinedProperties({ bundleKey: bundleKey }),
      bulletinRoot: bulletinRootRaw,
      treeSize: resolvedTreeSize,
    },
  );
  const electionManifest =
    publicAuditArtifacts.availability === 'available' ? publicAuditArtifacts.electionManifest : undefined;
  const closeStatement =
    publicAuditArtifacts.availability === 'available' ? publicAuditArtifacts.closeStatement : undefined;
  return { publicInputAuthority, electionManifest, closeStatement };
}

async function acquireReadSthVerification(
  sessionId: SessionFinalizationAdmittedContext['sessionId'],
  session: SessionReadModel,
  finalizationResult: FinalizationResultAuthority,
  presentation: ReturnType<typeof projectFinalizationResultForPublicResponse>['presentation'],
  logId: string,
) {
  const sthPublicRuntimeConfig = resolveNodeSthPublicRuntimeConfig();
  const sthVerification =
    sthPublicRuntimeConfig.sources.length > 0
      ? await resolveSthVerificationFromProviders({
          sources: sthPublicRuntimeConfig.sources,
          journal: {
            sthDigest: presentation.sthDigest,
            bulletinRoot: finalizationResult.journal.bulletinRoot,
            treeSize: presentation.treeSize,
          },
          minMatchingSources: sthPublicRuntimeConfig.minMatchingSources,
          sessionId,
          sameOriginProvider: () =>
            projectSessionSthData({
              journal: finalizationResult.journal,
              timestamp: session.voting.lastActivityMs,
              logId: logId,
            }),
        })
      : undefined;

  return { sthVerification, sthSourcesConfigured: sthPublicRuntimeConfig.sources.length > 0 };
}

function projectReadVoteReceipt(exactVoterEvidence: AvailableVerificationVoterEvidence | undefined) {
  return exactVoterEvidence
    ? {
        voteId: exactVoterEvidence.voteReceipt.voteId,
        commitment: exactVoterEvidence.voteReceipt.commitment,
        bulletinIndex: exactVoterEvidence.voteReceipt.bulletinIndex,
        bulletinRootAtCast: exactVoterEvidence.voteReceipt.bulletinRootAtCast,
        timestamp: exactVoterEvidence.voteReceipt.castAtMs,
        ...omitUndefinedProperties({
          inputCommitment: exactVoterEvidence.voteReceipt.inputCommitment,
        }),
      }
    : undefined;
}

function logTamperEvidence(
  sessionId: SessionFinalizationAdmittedContext['sessionId'],
  presentation: ReturnType<typeof projectFinalizationResultForPublicResponse>['presentation'],
  debugEnabled: boolean,
): void {
  const { excludedSlots } = presentation;
  if (excludedSlots > 0 && debugEnabled) {
    logger.debug('[API][verify][DEBUG] Tamper detected in verification payload', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      excludedSlots,
      missingSlots: presentation.missingSlots,
      invalidPresentedSlots: presentation.invalidPresentedSlots,
    });
  }
}

function projectVerificationTally(
  tally: FinalizationResultAuthority['tally'],
  verifiedTallyForChecks: number[] | undefined,
) {
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
    typeof tally.totalVotes === 'number' ? tally.totalVotes : Object.values(tallyCounts).reduce((sum, v) => sum + v, 0);
  return { verifiedTallyArray, tallyCounts, tallyTotalVotes };
}

function allowsDevelopmentVerification(
  verificationStatus: VerificationStatus | undefined,
  runtimeProfile: ResolvedRuntimeProfile,
): boolean {
  const allowDevModeVerification =
    verificationStatus === 'dev_mode' &&
    (runtimeProfile.proof.evidence === 'development' || runtimeProfile.proof.evidence === 'mock');
  return allowDevModeVerification;
}

function projectAdmittedVerifierReport(
  verifierOutcome: VerificationOutcomeInput,
  effectiveVerificationResult: VerificationResult | undefined,
) {
  const admittedVerificationReportStatus = verifierOutcome.report?.status;
  const publicVerificationReport =
    admittedVerificationReportStatus !== undefined &&
    admittedVerificationReportStatus === effectiveVerificationResult?.report?.status
      ? sanitizeVerificationReportForPublicResponse(effectiveVerificationResult.report)
      : undefined;
  return publicVerificationReport;
}

function requiresFailedVerifierPresentation(
  result: VerificationResult | undefined,
  status: VerificationStatus | undefined,
  allowDevelopment: boolean,
): boolean {
  const allowedStatuses = new Set(['success', 'failed', 'not_run', 'running']);
  return Boolean(result && status && !allowedStatuses.has(status) && !allowDevelopment);
}

function projectVerifierOutcome(
  verificationResult: VerificationResult | undefined,
  runtimeProfile: ResolvedRuntimeProfile,
) {
  const verificationStatus = verificationResult?.status;
  const allowDevModeVerification = allowsDevelopmentVerification(verificationStatus, runtimeProfile);

  const forceFailClosedVerification = requiresFailedVerifierPresentation(
    verificationResult,
    verificationStatus,
    allowDevModeVerification,
  );

  const effectiveVerificationResult = verificationResult;

  // Prepare response data (STARK verification status only).
  // The overall user-facing verdict is derived from verification checks + summary,
  // so missing evidence can still downgrade the page while this remains "success".
  const computedVerificationStatus = verificationStatus ?? 'not_run';
  const presentationVerificationStatus = forceFailClosedVerification ? 'failed' : computedVerificationStatus;
  const presentationVerificationReportStatus = forceFailClosedVerification
    ? 'failed'
    : effectiveVerificationResult?.report?.status;
  const verifierOutcome = admitVerificationPresentationOutcome({
    verificationStatus: presentationVerificationStatus,
    ...omitUndefinedProperties({ verificationReportStatus: presentationVerificationReportStatus }),
    ...omitUndefinedProperties({ verificationReport: effectiveVerificationResult?.report }),
    ...omitUndefinedProperties({ failureCategory: effectiveVerificationResult?.failureCategory }),
  });

  const publicVerificationReport = projectAdmittedVerifierReport(verifierOutcome, effectiveVerificationResult);
  return { allowDevModeVerification, verifierOutcome, publicVerificationReport };
}

function projectScenarioBotVotes(scenarioId: string, tamperSummary: FinalizationResultAuthority['tamperSummary']) {
  const affectedBotIds =
    tamperSummary && Array.isArray(tamperSummary.affectedBotIds) ? tamperSummary.affectedBotIds : undefined;
  const botVotesSummary =
    (scenarioId === 'S3' || scenarioId === 'S4') && affectedBotIds && affectedBotIds.length > 0
      ? { total: BOT_COUNT, affectedBotIds, source: 'scenario_simulation' }
      : undefined;
  return botVotesSummary;
}

function projectVerificationScenario(
  finalizationResult: FinalizationResultAuthority,
  presentation: ReturnType<typeof projectFinalizationResultForPublicResponse>['presentation'],
) {
  const { scenarios = [], tamperDetected } = finalizationResult;
  const { excludedSlots } = presentation;
  const scenarioTamperCount = resolveScenarioTamperCount(finalizationResult.tamperSummary);
  const tamperDetectedBool: boolean = Boolean(tamperDetected);
  const effectiveTamperDetected =
    tamperDetectedBool ||
    resolveFinalizationTamperDetected({
      excludedSlots,
      rejectedRecords: presentation.rejectedRecords,
      scenarioTamperCount,
    });

  const scenarioIdCandidate = scenarios.length > 0 ? (scenarios[0] ?? 'S0') : 'S0';
  const allowedScenarioIds = new Set(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
  const scenarioId = allowedScenarioIds.has(scenarioIdCandidate) ? scenarioIdCandidate : 'S0';
  const tamperSummary = finalizationResult.tamperSummary;
  const botVotesSummary = projectScenarioBotVotes(scenarioId, tamperSummary);

  return { effectiveTamperDetected, scenarioId, tamperSummary, botVotesSummary };
}

function logVerificationRead(session: SessionReadModel, debugEnabled: boolean): void {
  const sessionId = session.identity.sessionId;
  if (debugEnabled) {
    logger.debug('[API][verify][DEBUG] Request started', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      timestamp: new Date().toISOString(),
    });
  }

  if (debugEnabled) {
    logger.debug('[API][verify][DEBUG] Session retrieved', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalizationStatus: session.finalization?.state.status ?? null,
      votesCount: session.voting.votes.size,
      userVoteIndex:
        session.voting.userParticipation.status === 'cast' ? session.voting.userParticipation.voteIndex : null,
    });
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

function matchesPublicInputProvenance(
  provenance: SupportedPublicInputArtifact['provenance'],
  expected: { finalizationId: string | undefined; bundleKey: string | undefined },
): boolean {
  const { finalizationId, bundleKey } = expected;
  if (finalizationId) {
    if (!provenance.finalizationId || provenance.finalizationId !== finalizationId) {
      return false;
    }
  }

  if (bundleKey) {
    if (!provenance.bundleKey || provenance.bundleKey !== bundleKey) {
      return false;
    }
  }

  return true;
}

function resolvePublicInputAuthority(
  artifact: SupportedPublicInputArtifact | undefined,
  options: {
    finalizationId?: string;
    bundleKey?: string;
    bulletinRoot?: string;
    treeSize?: number;
  },
): VerificationPublicInputAuthority | undefined {
  if (!artifact) {
    return undefined;
  }

  const { finalizationId, bundleKey, bulletinRoot, treeSize } = options;
  const { provenance, typedAuthority } = artifact;

  if (!matchesPublicInputProvenance(provenance, { finalizationId, bundleKey })) return undefined;

  if (bulletinRoot && normalizeHexString(typedAuthority.bulletinRoot) !== normalizeHexString(bulletinRoot)) {
    return undefined;
  }
  if (typeof treeSize === 'number' && typedAuthority.treeSize !== treeSize) {
    return undefined;
  }

  return {
    ...typedAuthority,
    source: provenance.source,
    ...(provenance.finalizationId ? { finalizationId: provenance.finalizationId } : {}),
    ...(provenance.bundleKey ? { bundleKey: provenance.bundleKey } : {}),
  };
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
