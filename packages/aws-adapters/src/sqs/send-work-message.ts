import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
const SQS_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A queue acknowledgement is successful only when SQS supplies an admissible message ID. */
export async function sendWorkMessage(client: SQSClient, queueUrl: string, payload: string): Promise<string> {
  const response = await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: payload }));
  if (!response.MessageId || !SQS_MESSAGE_ID_PATTERN.test(response.MessageId)) {
    throw new Error('SQS publish response did not include a valid message ID');
  }
  return response.MessageId;
}
