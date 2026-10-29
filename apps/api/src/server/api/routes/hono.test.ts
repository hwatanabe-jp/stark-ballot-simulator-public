import { handle } from '@hono/aws-lambda';
import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createHonoApp as createConfiguredHonoApp, ORIGIN_VERIFY_HEADER, type HonoAppOptions } from './hono';
import { createMockVoteStore, type MockVoteStore } from '../../test-support/mockVoteStore';
import {
  getApiErrorCode,
  readJsonRecord,
  requireDataRecord,
} from '@stark-ballot/test-support/testing/response-helpers';
import { getObjectProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { getLogContext } from '@stark-ballot/diagnostics/requestLogContext';
import { configureLogger, logger } from '@stark-ballot/diagnostics/logger';
import { hashIpForLogging } from '@stark-ballot/diagnostics/logging';
import type { ArtifactReader } from '@stark-ballot/application/verification/artifact-reader';
import {
  localRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import {
  clearRuntimeConfigReferenceResolver,
  installStaticRuntimeConfigReferenceResolver,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

const sessionCreateRateLimitMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ clientIp: '203.0.113.10' })));

vi.mock('../middleware/rateLimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/rateLimit')>()),
  enforceSessionCreateRateLimit: sessionCreateRateLimitMock,
}));

const capabilitySecret = 'hono-route-test-session-capability-secret';
const targetOriginVerifyHeader = 'origin-header-secret-0123456789abcdef';
const localProfile = localRuntimeProfile();

function createHonoApp(options: HonoAppOptions = {}) {
  return createConfiguredHonoApp({
    runtimeProfile: localProfile,
    ...options,
  });
}

function createBaseIdentity(overrides: Partial<SessionIdentityRecord> = {}): SessionIdentityRecord {
  const now = Date.now();
  return {
    sessionId: asSessionId('session-123'),
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: '0x' + '1'.repeat(64),
    electionConfig: {
      totalExpected: 1,
      choices: ['A', 'B', 'C', 'D', 'E'],
      version: 'test-v1',
      botCount: 0,
      merkleTreeDepth: 1,
    },
    logId: '0x' + '2'.repeat(64),
    createdAtMs: now,
    ...overrides,
  };
}

function createBaseVotingRecord(
  identity: SessionIdentityRecord = createBaseIdentity(),
  overrides: Partial<SessionVotingRecord> = {},
): SessionVotingRecord {
  return {
    sessionId: identity.sessionId,
    votes: new Map(),
    bulletin: new SimpleBulletinBoard(identity.logId),
    bulletinRootHistory: [],
    botCount: 0,
    userParticipation: { status: 'not_cast' },
    lastActivityMs: identity.createdAtMs,
    ...overrides,
  };
}

function createStoreWithSession(
  identity: SessionIdentityRecord = createBaseIdentity(),
  voting: SessionVotingRecord = createBaseVotingRecord(identity),
  overrides: Partial<MockVoteStore> = {},
): MockVoteStore {
  return createMockVoteStore({
    getSessionIdentity: (requestedSessionId) =>
      Promise.resolve(requestedSessionId === identity.sessionId ? identity : null),
    getVotingRecord: (requestedSessionId) => Promise.resolve(requestedSessionId === identity.sessionId ? voting : null),
    getCurrentFinalizationRecord: () => Promise.resolve(null),
    ...overrides,
  });
}

function createBotVotes(count: number): Map<number, StoredVoteRecord> {
  return new Map(
    Array.from({ length: count }, (_, index) => [
      index,
      {
        voteId: `bot-vote-${index}`,
        vote: 'A' as const,
        rand: `0x${String(index + 1).padStart(64, '0')}`,
        commit: `0x${String(index + 1).padStart(64, '0')}`,
        timestamp: index + 1,
        rootAtCast: `0x${'0'.repeat(64)}`,
      },
    ]),
  );
}

function createObsoleteSessionIdentityHeaders(sessionId: string = 'session-123'): Record<string, string> {
  return {
    'X-Session-ID': sessionId,
  };
}

function createPathSessionAuthHeaders(sessionId: string = 'session-123'): Record<string, string> {
  return {
    'X-Session-Capability': createSessionCapabilityToken({ sessionId: asSessionId(sessionId) }, capabilitySecret),
  };
}

function configureTargetRuntime(
  deploymentEnvironment: 'develop' | 'main',
  selector: 'target-aws-async' | 'target-aws-async-quiesced' = 'target-aws-async',
): ResolvedRuntimeProfile {
  const profileEnv = targetRuntimeProfileEnv(deploymentEnvironment);
  profileEnv['RUNTIME_PROFILE'] = selector;
  const profile = resolveRuntimeProfile(profileEnv);
  for (const [name, value] of Object.entries(profileEnv)) {
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }
  vi.stubEnv('SESSION_CAPABILITY_SECRET', '');
  vi.stubEnv('SESSION_CAPABILITY_TTL_SECONDS', '');
  vi.stubEnv('VOTE_SECRET_ENCRYPTION_KEY', '');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  vi.stubEnv('EXPECTED_ORIGIN_VERIFY_HEADER', targetOriginVerifyHeader);
  vi.stubEnv('LOG_IP_HASH_SALT', 'resolved-hono-route-log-hash-salt');
  vi.stubEnv('LOG_FORMAT', 'json');
  vi.stubEnv('DEPLOYMENT_ID', `dep_${'1'.repeat(32)}`);
  vi.stubEnv('APP_SOURCE_SHA', '2'.repeat(40));
  vi.stubEnv('DEPLOY_MODE', 'normal');

  if (profile.target.kind !== 'aws' || profile.external.kind !== 'aws') {
    throw new Error('Expected target AWS runtime profile');
  }
  installStaticRuntimeConfigReferenceResolver(
    new Map([
      [profile.external.secretReferences.sessionCapabilitySecret, capabilitySecret],
      [profile.external.secretReferences.sessionCapabilityTtlSeconds, '300'],
      [profile.external.secretReferences.turnstileSecretKey, 'resolved-turnstile-secret'],
      [profile.external.secretReferences.voteSecretEncryptionKey, `0x${'3'.repeat(64)}`],
      [profile.external.secretReferences.expectedOriginVerifyHeader, targetOriginVerifyHeader],
      [profile.external.secretReferences.logIpHashSalt, 'resolved-hono-route-log-hash-salt'],
    ]),
    {
      expectedAccountId: profile.external.accountId,
      expectedDeploymentEnvironment: profile.target.deploymentEnvironment,
      expectedRegion: profile.external.region,
    },
  );
  return profile;
}

function createTargetAdmissionTestApp(profile: ResolvedRuntimeProfile) {
  const artifactReader: ArtifactReader = {
    read: () => Promise.resolve({ kind: 'notFound' }),
  };
  return createHonoApp({
    runtimeProfile: profile,
    artifactDeliveryDependencyOverrides: { artifactReader },
  });
}

describe('createHonoApp', () => {
  let consoleErrorSpy: MockInstance<typeof console.error>;
  let consoleWarnSpy: MockInstance<typeof console.warn>;
  let loggerErrorSpy: MockInstance<typeof logger.error>;
  let loggerWarnSpy: MockInstance<typeof logger.warn>;
  let originalCapabilitySecret: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigReferenceResolver();
    originalCapabilitySecret = process.env['SESSION_CAPABILITY_SECRET'];
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loggerErrorSpy = vi.spyOn(logger, 'error');
    loggerWarnSpy = vi.spyOn(logger, 'warn');
  });

  afterEach(() => {
    clearRuntimeConfigReferenceResolver();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (originalCapabilitySecret === undefined) {
      delete process.env['SESSION_CAPABILITY_SECRET'];
    } else {
      process.env['SESSION_CAPABILITY_SECRET'] = originalCapabilitySecret;
    }
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    loggerErrorSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  it('authenticates cancellation before rate/body admission and the sync-mode refusal', async () => {
    const identity = createBaseIdentity();
    vi.mocked(getGlobalStore).mockReturnValue(createStoreWithSession(identity));
    const enforceFinalizeCancelRateLimit = vi.fn(async () => ({ clientIp: '203.0.113.10' }));
    const app = createHonoApp({ finalizationDependencyOverrides: { enforceFinalizeCancelRateLimit } });
    const url = `/api/sessions/${identity.sessionId}/finalizations/test-finalization/cancel`;
    const denied = await app.request(url, {
      method: 'POST',
      headers: { 'X-Session-Capability': 'invalid' },
      body: '{',
    });
    expect(denied.status).toBe(401);
    expect(enforceFinalizeCancelRateLimit).not.toHaveBeenCalled();
    const headers = { ...createPathSessionAuthHeaders(identity.sessionId), 'Content-Type': 'application/json' };
    const invalidBody = await app.request(url, { method: 'POST', headers, body: '{' });
    expect(invalidBody.status).toBe(400);
    expect(enforceFinalizeCancelRateLimit).toHaveBeenCalledOnce();
    const disabled = await app.request(url, { method: 'POST', headers, body: '{}' });
    expect(disabled.status).toBe(404);
    expect(enforceFinalizeCancelRateLimit).toHaveBeenCalledTimes(2);
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
      createSession: () => Promise.resolve(createBaseIdentity()),
    });

    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();
    // When
    const response = await app.request('http://localhost/api/sessions', { method: 'POST' });

    // Then
    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'session response');
    const data = requireDataRecord(payload, 'session data');
    expect(getStringProperty(data, 'sessionId')).toBe('session-123');
    expect(data).not.toHaveProperty('artifactContractId');
    expect(data).not.toHaveProperty('contractGeneration');
    expect(getStringProperty(getObjectProperty(payload, 'meta'), 'requestId')).toBeTruthy();
  });

  it('does not register the replaced session, vote, or progress paths', async () => {
    vi.mocked(getGlobalStore).mockReturnValue(createMockVoteStore());
    const app = createHonoApp();

    expect((await app.request('http://localhost/api/session', { method: 'POST' })).status).toBe(404);
    expect((await app.request('http://localhost/api/vote', { method: 'POST' })).status).toBe(404);
    expect((await app.request('http://localhost/api/progress')).status).toBe(404);
  });

  it.each(['develop', 'main'] as const)('rejects direct %s API requests without origin verification', async (env) => {
    const profile = configureTargetRuntime(env);
    const app = createTargetAdmissionTestApp(profile);
    const response = await app.request('http://localhost/api/sessions', { method: 'POST' });

    expect(response.status).toBe(403);
    const payload = await readJsonRecord(response, 'origin gate response');
    expect(getApiErrorCode(payload)).toBe('SAME_ORIGIN_REQUIRED');
    expect(getGlobalStore).not.toHaveBeenCalled();
  });

  it('uses the injected local profile for admission and store selection', async () => {
    const profile = localRuntimeProfile();
    const store = createMockVoteStore({
      createSession: () => Promise.resolve(createBaseIdentity()),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ runtimeProfile: profile });
    const response = await app.request('http://localhost/api/sessions', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(getGlobalStore).toHaveBeenCalledWith(profile);
  });

  it('allows target session creation for operator-gated develop with matching origin verification', async () => {
    const profile = configureTargetRuntime('develop');
    const createSession = vi.fn().mockResolvedValue(createBaseIdentity());
    const store = createMockVoteStore({ createSession });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createTargetAdmissionTestApp(profile);
    const response = await app.request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { [ORIGIN_VERIFY_HEADER]: targetOriginVerifyHeader },
    });

    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'target session response');
    const data = requireDataRecord(payload, 'target session data');
    expect(getStringProperty(data, 'sessionId')).toBe('session-123');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('uses the injected develop profile for operator-gated admission', async () => {
    const profile = configureTargetRuntime('develop');
    const createSession = vi.fn().mockResolvedValue(createBaseIdentity());
    vi.mocked(getGlobalStore).mockReturnValue(createMockVoteStore({ createSession }));

    const app = createTargetAdmissionTestApp(profile);
    const response = await app.request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { [ORIGIN_VERIFY_HEADER]: targetOriginVerifyHeader },
    });

    expect(response.status).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(getGlobalStore).toHaveBeenCalledWith(profile);
  });

  it('blocks session creation for a quiesced target develop profile even with verified origin admission', async () => {
    const profile = configureTargetRuntime('develop', 'target-aws-async-quiesced');
    const createSession = vi.fn().mockResolvedValue(createBaseIdentity());
    vi.mocked(getGlobalStore).mockReturnValue(createMockVoteStore({ createSession }));

    const app = createTargetAdmissionTestApp(profile);
    const response = await app.request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { [ORIGIN_VERIFY_HEADER]: targetOriginVerifyHeader },
    });

    expect(response.status).toBe(404);
    expect(getApiErrorCode(await readJsonRecord(response, 'quiesced session admission response'))).toBe(
      'SESSION_NOT_FOUND',
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('requires a Turnstile token for main session creation', async () => {
    const profile = configureTargetRuntime('main');
    const createSession = vi.fn().mockResolvedValue(createBaseIdentity());
    vi.mocked(getGlobalStore).mockReturnValue(createMockVoteStore({ createSession }));

    const app = createTargetAdmissionTestApp(profile);
    const response = await app.request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { [ORIGIN_VERIFY_HEADER]: targetOriginVerifyHeader },
    });

    expect(response.status).toBe(403);
    const payload = await readJsonRecord(response, 'target session admission response');
    expect(getApiErrorCode(payload)).toBe('CAPTCHA_FAILED');
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'valid session challenge',
      success: true,
      action: 'session',
      hostname: 'stark-ballot-sim.hwatanabe.dev',
      allowed: true,
    },
    {
      label: 'failed challenge',
      success: false,
      action: 'session',
      hostname: 'stark-ballot-sim.hwatanabe.dev',
      allowed: false,
    },
    {
      label: 'wrong action',
      success: true,
      action: 'vote',
      hostname: 'stark-ballot-sim.hwatanabe.dev',
      allowed: false,
    },
    { label: 'wrong hostname', success: true, action: 'session', hostname: 'untrusted.example', allowed: false },
  ])('checks main session admission against $label', async ({ success, action, hostname, allowed }) => {
    const profile = configureTargetRuntime('main');
    const createSession = vi.fn().mockResolvedValue(createBaseIdentity());
    vi.mocked(getGlobalStore).mockReturnValue(createMockVoteStore({ createSession }));
    const verify = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success, action, hostname }));
    vi.stubGlobal('fetch', verify);

    const response = await createTargetAdmissionTestApp(profile).request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { [ORIGIN_VERIFY_HEADER]: targetOriginVerifyHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'test-session-token' }),
    });

    expect(verify).toHaveBeenCalledTimes(1);
    const request = verify.mock.calls[0];
    expect(request?.[0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(request?.[1]?.method).toBe('POST');
    expect(request?.[1]?.body).toBeInstanceOf(URLSearchParams);
    expect(response.status).toBe(allowed ? 200 : 403);
    expect(createSession).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) {
      expect(getApiErrorCode(await readJsonRecord(response, 'main challenge rejection'))).toBe('CAPTCHA_FAILED');
    }
  });

  it('returns standardized error payloads when handlers throw', async () => {
    // Given
    const store = createMockVoteStore({
      createSession: () => Promise.reject(new Error('boom')),
    });

    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();
    // When
    const response = await app.request('http://localhost/api/sessions', { method: 'POST' });

    // Then
    expect(response.status).toBe(500);
    const payload = await readJsonRecord(response, 'error response');
    expect(getApiErrorCode(payload)).toBe('INTERNAL_ERROR');
  });

  it.each(['full', 'lambda', 'readonly'] as const)(
    'blocks HEAD before store access in %s and through the Gateway adapter',
    async (mode) => {
      const app = createHonoApp({ mode, basePath: '/custom' });
      vi.mocked(getGlobalStore).mockClear();
      for (const suffix of ['progress', 'finalizations/current', 'finalizations/execution/artifacts/bundle']) {
        const path = `/custom/sessions/session-123/${suffix}`;
        const response = await app.request(`http://localhost${path}`, { method: 'HEAD' });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('');
        const gateway = await handle(app)({
          version: '',
          resource: '/custom/{proxy+}',
          path,
          httpMethod: 'HEAD',
          headers: {},
          body: null,
          isBase64Encoded: false,
          requestContext: {
            accountId: '123456789012',
            apiId: 'test',
            authorizer: {},
            domainName: 'localhost',
            domainPrefix: 'localhost',
            httpMethod: 'HEAD',
            path,
            protocol: 'HTTP/1.1',
            identity: { sourceIp: '127.0.0.1', userAgent: 'test' },
            extendedRequestId: 'gateway-head',
            requestId: 'gateway-head',
            resourcePath: '/custom/{proxy+}',
            stage: 'live',
            requestTime: '',
            requestTimeEpoch: 0,
          },
        });
        expect(gateway.statusCode).toBe(404);
        expect(gateway.body).toBe('');
      }
      expect(getGlobalStore).not.toHaveBeenCalled();
    },
  );

  it('supports custom basePath for read-only routes', async () => {
    // Given
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/test-readonly-api', mode: 'readonly' });

    // When
    const response = await app.request('http://localhost/test-readonly-api/sessions/session-123/progress');

    // Then
    expect(response.status).toBe(401);
    const payload = await readJsonRecord(response, 'progress response');
    expect(getApiErrorCode(payload)).toBe('SESSION_CAPABILITY_REQUIRED');
  });

  it('rejects a wire session identifier before capability or store access', async () => {
    const getSessionIdentity = vi.fn(() => Promise.reject(new Error('store should not run')));
    vi.mocked(getGlobalStore).mockReturnValue(createMockVoteStore({ getSessionIdentity }));
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const response = await app.request('http://localhost/api/sessions/session_unsafe/progress');

    expect(response.status).toBe(400);
    expect(getApiErrorCode(await readJsonRecord(response, 'invalid session identifier response'))).toBe(
      'INVALID_REQUEST',
    );
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it('derives progress identity from the path and does not authorize with an obsolete identity header', async () => {
    const identity = createBaseIdentity();
    const voting = createBaseVotingRecord(identity, {
      votes: createBotVotes(5),
      botCount: 4,
    });
    const getVotingRecord = vi.fn(() => Promise.resolve(voting));
    vi.mocked(getGlobalStore).mockReturnValue(createStoreWithSession(identity, voting, { getVotingRecord }));
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const success = await app.request('http://localhost/api/sessions/session-123/progress', {
      headers: createPathSessionAuthHeaders(),
    });
    expect(success.status).toBe(200);
    expect(requireDataRecord(await readJsonRecord(success), 'progress data')).toMatchObject({
      count: 4,
      userVoted: false,
      finalized: false,
    });
    expect(getVotingRecord).toHaveBeenCalledWith('session-123');

    getVotingRecord.mockClear();
    const obsoleteHeader = await app.request('http://localhost/api/sessions/session-123/progress', {
      headers: createObsoleteSessionIdentityHeaders(),
    });
    expect(obsoleteHeader.status).toBe(401);
    expect(getApiErrorCode(await readJsonRecord(obsoleteHeader))).toBe('SESSION_CAPABILITY_REQUIRED');
    expect(getVotingRecord).not.toHaveBeenCalled();
  });

  it('does not register mutation routes in readonly mode', async () => {
    // Given
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/test-readonly-api', mode: 'readonly' });

    // When
    const response = await app.request('http://localhost/test-readonly-api/sessions', { method: 'POST' });

    // Then
    expect(response.status).toBe(404);
  });

  it('does not expose retired routes in readonly mode', async () => {
    const store = createMockVoteStore({
      getSessionIdentity: vi.fn(() => Promise.reject(new Error('handler should not run'))),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/test-readonly-api', mode: 'readonly' });

    expect((await app.request('http://localhost/test-readonly-api/debug/enable')).status).toBe(404);
    expect((await app.request('http://localhost/test-readonly-api/botdata/12')).status).toBe(404);
    for (const path of [
      '/bulletin',
      '/bulletin/consistency-proof',
      '/bulletin/vote-1/proof',
      '/sth',
      '/bitmap-proof',
      '/zkvm-input-hash',
    ]) {
      expect((await app.request(`http://localhost/test-readonly-api${path}`)).status).toBe(404);
    }
  });

  it('does not expose replaced evidence routes or private input query variants in default mode', async () => {
    const store = createMockVoteStore({
      getSessionIdentity: vi.fn(() => Promise.reject(new Error('handler should not run'))),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();

    expect((await app.request('http://localhost/api/debug/enable')).status).toBe(404);
    expect((await app.request('http://localhost/api/botdata/12')).status).toBe(404);

    for (const path of [
      '/bulletin',
      '/bulletin/consistency-proof',
      '/bulletin/vote-1/proof',
      '/sth',
      '/bitmap-proof',
      '/zkvm-input-hash',
    ]) {
      expect((await app.request(`http://localhost/api${path}`)).status).toBe(404);
    }

    for (const value of ['true', '1', 'yes', 'false', 'maybe']) {
      const response = await app.request(
        `http://localhost/api/sessions/session-1/finalizations/current/input-commitment?includeData=${value}`,
      );
      expect(response.status).toBe(400);
      expect(getApiErrorCode(await readJsonRecord(response, 'private input query rejection'))).toBe('INVALID_REQUEST');
    }
  });

  it('registers the internal callback only in full mode and keeps it outside CORS', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);
    const callbackPath = '/api/internal/sessions/session-1/finalizations/finalization-1/callback';

    for (const mode of ['lambda', 'readonly'] as const) {
      const app = createHonoApp({ basePath: '/api', mode });
      const response = await app.request(`http://localhost${callbackPath}`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3000',
        },
      });

      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8');
      expect(await response.text()).toBe('404 Not Found');
    }

    vi.stubEnv('FINALIZE_CALLBACK_SECRET', '');
    const fullApp = createHonoApp({ basePath: '/api', mode: 'full' });
    const response = await fullApp.request(`http://localhost${callbackPath}`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
      },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();

    for (const mode of ['full', 'lambda', 'readonly'] as const) {
      const app = mode === 'full' ? fullApp : createHonoApp({ basePath: '/api', mode });
      const preflight = await app.request(`http://localhost${callbackPath}`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });
      expect(preflight.status, mode).toBe(404);
      expect(preflight.headers.get('Access-Control-Allow-Origin'), mode).toBeNull();
      expect(preflight.headers.get('Access-Control-Allow-Methods'), mode).toBeNull();
      expect(preflight.headers.get('Access-Control-Allow-Headers'), mode).toBeNull();
    }
  });

  it('does not register retired debug or botdata routes in lambda mode', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    for (const path of ['/debug/enable', '/botdata/12']) {
      const response = await app.request(`http://localhost/api${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8');
      expect(await response.text()).toBe('404 Not Found');
    }
  });

  it('rejects private input query variants in lambda mode before handler execution', async () => {
    const store = createMockVoteStore({
      getSessionIdentity: vi.fn(() => Promise.reject(new Error('handler should not run'))),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    for (const value of ['true', '1', 'yes', 'false', 'maybe']) {
      const response = await app.request(
        `http://localhost/api/sessions/session-1/finalizations/current/input-commitment?includeData=${value}`,
      );
      expect(response.status).toBe(400);
      const payload = await readJsonRecord(response, 'private input query rejection');
      expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    }
  });

  it('rejects unexpected query fields before readonly handler execution', async () => {
    const getSessionIdentity = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSessionIdentity,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request(
      'http://localhost/api/sessions/session-1/finalizations/finalization-1/verification?include=journal&unexpected=1',
      {
        headers: { 'X-Session-Capability': 'not-used-before-validation' },
      },
    );
    const payload = await readJsonRecord(response, 'invalid query response');

    expect(response.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it('rejects undocumented public API query flag values before handler execution', async () => {
    const getSessionIdentity = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSessionIdentity,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const verifyResponse = await app.request(
      'http://localhost/api/sessions/session-1/finalizations/finalization-1/verification?include=maybe',
      {
        headers: { 'X-Session-Capability': 'not-used-before-validation' },
      },
    );
    const verifyPayload = await readJsonRecord(verifyResponse, 'invalid include response');
    expect(verifyResponse.status).toBe(400);
    expect(getApiErrorCode(verifyPayload)).toBe('INVALID_REQUEST');

    const inputCommitmentResponse = await app.request(
      'http://localhost/api/sessions/session-1/finalizations/current/input-commitment?includeData=maybe',
      {
        headers: { 'X-Session-Capability': 'not-used-before-validation' },
      },
    );
    const inputCommitmentPayload = await readJsonRecord(inputCommitmentResponse, 'invalid includeData response');
    expect(inputCommitmentResponse.status).toBe(400);
    expect(getApiErrorCode(inputCommitmentPayload)).toBe('INVALID_REQUEST');
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it('returns a standard error envelope for consistency-proof semantic validation failures', async () => {
    const identity = createBaseIdentity();
    const store = createStoreWithSession(identity);
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request(
      `http://localhost/api/sessions/${identity.sessionId}/bulletin/consistency-proof?fromTreeSize=2&toTreeSize=1`,
      {
        headers: createPathSessionAuthHeaders(identity.sessionId),
      },
    );
    const payload = await readJsonRecord(response, 'consistency proof semantic error');

    expect(response.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_SIZE');
    expect(getStringProperty(getObjectProperty(payload, 'error'), 'message')).toBeTruthy();
    expect(payload).not.toHaveProperty('statusCode');
  });

  it('returns a standard error envelope for bitmap-proof semantic failures', async () => {
    const identity = createBaseIdentity();
    const store = createStoreWithSession(identity, createBaseVotingRecord(identity), {
      getBitmapData: vi.fn(() => Promise.resolve(null)),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request(
      `http://localhost/api/sessions/${identity.sessionId}/finalizations/current/bitmap-proofs/included/0`,
      {
        headers: createPathSessionAuthHeaders(identity.sessionId),
      },
    );
    const payload = await readJsonRecord(response, 'bitmap proof semantic error');

    expect(response.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_BITMAP_PROOF_REQUEST');
    expect(getStringProperty(getObjectProperty(payload, 'error'), 'message')).toBeTruthy();
    expect(payload).not.toHaveProperty('statusCode');
  });

  it('rejects invalid path params before handler execution', async () => {
    const getSessionIdentity = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSessionIdentity,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request(
      'http://localhost/api/sessions/session-1/finalizations/bad.segment/artifacts/bundle',
    );
    const payload = await readJsonRecord(response, 'invalid params response');

    expect(response.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it('rejects query fields on routes without a query schema before handler execution', async () => {
    const getVotingRecord = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getVotingRecord,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/sessions/session-123/progress?unexpected=1');
    const payload = await readJsonRecord(response, 'invalid no-query response');

    expect(response.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    expect(getVotingRecord).not.toHaveBeenCalled();
  });

  it('allows documented bulletin paging query fields but rejects extras', async () => {
    const getSessionIdentity = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSessionIdentity,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const documentedResponse = await app.request(
      'http://localhost/api/sessions/session-123/bulletin?offset=0&limit=10',
    );
    const documentedPayload = await readJsonRecord(documentedResponse, 'documented query response');
    expect(documentedResponse.status).toBe(401);
    expect(getApiErrorCode(documentedPayload)).toBe('SESSION_CAPABILITY_REQUIRED');
    expect(getSessionIdentity).not.toHaveBeenCalled();

    const extraResponse = await app.request(
      'http://localhost/api/sessions/session-123/bulletin?offset=0&limit=10&unexpected=1',
    );
    const extraPayload = await readJsonRecord(extraResponse, 'extra query response');
    expect(extraResponse.status).toBe(400);
    expect(getApiErrorCode(extraPayload)).toBe('INVALID_REQUEST');
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it('does not authorize canonical evidence routes with the obsolete identity header', async () => {
    const getSessionIdentity = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSessionIdentity,
      }),
    );

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const headers = createObsoleteSessionIdentityHeaders('session-123');
    for (const path of [
      '/sessions/session-123/bulletin',
      '/sessions/session-123/bulletin/consistency-proof?fromTreeSize=0&toTreeSize=0',
      '/sessions/session-123/votes/550e8400-e29b-41d4-a716-446655440000/inclusion-proof',
      '/sessions/session-123/bulletin/sth',
      '/sessions/session-123/finalizations/current/bitmap-proofs/included/0',
      '/sessions/session-123/finalizations/current/input-commitment',
    ]) {
      const response = await app.request(`http://localhost/api${path}`, { headers });
      expect(response.status, path).toBe(401);
      expect(getApiErrorCode(await readJsonRecord(response, `obsolete identity rejection for ${path}`))).toBe(
        'SESSION_CAPABILITY_REQUIRED',
      );
    }
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it('allows authenticated range and conditional-read headers in CORS preflight', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();
    const response = await app.request('http://localhost/api/sessions', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Session-Capability, Range, If-None-Match',
      },
    });

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    const allowHeaders = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
    expect(allowHeaders).not.toContain('x-session-id');
    expect(allowHeaders).toContain('x-session-capability');
    expect(allowHeaders).toContain('range');
    expect(allowHeaders).toContain('if-none-match');
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

  it('exposes ranged bundle and conditional-read response headers to browser JavaScript', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp();
    const response = await app.request('http://localhost/api/sessions/session-123/progress', {
      headers: {
        Origin: 'http://localhost:3000',
      },
    });

    const exposeHeaders = response.headers.get('access-control-expose-headers')?.toLowerCase() ?? '';
    expect(exposeHeaders).toContain('content-range');
    expect(exposeHeaders).toContain('accept-ranges');
    expect(exposeHeaders).toContain('x-stark-bundle-range-chunk-size');
    expect(exposeHeaders).toContain('x-request-id');
    expect(exposeHeaders).toContain('etag');
  });

  it('returns the trusted gateway request ID and never promotes a client header', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const response = await app.fetch(
      new Request('http://localhost/api/sessions/session-123/progress', {
        headers: { 'x-request-id': 'client-ref_123.abc' },
      }),
      { requestContext: { extendedRequestId: 'trusted-gateway-request-id' } },
    );

    expect(response.headers.get('x-request-id')).toBe('trusted-gateway-request-id');
    const payload = await readJsonRecord(response, 'correlated request failure');
    expect(getStringProperty(getObjectProperty(payload, 'meta'), 'requestId')).toBe('trusted-gateway-request-id');
    expect(JSON.stringify(payload)).not.toContain('client-ref_123.abc');
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'request completed',
      expect.objectContaining({
        event: 'http_request',
        client_request_id: 'client-ref_123.abc',
      }),
    );
  });

  it('generates a trusted local request ID and omits malicious client correlators', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';

    const response = await app.request('http://localhost/api/sessions/session-123/progress', {
      headers: {
        'x-request-id': `/api/sessions/${rawSessionId}/finalizations/execution-1/artifacts/bundle`,
      },
    });

    expect(response.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const payload = await readJsonRecord(response, 'generated request ID failure');
    expect(getStringProperty(getObjectProperty(payload, 'meta'), 'requestId')).toBe(
      response.headers.get('x-request-id'),
    );
    const summaryFields = loggerWarnSpy.mock.calls.find(
      (call) => call[0] === 'request completed' && typeof call[1] === 'object' && call[1] !== null,
    )?.[1] as Record<string, unknown> | undefined;
    expect(summaryFields).not.toHaveProperty('client_request_id');
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(rawSessionId);
  });

  it('emits a safe JSON summary with the route template and matching trusted response ID', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const finalizationId = 'execution-1';
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);
    configureLogger({
      format: 'json',
      level: 'debug',
      serviceName: 'public-api',
      envName: 'test',
      includeStack: true,
    });

    try {
      const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
      const response = await app.fetch(
        new Request(
          `http://localhost/api/sessions/${rawSessionId}/finalizations/${finalizationId}/artifacts/bundle?private=${rawSessionId}`,
          {
            headers: {
              'x-request-id': `/api/sessions/${rawSessionId}/finalizations/${finalizationId}/artifacts/bundle`,
            },
          },
        ),
        { requestContext: { extendedRequestId: 'trusted-summary-request-id' } },
      );

      const emittedRecords = consoleWarnSpy.mock.calls
        .map(([value]) => (typeof value === 'string' ? value : ''))
        .filter((value) => value.startsWith('{'))
        .map((value) => JSON.parse(value) as unknown);
      const summary = emittedRecords.find((value) => getStringProperty(value, 'event') === 'http_request');
      const summaryHttp = getObjectProperty(summary, 'http');

      expect(response.headers.get('x-request-id')).toBe('trusted-summary-request-id');
      expect(getStringProperty(summary, 'request_id')).toBe('trusted-summary-request-id');
      expect(getStringProperty(summaryHttp, 'path')).toBe(
        '/api/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle',
      );
      expect(summary).not.toHaveProperty('client_request_id');
      expect(JSON.stringify(emittedRecords)).not.toContain(rawSessionId);
      expect(JSON.stringify(emittedRecords)).not.toContain('private=');
    } finally {
      configureLogger({
        format: 'text',
        level: 'warn',
        serviceName: 'app',
        envName: 'unknown',
        includeStack: false,
      });
    }
  });

  it('uses a route template and trusted request ID while handling thrown route errors', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const observedContexts: unknown[] = [];
    const store = createMockVoteStore({
      getSessionIdentity: vi.fn(() => {
        observedContexts.push(getLogContext());
        return Promise.reject(new Error(`storage failed for /api/sessions/${rawSessionId}/finalizations/current`));
      }),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);
    loggerErrorSpy.mockImplementation(() => {
      observedContexts.push(getLogContext());
    });
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const response = await app.fetch(
      new Request(`http://localhost/api/sessions/${rawSessionId}/finalizations/current`, {
        headers: createPathSessionAuthHeaders(rawSessionId),
      }),
      {
        requestContext: {
          extendedRequestId: 'trusted-error-request-id',
          identity: { sourceIp: '203.0.113.90' },
        },
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe('trusted-error-request-id');
    expect(
      getStringProperty(
        getObjectProperty(await readJsonRecord(response, 'thrown route response'), 'meta'),
        'requestId',
      ),
    ).toBe('trusted-error-request-id');
    const correlatedContext = observedContexts.find(
      (value) => getStringProperty(value, 'requestId') === 'trusted-error-request-id',
    );
    expect(correlatedContext).toBeDefined();
    expect(getStringProperty(getObjectProperty(correlatedContext, 'http'), 'path')).toBe(
      '/api/sessions/:sessionId/finalizations/current',
    );
    expect(getStringProperty(getObjectProperty(correlatedContext, 'http'), 'source_ip_hash')).toBe(
      hashIpForLogging('203.0.113.90'),
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Unhandled API error',
      expect.any(Error),
      expect.objectContaining({ event: 'api_error', public_code: 'INTERNAL_ERROR' }),
    );
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(rawSessionId);
  });

  it('maps opaque thrown values to a correlated error without logging the value', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const opaqueFailure = { path: `/api/sessions/${rawSessionId}/finalizations/current` };
    const store = createMockVoteStore({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise a defensive boundary for opaque third-party rejections.
      getSessionIdentity: vi.fn(() => Promise.reject(opaqueFailure)),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const response = await app.fetch(
      new Request(`http://localhost/api/sessions/${rawSessionId}/finalizations/current`, {
        headers: createPathSessionAuthHeaders(rawSessionId),
      }),
      { requestContext: { extendedRequestId: 'trusted-opaque-error-id' } },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe('trusted-opaque-error-id');
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Unhandled API error',
      expect.any(Error),
      expect.objectContaining({ event: 'api_error', public_code: 'INTERNAL_ERROR' }),
    );
    expect(loggerErrorSpy.mock.calls.flat()).not.toContain(opaqueFailure);
  });

  it('rejects cross-origin STH requests in lambda mode before session lookup', async () => {
    const getSessionIdentity = vi.fn(() => Promise.reject(new Error('handler should not reach session lookup')));
    const store = createMockVoteStore({
      getSessionIdentity,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/sessions/session-1/bulletin/sth', {
      headers: {
        Origin: 'https://auditor.example',
        'Sec-Fetch-Site': 'cross-site',
        'X-Session-Capability': 'capability-token',
      },
    });
    const payload = await readJsonRecord(response, 'same-origin response');

    expect(response.status).toBe(403);
    expect(getApiErrorCode(payload)).toBe('SAME_ORIGIN_REQUIRED');
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it('allows labeled same-origin STH auditor sources through request validation', async () => {
    const store = createStoreWithSession();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request('http://localhost/api/sessions/session-123/bulletin/sth?auditorId=b', {
      headers: createPathSessionAuthHeaders(),
    });
    const payload = await readJsonRecord(response, 'sth response');

    expect(response.status).toBe(404);
    expect(getApiErrorCode(payload)).toBe('SESSION_NOT_FINALIZED');
  });

  it('ignores retired debug header and cookie activation in request logging', async () => {
    const store = createMockVoteStore();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const headerResponse = await app.request('http://localhost/api/sessions/session-123/progress', {
      headers: {
        'x-debug-log': 'retired-debug-token',
      },
    });
    const cookieResponse = await app.request('http://localhost/api/sessions/session-123/progress', {
      headers: {
        cookie: 'stark_ballot_debug=retired-debug-token',
      },
    });

    expect(headerResponse.status).toBe(401);
    expect(cookieResponse.status).toBe(401);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
  });
});
