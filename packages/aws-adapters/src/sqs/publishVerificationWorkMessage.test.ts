import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishVerificationWorkMessage, setVerificationSqsClient } from './publishVerificationWorkMessage';

describe('publishVerificationWorkMessage', () => {
  afterEach(() => {
    setVerificationSqsClient(null);
    vi.unstubAllEnvs();
  });

  it('publishes standard SQS messages without FIFO-only fields', async () => {
    vi.stubEnv('VERIFICATION_WORK_QUEUE_URL', 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify');
    const send = vi.fn().mockResolvedValue({});
    setVerificationSqsClient({ send } as never);

    await publishVerificationWorkMessage({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      executionId: 'exec-standard-queue',
      queuedAt: 1_700_000_000_000,
      bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-standard-queue/bundle.zip',
      expectedImageId: `0x${'1'.repeat(64)}`,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [SendMessageCommand];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input).toMatchObject({
      QueueUrl: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify',
    });
    expect(command.input).not.toHaveProperty('MessageDeduplicationId');
    expect(command.input).not.toHaveProperty('MessageGroupId');
    expect(JSON.parse(String(command.input.MessageBody))).toMatchObject({
      messageVersion: 'v1',
      executionId: 'exec-standard-queue',
    });
  });
});
