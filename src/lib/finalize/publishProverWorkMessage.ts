import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { ProverWorkMessage } from './types';

let sqsClient: SQSClient | null = null;

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

export async function publishProverWorkMessage(message: ProverWorkMessage): Promise<void> {
  const queueUrl = process.env.PROVER_WORK_QUEUE_URL;
  if (!queueUrl) {
    throw new Error('PROVER_WORK_QUEUE_URL is not configured');
  }

  const payload = JSON.stringify(message);
  const client = getSqsClient();
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: payload,
    }),
  );
}
