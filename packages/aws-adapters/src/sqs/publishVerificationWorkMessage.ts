import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  VERIFICATION_WORK_MESSAGE_VERSION,
  parseVerificationWorkMessage,
  type VerificationWorkMessage,
} from '@stark-ballot/aws-adapters/sqs/verificationWorkMessage';

let sqsClient: SQSClient | null = null;

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
  await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: payload,
    }),
  );
}
