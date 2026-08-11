import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  VERIFICATION_WORK_RECORD_TYPE,
  parseVerificationWorkMessage,
  type VerificationWorkMessage,
} from '@stark-ballot/aws-adapters/sqs/verificationWorkMessage';
import { emitCanonicalEvent } from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

let sqsClient: SQSClient | null = null;
const SQS_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function getSqsClient(region: string): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({ region });
  }
  return sqsClient;
}

export function setVerificationSqsClient(client: SQSClient | null): void {
  sqsClient = client;
}

export async function publishVerificationWorkMessage(
  profile: ResolvedRuntimeProfile,
  message: Omit<VerificationWorkMessage, 'recordType'>,
): Promise<void> {
  const correlation = {
    session_id_hash: hashSessionIdForLogging(message.sessionId),
    finalization_id: message.finalizationId,
  } as const;

  try {
    if (profile.external.kind !== 'aws') {
      throw new Error('Verification work publication requires a target AWS runtime profile.');
    }
    const queueUrl = profile.external.asyncRuntime.verificationWorkQueueUrl;
    const payload = JSON.stringify(
      parseVerificationWorkMessage({
        recordType: VERIFICATION_WORK_RECORD_TYPE,
        ...message,
      }),
    );
    const response = await getSqsClient(profile.external.region).send(
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
      queue: 'verification',
      result: 'succeeded',
      sqs_message_id: response.MessageId,
      ...correlation,
    });
  } catch (error) {
    emitCanonicalEvent({
      event: 'queue_publish',
      queue: 'verification',
      result: 'failed',
      ...correlation,
    });
    throw error;
  }
}
