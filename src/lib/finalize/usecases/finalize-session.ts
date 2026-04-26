import type { VoteStore } from '@/types/voteStore';
import type { FinalizationScenarioContext, SessionData } from '@/types/server';
import type { FinalizationQueue } from '@/lib/finalize/finalization-queue';
import type { ProofBundleService } from '@/lib/finalize/proof-bundle-service';
import type { ZkVMExecutor } from '@/lib/zkvm/executor-factory';
import { BOT_COUNT } from '@/shared/constants';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { createElectionId } from '@/lib/zkvm/types';
import { buildZkVMInputFromSession, CtProofUnavailableError } from '@/lib/zkvm/input-builder';
import { applyFinalizeScenarios } from '@/lib/finalize/scenario-application';
import { resolveElectionConfigForManifest } from '@/lib/verification/public-audit-artifacts';
import {
  buildUnsupportedCurrentArtifactDetails,
  isCurrentArtifactBoundaryError,
  isCurrentContractGeneration,
} from '@/lib/contract';
import { finalizeAsync } from './finalize-async';
import { finalizeSync } from './finalize-sync';
import type { FinalizeScenarioContext, FinalizeSessionError, FinalizeSessionOutcome, Result } from './types';

export interface FinalizeSessionInput {
  sessionId: string;
  session: SessionData;
  scenarioId: string;
  expectedImageId: string;
  publicBaseUrl: string;
  asyncMode: boolean;
  queueUrl?: string;
  publishMaxAttempts: number;
  clientMeta: {
    clientIp: string;
    userAgent?: string;
    traceId?: string;
  };
  allowDevMode: boolean;
  debugFinalize: boolean;
  buildBundleUrl: (baseUrl: string, sessionId: string, executionId: string, ...segments: string[]) => string;
}

export interface FinalizeSessionDependencies {
  store: VoteStore;
  finalizationQueue: FinalizationQueue;
  proofBundleService: ProofBundleService;
  getExecutor: () => Promise<ZkVMExecutor>;
  now?: () => number;
}

export async function finalizeSessionUsecase(
  input: FinalizeSessionInput,
  deps: FinalizeSessionDependencies,
): Promise<Result<FinalizeSessionOutcome, FinalizeSessionError>> {
  const session = input.session;

  if (!session.electionId) {
    session.electionId = createElectionId();
    await deps.store.updateSession(input.sessionId, { electionId: session.electionId });
  }

  if (session.finalized) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.SESSION_ALREADY_FINALIZED,
      },
    };
  }

  if (session.userVoteIndex === undefined) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.USER_NOT_VOTED,
      },
    };
  }

  if (session.botCount < BOT_COUNT) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.VOTING_NOT_COMPLETE,
      },
    };
  }

  const sessionContractGeneration = session.contractGeneration;
  if (typeof sessionContractGeneration !== 'string' || !isCurrentContractGeneration(sessionContractGeneration)) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
        details: {
          details: 'Session no longer matches the current contract generation',
          artifactState: 'unsupported_current_artifact',
          ...buildUnsupportedCurrentArtifactDetails(session, sessionContractGeneration ?? null),
        },
      },
    };
  }
  const contractGeneration = sessionContractGeneration;

  const scenarios = input.scenarioId === 'S0' ? [] : [input.scenarioId];

  let scenarioContext: FinalizeScenarioContext;
  let zkvmInput: ReturnType<typeof buildZkVMInputFromSession>;
  let authoritativeElectionConfig: NonNullable<SessionData['electionConfig']>;

  try {
    const scenarioApplication = applyFinalizeScenarios({
      votes: session.votes,
      userVoteIndex: session.userVoteIndex,
      scenarios,
    });

    const scenarioResult = scenarioApplication.scenarioResult;
    const summary = scenarioApplication.summary;
    const affectedBotIds =
      scenarioResult && (input.scenarioId === 'S3' || input.scenarioId === 'S4')
        ? Array.from(
            new Set(
              scenarioResult.changes
                .filter((change) => change.voteIndex !== session.userVoteIndex)
                .map((change) => change.voteIndex),
            ),
          )
        : undefined;

    scenarioContext = {
      scenarios,
      scenariosApplied: scenarioApplication.scenariosApplied,
      tamperMode: scenarioApplication.tamperMode,
      claimedCounts: scenarioApplication.claimedCounts,
      claimedTotalVotes: scenarioApplication.claimedTotalVotes,
      summary,
      scenarioResult,
      affectedBotIds,
    };

    const votesForInput =
      scenarioApplication.tamperMode === 'input' ? scenarioApplication.modifiedVotes : session.votes;
    const sessionForInput: SessionData = {
      ...session,
      votes: votesForInput,
    };

    // Exclusion scenarios intentionally preserve original bulletin indices so
    // the guest can observe missing slots against the full bulletin tree.
    zkvmInput = buildZkVMInputFromSession(sessionForInput, {
      allowSparseVoteIndices: scenarioApplication.tamperMode === 'input',
    });
    authoritativeElectionConfig = resolveElectionConfigForManifest({
      electionConfig: sessionForInput.electionConfig,
      electionConfigHash: zkvmInput.electionConfigHash,
      totalExpected: zkvmInput.totalExpected,
    });
  } catch (error) {
    if (error instanceof CtProofUnavailableError) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ErrorCode.VERIFICATION_FAILED,
          details: {
            details: error.message,
            reason: error.reason,
            voteIndex: error.index,
            expectedTreeSize: error.expectedTreeSize,
            actualTreeSize: error.actualTreeSize,
          },
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.INTERNAL_ERROR,
        details: {
          details: error instanceof Error ? error.message : 'Failed to prepare finalization inputs',
        },
      },
    };
  }

  const scenarioStorageContext: FinalizationScenarioContext = {
    scenarios: scenarioContext.scenariosApplied,
    tamperMode: scenarioContext.tamperMode,
    claimedCounts: scenarioContext.claimedCounts,
    claimedTotalVotes: scenarioContext.claimedTotalVotes,
    summary: {
      ignoredCount: scenarioContext.summary.ignoredCount,
      recountedCount: scenarioContext.summary.recountedCount,
      userRecountChoice: scenarioContext.summary.userRecountChoice,
      ...(scenarioContext.affectedBotIds ? { affectedBotIds: scenarioContext.affectedBotIds } : {}),
    },
  };

  if (input.asyncMode) {
    if (!input.queueUrl) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ErrorCode.INTERNAL_ERROR,
          details: { details: 'PROVER_WORK_QUEUE_URL is not configured' },
        },
      };
    }

    try {
      await deps.store.updateSession(input.sessionId, {
        finalizationScenarioContext: scenarioStorageContext,
        finalizationContractGeneration: contractGeneration,
      });
    } catch (error) {
      if (isCurrentArtifactBoundaryError(error)) {
        return {
          ok: false,
          error: {
            kind: 'api',
            code:
              error.code === 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE'
                ? ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
                : ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
            details: {
              details: error.message,
              artifactState: error.artifactState,
              ...error.details,
            },
          },
        };
      }
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            details: error instanceof Error ? error.message : 'Failed to persist scenario context',
          },
        },
      };
    }

    let asyncResult: Awaited<ReturnType<typeof finalizeAsync>>;
    try {
      asyncResult = await finalizeAsync(
        {
          sessionId: input.sessionId,
          session,
          contractGeneration,
          zkvmInput,
          electionConfig: authoritativeElectionConfig,
          expectedImageId: input.expectedImageId,
          scenarios: scenarioContext.scenariosApplied,
          scenarioContext: scenarioStorageContext,
          publicBaseUrl: input.publicBaseUrl,
          queueUrl: input.queueUrl,
          clientMeta: input.clientMeta,
          publishMaxAttempts: input.publishMaxAttempts,
        },
        {
          store: deps.store,
          finalizationQueue: deps.finalizationQueue,
          now: deps.now,
        },
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            details: error instanceof Error ? error.message : 'Failed to enqueue finalization job',
          },
        },
      };
    }

    if (!asyncResult.ok) {
      return asyncResult;
    }

    return {
      ok: true,
      value: {
        kind: 'accepted',
        payload: asyncResult.value.payload,
        state: asyncResult.value.state,
      },
    };
  }

  const syncResult = await finalizeSync(
    {
      sessionId: input.sessionId,
      session,
      contractGeneration,
      zkvmInput,
      electionConfig: authoritativeElectionConfig,
      expectedImageId: input.expectedImageId,
      publicBaseUrl: input.publicBaseUrl,
      scenario: scenarioContext,
      allowDevMode: input.allowDevMode,
      debugFinalize: input.debugFinalize,
      buildBundleUrl: input.buildBundleUrl,
    },
    {
      store: deps.store,
      getExecutor: deps.getExecutor,
      proofBundleService: deps.proofBundleService,
      now: deps.now,
    },
  );

  if (!syncResult.ok) {
    return syncResult;
  }

  return {
    ok: true,
    value: {
      kind: 'sync',
      payload: syncResult.value,
    },
  };
}
