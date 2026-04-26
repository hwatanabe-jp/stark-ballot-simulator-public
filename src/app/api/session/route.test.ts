import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { BotVoter } from '@/lib/bot/botVoter';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import type { SessionData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { getRecordProperty, getStringProperty } from '@/lib/utils/guards';
import { resetSessionCreateRateLimiter } from '@/lib/rateLimit/sessionCreateRateLimit';

vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));
vi.mock('@/lib/bot/botVoter');

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

describe('POST /api/session', () => {
  let mockStore: VoteStore;
  let createSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['createSession']>>>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  const createBaseSession = (overrides: Partial<SessionData> = {}): SessionData => {
    const now = Date.now();
    return {
      sessionId: 'test-session-123',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '1'.repeat(64),
      logId: '0x' + '2'.repeat(64),
      contractGeneration: 'test-current-generation',
      votes: new Map(),
      botCount: 0,
      finalized: false,
      createdAt: now,
      lastActivity: now,
      ...overrides,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    restoreEnv();
    resetSessionCreateRateLimiter();
    createSessionMock = vi.fn<NonNullable<VoteStore['createSession']>>().mockResolvedValue(createBaseSession());
    mockStore = createMockVoteStore({
      createSession: createSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const mockBotVoter = vi.mocked(BotVoter);
    mockBotVoter.prototype.startBotVoting = vi.fn().mockResolvedValue(undefined);

    // Suppress console.error logs in tests
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    restoreEnv();
    resetSessionCreateRateLimiter();
  });

  it('should create a session and return sessionId', async () => {
    const request = new NextRequest('http://localhost:3000/api/session', { method: 'POST' });
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'session response');

    expect(response.status).toBe(200);
    const data = getRecordProperty(payload, 'data');
    expect(getStringProperty(data, 'sessionId')).toBe('test-session-123');
    expect(getStringProperty(data, 'electionId')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(getStringProperty(data, 'electionConfigHash')).toBe('0x' + '1'.repeat(64));
    expect(getStringProperty(data, 'logId')).toBe('0x' + '2'.repeat(64));
    expect(getStringProperty(data, 'contractGeneration')).toBe('test-current-generation');
    expect(getStringProperty(data, 'capabilityToken')).toBeTruthy();
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    // Bot voting is no longer started immediately - it's triggered after user votes
  });

  it('fails closed when the store omits contractGeneration', async () => {
    createSessionMock.mockResolvedValue(createBaseSession({ contractGeneration: undefined }));

    const request = new NextRequest('http://localhost:3000/api/session', { method: 'POST' });
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'session response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe('INTERNAL_ERROR');
    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });

  it('should handle session limit exceeded error', async () => {
    createSessionMock.mockRejectedValue(new Error('SESSION_LIMIT_EXCEEDED'));

    const request = new NextRequest('http://localhost:3000/api/session', { method: 'POST' });
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'session response');

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: 'SESSION_LIMIT_EXCEEDED',
      message: '現在混雑しています。しばらくしてからお試しください',
      statusCode: 503,
    });
  });

  it('should handle generic errors', async () => {
    createSessionMock.mockRejectedValue(new Error('Some error'));

    const request = new NextRequest('http://localhost:3000/api/session', { method: 'POST' });
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'session response');

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: 'INTERNAL_ERROR',
      message: '内部エラーが発生しました',
      statusCode: 500,
    });
  });

  it('should reject session creation when MAX_SESSIONS is reached', async () => {
    process.env.MAX_SESSIONS = '1';
    const getActiveSessionCount = vi.fn<NonNullable<VoteStore['getActiveSessionCount']>>().mockResolvedValue(1);
    mockStore = createMockVoteStore({
      createSession: createSessionMock,
      getActiveSessionCount,
    });
    vi.mocked(getGlobalStore).mockReturnValue(mockStore);

    const request = new NextRequest('http://localhost:3000/api/session', { method: 'POST' });
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'session response');

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: 'SESSION_LIMIT_EXCEEDED',
      message: '現在混雑しています。しばらくしてからお試しください',
      statusCode: 503,
    });
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('should require turnstile token when SESSION_CREATE_TURNSTILE_REQUIRED is enabled', async () => {
    process.env.SESSION_CREATE_TURNSTILE_REQUIRED = '1';
    process.env.TURNSTILE_BYPASS = '0';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';

    const request = new NextRequest('http://localhost:3000/api/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const response = await POST(request);
    const payload = await readJsonRecord(response, 'session response');

    expect(response.status).toBe(403);
    expect(getStringProperty(payload, 'error')).toBe('CAPTCHA_FAILED');
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('should create session with valid turnstile token when required', async () => {
    process.env.SESSION_CREATE_TURNSTILE_REQUIRED = '1';
    process.env.TURNSTILE_BYPASS = '0';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, action: 'session' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = new NextRequest('http://localhost:3000/api/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ turnstileToken: 'cf-turnstile-token' }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should consume session-create rate limit even when JSON is invalid', async () => {
    process.env.SESSION_CREATE_RATE_LIMIT = '1';
    process.env.SESSION_CREATE_RATE_LIMIT_WINDOW_MS = '600000';

    const requestA = new NextRequest('http://localhost:3000/api/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    const responseA = await POST(requestA);
    const payloadA = await readJsonRecord(responseA, 'session response A');

    expect(responseA.status).toBe(400);
    expect(getStringProperty(payloadA, 'error')).toBe('INVALID_REQUEST');

    const requestB = new NextRequest('http://localhost:3000/api/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    const responseB = await POST(requestB);
    const payloadB = await readJsonRecord(responseB, 'session response B');

    expect(responseB.status).toBe(503);
    expect(getStringProperty(payloadB, 'error')).toBe('GLOBAL_LIMIT_EXCEEDED');
    expect(createSessionMock).not.toHaveBeenCalled();
  });
});
