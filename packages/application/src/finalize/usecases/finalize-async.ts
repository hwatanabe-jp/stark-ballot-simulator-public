import type { FinalizationQueue } from '@stark-ballot/application/finalize/finalization-queue';
import { generateExecutionId } from '@stark-ballot/application/finalize/execution-id';
import {
  createFinalizationWorkItem,
  type FinalizationScenarioCode,
} from '@stark-ballot/application/finalize/finalization-work-item';
import { computeInputCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionData } from '@stark-ballot/domain/types/server';
import type {
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { logger } from '@stark-ballot/diagnostics/logger';
import { emitCanonicalEvent } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { isCurrentArtifactBoundaryError } from '@stark-ballot/domain/contract';
import type { FinalizeAcceptedPayload, FinalizeSessionError, Result } from './types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

function toScenarioCode(value: string): FinalizationScenarioCode {
  if (value !== 'S0' && value !== 'S1' && value !== 'S2' && value !== 'S3' && value !== 'S4' && value !== 'S5') {
    throw new Error(`Unsupported scenario code: ${value}`);
  }
  return value;
}

export type PersistAsyncProverInput = (input: {
  sessionId: string;
  executionId: string;
  contractGeneration: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
}) => Promise<unknown>;

export interface FinalizeAsyncInput {
  sessionId: string;
  session: SessionData;
  contractGeneration: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  expectedImageId: string;
  scenarios: string[];
  scenarioContext?: FinalizationScenarioContext;
  queueUrl: string;
  publishMaxAttempts: number;
  targetAwsRuntime?: boolean;
}

export interface FinalizeAsyncDependencies {
  store: VoteStore & FinalizationLifecycleStore;
  finalizationQueue: FinalizationQueue;
  now?: () => number;
  computeCommitment?: typeof computeInputCommitment;
  persistAsyncProverInput?: PersistAsyncProverInput;
}

export async function finalizeAsync(
  input: FinalizeAsyncInput,
  deps: FinalizeAsyncDependencies,
): Promise<Result<{ payload: FinalizeAcceptedPayload; state: FinalizationState }, FinalizeSessionError>> {
  const queuedAt = (deps.now ?? Date.now)();
  const executionId = generateExecutionId(queuedAt);

  if (typeof deps.store.markFinalizationQueued !== 'function') {
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: { details: 'Store does not support async finalization' },
      },
    };
  }

  const correlation = {
    session_id_hash: hashSessionIdForLogging(input.sessionId),
    execution_id: executionId,
  } as const;
  emitCanonicalEvent({
    event: 'finalize_transition_attempted',
    to: 'pending',
    source: 'finalize',
    reason: 'FINALIZE_REQUESTED',
    ...correlation,
  });

  let finalizationState: FinalizationState;
  try {
    finalizationState = await deps.store.markFinalizationQueued(input.sessionId, {
      executionId,
      queuedAt,
      contractGeneration: input.contractGeneration,
      scenarioContext: input.scenarioContext,
      observability: {
        source: 'finalize',
        reason: 'FINALIZE_REQUESTED',
      },
    });
  } catch (error) {
    if (isCurrentArtifactBoundaryError(error)) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code:
            error.code === 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE'
              ? ApplicationErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
              : ApplicationErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
          details: {
            details: error.message,
            artifactState: error.artifactState,
            ...error.details,
          },
        },
      };
    }
    logger.error('[API] Failed to mark session as queued', error);
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: { details: 'Failed to update session finalization state' },
      },
    };
  }

  if (finalizationState.status !== 'pending' || finalizationState.executionId !== executionId) {
    return {
      ok: true,
      value: {
        payload: {
          executionId: finalizationState.executionId,
          state: finalizationState,
        },
        state: finalizationState,
      },
    };
  }

  const zkvmInputCommitment = (deps.computeCommitment ?? computeInputCommitment)(input.zkvmInput);
  if (input.targetAwsRuntime ?? false) {
    if (!deps.persistAsyncProverInput) {
      emitCanonicalEvent({
        event: 'finalize_transition_attempted',
        to: 'failed',
        source: 'finalize',
        reason: 'PROVER_INPUT_PERSISTENCE_UNAVAILABLE',
        ...correlation,
      });
      if (typeof deps.store.markFinalizationFailed === 'function') {
        try {
          await deps.store.markFinalizationFailed(input.sessionId, {
            executionId,
            queuedAt,
            contractGeneration: input.contractGeneration,
            failedAt: (deps.now ?? Date.now)(),
            error: {
              code: 'PROVER_INPUT_PERSISTENCE_UNAVAILABLE',
              message: 'Target async prover input persistence is unavailable',
            },
            observability: {
              source: 'finalize',
              reason: 'PROVER_INPUT_PERSISTENCE_UNAVAILABLE',
            },
          });
        } catch (markError) {
          logger.error('[API] Failed to mark finalization as failed after missing input persistence', markError);
        }
      }
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.INTERNAL_ERROR,
          details: { details: 'Target async prover input persistence is not configured' },
        },
      };
    }
    try {
      await deps.persistAsyncProverInput({
        sessionId: input.sessionId,
        executionId,
        contractGeneration: input.contractGeneration,
        ...omitUndefinedProperties({ zkvmInput: input.zkvmInput }),
        electionConfig: input.electionConfig,
      });
    } catch (error) {
      logger.error('[API] Failed to persist target async prover input', error);

      if (typeof deps.store.markFinalizationFailed === 'function') {
        emitCanonicalEvent({
          event: 'finalize_transition_attempted',
          to: 'failed',
          source: 'finalize',
          reason: 'PROVER_INPUT_UPLOAD_FAILED',
          ...correlation,
        });
        try {
          await deps.store.markFinalizationFailed(input.sessionId, {
            executionId,
            queuedAt,
            contractGeneration: input.contractGeneration,
            failedAt: (deps.now ?? Date.now)(),
            error: {
              code: 'PROVER_INPUT_UPLOAD_FAILED',
              message: error instanceof Error ? error.message : 'Failed to persist target async prover input',
            },
            observability: {
              source: 'finalize',
              reason: 'PROVER_INPUT_UPLOAD_FAILED',
            },
          });
        } catch (markError) {
          logger.error('[API] Failed to mark finalization as failed after input upload error', markError);
        }
      }

      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.INTERNAL_ERROR,
          details: { details: 'Failed to persist target async prover input' },
        },
      };
    }
  }

  const message = createFinalizationWorkItem({
    sessionId: input.sessionId,
    contractGeneration: input.contractGeneration,
    executionId,
    queuedAt,
    expectedImageId: input.expectedImageId,
    ...omitUndefinedProperties({ zkvmInput: (input.targetAwsRuntime ?? false) ? undefined : input.zkvmInput }),
    ...omitUndefinedProperties({
      zkvmInputCommitment: (input.targetAwsRuntime ?? false) ? undefined : zkvmInputCommitment,
      electionConfig: (input.targetAwsRuntime ?? false) ? undefined : input.electionConfig,
    }),
    scenarios: input.scenarios.map(toScenarioCode),
    simulateTampering: false,
    ...omitUndefinedProperties({ scenarioContext: input.scenarioContext }),
  });

  try {
    await deps.finalizationQueue.publish(message, input.publishMaxAttempts);
  } catch (error) {
    logger.error('[API] Failed to publish finalize job', error);

    if (typeof deps.store.markFinalizationFailed === 'function') {
      emitCanonicalEvent({
        event: 'finalize_transition_attempted',
        to: 'failed',
        source: 'finalize',
        reason: 'SQS_PUBLISH_FAILED',
        ...correlation,
      });
      try {
        await deps.store.markFinalizationFailed(input.sessionId, {
          executionId,
          queuedAt,
          contractGeneration: input.contractGeneration,
          failedAt: (deps.now ?? Date.now)(),
          error: {
            code: 'SQS_PUBLISH_FAILED',
            message: error instanceof Error ? error.message : 'Failed to enqueue finalization job',
          },
          observability: {
            source: 'finalize',
            reason: 'SQS_PUBLISH_FAILED',
          },
        });
      } catch (markError) {
        logger.error('[API] Failed to mark finalization as failed after publish error', markError);
      }
    }

    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: { details: 'Failed to enqueue finalization job' },
      },
    };
  }

  return {
    ok: true,
    value: {
      payload: {
        executionId,
        state: finalizationState,
      },
      state: finalizationState,
    },
  };
}
