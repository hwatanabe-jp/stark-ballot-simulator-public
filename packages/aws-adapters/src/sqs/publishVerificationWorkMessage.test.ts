import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { targetRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());
const defaultSqsClientMock = vi.hoisted(() => ({
  configs: [] as unknown[],
  send: vi.fn(),
}));

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: emitCanonicalEventMock,
}));
vi.mock('@aws-sdk/client-sqs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sqs')>();
  return {
    ...actual,
    SQSClient: class {
      readonly send = defaultSqsClientMock.send;

      constructor(config: unknown) {
        defaultSqsClientMock.configs.push(config);
      }
    },
  };
});

import { publishVerificationWorkMessage, setVerificationSqsClient } from './publishVerificationWorkMessage';

describe('publishVerificationWorkMessage', () => {
  const profile = targetRuntimeProfile();
  if (profile.external.kind !== 'aws') {
    throw new Error('Expected target runtime profile');
  }
  const region = profile.external.region;
  const queueUrl = profile.external.asyncRuntime.verificationWorkQueueUrl;

  beforeEach(() => {
    vi.clearAllMocks();
    defaultSqsClientMock.configs.length = 0;
    vi.stubEnv('VERIFICATION_WORK_QUEUE_URL', 'https://sqs.invalid.example/untrusted');
  });

  afterEach(() => {
    setVerificationSqsClient(null);
    vi.unstubAllEnvs();
  });

  it('constructs the default SQS client in the injected target region', async () => {
    defaultSqsClientMock.send.mockResolvedValue({ MessageId: 'default-verification-message' });

    await publishVerificationWorkMessage(profile, {
      sessionId: asSessionId('550e8400-e29b-41d4-a716-446655440000'),
      finalizationId: asFinalizationId('exec-default-client'),
      queuedAtMs: 1_700_000_000_000,
      bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-default-client/bundle.zip',
      expectedImageId: `0x${'1'.repeat(64)}`,
    });

    expect(defaultSqsClientMock.configs).toEqual([{ region }]);
  });

  it('publishes standard SQS messages without FIFO-only fields', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'verification-message-id' });
    setVerificationSqsClient({ send } as never);

    await publishVerificationWorkMessage(profile, {
      sessionId: asSessionId('550e8400-e29b-41d4-a716-446655440000'),
      finalizationId: asFinalizationId('exec-standard-queue'),
      queuedAtMs: 1_700_000_000_000,
      bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-standard-queue/bundle.zip',
      expectedImageId: `0x${'1'.repeat(64)}`,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as [SendMessageCommand];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input).toMatchObject({
      QueueUrl: queueUrl,
    });
    expect(command.input).not.toHaveProperty('MessageDeduplicationId');
    expect(command.input).not.toHaveProperty('MessageGroupId');
    expect(JSON.parse(String(command.input.MessageBody))).toMatchObject({
      recordType: 'verification-work',
      finalizationId: 'exec-standard-queue',
    });
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'verification',
      result: 'succeeded',
      sqs_message_id: 'verification-message-id',
      session_id_hash: hashSessionIdForLogging('550e8400-e29b-41d4-a716-446655440000'),
      finalization_id: 'exec-standard-queue',
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('bundle.zip');
  });

  it('emits a failed publish event and preserves the SQS error', async () => {
    const send = vi.fn().mockRejectedValue(new Error('SQS unavailable'));
    setVerificationSqsClient({ send } as never);

    await expect(
      publishVerificationWorkMessage(profile, {
        sessionId: asSessionId('550e8400-e29b-41d4-a716-446655440000'),
        finalizationId: asFinalizationId('exec-failed-queue'),
        queuedAtMs: 1_700_000_000_000,
        bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-failed-queue/bundle.zip',
        expectedImageId: `0x${'1'.repeat(64)}`,
      }),
    ).rejects.toThrow('SQS unavailable');

    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'verification',
      result: 'failed',
      session_id_hash: hashSessionIdForLogging('550e8400-e29b-41d4-a716-446655440000'),
      finalization_id: 'exec-failed-queue',
    });
  });

  it('fails closed when SQS returns an invalid message id', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'contains spaces' });
    setVerificationSqsClient({ send } as never);

    await expect(
      publishVerificationWorkMessage(profile, {
        sessionId: asSessionId('550e8400-e29b-41d4-a716-446655440000'),
        finalizationId: asFinalizationId('exec-invalid-message-id'),
        queuedAtMs: 1_700_000_000_000,
        bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-invalid-message-id/bundle.zip',
        expectedImageId: `0x${'1'.repeat(64)}`,
      }),
    ).rejects.toThrow('valid message ID');

    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'verification',
      result: 'failed',
      session_id_hash: hashSessionIdForLogging('550e8400-e29b-41d4-a716-446655440000'),
      finalization_id: 'exec-invalid-message-id',
    });
  });
});
