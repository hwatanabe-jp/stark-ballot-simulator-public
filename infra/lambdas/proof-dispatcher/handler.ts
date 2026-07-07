import { DescribeExecutionCommand, SFNClient, StartExecutionCommand, type ExecutionStatus } from '@aws-sdk/client-sfn';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { parseProverWorkMessage } from '@stark-ballot/aws-adapters/sqs/proverWorkMessage';
import { validateAsyncProverArtifactKeys } from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { parseAwsFinalizationRuntimeState } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { logger } from '@stark-ballot/diagnostics/logger';

const sfnClient = new SFNClient({});
type ParsedProverWorkMessage = ReturnType<typeof parseProverWorkMessage>;
type AwsFinalizationRuntimeState = ReturnType<typeof parseAwsFinalizationRuntimeState>;

export const PROVER_STATE_MACHINE_INPUT_JSONPATHS = {
  inputS3Key: '$.inputS3Key',
  outputS3Prefix: '$.outputS3Prefix',
} as const;

function resolveTargetArtifactKeys(message: ParsedProverWorkMessage): {
  inputS3Key: string;
  outputS3Prefix: string;
  bundleS3Key: string;
} {
  if (!message.inputS3Key || !message.outputS3Prefix || !message.bundleS3Key) {
    throw new Error('Target prover work message requires inputS3Key, outputS3Prefix, and bundleS3Key');
  }
  return validateAsyncProverArtifactKeys({
    sessionId: message.sessionId,
    executionId: message.executionId,
    inputS3Key: message.inputS3Key,
    outputS3Prefix: message.outputS3Prefix,
    bundleS3Key: message.bundleS3Key,
  });
}

function buildStepFunctionsInput(
  message: ParsedProverWorkMessage,
  artifactKeys: {
    inputS3Key: string;
    outputS3Prefix: string;
    bundleS3Key: string;
  },
): Record<string, unknown> {
  return {
    messageVersion: message.messageVersion,
    sessionId: message.sessionId,
    contractGeneration: message.contractGeneration,
    executionId: message.executionId,
    queuedAt: message.queuedAt,
    expectedImageId: message.expectedImageId,
    inputS3Key: artifactKeys.inputS3Key,
    outputS3Prefix: artifactKeys.outputS3Prefix,
    bundleS3Key: artifactKeys.bundleS3Key,
    scenarios: message.scenarios,
    simulateTampering: message.simulateTampering,
    scenarioContext: message.scenarioContext,
  };
}

function assertTargetAwsRuntime(): void {
  if (process.env['TARGET_AWS_RUNTIME'] !== '1') {
    throw new Error('TARGET_AWS_RUNTIME=1 is required for target prover dispatch');
  }
}

function isExecutionAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'ExecutionAlreadyExists');
}

function isExecutionDoesNotExist(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'ExecutionDoesNotExist');
}

function buildExecutionArn(stateMachineArn: string, executionName: string): string {
  return `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${executionName}`;
}

function shouldDispatchFinalizationWork(
  state: AwsFinalizationRuntimeState,
  executionId: string,
): state is NonNullable<AwsFinalizationRuntimeState> & { status: 'pending'; executionId: string } {
  return state?.status === 'pending' && state.executionId === executionId;
}

function hasFinalizationState(value: unknown): boolean {
  return value !== undefined;
}

async function describeExistingExecutionStatus(
  stateMachineArn: string,
  executionId: string,
): Promise<ExecutionStatus | 'NOT_FOUND' | 'UNKNOWN'> {
  try {
    const response = await sfnClient.send(
      new DescribeExecutionCommand({
        executionArn: buildExecutionArn(stateMachineArn, executionId),
      }),
    );
    return response.status ?? 'UNKNOWN';
  } catch (error) {
    if (isExecutionDoesNotExist(error)) {
      return 'NOT_FOUND';
    }
    throw error;
  }
}

export const handler = async (event: { Records?: Array<{ body?: string }> }): Promise<{ batchItemFailures: [] }> => {
  await ensureAwsRuntimeConfigReferencesLoaded('proof_dispatcher');
  assertTargetAwsRuntime();
  validateEnv();

  const stateMachineArn = process.env['PROVER_STATE_MACHINE_ARN'];
  if (!stateMachineArn) {
    throw new Error('PROVER_STATE_MACHINE_ARN is required for target prover dispatch');
  }

  const store = getGlobalStore();

  for (const record of event.Records ?? []) {
    const message = parseProverWorkMessage(JSON.parse(record.body ?? '{}'));
    const artifactKeys = resolveTargetArtifactKeys(message);
    const session = await store.getSession(message.sessionId);
    const rawFinalizationState = session?.finalizationState;
    const finalizationState = parseAwsFinalizationRuntimeState(rawFinalizationState);

    if (session && !finalizationState && hasFinalizationState(rawFinalizationState)) {
      logger.warn('[ProofDispatcher] Dropping finalization work item with unparsable finalization state', {
        sessionId: message.sessionId,
        executionId: message.executionId,
        reason: 'finalization_state_unparsable',
      });
      continue;
    }

    if (!session || !shouldDispatchFinalizationWork(finalizationState, message.executionId)) {
      logger.info('[ProofDispatcher] Dropping stale finalization work item', {
        sessionId: message.sessionId,
        executionId: message.executionId,
        currentExecutionId: finalizationState?.executionId,
        currentStatus: finalizationState?.status,
        reason: session ? 'finalization_state_not_pending_for_execution' : 'session_not_found',
      });
      continue;
    }

    try {
      await sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn,
          name: message.executionId,
          input: JSON.stringify(buildStepFunctionsInput(message, artifactKeys)),
        }),
      );
    } catch (error) {
      if (isExecutionAlreadyExists(error)) {
        const freshSession = await store.getSession(message.sessionId);
        const freshFinalizationState = parseAwsFinalizationRuntimeState(freshSession?.finalizationState);
        if (!shouldDispatchFinalizationWork(freshFinalizationState, message.executionId)) {
          logger.info('[ProofDispatcher] Treating existing Step Functions execution as processed after state re-read', {
            sessionId: message.sessionId,
            executionId: message.executionId,
            currentExecutionId: freshFinalizationState?.executionId,
            currentStatus: freshFinalizationState?.status,
            reason: freshSession ? 'finalization_state_not_pending_for_execution' : 'session_not_found',
          });
          continue;
        }
        const executionStatus = await describeExistingExecutionStatus(stateMachineArn, message.executionId);
        if (executionStatus === 'RUNNING') {
          logger.info('[ProofDispatcher] Treating existing open Step Functions execution as already dispatched', {
            sessionId: message.sessionId,
            executionId: message.executionId,
            currentStatus: freshFinalizationState.status,
            executionStatus,
          });
          continue;
        }
        logger.warn(
          '[ProofDispatcher] Step Functions execution already exists but finalization is still pending and execution is closed',
          {
            sessionId: message.sessionId,
            executionId: message.executionId,
            currentStatus: freshFinalizationState.status,
            executionStatus,
          },
        );
      }
      throw error;
    }
  }

  return { batchItemFailures: [] };
};
