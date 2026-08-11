import type { FinalizationQueue } from '@stark-ballot/application/finalize/finalization-queue';
import {
  createFinalizationWorkItem,
  type FinalizationScenarioCode,
} from '@stark-ballot/application/finalize/finalization-work-item';
import { computeInputCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import type {
  FinalizationId,
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { logger } from '@stark-ballot/diagnostics/logger';
import { emitCanonicalEvent } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { FinalizeAcceptedPayload, FinalizeSessionError, Result } from './types';

function toScenarioCode(value: string): FinalizationScenarioCode {
  if (value !== 'S0' && value !== 'S1' && value !== 'S2' && value !== 'S3' && value !== 'S4' && value !== 'S5') {
    throw new Error(`Unsupported scenario code: ${value}`);
  }
  return value;
}

export type PersistAsyncProverInput = (input: {
  sessionId: string;
  finalizationId: FinalizationId;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
}) => Promise<unknown>;

export interface FinalizeAsyncInput {
  sessionId: string;
  finalizationId: FinalizationId;
  queuedAtMs: number;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  expectedImageId: string;
  scenarios: string[];
  scenarioContext: FinalizationScenarioContext;
  publishMaxAttempts: number;
  inputSource: 'inline' | 's3';
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
    finalization_id: input.finalizationId,
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
    const finalizationRecord = await deps.store.markFinalizationQueued(input.sessionId, {
      finalizationId: input.finalizationId,
      queuedAtMs: input.queuedAtMs,
      scenarioContext: input.scenarioContext,
      observability: {
        source: 'finalize',
        reason: 'FINALIZE_REQUESTED',
      },
    });
    finalizationState = finalizationRecord.state;
  } catch {
    logger.error('[API] Failed to mark session as queued');
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: { details: 'Failed to update session finalization state' },
      },
    };
  }

  if (finalizationState.status !== 'pending' || finalizationState.finalizationId !== input.finalizationId) {
    return {
      ok: true,
      value: {
        payload: {
          finalizationId: finalizationState.finalizationId,
          state: finalizationState,
        },
        state: finalizationState,
      },
    };
  }

  const zkvmInputCommitment = (deps.computeCommitment ?? computeInputCommitment)(input.zkvmInput);
  if (input.inputSource === 's3') {
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
            finalizationId: input.finalizationId,
            queuedAtMs: input.queuedAtMs,
            failedAtMs: (deps.now ?? Date.now)(),
            error: {
              code: 'PROVER_INPUT_PERSISTENCE_UNAVAILABLE',
              message: 'Target async prover input persistence is unavailable',
            },
            observability: {
              source: 'finalize',
              reason: 'PROVER_INPUT_PERSISTENCE_UNAVAILABLE',
            },
          });
        } catch {
          logger.error('[API] Failed to mark finalization as failed after missing input persistence');
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
        finalizationId: input.finalizationId,
        zkvmInput: input.zkvmInput,
        electionConfig: input.electionConfig,
      });
    } catch {
      logger.error('[API] Failed to persist target async prover input');

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
            finalizationId: input.finalizationId,
            queuedAtMs: input.queuedAtMs,
            failedAtMs: (deps.now ?? Date.now)(),
            error: {
              code: 'PROVER_INPUT_UPLOAD_FAILED',
              message: 'Failed to persist target async prover input',
            },
            observability: {
              source: 'finalize',
              reason: 'PROVER_INPUT_UPLOAD_FAILED',
            },
          });
        } catch {
          logger.error('[API] Failed to mark finalization as failed after input upload error');
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

  const workItemCommon = {
    sessionId: input.sessionId,
    finalizationId: input.finalizationId,
    queuedAtMs: input.queuedAtMs,
    expectedImageId: input.expectedImageId,
    scenarios: input.scenarios.map(toScenarioCode),
    simulateTampering: false,
    scenarioContext: input.scenarioContext,
  };
  const message = createFinalizationWorkItem(
    input.inputSource === 's3'
      ? {
          ...workItemCommon,
          inputSource: 's3',
        }
      : {
          ...workItemCommon,
          inputSource: 'inline',
          zkvmInput: input.zkvmInput,
          zkvmInputCommitment,
          electionConfig: input.electionConfig,
        },
  );

  try {
    await deps.finalizationQueue.publish(message, input.publishMaxAttempts);
  } catch {
    logger.error('[API] Failed to publish finalize job');

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
          finalizationId: input.finalizationId,
          queuedAtMs: input.queuedAtMs,
          failedAtMs: (deps.now ?? Date.now)(),
          error: {
            code: 'SQS_PUBLISH_FAILED',
            message: 'Failed to enqueue finalization job',
          },
          observability: {
            source: 'finalize',
            reason: 'SQS_PUBLISH_FAILED',
          },
        });
      } catch {
        logger.error('[API] Failed to mark finalization as failed after publish error');
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
        finalizationId: input.finalizationId,
        state: finalizationState,
      },
      state: finalizationState,
    },
  };
}
