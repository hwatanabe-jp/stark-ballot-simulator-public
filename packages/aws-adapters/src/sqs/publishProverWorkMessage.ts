import { sendWorkMessage } from './send-work-message';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { FinalizationWorkItem } from '@stark-ballot/application/finalize/finalization-work-item';
import { PROVER_WORK_RECORD_TYPE, ProverWorkMessageSchema } from './proverWorkMessage';
import { buildFinalizationArtifactS3Keys } from '@stark-ballot/aws-adapters/finalize/artifact-key-layout';
import { emitCanonicalEvent } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

let sqsClient: SQSClient | null = null;

function getSqsClient(region: string): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({ region });
  }
  return sqsClient;
}

function buildS3ProverPayload(
  message: FinalizationWorkItem & { inputSource: 's3' },
  proofArtifactPrefix: string,
): {
  inputS3Key: string;
  outputS3Prefix: string;
  bundleS3Key: string;
} {
  const { inputS3Key, outputS3Prefix, bundleS3Key } = buildFinalizationArtifactS3Keys(
    message.sessionId,
    message.finalizationId,
    proofArtifactPrefix,
  );
  return { inputS3Key, outputS3Prefix, bundleS3Key };
}

export function resetSqsClients(): void {
  sqsClient = null;
}

export async function publishProverWorkMessage(
  profile: ResolvedRuntimeProfile,
  message: FinalizationWorkItem,
): Promise<void> {
  const correlation = {
    session_id_hash: hashSessionIdForLogging(message.sessionId),
    finalization_id: message.finalizationId,
  } as const;

  try {
    if (profile.external.kind !== 'aws') {
      throw new Error('Prover work publication requires a target AWS runtime profile.');
    }
    const queueUrl = profile.external.asyncRuntime.proverWorkQueueUrl;
    const commonPayload = {
      recordType: PROVER_WORK_RECORD_TYPE,
      sessionId: message.sessionId,
      finalizationId: message.finalizationId,
      queuedAtMs: message.queuedAtMs,
      expectedImageId: message.expectedImageId,
      scenarios: message.scenarios,
      simulateTampering: message.simulateTampering,
      scenarioContext: message.scenarioContext,
    };
    const parsedMessage =
      message.inputSource === 'inline'
        ? ProverWorkMessageSchema.parse({
            ...commonPayload,
            inputSource: 'inline',
            zkvmInput: message.zkvmInput,
            ...omitUndefinedProperties({ zkvmInputCommitment: message.zkvmInputCommitment }),
            electionConfig: message.electionConfig,
          })
        : ProverWorkMessageSchema.parse({
            ...commonPayload,
            inputSource: 's3',
            ...buildS3ProverPayload(message, profile.external.artifactStorage.prefix),
          });
    const payload = JSON.stringify(parsedMessage);
    const messageId = await sendWorkMessage(getSqsClient(profile.external.region), queueUrl, payload);
    emitCanonicalEvent({
      event: 'queue_publish',
      queue: 'prover',
      result: 'succeeded',
      sqs_message_id: messageId,
      ...correlation,
    });
  } catch (error) {
    emitCanonicalEvent({
      event: 'queue_publish',
      queue: 'prover',
      result: 'failed',
      ...correlation,
    });
    throw error;
  }
}
