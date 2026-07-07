import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createHonoApp, ORIGIN_VERIFY_HEADER } from './hono';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { readJsonRecord, requireDataRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import type { SessionData } from '@stark-ballot/domain/types/server';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

const capabilitySecret = 'hono-route-test-session-capability-secret';
const targetOriginVerifyHeader = 'origin-header-secret-0123456789abcdef';
const targetSessionAdmissionEnvKeys = [
  'TARGET_AWS_RUNTIME',
  'EXPECTED_ORIGIN_VERIFY_HEADER',
  'RUNTIME_DEPLOYMENT_ENV',
  'TARGET_DEVELOP_OPERATOR_GATE_ENABLED',
  'TARGET_PUBLIC_SESSION_CREATE_ENABLED',
  'SESSION_CREATE_TURNSTILE_REQUIRED',
] as const;

type TargetSessionAdmissionEnvKey = (typeof targetSessionAdmissionEnvKeys)[number];

function createBaseSession(overrides: Partial<SessionData> = {}): SessionData {
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
}

function createSessionAuthHeaders(sessionId: string = 'session-123'): Record<string, string> {
  return {
    'X-Session-ID': sessionId,
    'X-Session-Capability': createSessionCapabilityToken({ sessionId }, capabilitySecret),
  };
}

async function withTargetSessionAdmissionEnv(
  overrides: Partial<Record<TargetSessionAdmissionEnvKey, string>>,
  run: () => Promise<void>,
): Promise<void> {
  const originalValues = Object.fromEntries(
    targetSessionAdmissionEnvKeys.map((key) => [key, process.env[key]]),
  ) as Record<TargetSessionAdmissionEnvKey, string | undefined>;

  try {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = targetOriginVerifyHeader;
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
    process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'true';
    process.env['TARGET_PUBLIC_SESSION_CREATE_ENABLED'] = 'true';
    process.env['SESSION_CREATE_TURNSTILE_REQUIRED'] = 'false';
    Object.assign(process.env, overrides);

    await run();
  } finally {
    for (const key of targetSessionAdmissionEnvKeys) {
      const original = originalValues[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

describe('createHonoApp', () => {
  let consoleErrorSpy: MockInstance<typeof console.error>;
  let consoleWarnSpy: MockInstance<typeof console.warn>;
  let originalCapabilitySecret: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCapabilitySecret = process.env['SESSION_CAPABILITY_SECRET'];
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalCapabilitySecret === undefined) {
      delete process.env['SESSION_CAPABILITY_SECRET'];
    } else {
      process.env['SESSION_CAPABILITY_SECRET'] = originalCapabilitySecret;
    }
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('does not import the Next route binding adapter', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'apps/api/src/server/api/routes/hono.ts'), 'utf-8');

    expect(source).not.toContain('./registry');
    expect(source).not.toContain('./registry');
    expect(source).not.toContain('./next');
    expect(source).not.toContain('./next');
  });

  it('binds handlers with the global store', async () => {
    // Given
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

  it('rejects direct target API requests that miss the CloudFront origin verification header', async () => {
    const originalTargetRuntime = process.env['TARGET_AWS_RUNTIME'];
    const originalExpectedHeader = process.env['EXPECTED_ORIGIN_VERIFY_HEADER'];
    try {
      process.env['TARGET_AWS_RUNTIME'] = '1';
      process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = targetOriginVerifyHeader;

      const app = createHonoApp();
      const response = await app.request('http://localhost/api/session', { method: 'POST' });

      expect(response.status).toBe(403);
      const payload = await readJsonRecord(response, 'origin gate response');
      expect(getStringProperty(payload, 'error')).toBe('SAME_ORIGIN_REQUIRED');
      expect(getGlobalStore).not.toHaveBeenCalled();
    } finally {
      if (originalTargetRuntime === undefined) {
        delete process.env['TARGET_AWS_RUNTIME'];
      } else {
        process.env['TARGET_AWS_RUNTIME'] = originalTargetRuntime;
      }
      if (originalExpectedHeader === undefined) {
        delete process.env['EXPECTED_ORIGIN_VERIFY_HEADER'];
      } else {
        process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = originalExpectedHeader;
      }
    }
  });

  it('allows target session creation for operator-gated develop with matching origin verification', async () => {
    await withTargetSessionAdmissionEnv({}, async () => {
      const createSession = vi.fn<() => Promise<SessionData>>().mockResolvedValue(createBaseSession());
      const store = createMockVoteStore({ createSession });
      vi.mocked(getGlobalStore).mockReturnValue(store);

      const app = createHonoApp();
      const response = await app.request('http://localhost/api/session', {
        method: 'POST',
        headers: { [ORIGIN_VERIFY_HEADER]: targetOriginVerifyHeader },
      });

      expect(response.status).toBe(200);
      const payload = await readJsonRecord(response, 'target session response');
      const data = requireDataRecord(payload, 'target session data');
      expect(getStringProperty(data, 'sessionId')).toBe('session-123');
      expect(createSession).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects target session creation when the develop operator gate is disabled', async () => {
    await withTargetSessionAdmissionEnv({ TARGET_DEVELOP_OPERATOR_GATE_ENABLED: 'false' }, async () => {
      const createSession = vi.fn<() => Promise<SessionData>>().mockResolvedValue(createBaseSession());
      const store = createMockVoteStore({ createSession });
      vi.mocked(getGlobalStore).mockReturnValue(store);

      const app = createHonoApp();
      const response = await app.request('http://localhost/api/session', {
        method: 'POST',
        headers: { [ORIGIN_VERIFY_HEADER]: targetOriginVerifyHeader },
      });

      expect(response.status).toBe(404);
      const payload = await readJsonRecord(response, 'target session admission response');
      expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  it('rejects target session creation outside develop even when the gate flag is enabled', async () => {
    await withTargetSessionAdmissionEnv({ RUNTIME_DEPLOYMENT_ENV: 'main' }, async () => {
      const createSession = vi.fn<() => Promise<SessionData>>().mockResolvedValue(createBaseSession());
      const store = createMockVoteStore({ createSession });
      vi.mocked(getGlobalStore).mockReturnValue(store);

      const app = createHonoApp();
      const response = await app.request('http://localhost/api/session', {
        method: 'POST',
        headers: { [ORIGIN_VERIFY_HEADER]: targetOriginVerifyHeader },
      });

      expect(response.status).toBe(404);
      const payload = await readJsonRecord(response, 'target session admission response');
      expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
      expect(createSession).not.toHaveBeenCalled();
    });
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

    const app = createHonoApp({ basePath: '/test-readonly-api', mode: 'readonly' });

    // When
    const response = await app.request('http://localhost/test-readonly-api/progress');

    // Then
    expect(response.status).toBe(400);
    const payload = await readJsonRecord(response, 'progress response');
    expect(getStringProperty(payload, 'error')).toBe('SESSION_ID_REQUIRED');
  });

  it('does not register mutation routes in readonly mode', async () => {
    // Given
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/test-readonly-api', mode: 'readonly' });

    // When
    const response = await app.request('http://localhost/test-readonly-api/session', { method: 'POST' });

    // Then
    expect(response.status).toBe(404);
  });

  it('does not expose retired routes in readonly mode', async () => {
    const store = createMockVoteStore({
      getSession: vi.fn(() => Promise.reject(new Error('handler should not run'))),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/test-readonly-api', mode: 'readonly' });

    expect((await app.request('http://localhost/test-readonly-api/debug/enable')).status).toBe(404);
    expect((await app.request('http://localhost/test-readonly-api/botdata/12')).status).toBe(404);

    for (const value of ['true', '1', 'yes']) {
      const response = await app.request(
        `http://localhost/test-readonly-api/zkvm-input-hash?sessionId=session-1&includeData=${value}`,
      );
      expect(response.status).toBe(410);
      const payload = await readJsonRecord(response, 'retired route response');
      expect(getStringProperty(payload, 'error')).toBe('ROUTE_RETIRED');
    }
  });

  it('does not expose retired routes or private zkVM data variants in default mode', async () => {
    const store = createMockVoteStore({
      getSession: vi.fn(() => Promise.reject(new Error('handler should not run'))),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();

    expect((await app.request('http://localhost/api/debug/enable')).status).toBe(404);
    expect((await app.request('http://localhost/api/botdata/12')).status).toBe(404);

    for (const value of ['true', '1', 'yes']) {
      const response = await app.request(
        `http://localhost/api/zkvm-input-hash?sessionId=session-1&includeData=${value}`,
      );
      expect(response.status).toBe(410);
      const payload = await readJsonRecord(response, 'retired route response');
      expect(getStringProperty(payload, 'error')).toBe('ROUTE_RETIRED');
    }
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

  it('does not register retired debug or botdata routes in lambda mode', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    expect((await app.request('http://localhost/api/debug/enable')).status).toBe(404);
    expect((await app.request('http://localhost/api/botdata/12')).status).toBe(404);
  });

  it('rejects private zkVM input data variants in lambda mode before handler execution', async () => {
    const store = createMockVoteStore({
      getSession: vi.fn(() => Promise.reject(new Error('handler should not run'))),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    for (const value of ['true', '1', 'yes']) {
      const response = await app.request(
        `http://localhost/api/zkvm-input-hash?sessionId=session-1&includeData=${value}`,
      );
      expect(response.status).toBe(410);
      const payload = await readJsonRecord(response, 'retired route response');
      expect(getStringProperty(payload, 'error')).toBe('ROUTE_RETIRED');
    }
  });

  it('rejects unexpected query fields before readonly handler execution', async () => {
    const getSessionMock = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSession: getSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/verify?includeJournal=1&unexpected=1');
    const payload = await readJsonRecord(response, 'invalid query response');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('rejects undocumented public API query flag values before handler execution', async () => {
    const getSessionMock = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSession: getSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const verifyResponse = await app.request('http://localhost/api/verify?includeJournal=maybe');
    const verifyPayload = await readJsonRecord(verifyResponse, 'invalid includeJournal response');
    expect(verifyResponse.status).toBe(400);
    expect(getStringProperty(verifyPayload, 'error')).toBe('INVALID_REQUEST');

    const hashResponse = await app.request(
      'http://localhost/api/zkvm-input-hash?sessionId=session-1&includeData=maybe',
      {
        headers: { 'X-Session-Capability': 'not-used-before-validation' },
      },
    );
    const hashPayload = await readJsonRecord(hashResponse, 'invalid includeData response');
    expect(hashResponse.status).toBe(400);
    expect(getStringProperty(hashPayload, 'error')).toBe('INVALID_REQUEST');
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('returns a standard error envelope for consistency-proof semantic validation failures', async () => {
    const session = createBaseSession();
    const store = createMockVoteStore({
      getSession: vi.fn(() => Promise.resolve(session)),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/bulletin/consistency-proof?oldSize=2&newSize=1', {
      headers: createSessionAuthHeaders(session.sessionId),
    });
    const payload = await readJsonRecord(response, 'consistency proof semantic error');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_SIZE');
    expect(getStringProperty(payload, 'message')).toBeTruthy();
    expect(payload).toHaveProperty('statusCode', 400);
  });

  it('returns a standard error envelope for bitmap-proof semantic failures', async () => {
    const session = createBaseSession();
    const store = createMockVoteStore({
      getSession: vi.fn(() => Promise.resolve(session)),
      getBitmapData: vi.fn(() => Promise.resolve(null)),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/bitmap-proof?i=0', {
      headers: createSessionAuthHeaders(session.sessionId),
    });
    const payload = await readJsonRecord(response, 'bitmap proof semantic error');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_BITMAP_PROOF_REQUEST');
    expect(getStringProperty(payload, 'message')).toBeTruthy();
    expect(payload).toHaveProperty('statusCode', 400);
  });

  it('rejects invalid path params before handler execution', async () => {
    const getSessionMock = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSession: getSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/verification/bundles/session-1/bad.segment');
    const payload = await readJsonRecord(response, 'invalid params response');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('rejects query fields on routes without a query schema before handler execution', async () => {
    const getSessionMock = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSession: getSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/progress?unexpected=1');
    const payload = await readJsonRecord(response, 'invalid no-query response');

    expect(response.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_REQUEST');
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('allows documented bulletin paging query fields but rejects extras', async () => {
    const getSessionMock = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSession: getSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const documentedResponse = await app.request('http://localhost/api/bulletin?offset=0&limit=10');
    const documentedPayload = await readJsonRecord(documentedResponse, 'documented query response');
    expect(documentedResponse.status).toBe(400);
    expect(getStringProperty(documentedPayload, 'error')).toBe('SESSION_ID_REQUIRED');
    expect(getSessionMock).not.toHaveBeenCalled();

    const extraResponse = await app.request('http://localhost/api/bulletin?offset=0&limit=10&unexpected=1');
    const extraPayload = await readJsonRecord(extraResponse, 'extra query response');
    expect(extraResponse.status).toBe(400);
    expect(getStringProperty(extraPayload, 'error')).toBe('INVALID_REQUEST');
    expect(getSessionMock).not.toHaveBeenCalled();
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
    expect(allowHeaders).not.toContain('authorization');
    expect(allowHeaders).not.toContain('x-debug-log');
    expect(allowHeaders).not.toContain('x-turnstile-token');

    const allowMethods = response.headers.get('access-control-allow-methods') ?? '';
    expect(allowMethods).toContain('GET');
    expect(allowMethods).toContain('POST');
    expect(allowMethods).toContain('OPTIONS');
    expect(allowMethods).not.toContain('PUT');
    expect(allowMethods).not.toContain('DELETE');
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

  it('rejects cross-origin STH requests in lambda mode before session lookup', async () => {
    const getSessionMock = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSession: getSessionMock,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/sth', {
      headers: {
        Origin: 'https://auditor.example',
        'Sec-Fetch-Site': 'cross-site',
        'X-Session-ID': 'session-1',
        'X-Session-Capability': 'capability-token',
      },
    });
    const payload = await readJsonRecord(response, 'same-origin response');

    expect(response.status).toBe(403);
    expect(getStringProperty(payload, 'error')).toBe('SAME_ORIGIN_REQUIRED');
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('allows labeled same-origin STH auditor sources through request validation', async () => {
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(createBaseSession()),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/sth?auditor=b', {
      headers: createSessionAuthHeaders(),
    });
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(404);
    expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FINALIZED');
  });

  it('ignores retired debug header and cookie activation in request logging', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const headerResponse = await app.request('http://localhost/api/progress', {
      headers: {
        'x-debug-log': 'retired-debug-token',
      },
    });
    const cookieResponse = await app.request('http://localhost/api/progress', {
      headers: {
        cookie: 'stark_ballot_debug=retired-debug-token',
      },
    });

    expect(headerResponse.status).toBe(400);
    expect(cookieResponse.status).toBe(400);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
  });
});
