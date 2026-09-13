import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROVER_WORK_RECORD_TYPE } from '@stark-ballot/aws-adapters/sqs/proverWorkMessage';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationWorkItem } from '@stark-ballot/application/finalize/finalization-work-item';
import { buildDefaultElectionConfig, hashElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { targetRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: emitCanonicalEventMock,
}));

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

import { publishProverWorkMessage, resetSqsClients } from '@stark-ballot/aws-adapters/sqs/publishProverWorkMessage';

const baseElectionConfig = {
  ...buildDefaultElectionConfig(),
  totalExpected: 1,
  botCount: 0,
};

const baseMessage: FinalizationWorkItem = {
  inputSource: 'inline',
  sessionId: asSessionId('00000000-0000-4000-8000-000000000001'),
  finalizationId: asFinalizationId('EXECUTION12345'),
  queuedAtMs: 1730000000000,
  expectedImageId: '0x' + '1'.repeat(64),
  electionConfig: baseElectionConfig,
  zkvmInputCommitment: '0x' + '2'.repeat(64),
  scenarios: [],
  simulateTampering: false,
  scenarioContext: {
    scenarios: [],
    tamperMode: 'none',
    claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
    claimedTotalVotes: 1,
    summary: {
      ignoredCount: 0,
      recountedCount: 0,
      userRecountChoice: null,
    },
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
  const profile = targetRuntimeProfile();
  if (profile.external.kind !== 'aws') {
    throw new Error('Expected target runtime profile');
  }
  const region = profile.external.region;
  const queueUrl = profile.external.asyncRuntime.proverWorkQueueUrl;

  beforeEach(() => {
    sqsState.clients.length = 0;
    sqsState.sendQueue.length = 0;
    emitCanonicalEventMock.mockClear();
    resetSqsClients();
    vi.stubEnv('PROVER_WORK_QUEUE_URL', 'https://sqs.invalid.example/untrusted');
    vi.stubEnv('S3_PROOF_PREFIX', 'untrusted/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('publishes with the default SQS client', async () => {
    sqsState.sendQueue.push(
      vi.fn().mockResolvedValueOnce({
        MessageId: '35f6c6bc-0189-49df-9d7b-8a60f6f15dc5',
      }),
    );

    await publishProverWorkMessage(profile, baseMessage);

    expect(sqsState.clients).toHaveLength(1);
    expect(sqsState.clients[0]?.config).toEqual({ region });
    expect(sqsState.clients[0]?.send).toHaveBeenCalledTimes(1);
    const command = sqsState.clients[0]?.send.mock.calls[0]?.[0] as { input?: { MessageBody?: string } } | undefined;
    const body = JSON.parse(command?.input?.MessageBody ?? '{}') as Record<string, unknown>;
    expect(body['recordType']).toBe(PROVER_WORK_RECORD_TYPE);
    expect(body['inputSource']).toBe('inline');
    expect(body['sessionId']).toBe(baseMessage.sessionId);
    expect(body['zkvmInput']).toBeTruthy();
    expect(body).not.toHaveProperty('requestMeta');
    expect(body).not.toHaveProperty('contractGeneration');
    expect(body).not.toHaveProperty('inputS3Key');
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'prover',
      result: 'succeeded',
      sqs_message_id: '35f6c6bc-0189-49df-9d7b-8a60f6f15dc5',
      session_id_hash: hashSessionIdForLogging(baseMessage.sessionId),
      finalization_id: baseMessage.finalizationId,
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(baseMessage.sessionId);
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(queueUrl);
  });

  it('projects target S3 artifact keys at the AWS adapter boundary', async () => {
    sqsState.sendQueue.push(vi.fn().mockResolvedValueOnce({ MessageId: 'projected-artifact-message' }));

    await publishProverWorkMessage(profile, {
      inputSource: 's3',
      sessionId: baseMessage.sessionId,
      finalizationId: baseMessage.finalizationId,
      queuedAtMs: baseMessage.queuedAtMs,
      expectedImageId: baseMessage.expectedImageId,
      scenarios: baseMessage.scenarios,
      simulateTampering: baseMessage.simulateTampering,
      scenarioContext: baseMessage.scenarioContext,
    });

    const command = sqsState.clients[0]?.send.mock.calls[0]?.[0] as { input?: { MessageBody?: string } } | undefined;
    const body = JSON.parse(command?.input?.MessageBody ?? '{}') as Record<string, unknown>;
    expect(body['inputSource']).toBe('s3');
    expect(body['inputS3Key']).toBe(`sessions/${baseMessage.sessionId}/${baseMessage.finalizationId}/input.json`);
    expect(body['outputS3Prefix']).toBe(`sessions/${baseMessage.sessionId}/${baseMessage.finalizationId}`);
    expect(body['bundleS3Key']).toBe(`sessions/${baseMessage.sessionId}/${baseMessage.finalizationId}/bundle.zip`);
    expect(body).not.toHaveProperty('requestMeta');
    expect(body).not.toHaveProperty('contractGeneration');
  });

  it('rethrows credentials provider errors', async () => {
    const credentialError = Object.assign(new Error('Could not load credentials from any providers'), {
      name: 'CredentialsProviderError',
    });
    sqsState.sendQueue.push(vi.fn().mockRejectedValueOnce(credentialError));

    await expect(publishProverWorkMessage(profile, baseMessage)).rejects.toThrow('Could not load credentials');

    expect(sqsState.clients).toHaveLength(1);
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'prover',
      result: 'failed',
      session_id_hash: hashSessionIdForLogging(baseMessage.sessionId),
      finalization_id: baseMessage.finalizationId,
    });
  });

  it('rethrows non-credential errors', async () => {
    const outageError = new Error('SQS outage');
    sqsState.sendQueue.push(vi.fn().mockRejectedValueOnce(outageError));

    await expect(publishProverWorkMessage(profile, baseMessage)).rejects.toThrow('SQS outage');

    expect(sqsState.clients).toHaveLength(1);
  });

  it('fails closed when SQS returns an oversized message id', async () => {
    sqsState.sendQueue.push(vi.fn().mockResolvedValueOnce({ MessageId: 'x'.repeat(129) }));

    await expect(publishProverWorkMessage(profile, baseMessage)).rejects.toThrow('valid message ID');

    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'queue_publish',
      queue: 'prover',
      result: 'failed',
      session_id_hash: hashSessionIdForLogging(baseMessage.sessionId),
      finalization_id: baseMessage.finalizationId,
    });
    expect(emitCanonicalEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'queue_publish',
        result: 'succeeded',
      }),
    );
  });

  it('uses the injected queue URL when process environment configuration is absent', async () => {
    delete process.env['PROVER_WORK_QUEUE_URL'];
    sqsState.sendQueue.push(vi.fn().mockResolvedValueOnce({ MessageId: 'injected-profile-message' }));

    await publishProverWorkMessage(profile, baseMessage);

    const command = sqsState.clients[0]?.send.mock.calls[0]?.[0] as { input?: { QueueUrl?: string } } | undefined;
    expect(command?.input?.QueueUrl).toBe(queueUrl);
  });
});
