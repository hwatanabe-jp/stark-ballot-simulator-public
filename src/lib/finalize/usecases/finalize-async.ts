import type { FinalizationQueue } from '@/lib/finalize/finalization-queue';
import { generateExecutionId } from '@/lib/finalize/execution-id';
import { buildStatusUrl } from '@/lib/finalize/finalize-urls';
import { ProverWorkMessageSchema, PROVER_WORK_MESSAGE_VERSION } from '@/lib/finalize/types';
import { computeInputCommitment } from '@/lib/zkvm/types';
import type { ElectionConfig } from '@/lib/zkvm/election-config';
import { ErrorCode } from '@/lib/errors/apiErrors';
import type { FinalizationScenarioContext, SessionData, FinalizationState } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import type { ZkVMInput } from '@/lib/zkvm/types';
import { logger } from '@/lib/utils/logger';
import { isCurrentArtifactBoundaryError } from '@/lib/contract';
import type { FinalizeAcceptedPayload, FinalizeSessionError, Result } from './types';

export interface FinalizeAsyncInput {
  sessionId: string;
  session: SessionData;
  contractGeneration: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  expectedImageId: string;
  scenarios: string[];
  scenarioContext?: FinalizationScenarioContext;
  publicBaseUrl: string;
  queueUrl: string;
  clientMeta: {
    clientIp: string;
    userAgent?: string;
    traceId?: string;
  };
  publishMaxAttempts: number;
}

export interface FinalizeAsyncDependencies {
  store: VoteStore;
  finalizationQueue: FinalizationQueue;
  now?: () => number;
  computeCommitment?: typeof computeInputCommitment;
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
        code: ErrorCode.INTERNAL_ERROR,
        details: { details: 'Store does not support async finalization' },
      },
    };
  }

  let finalizationState: FinalizationState;
  try {
    finalizationState = await deps.store.markFinalizationQueued(input.sessionId, {
      executionId,
      queuedAt,
      contractGeneration: input.contractGeneration,
      scenarioContext: input.scenarioContext,
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
    logger.error('[API] Failed to mark session as queued', error);
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.INTERNAL_ERROR,
        details: { details: 'Failed to update session finalization state' },
      },
    };
  }

  const requestMeta = {
    clientIp: input.clientMeta.clientIp,
    timestamp: queuedAt,
    electionId: input.session.electionId ?? '',
    userAgent: input.clientMeta.userAgent,
    traceId: input.clientMeta.traceId,
  };

  const zkvmInputCommitment = (deps.computeCommitment ?? computeInputCommitment)(input.zkvmInput);

  const message = ProverWorkMessageSchema.parse({
    messageVersion: PROVER_WORK_MESSAGE_VERSION,
    sessionId: input.sessionId,
    contractGeneration: input.contractGeneration,
    executionId,
    queuedAt,
    expectedImageId: input.expectedImageId,
    zkvmInput: input.zkvmInput,
    zkvmInputCommitment,
    electionConfig: input.electionConfig,
    scenarios: input.scenarios,
    simulateTampering: false,
    scenarioContext: input.scenarioContext,
    requestMeta,
  });

  try {
    await deps.finalizationQueue.publish(message, input.publishMaxAttempts);
  } catch (error) {
    logger.error('[API] Failed to publish finalize job', error);

    if (typeof deps.store.markFinalizationFailed === 'function') {
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
        });
      } catch (markError) {
        logger.error('[API] Failed to mark finalization as failed after publish error', markError);
      }
    }

    return {
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.INTERNAL_ERROR,
        details: { details: 'Failed to enqueue finalization job' },
      },
    };
  }

  return {
    ok: true,
    value: {
      payload: {
        executionId,
        statusUrl: buildStatusUrl(input.publicBaseUrl, input.sessionId),
        state: finalizationState,
      },
      state: finalizationState,
    },
  };
}
