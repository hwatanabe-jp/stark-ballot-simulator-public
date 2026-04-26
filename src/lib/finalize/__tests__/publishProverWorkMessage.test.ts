import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROVER_WORK_MESSAGE_VERSION, type ProverWorkMessage } from '@/lib/finalize/types';
import { buildDefaultElectionConfig, hashElectionConfig } from '@/lib/zkvm/election-config';

const sqsState = vi.hoisted(() => ({
  clients: [] as Array<{ config: unknown; send: ReturnType<typeof vi.fn> }>,
  sendQueue: [] as Array<ReturnType<typeof vi.fn>>,
}));

const SQSClientMock = vi.hoisted(
  () =>
    class {
      config: unknown;
      send: ReturnType<typeof vi.fn>;

      constructor(config: unknown) {
        this.config = config;
        this.send = sqsState.sendQueue.shift() ?? vi.fn();
        sqsState.clients.push(this);
      }
    },
);

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: SQSClientMock,
  SendMessageCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { publishProverWorkMessage, resetSqsClients } from '@/lib/finalize/publishProverWorkMessage';

const baseElectionConfig = {
  ...buildDefaultElectionConfig(),
  totalExpected: 1,
  botCount: 0,
};

const baseMessage: ProverWorkMessage = {
  messageVersion: PROVER_WORK_MESSAGE_VERSION,
  sessionId: '00000000-0000-4000-8000-000000000001',
  contractGeneration: '2026-04-zkvm-current-v1',
  executionId: 'EXECUTION12345',
  queuedAt: 1730000000000,
  expectedImageId: '0x' + '1'.repeat(64),
  electionConfig: baseElectionConfig,
  zkvmInputCommitment: '0x' + '2'.repeat(64),
  scenarios: [],
  simulateTampering: false,
  requestMeta: {
    clientIp: '127.0.0.1',
    timestamp: 1730000000000,
    electionId: '00000000-0000-4000-8000-000000000002',
    userAgent: 'vitest',
  },
  zkvmInput: {
    electionId: '00000000-0000-4000-8000-000000000002',
    bulletinRoot: '0x' + '3'.repeat(64),
    treeSize: 1,
    logId: '0x' + '4'.repeat(64),
    timestamp: 1730000000000,
    totalExpected: 1,
    electionConfigHash: hashElectionConfig(baseElectionConfig),
    votes: [
      {
        commitment: '0x' + '6'.repeat(64),
        choice: 0,
        random: '0x' + '7'.repeat(64),
        index: 0,
        merklePath: ['0x' + '8'.repeat(64)],
      },
    ],
  },
};

describe('publishProverWorkMessage', () => {
  const queueUrl = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/queue';
  let originalQueueUrl: string | undefined;

  beforeEach(() => {
    sqsState.clients.length = 0;
    sqsState.sendQueue.length = 0;
    resetSqsClients();

    originalQueueUrl = process.env.PROVER_WORK_QUEUE_URL;
    process.env.PROVER_WORK_QUEUE_URL = queueUrl;
  });

  afterEach(() => {
    if (originalQueueUrl === undefined) {
      delete process.env.PROVER_WORK_QUEUE_URL;
    } else {
      process.env.PROVER_WORK_QUEUE_URL = originalQueueUrl;
    }
  });

  it('publishes with the default SQS client', async () => {
    sqsState.sendQueue.push(vi.fn().mockResolvedValueOnce({}));

    await publishProverWorkMessage(baseMessage);

    expect(sqsState.clients).toHaveLength(1);
    expect(sqsState.clients[0]?.send).toHaveBeenCalledTimes(1);
  });

  it('rethrows credentials provider errors', async () => {
    const credentialError = Object.assign(new Error('Could not load credentials from any providers'), {
      name: 'CredentialsProviderError',
    });
    sqsState.sendQueue.push(vi.fn().mockRejectedValueOnce(credentialError));

    await expect(publishProverWorkMessage(baseMessage)).rejects.toThrow('Could not load credentials');

    expect(sqsState.clients).toHaveLength(1);
  });

  it('rethrows non-credential errors', async () => {
    const outageError = new Error('SQS outage');
    sqsState.sendQueue.push(vi.fn().mockRejectedValueOnce(outageError));

    await expect(publishProverWorkMessage(baseMessage)).rejects.toThrow('SQS outage');

    expect(sqsState.clients).toHaveLength(1);
  });

  it('fails when PROVER_WORK_QUEUE_URL is not configured', async () => {
    delete process.env.PROVER_WORK_QUEUE_URL;

    await expect(publishProverWorkMessage(baseMessage)).rejects.toThrow('PROVER_WORK_QUEUE_URL is not configured');
    expect(sqsState.clients).toHaveLength(0);
  });
});
