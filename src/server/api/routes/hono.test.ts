import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHonoApp } from './hono';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord, requireDataRecord } from '@/lib/testing/response-helpers';
import { getStringProperty } from '@/lib/utils/guards';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { getGlobalStore } from '@/lib/store/storeInstance';
import type { SessionData } from '@/types/server';

vi.mock('@/lib/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

describe('createHonoApp', () => {
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('binds handlers with the global store', async () => {
    // Given
    const createBaseSession = (overrides: Partial<SessionData> = {}): SessionData => {
      const now = Date.now();
      return {
        sessionId: 'session-123',
        contractGeneration: resolveCurrentContractGeneration(),
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '1'.repeat(64),
        logId: '0x' + '2'.repeat(64),
        votes: new Map(),
        botCount: 0,
        finalized: false,
        createdAt: now,
        lastActivity: now,
        ...overrides,
      };
    };

    const store = createMockVoteStore({
      createSession: () => Promise.resolve(createBaseSession()),
    });

    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();
    // When
    const response = await app.request('http://localhost/api/session', { method: 'POST' });

    // Then
    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'session response');
    const data = requireDataRecord(payload, 'session data');
    expect(getStringProperty(data, 'sessionId')).toBe('session-123');
  });

  it('returns standardized error payloads when handlers throw', async () => {
    // Given
    const store = createMockVoteStore({
      createSession: () => Promise.reject(new Error('boom')),
    });

    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();
    // When
    const response = await app.request('http://localhost/api/session', { method: 'POST' });

    // Then
    expect(response.status).toBe(500);
    const payload = await readJsonRecord(response, 'error response');
    expect(getStringProperty(payload, 'error')).toBe('INTERNAL_ERROR');
  });

  it('supports custom basePath for read-only routes', async () => {
    // Given
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api/hono', mode: 'readonly' });

    // When
    const response = await app.request('http://localhost/api/hono/progress');

    // Then
    expect(response.status).toBe(400);
    const payload = await readJsonRecord(response, 'progress response');
    expect(getStringProperty(payload, 'error')).toBe('SESSION_ID_REQUIRED');
  });

  it('does not register mutation routes in readonly mode', async () => {
    // Given
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api/hono', mode: 'readonly' });

    // When
    const response = await app.request('http://localhost/api/hono/session', { method: 'POST' });

    // Then
    expect(response.status).toBe(404);
  });

  it('does not register finalize callback route in lambda mode', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/finalize/callback', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    expect(response.status).toBe(404);
  });

  it('allows authenticated range download headers in CORS preflight', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();
    const response = await app.request('http://localhost/api/session', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Session-ID, X-Session-Capability, Range',
      },
    });

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    const allowHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
    expect(allowHeaders).toContain('x-session-id');
    expect(allowHeaders).toContain('x-session-capability');
    expect(allowHeaders).toContain('range');
  });

  it('exposes ranged bundle response headers to browser JavaScript', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();
    const response = await app.request('http://localhost/api/progress', {
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    const exposeHeaders = response.headers.get('access-control-expose-headers')?.toLowerCase() ?? '';
    expect(exposeHeaders).toContain('content-range');
    expect(exposeHeaders).toContain('accept-ranges');
    expect(exposeHeaders).toContain('x-stark-bundle-range-chunk-size');
  });
});
