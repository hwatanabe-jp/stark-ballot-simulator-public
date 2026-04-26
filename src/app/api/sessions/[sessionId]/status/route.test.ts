import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import type { SessionData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { getRecordProperty, getStringProperty } from '@/lib/utils/guards';
import { _setSqsClient } from '@/server/api/utils/finalizationQueueInfo';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { interpolateProgress } from '@/lib/finalize/progress-interpolation';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { ErrorCode } from '@/lib/errors';
import type { ZkVMJournal } from '@/lib/zkvm/types';

const sendMock = vi.fn();
const sqsSendMock = vi.fn();
const mockSqsClient = { send: sqsSendMock } as unknown as SQSClient;

function createStatusRequest(sessionId: string, includeCapability = true): NextRequest {
  const headers: Record<string, string> = {};
  if (includeCapability) {
    headers[SESSION_CAPABILITY_HEADER] = createTestSessionCapabilityToken(sessionId);
  }
  return new NextRequest(`http://localhost:3000/api/sessions/${sessionId}/status`, { headers });
}

function createAuthoritativePublicInputArtifact(
  journal: Pick<
    ZkVMJournal,
    | 'electionId'
    | 'electionConfigHash'
    | 'methodVersion'
    | 'bulletinRoot'
    | 'treeSize'
    | 'totalExpected'
    | 'validVotes'
    | 'inputCommitment'
  >,
  overrides: Parameters<typeof createTestPublicInputArtifact>[0] = {},
) {
  return createTestPublicInputArtifact({
    ...overrides,
    typedAuthority: {
      electionId: journal.electionId,
      electionConfigHash: journal.electionConfigHash,
      methodVersion: journal.methodVersion,
      bulletinRoot: journal.bulletinRoot,
      treeSize: journal.treeSize,
      totalExpected: journal.totalExpected,
      votesCount: journal.validVotes,
      logId: '0x' + 'b'.repeat(64),
      timestamp: 123,
      recomputedInputCommitment: journal.inputCommitment,
      ...overrides.typedAuthority,
    },
  });
}

function createBaseSession(
  overrides: Partial<SessionData> & { allowMissingVerificationExecutionId?: boolean } = {},
): SessionData {
  const now = Date.now();
  const { allowMissingVerificationExecutionId = false, ...sessionOverrides } = overrides;
  const session: SessionData = {
    sessionId: 'session-base',
    contractGeneration: resolveCurrentContractGeneration(),
    votes: new Map(),
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    ...sessionOverrides,
  };

  if (
    !allowMissingVerificationExecutionId &&
    session.finalized &&
    session.finalizationResult &&
    !session.finalizationResult.verificationExecutionId
  ) {
    const needsDerivedExecutionId = !session.finalizationResult.verificationExecutionId;
    const derivedExecutionId =
      session.finalizationResult.verificationResult?.executionId ?? session.finalizationState?.executionId ?? 'exec-1';
    session.finalizationResult.verificationExecutionId = derivedExecutionId;
    if (
      needsDerivedExecutionId &&
      session.finalizationResult.publicInputArtifact?.provenance &&
      !session.finalizationResult.publicInputArtifact.provenance.executionId
    ) {
      session.finalizationResult.publicInputArtifact.provenance.executionId = derivedExecutionId;
    }
  }

  if (
    session.finalizationContractGeneration === undefined &&
    (session.finalized ||
      session.finalizationResult !== undefined ||
      session.finalizationState !== undefined ||
      session.finalizationScenarioContext !== undefined)
  ) {
    session.finalizationContractGeneration = session.contractGeneration;
  }

  return session;
}

vi.mock('@/lib/store/storeInstance');
vi.mock('@aws-sdk/client-sfn', () => {
  class MockSFNClient {
    send = sendMock;
  }

  class MockDescribeExecutionCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    SFNClient: MockSFNClient,
    DescribeExecutionCommand: MockDescribeExecutionCommand,
  };
});

describe('GET /api/sessions/[sessionId]/status', () => {
  let originalAsyncFlag: string | undefined;
  let originalQueueUrl: string | undefined;
  let originalProverConcurrency: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();
    sendMock.mockReset();
    sqsSendMock.mockReset();
    originalAsyncFlag = process.env.FINALIZE_ASYNC_MODE;
    originalQueueUrl = process.env.PROVER_WORK_QUEUE_URL;
    originalProverConcurrency = process.env.PROVER_LAMBDA_CONCURRENCY;
    process.env.FINALIZE_ASYNC_MODE = 'true';
    process.env.PROVER_STEP_FUNCTIONS_ENABLED = 'true';
    process.env.PROVER_WORK_QUEUE_URL = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/ProverWorkQueue';
    process.env.PROVER_LAMBDA_CONCURRENCY = '2';
    sqsSendMock.mockResolvedValue({
      Attributes: {
        ApproximateNumberOfMessages: '1',
        ApproximateNumberOfMessagesNotVisible: '1',
        ApproximateNumberOfMessagesDelayed: '0',
      },
    });
    _setSqsClient(mockSqsClient);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    if (originalProverConcurrency === undefined) {
      delete process.env.PROVER_LAMBDA_CONCURRENCY;
    } else {
      process.env.PROVER_LAMBDA_CONCURRENCY = originalProverConcurrency;
    }
    delete process.env.PROVER_STEP_FUNCTIONS_ENABLED;
    _setSqsClient(null);
  });

  it('returns finalization state with 200 status', async () => {
    const now = 1730000009000;
    const sessionId = '5f339e0a-86fb-476b-a2ef-61e94fd378d9';
    const queuedAt = 1730000000000;
    const startedAt = 1730000001000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalizationState: {
          status: 'running',
          executionId: '01HVN5WA1CEH94868G90QGJ7HX',
          queuedAt,
          startedAt,
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });

    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status');
    expect(getStringProperty(body, 'sessionId')).toBe(sessionId);
    const finalizationState = getRecordProperty(body, 'finalizationState');
    const queue = body.queue;
    expect(finalizationState).toEqual({
      status: 'running',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt,
      startedAt,
    });
    expect(queue).toBeNull();
    const progress = getRecordProperty(body, 'progress');
    const expectedPercent = Math.max(1, Math.floor(interpolateProgress(now - startedAt, 360000)));
    expect(progress).toEqual({
      phase: 'running',
      source: 'derived',
      percent: expectedPercent,
      updatedAt: now,
    });
    expect(sqsSendMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('strips nested bundle metadata from succeeded finalization status responses', async () => {
    const sessionId = 'status-succeeded-metadata';
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-with-metadata',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          completedAt: 1730000005000,
          bundleMetadata: {
            s3BundleKey: 'sessions/status-succeeded-metadata/exec-with-metadata/bundle.zip',
            s3UploadedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status succeeded metadata');
    const finalizationState = getRecordProperty(body, 'finalizationState');
    expect(finalizationState).toEqual({
      status: 'succeeded',
      executionId: 'exec-with-metadata',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      completedAt: 1730000005000,
    });
    expect(finalizationState).not.toHaveProperty('bundleMetadata');
  });

  it.each([
    {
      status: 'running',
      state: {
        status: 'running',
        executionId: 'exec-running-metadata',
        queuedAt: 1730000000000,
        startedAt: 1730000001000,
        bundleMetadata: {
          s3BundleKey: 'sessions/status-running-metadata/exec-running-metadata/bundle.zip',
          s3UploadedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
    {
      status: 'failed',
      state: {
        status: 'failed',
        executionId: 'exec-failed-metadata',
        queuedAt: 1730000000000,
        startedAt: 1730000001000,
        failedAt: 1730000005000,
        error: {
          code: 'FINALIZE_FAILED',
          message: 'finalization failed',
        },
        bundleMetadata: {
          s3BundleKey: 'sessions/status-failed-metadata/exec-failed-metadata/bundle.zip',
          s3UploadedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
    {
      status: 'timeout',
      state: {
        status: 'timeout',
        executionId: 'exec-timeout-metadata',
        queuedAt: 1730000000000,
        startedAt: 1730000001000,
        timeoutAt: 1730000005000,
        bundleMetadata: {
          s3BundleKey: 'sessions/status-timeout-metadata/exec-timeout-metadata/bundle.zip',
          s3UploadedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  ])('strips corrupt nested bundle metadata from $status status responses', async ({ state, status }) => {
    const sessionId = `status-${status}-metadata`;
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalizationState: state as SessionData['finalizationState'],
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, `session status ${status} metadata`);
    const finalizationState = getRecordProperty(body, 'finalizationState');
    expect(finalizationState).not.toHaveProperty('bundleMetadata');
  });

  it('returns 404 when session does not exist', async () => {
    const sessionId = '1c8e4f73-0cc6-4b35-a552-a92518b18b0e';
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(null);
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(404);
  });

  it('marks current finalized state as corrupt when the top-level verificationExecutionId is missing', async () => {
    const sessionId = 'status-missing-selector';
    const journal = createTestJournal();
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        allowMissingVerificationExecutionId: true,
        finalized: true,
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-3',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          completedAt: 1730000005000,
        },
        finalizationResult: {
          tally: {
            counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 64,
            tamperedCount: 0,
          },
          imageId: '0x' + '2'.repeat(64),
          publicInputArtifact: createAuthoritativePublicInputArtifact(journal, {
            executionId: 'exec-3',
          }),
          journal,
          verificationResult: {
            status: 'success',
            executionId: 'exec-3',
          },
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status missing selector');
    expect(getStringProperty(body, 'artifactState')).toBe('corrupt_or_unreadable');
    expect(body.finalizationResult).toBeNull();
  });

  it('marks current finalized state as corrupt when public input authority is unbound', async () => {
    const sessionId = 'status-unbound-public-input';
    const journal = createTestJournal();
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: true,
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-4',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          completedAt: 1730000005000,
        },
        finalizationResult: {
          tally: {
            counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 64,
            tamperedCount: 0,
          },
          imageId: '0x' + '2'.repeat(64),
          publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
          journal,
          verificationExecutionId: 'exec-4',
          verificationResult: {
            status: 'success',
            executionId: 'exec-4',
          },
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status unbound public input');
    expect(getStringProperty(body, 'artifactState')).toBe('corrupt_or_unreadable');
    const finalizationState = getRecordProperty(body, 'finalizationState');
    expect(finalizationState).toMatchObject({
      status: 'failed',
      executionId: 'exec-4',
      error: {
        code: ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE,
      },
    });
    expect(body.finalizationResult).toBeNull();
  });

  it('enriches response with Step Functions execution details when ARN present', async () => {
    const sessionId = '6a5bfb22-3be0-4a0f-9392-4cfd06c6cbb6';
    const executionArn = 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-01';
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalizationState: {
          status: 'running',
          executionId: '01HVN5WA1CEH94868G90QGJ7HX',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          stepFunctionsArn: executionArn,
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    sendMock.mockResolvedValueOnce({
      executionArn,
      status: 'FAILED',
      error: 'TaskFailed',
      cause: 'Lambda timed out',
      input: '{}',
      startDate: new Date(1730000001000),
      stopDate: new Date(1730000009000),
    });

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status step functions');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const stepFunctions = getRecordProperty(body, 'stepFunctions');
    expect(stepFunctions).toEqual({
      executionArn,
      status: 'FAILED',
      startTime: 1730000001000,
      stopTime: 1730000009000,
      error: 'TaskFailed',
      cause: 'Lambda timed out',
    });
  });

  it('omits progress for pending state while returning queue info', async () => {
    const sessionId = 'c1523e38-1e91-4dbe-94a5-4a8c27f227a6';
    const queuedAt = 1730000000000;
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalizationState: {
          status: 'pending',
          executionId: '01HVN5WA1CEH94868G90QGJ7HX',
          queuedAt,
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });

    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status pending');
    expect(body.progress).toBeUndefined();
    const queue = getRecordProperty(body, 'queue');
    expect(queue).toEqual({
      position: 2,
      depth: 2,
      concurrencyLimit: 2,
      estimatedStartAt: queuedAt,
      estimatedDurationMs: 360000,
      estimatedCompletionAt: queuedAt + 360000,
    });
  });

  it('does not expose finalizationResult when session is not finalized', async () => {
    const sessionId = '4f6ff0b6-6b70-4f4a-8fd8-c9a7008e0d2a';
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: false,
        finalizationResult: {
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
            tamperedCount: 0,
          },
          journal: createTestJournal(),
          imageId: '0x' + '2'.repeat(64),
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });

    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status no finalize');
    expect(body.finalizationResult).toBeNull();
  });

  it('does not expose finalizationResult for stale finalized artifacts', async () => {
    const sessionId = '9c3bc1dc-51cc-4af3-8660-35a1a3d1b950';
    const journal = createTestJournal();
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: true,
        finalizationContractGeneration: 'stale-contract-generation',
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-stale',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          completedAt: 1730000005000,
        },
        finalizationResult: {
          tally: {
            counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 64,
            tamperedCount: 0,
          },
          imageId: '0x' + '2'.repeat(64),
          journal,
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status stale finalized');
    expect(getStringProperty(body, 'artifactState')).toBe('unsupported_current_artifact');
    const finalizationState = getRecordProperty(body, 'finalizationState');
    expect(finalizationState).toMatchObject({
      status: 'failed',
      executionId: 'exec-stale',
      error: {
        code: ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
      },
    });
    expect(body.finalizationResult).toBeNull();
    expect(body.queue).toBeNull();
    expect(body.progress).toBeUndefined();
    expect(body.stepFunctions).toBeNull();
  });

  it('fails closed for stale running branches before exposing progress state', async () => {
    const sessionId = 'b6cd0cb1-31a5-42ae-a6dd-5193c704dbf1';
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: false,
        finalizationContractGeneration: 'stale-contract-generation',
        finalizationState: {
          status: 'running',
          executionId: 'exec-running-stale',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-running',
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status stale running');
    expect(getStringProperty(body, 'artifactState')).toBe('unsupported_current_artifact');
    const finalizationState = getRecordProperty(body, 'finalizationState');
    expect(finalizationState).toMatchObject({
      status: 'failed',
      executionId: 'exec-running-stale',
      error: {
        code: ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
      },
    });
    expect(body.queue).toBeNull();
    expect(body.progress).toBeUndefined();
    expect(body.finalizationResult).toBeNull();
    expect(body.stepFunctions).toBeNull();
  });

  it('fails closed for explicit stale-current failures even when wrapper generation is absent', async () => {
    const sessionId = 'f6cb6c84-b56f-4cf3-b9dd-e3834a78e45d';
    const session = createBaseSession({
      sessionId,
      finalized: false,
      contractGeneration: 'stale-live-generation',
      finalizationState: {
        status: 'failed',
        executionId: 'exec-stale-current',
        queuedAt: 1730000000000,
        failedAt: 1730000002000,
        error: {
          code: ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
          message: 'stale current execution',
        },
      },
    });
    session.finalizationContractGeneration = undefined;
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(session);
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status explicit stale-current');
    expect(getStringProperty(body, 'artifactState')).toBe('unsupported_current_artifact');
    const finalizationState = getRecordProperty(body, 'finalizationState');
    expect(finalizationState).toMatchObject({
      status: 'failed',
      executionId: 'exec-stale-current',
      error: {
        code: ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
      },
    });
    expect(body.finalizationResult).toBeNull();
    expect(body.queue).toBeNull();
    expect(body.progress).toBeUndefined();
    expect(body.stepFunctions).toBeNull();
  });

  it('returns 404 for stale live sessions without any persisted finalization branch', async () => {
    const sessionId = '4af5538f-937a-4f87-b0f5-94f8fe3eef2f';
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        contractGeneration: 'stale-live-generation',
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(404);
  });

  it('surfaces a persisted fail-closed tombstone even when no finalization state can be projected', async () => {
    const sessionId = '9b9f88c0-6a5b-461e-aee7-6d84ed7921fe';
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        contractGeneration: 'stale-live-generation',
        finalized: false,
        finalizationArtifactState: 'corrupt_or_unreadable',
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status persisted tombstone');
    expect(getStringProperty(body, 'artifactState')).toBe('corrupt_or_unreadable');
    expect(body.finalizationState).toBeNull();
    expect(body.finalizationResult).toBeNull();
    expect(body.queue).toBeNull();
    expect(body.progress).toBeUndefined();
    expect(body.stepFunctions).toBeNull();
  });

  it('fails closed when exposed finalizationResult carries stale verification success', async () => {
    const sessionId = '35d85f4a-6e8d-4804-95cf-3164f95463d1';
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: true,
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-1',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          completedAt: 1730000005000,
        },
        finalizationResult: {
          tally: {
            counts: { A: 61, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 61,
            tamperedCount: 3,
          },
          imageId: '0x' + '2'.repeat(64),
          verificationResult: {
            status: 'success',
          },
          publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
          journal,
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status canonical verification');
    const finalizationResult = getRecordProperty(body, 'finalizationResult');
    const verificationResult = getRecordProperty(finalizationResult, 'verificationResult');
    expect(getStringProperty(verificationResult, 'status')).toBe('failed');
  });

  it('does not expose server-only finalization fields', async () => {
    const sessionId = '6a701d69-bf2f-42d8-bf5d-7b862a68d2a3';
    const journal = createTestJournal();
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: true,
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-2',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          completedAt: 1730000005000,
        },
        finalizationResult: {
          tally: {
            counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 64,
            tamperedCount: 0,
          },
          imageId: '0x' + '2'.repeat(64),
          publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
          journal,
          receiptRaw: { seal: 'raw' },
          bitmapData: {
            includedBitmap: [true, false],
            includedBitmapRoot: journal.includedBitmapRoot,
            treeSize: journal.treeSize,
            finalizedAt: 1730000005000,
          },
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status public projection');
    const finalizationResult = getRecordProperty(body, 'finalizationResult');
    expect(finalizationResult).not.toHaveProperty('receiptRaw');
    expect(finalizationResult).not.toHaveProperty('bitmapData');
  });

  it('serializes dev_mode verification status without server-only file paths', async () => {
    const sessionId = '9a16c0d1-2d66-4a36-8db5-d6ed1fd8bf46';
    const journal = createTestJournal();
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId,
        finalized: true,
        finalizationState: {
          status: 'succeeded',
          executionId: 'exec-3',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          completedAt: 1730000005000,
        },
        finalizationResult: {
          tally: {
            counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 64,
            tamperedCount: 0,
          },
          imageId: '0x' + '2'.repeat(64),
          publicInputArtifact: createAuthoritativePublicInputArtifact(journal, {
            executionId: 'exec-3',
          }),
          journal,
          verificationExecutionId: 'exec-3',
          verificationResult: {
            status: 'dev_mode',
            report: {
              status: 'dev_mode',
              verifier_version: '1.0.0',
              verified_at: '2026-01-01T00:00:00.000Z',
              duration_ms: 7,
              expected_image_id: '0x' + '2'.repeat(64),
              receipt_image_id: '0x' + '2'.repeat(64),
              bundle_path: '/tmp/mock-bundle',
              receipt_path: '/tmp/mock-bundle/receipt.json',
              dev_mode_receipt: true,
              errors: [],
            },
          },
        },
      }),
    );
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId), {
      params: { sessionId },
    });

    expect(response.status).toBe(200);
    const body = await readJsonRecord(response, 'session status dev_mode projection');
    const finalizationResult = getRecordProperty(body, 'finalizationResult');
    const verificationResult = getRecordProperty(finalizationResult, 'verificationResult');
    expect(getStringProperty(verificationResult, 'status')).toBe('dev_mode');
    expect(verificationResult).not.toHaveProperty('bundlePath');
    expect(verificationResult).not.toHaveProperty('reportPath');
    expect(verificationResult).not.toHaveProperty('bundleArchivePath');
    const verificationReport = getRecordProperty(verificationResult, 'report');
    expect(verificationReport).not.toHaveProperty('bundle_path');
    expect(verificationReport).not.toHaveProperty('receipt_path');
  });

  it('returns 401 when capability token is missing', async () => {
    const sessionId = 'f47d5f43-7f97-41b4-bf82-a6b10dbfd4f4';
    const getSessionMock = vi
      .fn<NonNullable<VoteStore['getSession']>>()
      .mockResolvedValue(createBaseSession({ sessionId }));
    const store = createMockVoteStore({ getSession: getSessionMock });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await GET(createStatusRequest(sessionId, false), {
      params: { sessionId },
    });

    expect(response.status).toBe(401);
  });
});
