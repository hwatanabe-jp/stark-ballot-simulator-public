import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: emitCanonicalEventMock,
}));

import { publishVerificationWorkMessage, setVerificationSqsClient } from './publishVerificationWorkMessage';

describe('publishVerificationWorkMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setVerificationSqsClient(null);
    vi.unstubAllEnvs();
  });

  it('publishes standard SQS messages without FIFO-only fields', async () => {
    vi.stubEnv('VERIFICATION_WORK_QUEUE_URL', 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify');
    const send = vi.fn().mockResolvedValue({ MessageId: 'verification-message-id' });
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
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'verification',
      result: 'succeeded',
      sqs_message_id: 'verification-message-id',
      session_id_hash: hashSessionIdForLogging('550e8400-e29b-41d4-a716-446655440000'),
      execution_id: 'exec-standard-queue',
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('bundle.zip');
  });

  it('emits a failed publish event and preserves the SQS error', async () => {
    vi.stubEnv('VERIFICATION_WORK_QUEUE_URL', 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify');
    const send = vi.fn().mockRejectedValue(new Error('SQS unavailable'));
    setVerificationSqsClient({ send } as never);

    await expect(
      publishVerificationWorkMessage({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        executionId: 'exec-failed-queue',
        queuedAt: 1_700_000_000_000,
        bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-failed-queue/bundle.zip',
        expectedImageId: `0x${'1'.repeat(64)}`,
      }),
    ).rejects.toThrow('SQS unavailable');

    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'verification',
      result: 'failed',
      session_id_hash: hashSessionIdForLogging('550e8400-e29b-41d4-a716-446655440000'),
      execution_id: 'exec-failed-queue',
    });
  });

  it('fails closed when SQS returns an invalid message id', async () => {
    vi.stubEnv('VERIFICATION_WORK_QUEUE_URL', 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify');
    const send = vi.fn().mockResolvedValue({ MessageId: 'contains spaces' });
    setVerificationSqsClient({ send } as never);

    await expect(
      publishVerificationWorkMessage({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        executionId: 'exec-invalid-message-id',
        queuedAt: 1_700_000_000_000,
        bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-invalid-message-id/bundle.zip',
        expectedImageId: `0x${'1'.repeat(64)}`,
      }),
    ).rejects.toThrow('valid message ID');

    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'verification',
      result: 'failed',
      session_id_hash: hashSessionIdForLogging('550e8400-e29b-41d4-a716-446655440000'),
      execution_id: 'exec-invalid-message-id',
    });
  });
});
