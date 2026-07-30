import { DescribeExecutionCommand, SFNClient, StartExecutionCommand, type ExecutionStatus } from '@aws-sdk/client-sfn';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { parseProverWorkMessage } from '@stark-ballot/aws-adapters/sqs/proverWorkMessage';
import { validateAsyncProverArtifactKeys } from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import { parseAwsFinalizationRuntimeState } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { emitCanonicalEvent, type DispatchDropReason } from '@stark-ballot/diagnostics/canonicalEvents';
import { RuntimeConfigValidationError, bootstrapLambdaRuntime, type RuntimeConfigName } from '../runtimeBootstrap.js';

const sfnClient = new SFNClient({});
type ParsedProverWorkMessage = ReturnType<typeof parseProverWorkMessage>;
type AwsFinalizationRuntimeState = ReturnType<typeof parseAwsFinalizationRuntimeState>;
type SqsEvent = { Records: Array<{ body: string }> };

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

function validateProofDispatcherConfig(): void {
  const invalidNames: RuntimeConfigName[] = [];
  if (process.env['TARGET_AWS_RUNTIME'] !== '1') {
    invalidNames.push('TARGET_AWS_RUNTIME');
  }
  if (!process.env['PROVER_STATE_MACHINE_ARN']?.trim()) {
    invalidNames.push('PROVER_STATE_MACHINE_ARN');
  }
  if (invalidNames.length > 0) {
    const message = invalidNames.includes('TARGET_AWS_RUNTIME')
      ? 'TARGET_AWS_RUNTIME=1 is required for target prover dispatch'
      : 'PROVER_STATE_MACHINE_ARN is required for target prover dispatch';
    throw new RuntimeConfigValidationError(invalidNames, undefined, message);
  }
}

function isSqsEvent(value: unknown): value is SqsEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { Records?: unknown }).Records) &&
    (value as { Records: unknown[] }).Records.every(
      (record) =>
        typeof record === 'object' && record !== null && typeof (record as { body?: unknown }).body === 'string',
    )
  );
}

function logInvalidSqsInvocation(reason: 'event_shape_invalid' | 'record_body_invalid'): void {
  logger.warn('Invocation payload is invalid', {
    event: 'invocation_invalid',
    source_kind: 'sqs',
    reason,
  });
}

function emitDispatchDropped(reason: DispatchDropReason, message?: ParsedProverWorkMessage): void {
  emitCanonicalEvent({
    event: 'dispatch_dropped',
    reason,
    ...(message
      ? {
          session_id_hash: hashSessionIdForLogging(message.sessionId),
          execution_id: message.executionId,
        }
      : {}),
  });
}

function resolveStateDropReason(
  finalizationState: AwsFinalizationRuntimeState,
  executionId: string,
): DispatchDropReason {
  if (!finalizationState) {
    return 'not_pending';
  }
  if (finalizationState.executionId !== executionId) {
    return 'already_processed';
  }
  if (finalizationState.status === 'running') {
    return 'already_dispatched';
  }
  return 'not_pending';
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

export const handler = async (rawEvent: unknown): Promise<{ batchItemFailures: [] }> => {
  await bootstrapLambdaRuntime({
    serviceName: 'proof-dispatcher',
    resolveRuntimeReferences: async (invalidNameCollector) => {
      await ensureAwsRuntimeConfigReferencesLoaded('proof_dispatcher', { invalidNameCollector });
    },
    validationSteps: [
      {
        validate: validateTargetObservabilityEnv,
      },
      {
        validate: validateProofDispatcherConfig,
      },
      {
        validate: validateEnv,
      },
    ],
  });

  if (!isSqsEvent(rawEvent)) {
    logInvalidSqsInvocation('event_shape_invalid');
    emitDispatchDropped('malformed');
    throw new Error('Invalid SQS invocation');
  }

  const stateMachineArn = process.env['PROVER_STATE_MACHINE_ARN'];
  if (!stateMachineArn) throw new Error('PROVER_STATE_MACHINE_ARN is required for target prover dispatch');

  const store = getGlobalStore();

  for (const record of rawEvent.Records) {
    let message: ParsedProverWorkMessage;
    try {
      message = parseProverWorkMessage(JSON.parse(record.body));
    } catch {
      logInvalidSqsInvocation('record_body_invalid');
      emitDispatchDropped('malformed');
      throw new Error('Invalid SQS invocation');
    }

    let artifactKeys: ReturnType<typeof resolveTargetArtifactKeys>;
    try {
      artifactKeys = resolveTargetArtifactKeys(message);
    } catch (error) {
      logInvalidSqsInvocation('record_body_invalid');
      emitDispatchDropped('malformed', message);
      throw error;
    }
    const session = await store.getSession(message.sessionId);
    const rawFinalizationState = session?.finalizationState;
    const finalizationState = parseAwsFinalizationRuntimeState(rawFinalizationState);

    if (session && !finalizationState && hasFinalizationState(rawFinalizationState)) {
      logger.warn('[ProofDispatcher] Dropping finalization work item with unparsable finalization state', {
        session_id_hash: hashSessionIdForLogging(message.sessionId),
        executionId: message.executionId,
        reason: 'finalization_state_unparsable',
      });
      emitDispatchDropped('malformed', message);
      continue;
    }

    if (!session || !shouldDispatchFinalizationWork(finalizationState, message.executionId)) {
      logger.info('[ProofDispatcher] Dropping stale finalization work item', {
        session_id_hash: hashSessionIdForLogging(message.sessionId),
        executionId: message.executionId,
        currentExecutionId: finalizationState?.executionId,
        currentStatus: finalizationState?.status,
        reason: session ? 'finalization_state_not_pending_for_execution' : 'session_not_found',
      });
      emitDispatchDropped(
        session ? resolveStateDropReason(finalizationState, message.executionId) : 'session_missing',
        message,
      );
      continue;
    }

    emitCanonicalEvent({
      event: 'finalize_transition_attempted',
      to: 'running',
      source: 'proof_dispatcher',
      reason: 'DISPATCH_REQUESTED',
      session_id_hash: hashSessionIdForLogging(message.sessionId),
      execution_id: message.executionId,
    });
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
            session_id_hash: hashSessionIdForLogging(message.sessionId),
            executionId: message.executionId,
            currentExecutionId: freshFinalizationState?.executionId,
            currentStatus: freshFinalizationState?.status,
            reason: freshSession ? 'finalization_state_not_pending_for_execution' : 'session_not_found',
          });
          emitDispatchDropped(freshSession ? 'already_processed' : 'session_missing', message);
          continue;
        }
        const executionStatus = await describeExistingExecutionStatus(stateMachineArn, message.executionId);
        if (executionStatus === 'RUNNING') {
          logger.info('[ProofDispatcher] Treating existing open Step Functions execution as already dispatched', {
            session_id_hash: hashSessionIdForLogging(message.sessionId),
            executionId: message.executionId,
            currentStatus: freshFinalizationState.status,
            executionStatus,
          });
          emitDispatchDropped('already_dispatched', message);
          continue;
        }
        logger.warn(
          '[ProofDispatcher] Step Functions execution already exists but finalization is still pending and execution is closed',
          {
            session_id_hash: hashSessionIdForLogging(message.sessionId),
            executionId: message.executionId,
            currentStatus: freshFinalizationState.status,
            executionStatus,
          },
        );
        emitCanonicalEvent({
          event: 'finalize_transition_attempted',
          to: 'running',
          source: 'proof_dispatcher',
          reason: 'STEP_FUNCTIONS_EXECUTION_CLOSED',
          session_id_hash: hashSessionIdForLogging(message.sessionId),
          execution_id: message.executionId,
        });
      }
      throw error;
    }
  }

  return { batchItemFailures: [] };
};
