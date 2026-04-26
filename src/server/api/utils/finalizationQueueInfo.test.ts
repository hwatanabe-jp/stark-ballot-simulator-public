import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { FinalizationState } from '@/types/server';
import { _setSqsClient, buildFinalizationQueueInfo } from '@/server/api/utils/finalizationQueueInfo';
import { logger } from '@/lib/utils/logger';

const originalEnv = { ...process.env };

const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
};

const sendMock = vi.fn();
const mockSqsClient = { send: sendMock } as unknown as SQSClient;

describe('buildFinalizationQueueInfo', () => {
  let warnSpy: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    vi.unstubAllEnvs();
    restoreEnv();
    sendMock.mockReset();
    _setSqsClient(mockSqsClient);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSqsClient(null);
    vi.unstubAllEnvs();
    restoreEnv();
    warnSpy.mockRestore();
  });

  it('returns null when queueUrl is missing', async () => {
    const state: FinalizationState = {
      status: 'pending',
      executionId: 'exec',
      queuedAt: 1_730_000_000_000,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: undefined, state });

    expect(queueInfo).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns null for pending state when queue depth is zero', async () => {
    sendMock.mockResolvedValue({
      Attributes: {
        ApproximateNumberOfMessages: '0',
        ApproximateNumberOfMessagesNotVisible: '0',
        ApproximateNumberOfMessagesDelayed: '0',
      },
    });

    const state: FinalizationState = {
      status: 'pending',
      executionId: 'exec',
      queuedAt: 1_730_000_000_000,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: 'https://example.com/queue', state });

    expect(queueInfo).toBeNull();
  });

  it('builds queue estimates for pending state using concurrency override', async () => {
    process.env.PROVER_LAMBDA_CONCURRENCY = '4';

    sendMock.mockResolvedValue({
      Attributes: {
        ApproximateNumberOfMessages: '5',
        ApproximateNumberOfMessagesNotVisible: '1',
        ApproximateNumberOfMessagesDelayed: '0',
      },
    });

    const queuedAt = 1_730_000_000_000;
    const state: FinalizationState = {
      status: 'pending',
      executionId: 'exec',
      queuedAt,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: 'https://example.com/queue', state });

    expect(queueInfo).toEqual({
      position: 6,
      depth: 6,
      concurrencyLimit: 4,
      estimatedStartAt: queuedAt + 360000,
      estimatedDurationMs: 360000,
      estimatedCompletionAt: queuedAt + 720000,
    });
  });

  it('uses startedAt for running state estimates', async () => {
    process.env.PROVER_LAMBDA_CONCURRENCY = '2';

    sendMock.mockResolvedValue({
      Attributes: {
        ApproximateNumberOfMessages: '1',
        ApproximateNumberOfMessagesNotVisible: '1',
        ApproximateNumberOfMessagesDelayed: '0',
      },
    });

    const queuedAt = 1_730_000_000_000;
    const startedAt = queuedAt + 1500;
    const state: FinalizationState = {
      status: 'running',
      executionId: 'exec',
      queuedAt,
      startedAt,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: 'https://example.com/queue', state });

    expect(queueInfo).toEqual({
      position: 0,
      depth: 2,
      concurrencyLimit: 2,
      estimatedStartAt: startedAt,
      estimatedDurationMs: 360000,
      estimatedCompletionAt: startedAt + 360000,
    });
  });

  it('returns null when queue attribute lookup fails', async () => {
    sendMock.mockRejectedValue(new Error('SQS unavailable'));

    const state: FinalizationState = {
      status: 'pending',
      executionId: 'exec',
      queuedAt: 1_730_000_000_000,
    };

    const queueInfo = await buildFinalizationQueueInfo({ queueUrl: 'https://example.com/queue', state });

    expect(queueInfo).toBeNull();
  });
});
