import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { FinalizationWorkItem } from '@stark-ballot/application/finalize/finalization-work-item';
import { PROVER_WORK_MESSAGE_VERSION, ProverWorkMessageSchema } from './proverWorkMessage';
import { buildFinalizationArtifactS3Keys } from '@stark-ballot/aws-adapters/finalize/artifact-key-layout';
import { emitCanonicalEvent } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

let sqsClient: SQSClient | null = null;
const SQS_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

export function setSqsClient(client: SQSClient | null): void {
  sqsClient = client;
}

export function resetSqsClients(): void {
  sqsClient = null;
}

export async function publishProverWorkMessage(message: FinalizationWorkItem): Promise<void> {
  const correlation = {
    session_id_hash: hashSessionIdForLogging(message.sessionId),
    execution_id: message.executionId,
  } as const;

  try {
    const queueUrl = process.env['PROVER_WORK_QUEUE_URL'];
    if (!queueUrl) {
      throw new Error('PROVER_WORK_QUEUE_URL is not configured');
    }
    const targetArtifactKeys =
      message.zkvmInput && message.electionConfig
        ? undefined
        : buildFinalizationArtifactS3Keys(message.sessionId, message.executionId, process.env['S3_PROOF_PREFIX']);

    const payload = JSON.stringify(
      ProverWorkMessageSchema.parse({
        messageVersion: PROVER_WORK_MESSAGE_VERSION,
        sessionId: message.sessionId,
        contractGeneration: message.contractGeneration,
        executionId: message.executionId,
        queuedAt: message.queuedAt,
        expectedImageId: message.expectedImageId,
        zkvmInput: message.zkvmInput,
        zkvmInputCommitment: message.zkvmInputCommitment,
        electionConfig: message.electionConfig,
        inputS3Key: targetArtifactKeys?.inputS3Key,
        outputS3Prefix: targetArtifactKeys?.outputS3Prefix,
        bundleS3Key: targetArtifactKeys?.bundleS3Key,
        scenarios: message.scenarios,
        simulateTampering: message.simulateTampering,
        scenarioContext: message.scenarioContext,
      }),
    );
    const response = await getSqsClient().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: payload,
      }),
    );
    if (!response.MessageId || !SQS_MESSAGE_ID_PATTERN.test(response.MessageId)) {
      throw new Error('SQS publish response did not include a valid message ID');
    }
    emitCanonicalEvent({
      event: 'queue_publish',
      queue: 'prover',
      result: 'succeeded',
      sqs_message_id: response.MessageId,
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
