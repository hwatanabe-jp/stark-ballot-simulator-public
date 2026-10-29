import { toFinalizationScenarioContext } from './finalize-scenario-context';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import {
  parseSessionIdentityRecord,
  type SessionIdentityRecord,
  type SessionVotingRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import type { FinalizationQueue } from '@stark-ballot/application/finalize/finalization-queue';
import type { ProofBundleService } from '@stark-ballot/application/finalize/proof-bundle-service';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type { ZkVMExecutor } from '@stark-ballot/application/finalize/zkvm-executor';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import { ApplicationErrorCode } from '@stark-ballot/application';
import {
  type FinalizationScenarioContext,
  type FinalizationId,
} from '@stark-ballot/application/finalize/finalization-types';
import type { VerificationResultStore } from '@stark-ballot/application/finalize/finalization-result-store';
import { buildZkVMInputFromSession, CtProofUnavailableError } from '@stark-ballot/application/zkvm-input/input-builder';
import { applyFinalizeScenarios } from '@stark-ballot/domain/finalize/scenario-application';
import { resolveElectionConfigForManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { finalizeAsync, type PersistAsyncProverInput } from './finalize-async';
import { finalizeSync } from './finalize-sync';
import { generateFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizeScenarioContext, FinalizeSessionError, FinalizeSessionOutcome, Result } from './types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

interface FinalizeSessionInputBase {
  sessionId: SessionId;
  identity: SessionIdentityRecord;
  voting: SessionVotingRecord;
  currentFinalization: FinalizationRecord | null;
  scenarioId: string;
  expectedImageId: string;
  publishMaxAttempts: number;
  allowDevMode: boolean;
  debugFinalize: boolean;
  debugFileStore?: boolean;
  executorModeLabel?: string;
  bitmapProofSource?: 'mock' | 'real';
}

export type FinalizeSessionInput = FinalizeSessionInputBase &
  ({ finalizationMode: { kind: 'sync' } } | { finalizationMode: { kind: 'async'; inputSource: 'inline' | 's3' } });

export interface FinalizeSessionDependencies {
  store: VoteStore & FinalizationStore & VerificationResultStore;
  finalizationQueue: FinalizationQueue;
  proofBundleService: ProofBundleService;
  getExecutor: () => Promise<ZkVMExecutor>;
  now?: () => number;
  persistAsyncProverInput?: PersistAsyncProverInput;
}

export async function finalizeSessionUsecase(
  input: FinalizeSessionInput,
  deps: FinalizeSessionDependencies,
): Promise<Result<FinalizeSessionOutcome, FinalizeSessionError>> {
  const admission = admitFinalizationSession(input);
  if (!admission.ok) return admission;
  const { voting } = input;
  const prepared = prepareFinalizationInputs(input, admission.value.userVoteIndex);
  if (!prepared.ok) return prepared;
  const { scenarioContext, zkvmInput, authoritativeElectionConfig } = prepared.value;

  const scenarioStorageContext = toFinalizationScenarioContext(scenarioContext);
  const queuedAtMs = (deps.now ?? Date.now)();
  const finalizationId = generateFinalizationId(queuedAtMs);

  if (input.finalizationMode.kind === 'async') {
    return finalizeSessionAsynchronously(
      input,
      deps,
      {
        ...prepared.value,
        finalizationId,
        queuedAtMs,
        scenarioStorageContext,
      },
      input.finalizationMode.inputSource,
    );
  }

  const syncResult = await finalizeSync(
    {
      sessionId: input.sessionId,
      finalizationId,
      queuedAtMs,
      voting,
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

interface PreparedFinalizationInputs {
  scenarioContext: FinalizeScenarioContext;
  zkvmInput: ReturnType<typeof buildZkVMInputFromSession>;
  authoritativeElectionConfig: SessionIdentityRecord['electionConfig'];
}

function admitFinalizationSession(
  input: FinalizeSessionInput,
): Result<{ userVoteIndex: number }, FinalizeSessionError> {
  const { identity, voting } = input;

  if (
    parseSessionIdentityRecord(identity) === undefined ||
    identity.sessionId !== input.sessionId ||
    voting.sessionId !== input.sessionId
  ) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: { details: 'Session identity is missing or invalid' },
      },
    };
  }

  if (input.currentFinalization?.state.status === 'succeeded') {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.SESSION_ALREADY_FINALIZED,
      },
    };
  }

  if (voting.userParticipation.status !== 'cast') {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.USER_NOT_VOTED,
      },
    };
  }
  const userVoteIndex = voting.userParticipation.voteIndex;

  if (voting.botCount < BOT_COUNT) {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.VOTING_NOT_COMPLETE,
      },
    };
  }

  return { ok: true, value: { userVoteIndex } };
}

function prepareFinalizationInputs(
  input: FinalizeSessionInput,
  userVoteIndex: number,
): Result<PreparedFinalizationInputs, FinalizeSessionError> {
  const { identity, voting } = input;
  const scenarios = input.scenarioId === 'S0' ? [] : [input.scenarioId];

  let scenarioContext: FinalizeScenarioContext;
  let zkvmInput: ReturnType<typeof buildZkVMInputFromSession>;
  let authoritativeElectionConfig: SessionIdentityRecord['electionConfig'];

  try {
    const scenarioApplication = applyFinalizeScenarios({
      votes: voting.votes,
      userVoteIndex,
      scenarios,
    });

    const scenarioResult = scenarioApplication.scenarioResult;
    const summary = scenarioApplication.summary;
    const affectedBotIds =
      scenarioResult && (input.scenarioId === 'S3' || input.scenarioId === 'S4')
        ? Array.from(
            new Set(
              scenarioResult.changes
                .filter((change) => change.voteIndex !== userVoteIndex)
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

    const votesForInput = scenarioApplication.tamperMode === 'input' ? scenarioApplication.modifiedVotes : voting.votes;
    const votingForInput: SessionVotingRecord = {
      ...voting,
      votes: votesForInput,
    };

    // Exclusion scenarios intentionally preserve original bulletin indices so
    // the guest can observe missing slots against the full bulletin tree.
    zkvmInput = buildZkVMInputFromSession(
      { identity, voting: votingForInput },
      {
        allowSparseVoteIndices: scenarioApplication.tamperMode === 'input',
      },
    );
    authoritativeElectionConfig = resolveElectionConfigForManifest({
      electionConfig: identity.electionConfig,
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

  return { ok: true, value: { scenarioContext, zkvmInput, authoritativeElectionConfig } };
}

async function finalizeSessionAsynchronously(
  input: FinalizeSessionInput,
  deps: FinalizeSessionDependencies,
  work: PreparedFinalizationInputs & {
    finalizationId: FinalizationId;
    queuedAtMs: number;
    scenarioStorageContext: FinalizationScenarioContext;
  },
  inputSource: 'inline' | 's3',
): Promise<Result<FinalizeSessionOutcome, FinalizeSessionError>> {
  const {
    finalizationId,
    queuedAtMs,
    zkvmInput,
    authoritativeElectionConfig,
    scenarioContext,
    scenarioStorageContext,
  } = work;
  let asyncResult: Awaited<ReturnType<typeof finalizeAsync>>;
  try {
    asyncResult = await finalizeAsync(
      {
        sessionId: input.sessionId,
        finalizationId,
        queuedAtMs,
        zkvmInput,
        ...omitUndefinedProperties({ electionConfig: authoritativeElectionConfig }),
        expectedImageId: input.expectedImageId,
        scenarios: scenarioContext.scenariosApplied,
        scenarioContext: scenarioStorageContext,
        publishMaxAttempts: input.publishMaxAttempts,
        inputSource: inputSource,
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
