import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, _setStepFunctionsClient } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { SFNClient } from '@aws-sdk/client-sfn';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getRecordProperty, getStringProperty } from '@/lib/utils/guards';
import type { SessionData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import * as rateLimitMiddleware from '@/server/api/middleware/rateLimit';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { resolveCurrentContractGeneration } from '@/lib/contract';

vi.mock('@/lib/store/storeInstance');

const mockSend = vi.fn();

function createBaseSession(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  return {
    sessionId: 'session-base',
    contractGeneration: resolveCurrentContractGeneration(),
    votes: new Map(),
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  setTestSessionCapabilitySecret();
  const client = new SFNClient({});
  vi.spyOn(client, 'send').mockImplementation(mockSend);
  _setStepFunctionsClient(client);
  process.env.FINALIZE_ASYNC_MODE = 'true';
});

afterEach(() => {
  delete process.env.PROVER_STEP_FUNCTIONS_ENABLED;
});

const EXECUTION_ID = '01HZ3JQ4ABXYZ7890DEF123456';

function buildRequest(body: unknown, sessionId = 'session-123'): NextRequest {
  return new NextRequest('http://localhost:3000/api/finalize/cancel', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
      [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/finalize/cancel', () => {
  it('marks the execution as failed when pending', async () => {
    const markFailed = vi.fn().mockResolvedValue({
      status: 'failed' as const,
      executionId: 'exec-123',
      queuedAt: 100,
      failedAt: 200,
      error: { code: 'USER_CANCELLED', message: 'Cancelled by user request' },
    });
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId: 'session-123',
        finalizationContractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'pending',
          executionId: EXECUTION_ID,
          queuedAt: 100,
        },
      }),
    );
    const store: VoteStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationFailed: markFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await POST(buildRequest({ executionId: EXECUTION_ID }));
    const payload = await readJsonRecord(response, 'cancel finalize');
    const state = getRecordProperty(payload, 'state');
    expect(response.status).toBe(200);
    expect(getStringProperty(state, 'status')).toBe('failed');
    expect(markFailed).toHaveBeenCalledWith('session-123', expect.objectContaining({ executionId: EXECUTION_ID }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('attempts to stop Step Functions when ARN is present', async () => {
    process.env.PROVER_STEP_FUNCTIONS_ENABLED = 'true';

    const markFailed = vi.fn().mockResolvedValue({
      status: 'failed' as const,
      executionId: EXECUTION_ID,
      queuedAt: 100,
      failedAt: 200,
      error: { code: 'USER_CANCELLED', message: 'Cancelled by user request' },
      stepFunctionsArn: `arn:aws:states:ap-northeast-1:123456789012:execution:Machine:${EXECUTION_ID}`,
    });
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId: 'session-123',
        finalizationContractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'running',
          executionId: EXECUTION_ID,
          queuedAt: 100,
          startedAt: 150,
          stepFunctionsArn: `arn:aws:states:ap-northeast-1:123456789012:execution:Machine:${EXECUTION_ID}`,
        },
      }),
    );
    const store: VoteStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationFailed: markFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('ExecutionAlreadyCompleted'), { name: 'ExecutionAlreadyCompleted' }),
    );

    const response = await POST(buildRequest({ executionId: EXECUTION_ID, reason: 'User requested cancel' }));
    await response.json();
    expect(response.status).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('rejects cancellation when state is already completed', async () => {
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId: 'session-123',
        finalizationContractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'succeeded',
          executionId: EXECUTION_ID,
          queuedAt: 100,
          startedAt: 150,
          completedAt: 300,
        },
      }),
    );
    const store: VoteStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationFailed: vi.fn(),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await POST(buildRequest({ executionId: EXECUTION_ID }));
    const payload = await readJsonRecord(response, 'cancel finalize conflict');
    expect(response.status).toBe(409);
    const error = getStringProperty(payload, 'error');
    expect(error).toBeDefined();
    expect(error).toContain('cannot be cancelled');
  });

  it('fails closed for stale running branches before calling the store writer', async () => {
    const markFailed = vi.fn();
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId: 'session-123',
        finalizationContractGeneration: 'stale-contract-generation',
        finalizationState: {
          status: 'running',
          executionId: EXECUTION_ID,
          queuedAt: 100,
          startedAt: 150,
        },
      }),
    );
    const store: VoteStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationFailed: markFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await POST(buildRequest({ executionId: EXECUTION_ID }));
    const payload = await readJsonRecord(response, 'cancel finalize stale running');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT);
    expect(getStringProperty(payload, 'artifactState')).toBe('unsupported_current_artifact');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('fails closed for unreadable in-flight branches before calling the store writer', async () => {
    const markFailed = vi.fn();
    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId: 'session-123',
        finalizationState: {
          status: 'pending',
          executionId: EXECUTION_ID,
          queuedAt: 100,
        },
      }),
    );
    const store: VoteStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationFailed: markFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await POST(buildRequest({ executionId: EXECUTION_ID }));
    const payload = await readJsonRecord(response, 'cancel finalize corrupt running');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE);
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('returns 404 when async mode disabled', async () => {
    process.env.FINALIZE_ASYNC_MODE = 'false';
    const response = await POST(buildRequest({ executionId: 'exec-000' }));
    expect(response.status).toBe(404);
  });

  it('returns 401 when capability token is missing', async () => {
    const sessionId = 'session-123';
    const request = new NextRequest('http://localhost:3000/api/finalize/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
      },
      body: JSON.stringify({ executionId: EXECUTION_ID }),
    });

    const response = await POST(request);
    const payload = await readJsonRecord(response, 'cancel missing capability');
    expect(response.status).toBe(401);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('returns 503 when finalize cancel rate limit is exceeded', async () => {
    vi.spyOn(rateLimitMiddleware, 'enforceFinalizeCancelRateLimit').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'GLOBAL_LIMIT_EXCEEDED',
          statusCode: 503,
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>().mockResolvedValue(
      createBaseSession({
        sessionId: 'session-123',
        finalizationContractGeneration: resolveCurrentContractGeneration(),
        finalizationState: {
          status: 'pending',
          executionId: EXECUTION_ID,
          queuedAt: 100,
        },
      }),
    );
    const store: VoteStore = createMockVoteStore({
      getSession: getSessionMock,
      markFinalizationFailed: vi.fn(),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await POST(buildRequest({ executionId: EXECUTION_ID }));
    const payload = await readJsonRecord(response, 'cancel finalize rate-limited');
    expect(response.status).toBe(503);
    expect(getStringProperty(payload, 'error')).toBe('GLOBAL_LIMIT_EXCEEDED');
  });
});
