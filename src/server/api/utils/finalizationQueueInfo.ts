import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { FinalizationState } from '@/types/server';
import { logger } from '@/lib/utils/logger';

export type FinalizationQueueInfo = {
  position: number;
  depth: number;
  concurrencyLimit: number;
  estimatedStartAt?: number;
  estimatedDurationMs: number;
  estimatedCompletionAt?: number;
};

type QueueMetrics = {
  visible: number;
  notVisible: number;
  delayed: number;
};

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_ESTIMATED_DURATION_MS = 360000;

let sqsClient: SQSClient | null = null;

function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/**
 * Override the SQS client for tests.
 */
export function _setSqsClient(client: SQSClient | null): void {
  sqsClient = client;
}

function parseApproximateCount(value?: string): number {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function resolveConcurrencyLimit(): number {
  const raw = process.env.PROVER_LAMBDA_CONCURRENCY;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return DEFAULT_CONCURRENCY;
}

async function fetchQueueMetrics(queueUrl: string): Promise<QueueMetrics | null> {
  try {
    const client = getSqsClient();
    const response = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    );
    const attributes = response.Attributes ?? {};
    return {
      visible: parseApproximateCount(attributes.ApproximateNumberOfMessages),
      notVisible: parseApproximateCount(attributes.ApproximateNumberOfMessagesNotVisible),
      delayed: parseApproximateCount(attributes.ApproximateNumberOfMessagesDelayed),
    };
  } catch (error) {
    logger.warn('[Queue Info] Failed to fetch SQS queue attributes', error);
    return null;
  }
}

function computeDepth(metrics: QueueMetrics): number {
  return metrics.visible + metrics.notVisible + metrics.delayed;
}

function buildQueueEstimates(state: FinalizationState, metrics: QueueMetrics): FinalizationQueueInfo {
  const concurrencyLimit = resolveConcurrencyLimit();
  const estimatedDurationMs = DEFAULT_ESTIMATED_DURATION_MS;
  const depth = computeDepth(metrics);
  const isPending = state.status === 'pending';
  const isRunning = state.status === 'running';
  const isTerminal = state.status === 'succeeded' || state.status === 'failed' || state.status === 'timeout';

  let position = depth;
  if (isRunning || isTerminal) {
    position = 0;
  }

  let estimatedStartAt: number;
  if (isPending) {
    const slotsAhead = Math.max(position - 1, 0);
    const batchesAhead = Math.floor(slotsAhead / concurrencyLimit);
    estimatedStartAt = state.queuedAt + batchesAhead * estimatedDurationMs;
  } else {
    const startedAt = 'startedAt' in state ? state.startedAt : undefined;
    estimatedStartAt = typeof startedAt === 'number' ? startedAt : state.queuedAt;
  }

  const estimatedCompletionAt = estimatedStartAt + estimatedDurationMs;

  return {
    position,
    depth,
    concurrencyLimit,
    estimatedStartAt,
    estimatedDurationMs,
    estimatedCompletionAt,
  };
}

export async function buildFinalizationQueueInfo(params: {
  queueUrl?: string;
  state: FinalizationState;
}): Promise<FinalizationQueueInfo | null> {
  const { queueUrl, state } = params;
  if (!queueUrl) {
    return null;
  }

  const metrics = await fetchQueueMetrics(queueUrl);
  if (!metrics) {
    return null;
  }

  if (state.status === 'pending' && computeDepth(metrics) === 0) {
    return null;
  }

  return buildQueueEstimates(state, metrics);
}
