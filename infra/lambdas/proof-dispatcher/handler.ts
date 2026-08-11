import { DescribeExecutionCommand, SFNClient, StartExecutionCommand, type ExecutionStatus } from '@aws-sdk/client-sfn';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { parseProverWorkMessage } from '@stark-ballot/aws-adapters/sqs/proverWorkMessage';
import { validateAsyncProverArtifactKeys } from '@stark-ballot/aws-adapters/finalize/async-prover-artifacts';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import { ensureAwsRuntimeConfigReferencesLoaded } from '@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { validateTargetObservabilityEnv } from '@stark-ballot/runtime-config/env/observability';
import {
  resolveRuntimeProfile,
  type ResolvedRuntimeProfile,
  validateRuntimeProfileSelection,
} from '@stark-ballot/runtime-config/env/runtimeProfile';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { emitCanonicalEvent, type DispatchDropReason } from '@stark-ballot/diagnostics/canonicalEvents';
import { RuntimeConfigValidationError, bootstrapLambdaRuntime } from '../runtimeBootstrap.js';

type ParsedProverWorkMessage = ReturnType<typeof parseProverWorkMessage>;
type SqsEvent = { Records: Array<{ body: string }> };
let resolvedRuntimeProfile: ResolvedRuntimeProfile | undefined;
let sfnClient: SFNClient | undefined;

export const PROVER_STATE_MACHINE_INPUT_JSONPATHS = {
  inputS3Key: '$.inputS3Key',
  outputS3Prefix: '$.outputS3Prefix',
} as const;

function resolveTargetArtifactKeys(
  profile: ResolvedRuntimeProfile,
  message: ParsedProverWorkMessage,
): {
  inputS3Key: string;
  outputS3Prefix: string;
  bundleS3Key: string;
} {
  if (message.inputSource !== 's3') {
    throw new Error('Target prover work message requires the s3 input source');
  }
  return validateAsyncProverArtifactKeys({
    profile,
    sessionId: message.sessionId,
    finalizationId: message.finalizationId,
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
    recordType: message.recordType,
    inputSource: 's3',
    sessionId: message.sessionId,
    finalizationId: message.finalizationId,
    queuedAtMs: message.queuedAtMs,
    expectedImageId: message.expectedImageId,
    inputS3Key: artifactKeys.inputS3Key,
    outputS3Prefix: artifactKeys.outputS3Prefix,
    bundleS3Key: artifactKeys.bundleS3Key,
    scenarios: message.scenarios,
    simulateTampering: message.simulateTampering,
    scenarioContext: message.scenarioContext,
  };
}

function validateProofDispatcherConfig(profile: ResolvedRuntimeProfile): void {
  if (profile.name !== 'target-aws-async') {
    throw new RuntimeConfigValidationError(
      ['RUNTIME_PROFILE'],
      undefined,
      'RUNTIME_PROFILE=target-aws-async is required for target prover dispatch',
    );
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
          finalization_id: message.finalizationId,
        }
      : {}),
  });
}

function resolveStateDropReason(
  finalizationState: FinalizationState | null,
  finalizationId: string,
): DispatchDropReason {
  if (!finalizationState) {
    return 'not_pending';
  }
  if (finalizationState.finalizationId !== finalizationId) {
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
  state: FinalizationState | null,
  finalizationId: string,
): state is Extract<FinalizationState, { status: 'pending' }> {
  return state?.status === 'pending' && state.finalizationId === finalizationId;
}

async function describeExistingExecutionStatus(
  client: SFNClient,
  stateMachineArn: string,
  finalizationId: string,
): Promise<ExecutionStatus | 'NOT_FOUND' | 'UNKNOWN'> {
  try {
    const response = await client.send(
      new DescribeExecutionCommand({
        executionArn: buildExecutionArn(stateMachineArn, finalizationId),
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
  const env = process.env;
  const runtimeProfile = (resolvedRuntimeProfile ??= resolveRuntimeProfile(env));
  await bootstrapLambdaRuntime({
    serviceName: 'proof-dispatcher',
    runtimeProfile,
    resolveRuntimeReferences: async (invalidNameCollector) => {
      await ensureAwsRuntimeConfigReferencesLoaded('proof_dispatcher', {
        profile: runtimeProfile,
        invalidNameCollector,
        env,
      });
    },
    validationSteps: [
      {
        validate: () => validateRuntimeProfileSelection(runtimeProfile, env),
      },
      {
        validate: () => validateTargetObservabilityEnv(runtimeProfile, env),
      },
      {
        validate: () => validateProofDispatcherConfig(runtimeProfile),
      },
      {
        validate: () => validateEnv(runtimeProfile, env),
      },
    ],
    env,
  });

  if (runtimeProfile.name !== 'target-aws-async') {
    throw new Error('Target proof-dispatcher runtime profile was not resolved');
  }
  const stepFunctionsClient = (sfnClient ??= new SFNClient({ region: runtimeProfile.external.region }));

  if (!isSqsEvent(rawEvent)) {
    logInvalidSqsInvocation('event_shape_invalid');
    emitDispatchDropped('malformed');
    throw new Error('Invalid SQS invocation');
  }

  const stateMachineArn = runtimeProfile.external.asyncRuntime.proverStateMachineArn;

  const store = getGlobalStore(runtimeProfile);

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
      artifactKeys = resolveTargetArtifactKeys(runtimeProfile, message);
    } catch (error) {
      logInvalidSqsInvocation('record_body_invalid');
      emitDispatchDropped('malformed', message);
      throw error;
    }
    const currentRecord = await store.getCurrentFinalizationRecord(message.sessionId);
    const finalizationState = currentRecord?.state ?? null;

    if (!currentRecord || !shouldDispatchFinalizationWork(finalizationState, message.finalizationId)) {
      logger.info('[ProofDispatcher] Dropping stale finalization work item', {
        session_id_hash: hashSessionIdForLogging(message.sessionId),
        finalizationId: message.finalizationId,
        currentFinalizationId: finalizationState?.finalizationId,
        currentStatus: finalizationState?.status,
        reason: currentRecord ? 'finalization_state_not_pending_for_execution' : 'finalization_record_not_found',
      });
      emitDispatchDropped(
        currentRecord ? resolveStateDropReason(finalizationState, message.finalizationId) : 'session_missing',
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
      finalization_id: message.finalizationId,
    });
    try {
      await stepFunctionsClient.send(
        new StartExecutionCommand({
          stateMachineArn,
          name: message.finalizationId,
          input: JSON.stringify(buildStepFunctionsInput(message, artifactKeys)),
        }),
      );
    } catch (error) {
      if (isExecutionAlreadyExists(error)) {
        const freshRecord = await store.getCurrentFinalizationRecord(message.sessionId);
        const freshFinalizationState = freshRecord?.state ?? null;
        if (!shouldDispatchFinalizationWork(freshFinalizationState, message.finalizationId)) {
          logger.info('[ProofDispatcher] Treating existing Step Functions execution as processed after state re-read', {
            session_id_hash: hashSessionIdForLogging(message.sessionId),
            finalizationId: message.finalizationId,
            currentFinalizationId: freshFinalizationState?.finalizationId,
            currentStatus: freshFinalizationState?.status,
            reason: freshRecord ? 'finalization_state_not_pending_for_execution' : 'finalization_record_not_found',
          });
          emitDispatchDropped(freshRecord ? 'already_processed' : 'session_missing', message);
          continue;
        }
        const executionStatus = await describeExistingExecutionStatus(
          stepFunctionsClient,
          stateMachineArn,
          message.finalizationId,
        );
        if (executionStatus === 'RUNNING') {
          logger.info('[ProofDispatcher] Treating existing open Step Functions execution as already dispatched', {
            session_id_hash: hashSessionIdForLogging(message.sessionId),
            finalizationId: message.finalizationId,
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
            finalizationId: message.finalizationId,
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
          finalization_id: message.finalizationId,
        });
      }
      throw error;
    }
  }

  return { batchItemFailures: [] };
};
