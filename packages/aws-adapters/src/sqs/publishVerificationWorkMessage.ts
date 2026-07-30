import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  VERIFICATION_WORK_MESSAGE_VERSION,
  parseVerificationWorkMessage,
  type VerificationWorkMessage,
} from '@stark-ballot/aws-adapters/sqs/verificationWorkMessage';
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

export function setVerificationSqsClient(client: SQSClient | null): void {
  sqsClient = client;
}

export async function publishVerificationWorkMessage(
  message: Omit<VerificationWorkMessage, 'messageVersion'>,
): Promise<void> {
  const correlation = {
    session_id_hash: hashSessionIdForLogging(message.sessionId),
    execution_id: message.executionId,
  } as const;

  try {
    const queueUrl = process.env['VERIFICATION_WORK_QUEUE_URL'];
    if (!queueUrl) {
      throw new Error('VERIFICATION_WORK_QUEUE_URL is not configured');
    }
    const payload = JSON.stringify(
      parseVerificationWorkMessage({
        messageVersion: VERIFICATION_WORK_MESSAGE_VERSION,
        ...message,
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
