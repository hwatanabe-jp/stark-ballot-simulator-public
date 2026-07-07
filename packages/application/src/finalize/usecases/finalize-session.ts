import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationScenarioContext, SessionData } from '@stark-ballot/domain/types/server';
import type { FinalizationQueue } from '@stark-ballot/application/finalize/finalization-queue';
import type { ProofBundleService } from '@stark-ballot/application/finalize/proof-bundle-service';
import type { FinalizeSyncDependencies } from './finalize-sync';
import type { ZkVMExecutor } from '@stark-ballot/application/finalize/zkvm-executor';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import { createElectionId } from '@stark-ballot/zkvm-contract/zkvm/types';
import { buildZkVMInputFromSession, CtProofUnavailableError } from '@stark-ballot/application/zkvm-input/input-builder';
import { applyFinalizeScenarios } from '@stark-ballot/domain/finalize/scenario-application';
import { resolveElectionConfigForManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { buildUnsupportedCurrentArtifactDetails, isCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { finalizeAsync, type PersistAsyncProverInput } from './finalize-async';
import { finalizeSync } from './finalize-sync';
import type { FinalizeScenarioContext, FinalizeSessionError, FinalizeSessionOutcome, Result } from './types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export interface FinalizeSessionInput {
  sessionId: string;
  session: SessionData;
  scenarioId: string;
  expectedImageId: string;
  asyncMode: boolean;
  queueUrl?: string;
  publishMaxAttempts: number;
  allowDevMode: boolean;
  debugFinalize: boolean;
  debugFileStore?: boolean;
  targetAwsRuntime?: boolean;
  executorModeLabel?: string;
  bitmapProofSource?: 'mock' | 'real';
}

export interface FinalizeSessionDependencies {
  store: VoteStore & FinalizationStore;
  finalizationQueue: FinalizationQueue;
  proofBundleService: ProofBundleService;
  getExecutor: () => Promise<ZkVMExecutor>;
  now?: () => number;
  persistAsyncProverInput?: PersistAsyncProverInput;
  assertAdmissibleFinalizationArtifactPatch?: FinalizeSyncDependencies['assertAdmissibleFinalizationArtifactPatch'];
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
        code: ApplicationErrorCode.SESSION_ALREADY_FINALIZED,
      },
    };
  }

  if (session.userVoteIndex === undefined) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.USER_NOT_VOTED,
      },
    };
  }

  if (session.botCount < BOT_COUNT) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.VOTING_NOT_COMPLETE,
      },
    };
  }

  const sessionContractGeneration = session.contractGeneration;
  if (typeof sessionContractGeneration !== 'string' || !isCurrentContractGeneration(sessionContractGeneration)) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
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
      ...omitUndefinedProperties({ affectedBotIds: affectedBotIds }),
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
      ...omitUndefinedProperties({ electionConfig: sessionForInput.electionConfig }),
      electionConfigHash: zkvmInput.electionConfigHash,
      totalExpected: zkvmInput.totalExpected,
    });
  } catch (error) {
    if (error instanceof CtProofUnavailableError) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.VERIFICATION_FAILED,
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
        code: ApplicationErrorCode.INTERNAL_ERROR,
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
          code: ApplicationErrorCode.INTERNAL_ERROR,
          details: { details: 'PROVER_WORK_QUEUE_URL is not configured' },
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
          ...omitUndefinedProperties({ electionConfig: authoritativeElectionConfig }),
          expectedImageId: input.expectedImageId,
          scenarios: scenarioContext.scenariosApplied,
          scenarioContext: scenarioStorageContext,
          queueUrl: input.queueUrl,
          publishMaxAttempts: input.publishMaxAttempts,
          targetAwsRuntime: input.targetAwsRuntime ?? false,
        },
        {
          store: deps.store,
          finalizationQueue: deps.finalizationQueue,
          ...omitUndefinedProperties({ now: deps.now }),
          ...omitUndefinedProperties({ persistAsyncProverInput: deps.persistAsyncProverInput }),
        },
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.INTERNAL_ERROR,
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
      ...omitUndefinedProperties({ electionConfig: authoritativeElectionConfig }),
      expectedImageId: input.expectedImageId,
      scenario: scenarioContext,
      allowDevMode: input.allowDevMode,
      debugFinalize: input.debugFinalize,
      ...omitUndefinedProperties({ debugFileStore: input.debugFileStore }),
      ...omitUndefinedProperties({
        executorModeLabel: input.executorModeLabel,
        bitmapProofSource: input.bitmapProofSource,
      }),
    },
    {
      store: deps.store,
      getExecutor: deps.getExecutor,
      proofBundleService: deps.proofBundleService,
      ...omitUndefinedProperties({ now: deps.now }),
      ...omitUndefinedProperties({
        assertAdmissibleFinalizationArtifactPatch: deps.assertAdmissibleFinalizationArtifactPatch,
      }),
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
