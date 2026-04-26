import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { publishProverWorkMessage } from '@/lib/finalize/publishProverWorkMessage';
import { PROVER_WORK_MESSAGE_VERSION, ProverWorkMessageSchema } from '@/lib/finalize/types';
import { getDefaultExecutor } from '@/lib/zkvm/executor-factory';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { addHexPrefix } from '@/lib/utils/hex';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import type { SessionData, VoteData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { ServerRateLimiter } from '@/lib/rateLimit/serverRateLimit';
import { _setSqsClient } from '@/server/api/utils/finalizationQueueInfo';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { resolveCurrentContractGeneration } from '@/lib/contract';

vi.mock('@/lib/store/storeInstance');
vi.mock('@/lib/finalize/publishProverWorkMessage', () => ({
  publishProverWorkMessage: vi.fn(),
}));
vi.mock('@/lib/zkvm/executor-factory');

const sqsSendMock = vi.fn();
const mockSqsClient = { send: sqsSendMock } as unknown as SQSClient;

function createVoteData(overrides: Partial<VoteData> = {}): VoteData {
  return {
    vote: 'A',
    commit: '0x' + '1'.repeat(64),
    rand: '0x' + '2'.repeat(64),
    path: [],
    ...overrides,
  };
}

function createBaseSession(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  const electionConfig = buildDefaultElectionConfig();
  return {
    sessionId: 'session-base',
    contractGeneration: resolveCurrentContractGeneration(),
    electionConfigHash: getDefaultElectionConfigHash(),
    electionConfig,
    votes: new Map(),
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    ...overrides,
  };
}

describe('POST /api/finalize (async mode)', () => {
  const queueUrl = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/ProverWorkQueue';
  const expectedImageId = '0xf2471bb167f465927d3cc90c3553d5f7512c5c71c4b34623456c141b2aabc45d';
  let originalAsyncFlag: string | undefined;
  let originalQueueUrl: string | undefined;
  let originalExpectedImageId: string | undefined;
  let originalTurnstileBypass: string | undefined;
  let originalTurnstileSecret: string | undefined;
  let originalRuntimeDeploymentEnv: string | undefined;
  let originalProverConcurrency: string | undefined;
  let originalSessionCapabilitySecret: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalAsyncFlag = process.env.FINALIZE_ASYNC_MODE;
    originalQueueUrl = process.env.PROVER_WORK_QUEUE_URL;
    originalExpectedImageId = process.env.EXPECTED_IMAGE_ID;
    originalTurnstileBypass = process.env.TURNSTILE_BYPASS;
    originalTurnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    originalRuntimeDeploymentEnv = process.env.RUNTIME_DEPLOYMENT_ENV;
    originalProverConcurrency = process.env.PROVER_LAMBDA_CONCURRENCY;
    originalSessionCapabilitySecret = process.env.SESSION_CAPABILITY_SECRET;
    process.env.FINALIZE_ASYNC_MODE = 'true';
    process.env.PROVER_WORK_QUEUE_URL = queueUrl;
    process.env.EXPECTED_IMAGE_ID = expectedImageId;
    process.env.USE_MOCK_STORE = 'true';
    process.env.TURNSTILE_BYPASS = '1';
    process.env.RUNTIME_DEPLOYMENT_ENV = 'develop';
    process.env.PROVER_LAMBDA_CONCURRENCY = '2';
    setTestSessionCapabilitySecret();
    delete process.env.TURNSTILE_SECRET_KEY;

    vi.mocked(getDefaultExecutor).mockRejectedValue(new Error('executor should not be called in async mode'));
    sqsSendMock.mockResolvedValue({
      Attributes: {
        ApproximateNumberOfMessages: '2',
        ApproximateNumberOfMessagesNotVisible: '1',
        ApproximateNumberOfMessagesDelayed: '0',
      },
    });
    _setSqsClient(mockSqsClient);
  });

  afterEach(() => {
    if (originalAsyncFlag === undefined) {
      delete process.env.FINALIZE_ASYNC_MODE;
    } else {
      process.env.FINALIZE_ASYNC_MODE = originalAsyncFlag;
    }

    if (originalQueueUrl === undefined) {
      delete process.env.PROVER_WORK_QUEUE_URL;
    } else {
      process.env.PROVER_WORK_QUEUE_URL = originalQueueUrl;
    }

    if (originalExpectedImageId === undefined) {
      delete process.env.EXPECTED_IMAGE_ID;
    } else {
      process.env.EXPECTED_IMAGE_ID = originalExpectedImageId;
    }

    if (originalTurnstileBypass === undefined) {
      delete process.env.TURNSTILE_BYPASS;
    } else {
      process.env.TURNSTILE_BYPASS = originalTurnstileBypass;
    }

    if (originalTurnstileSecret === undefined) {
      delete process.env.TURNSTILE_SECRET_KEY;
    } else {
      process.env.TURNSTILE_SECRET_KEY = originalTurnstileSecret;
    }
    if (originalRuntimeDeploymentEnv === undefined) {
      delete process.env.RUNTIME_DEPLOYMENT_ENV;
    } else {
      process.env.RUNTIME_DEPLOYMENT_ENV = originalRuntimeDeploymentEnv;
    }
    if (originalProverConcurrency === undefined) {
      delete process.env.PROVER_LAMBDA_CONCURRENCY;
    } else {
      process.env.PROVER_LAMBDA_CONCURRENCY = originalProverConcurrency;
    }
    if (originalSessionCapabilitySecret === undefined) {
      delete process.env.SESSION_CAPABILITY_SECRET;
    } else {
      process.env.SESSION_CAPABILITY_SECRET = originalSessionCapabilitySecret;
    }
    _setSqsClient(null);
  });

  it('enqueues finalize job and returns 202 Accepted', async () => {
    const sessionId = '2f1c92c3-29d7-4d07-8c65-9f39fbb7eac7';
    const queuedAt = 1730000000000;
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    const markFinalizationQueued = vi
      .fn<NonNullable<VoteStore['markFinalizationQueued']>>()
      .mockImplementation((_id, payload) =>
        Promise.resolve({
          status: 'pending',
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
        }),
      );
    const mockStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationQueued,
    });

    const baseSession = createBaseSession({
      sessionId,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      logId: '0x' + '0'.repeat(64),
      createdAt: queuedAt - 10,
      lastActivity: queuedAt - 10,
      userVoteIndex: 0,
      botCount: 63,
      votes: new Map(),
      finalized: false,
    });

    for (let i = 0; i < 64; i++) {
      baseSession.votes.set(
        i,
        createVoteData({
          vote: i === 0 ? 'A' : 'B',
          commit: '0x' + (i + 10).toString(16).padStart(64, '0'),
          rand: '0x' + (i + 20).toString(16).padStart(64, '0'),
          path: [],
          timestamp: queuedAt - 1000 + i,
        }),
      );
    }

    const sessionWithBulletin = withBulletin(baseSession);
    getSessionMock.mockResolvedValue(sessionWithBulletin);

    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const publishMock = vi.mocked(publishProverWorkMessage);
    publishMock.mockResolvedValue(undefined);

    vi.spyOn(Date, 'now').mockReturnValue(queuedAt);

    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        'User-Agent': 'vitest',
      },
      body: JSON.stringify({ scenarioId: 'S1' }),
    });

    const response = await POST(request);
    const payload = await readJsonRecord(response, 'finalize async response');
    const executionId = getStringProperty(payload, 'executionId');
    const statusUrl = getStringProperty(payload, 'statusUrl');
    const state = getRecordProperty(payload, 'state');
    const stateStatus = getStringProperty(state, 'status');
    const stateExecutionId = getStringProperty(state, 'executionId');
    const stateQueuedAt = getNumberProperty(state, 'queuedAt');
    const queue = getRecordProperty(payload, 'queue');

    expect(response.status).toBe(202);
    expect(executionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID base32
    expect(statusUrl).toBe(`http://localhost:3000/api/sessions/${sessionId}/status`);
    expect(stateStatus).toBe('pending');
    expect(stateExecutionId).toBe(executionId);
    expect(stateQueuedAt).toBe(queuedAt);
    expect(queue).toEqual({
      position: 3,
      depth: 3,
      concurrencyLimit: 2,
      estimatedStartAt: queuedAt + 360000,
      estimatedDurationMs: 360000,
      estimatedCompletionAt: queuedAt + 720000,
    });

    expect(markFinalizationQueued).toHaveBeenCalledWith(sessionId, {
      executionId: executionId,
      queuedAt,
      contractGeneration: resolveCurrentContractGeneration(),
      scenarioContext: {
        scenarios: ['S1'],
        tamperMode: 'input',
        claimedCounts: { A: 0, B: 63, C: 0, D: 0, E: 0 },
        claimedTotalVotes: 63,
        summary: {
          ignoredCount: 1,
          recountedCount: 0,
          userRecountChoice: null,
        },
      },
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const queuedMessage = publishMock.mock.calls[0][0];
    const parsed = ProverWorkMessageSchema.parse(queuedMessage);
    expect(parsed.messageVersion).toBe(PROVER_WORK_MESSAGE_VERSION);
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.expectedImageId).toBe(expectedImageId);
    expect(parsed.zkvmInput.votes.length).toBeGreaterThan(0);
    expect(parsed.electionConfig).toEqual(buildDefaultElectionConfig());
    expect(parsed.scenarios).toEqual(['S1']);
    expect(parsed.scenarioContext).toEqual({
      scenarios: ['S1'],
      tamperMode: 'input',
      claimedCounts: { A: 0, B: 63, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 63,
      summary: {
        ignoredCount: 1,
        recountedCount: 0,
        userRecountChoice: null,
      },
    });

    expect(getDefaultExecutor).not.toHaveBeenCalled();
  });

  it('records rate limits when async finalize succeeds', async () => {
    const originalUseMockStore = process.env.USE_MOCK_STORE;
    process.env.USE_MOCK_STORE = 'false';

    const sessionId = '55d1b9c0-3a5f-4e1f-9d0a-0e5b1c9a1f11';
    const queuedAt = 1730000024000;
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    const markFinalizationQueued = vi
      .fn<NonNullable<VoteStore['markFinalizationQueued']>>()
      .mockImplementation((_id, payload) =>
        Promise.resolve({
          status: 'pending',
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
        }),
      );
    const mockStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationQueued,
    });

    const session = withBulletin(createSessionWithVotes(sessionId, queuedAt));
    getSessionMock.mockResolvedValue(session);
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const publishMock = vi.mocked(publishProverWorkMessage);
    publishMock.mockResolvedValue(undefined);

    const consumeIpSpy = vi.spyOn(ServerRateLimiter.prototype, 'consumeZkVmExecution').mockResolvedValue({
      allowed: true,
      remainingExecutions: 100,
    });
    const checkIpSpy = vi.spyOn(ServerRateLimiter.prototype, 'checkZkVmRateLimit').mockResolvedValue({
      allowed: true,
      remainingExecutions: 50,
    });
    const checkGlobalSpy = vi.spyOn(ServerRateLimiter.prototype, 'checkGlobalLimit').mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 1000,
    });
    const recordIpSpy = vi.spyOn(ServerRateLimiter.prototype, 'recordZkVmExecution').mockResolvedValue(undefined);
    const incrementGlobalSpy = vi.spyOn(ServerRateLimiter.prototype, 'incrementGlobalCount').mockResolvedValue(1);

    vi.spyOn(Date, 'now').mockReturnValue(queuedAt);

    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(consumeIpSpy).toHaveBeenCalledTimes(1);
    expect(checkIpSpy).toHaveBeenCalledTimes(1);
    expect(checkGlobalSpy).toHaveBeenCalledWith('daily');
    expect(checkGlobalSpy).toHaveBeenCalledWith('hourly');
    expect(recordIpSpy).toHaveBeenCalledTimes(1);
    expect(incrementGlobalSpy).toHaveBeenCalledWith('daily');
    expect(incrementGlobalSpy).toHaveBeenCalledWith('hourly');

    consumeIpSpy.mockRestore();
    checkIpSpy.mockRestore();
    checkGlobalSpy.mockRestore();
    recordIpSpy.mockRestore();
    incrementGlobalSpy.mockRestore();

    if (originalUseMockStore === undefined) {
      delete process.env.USE_MOCK_STORE;
    } else {
      process.env.USE_MOCK_STORE = originalUseMockStore;
    }
  });

  it('prefers forwarded host when building statusUrl', async () => {
    const sessionId = 'f3b1e8b7-4e6a-4f3b-8d8d-5411d2c8ed22';
    const queuedAt = 1730000012000;
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    const markFinalizationQueued = vi
      .fn<NonNullable<VoteStore['markFinalizationQueued']>>()
      .mockImplementation((_id, payload) =>
        Promise.resolve({
          status: 'pending',
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
        }),
      );
    const mockStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationQueued,
    });

    const session = withBulletin(createSessionWithVotes(sessionId, queuedAt));
    getSessionMock.mockResolvedValue(session);
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const publishMock = vi.mocked(publishProverWorkMessage);
    publishMock.mockResolvedValue(undefined);

    vi.spyOn(Date, 'now').mockReturnValue(queuedAt);

    const originalBaseUrl = process.env.VERIFIER_PUBLIC_BASE_URL;
    delete process.env.VERIFIER_PUBLIC_BASE_URL;

    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        'X-Forwarded-Host': 'preview.example.com',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    const payload = await readJsonRecord(response, 'finalize async response');
    const statusUrl = getStringProperty(payload, 'statusUrl');

    expect(response.status).toBe(202);
    expect(statusUrl).toBe(`https://preview.example.com/api/sessions/${sessionId}/status`);

    if (originalBaseUrl === undefined) {
      delete process.env.VERIFIER_PUBLIC_BASE_URL;
    } else {
      process.env.VERIFIER_PUBLIC_BASE_URL = originalBaseUrl;
    }
  });

  it('retries SQS publish on transient failure', async () => {
    const sessionId = 'e0f33a5c-4f76-4f47-b2cf-7fe8f3d8c0de';
    const queuedAt = 1730000005000;
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    const markFinalizationQueued = vi
      .fn<NonNullable<VoteStore['markFinalizationQueued']>>()
      .mockImplementation((_id, payload) =>
        Promise.resolve({
          status: 'pending',
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
        }),
      );
    const mockStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationQueued,
    });

    const session = withBulletin(createSessionWithVotes(sessionId, queuedAt));
    getSessionMock.mockResolvedValue(session);
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const publishMock = vi.mocked(publishProverWorkMessage);
    publishMock.mockRejectedValueOnce(new Error('SQS transient error'));
    publishMock.mockResolvedValueOnce(undefined);

    vi.spyOn(Date, 'now').mockReturnValue(queuedAt);

    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(markFinalizationQueued).toHaveBeenCalledTimes(1);
  });

  it('records failure when SQS publish ultimately fails', async () => {
    const sessionId = '2f1b5f8a-2b4c-4f91-983b-5a52dcc25ab4';
    const queuedAt = 1730000009000;
    const markFailed = vi.fn<NonNullable<VoteStore['markFinalizationFailed']>>().mockResolvedValue({
      status: 'failed' as const,
      executionId: 'EXEC123',
      queuedAt,
      failedAt: queuedAt + 5,
      error: { code: 'SQS_PUBLISH_FAILED', message: 'SQS publish failed' },
    });

    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    const markFinalizationQueued = vi.fn<NonNullable<VoteStore['markFinalizationQueued']>>().mockImplementation(() =>
      Promise.resolve({
        status: 'pending',
        executionId: 'EXEC123',
        queuedAt,
      }),
    );
    const mockStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationQueued,
      markFinalizationFailed: markFailed,
    });

    const session = withBulletin(createSessionWithVotes(sessionId, queuedAt));
    getSessionMock.mockResolvedValue(session);
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const publishMock = vi.mocked(publishProverWorkMessage);
    publishMock.mockRejectedValue(new Error('SQS outage'));

    vi.spyOn(Date, 'now').mockReturnValue(queuedAt);

    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    expect(markFailed).toHaveBeenCalledTimes(1);
    const failurePayload = markFailed.mock.calls[0]?.[1];
    const failureRecord = isRecord(failurePayload) ? failurePayload : null;
    const errorRecord = failureRecord ? getRecordProperty(failureRecord, 'error') : null;
    expect(getStringProperty(errorRecord, 'code')).toBe('SQS_PUBLISH_FAILED');
    expect(getStringProperty(failureRecord, 'executionId')).toBeTypeOf('string');
  });
});

function createSessionWithVotes(sessionId: string, baseTime: number): SessionData {
  const session = createBaseSession({
    sessionId,
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    logId: '0x' + '0'.repeat(64),
    createdAt: baseTime - 10,
    lastActivity: baseTime - 10,
    userVoteIndex: 0,
    botCount: 63,
    votes: new Map(),
    finalized: false,
  });

  for (let i = 0; i < 63; i++) {
    session.votes.set(
      i,
      createVoteData({
        vote: 'A',
        commit: '0x' + (i + 10).toString(16).padStart(64, '0'),
        rand: '0x' + (i + 20).toString(16).padStart(64, '0'),
        path: [],
        timestamp: baseTime - 100 + i,
      }),
    );
  }

  return session;
}

function withBulletin(session: SessionData): SessionData {
  const board = new SimpleBulletinBoard(session.logId ?? '0x' + '0'.repeat(64));
  const seen = new Set<string>();

  for (const [index, vote] of session.votes.entries()) {
    const assignedId = vote.voteId && typeof vote.voteId === 'string' ? vote.voteId : deterministicVoteId(index);
    vote.voteId = assignedId;

    let normalizedCommitment = normalizeCommitment(vote.commit);
    while (seen.has(normalizedCommitment)) {
      normalizedCommitment = incrementHex(normalizedCommitment);
    }
    seen.add(normalizedCommitment);

    vote.commit = addHexPrefix(normalizedCommitment);
    board.appendVote(assignedId, normalizedCommitment);
  }

  session.bulletin = board;
  session.bulletinRootHistory = [
    {
      root: addHexPrefix(board.getCurrentRoot()),
      timestamp: Date.now(),
      treeSize: board.getSize(),
    },
  ];

  return session;
}

function normalizeCommitment(commitment: string): string {
  if (!commitment) {
    return '0'.repeat(64);
  }
  const normalized = commitment.startsWith('0x') ? commitment.slice(2) : commitment;
  return normalized.length > 0 ? normalized : '0'.repeat(64);
}

function deterministicVoteId(index: number): string {
  const suffix = (index + 1).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
}

function incrementHex(hex: string): string {
  const value = BigInt('0x' + hex) + 1n;
  return value.toString(16).padStart(hex.length, '0');
}
