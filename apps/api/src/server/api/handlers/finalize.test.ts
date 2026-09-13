import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { ApplicationErrorCode } from '@stark-ballot/application';
import type { ArtifactReader } from '@stark-ballot/application/verification/artifact-reader';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { MockSessionStore } from '@stark-ballot/aws-adapters/store/mockSessionStore';
import { ServerRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/serverRateLimit';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import { logger } from '@stark-ballot/diagnostics/logger';
import {
  clearRuntimeConfigReferenceResolver,
  installStaticRuntimeConfigReferenceResolver,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import {
  targetRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getNumberProperty, getRecordProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { createHonoApp } from '../routes/hono';

const finalizeSessionUsecaseMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/application/finalize/usecases/finalize-session', () => ({
  finalizeSessionUsecase: finalizeSessionUsecaseMock,
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

const capabilitySecret = 'finalize-handler-test-session-capability-secret';
const expectedImageId = `0x${'ab'.repeat(32)}`;
const originVerifyHeader = 'origin-header-secret-0123456789abcdef';
const targetRuntimeEnvKeys = new Set([
  ...Object.keys(targetRuntimeProfileEnv('develop')),
  ...Object.keys(targetRuntimeProfileEnv('main')),
  'SESSION_CAPABILITY_SECRET',
  'SESSION_CAPABILITY_TTL_SECONDS',
  'VOTE_SECRET_ENCRYPTION_KEY',
  'TURNSTILE_SECRET_KEY',
  'EXPECTED_ORIGIN_VERIFY_HEADER',
  'LOG_IP_HASH_SALT',
  'LOG_FORMAT',
  'DEPLOYMENT_ID',
  'APP_SOURCE_SHA',
  'DEPLOY_MODE',
]);

function expectRequestStatusLog(
  spy: MockInstance<typeof logger.warn>,
  callIndex: number,
  expectedStatus: number,
): void {
  const call = spy.mock.calls[callIndex];
  const fields = call?.[1];
  expect(call?.[0]).toBe('request completed');
  expect(getStringProperty(fields, 'event')).toBe('http_request');
  expect(getNumberProperty(getRecordProperty(fields, 'http'), 'status')).toBe(expectedStatus);
}

function buildFinalizeRequest(sessionId: SessionId, headers: Record<string, string> = {}): Request {
  return new Request(`https://develop.example/api/sessions/${sessionId}/finalizations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken(
        { sessionId, nowMs: Date.now(), ttlSeconds: 300 },
        capabilitySecret,
      ),
      ...headers,
    },
    body: JSON.stringify({ scenarioId: 'S0' }),
  });
}

function createTargetFinalizeTestApp(runtimeProfile: ResolvedRuntimeProfile) {
  const artifactReader: ArtifactReader = {
    read: () => Promise.resolve({ kind: 'notFound' }),
  };
  const rateLimiter = new ServerRateLimiter();
  return createHonoApp({
    runtimeProfile,
    artifactDeliveryDependencyOverrides: { artifactReader },
    finalizationDependencyOverrides: {
      enforceFinalizeRateLimit: (clientIp) =>
        Promise.resolve({
          clientIp: clientIp ?? '203.0.113.10',
          rateLimiter,
          shouldRecord: false,
        }),
    },
  });
}

function configureTargetRuntime(deploymentEnvironment: 'develop' | 'main'): ResolvedRuntimeProfile {
  const runtimeProfile = targetRuntimeProfile(deploymentEnvironment);
  Object.assign(process.env, targetRuntimeProfileEnv(deploymentEnvironment));
  delete process.env['SESSION_CAPABILITY_SECRET'];
  delete process.env['SESSION_CAPABILITY_TTL_SECONDS'];
  delete process.env['VOTE_SECRET_ENCRYPTION_KEY'];
  delete process.env['TURNSTILE_SECRET_KEY'];
  process.env['EXPECTED_IMAGE_ID'] = expectedImageId;
  process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = originVerifyHeader;
  process.env['LOG_IP_HASH_SALT'] = 'resolved-finalize-handler-log-hash-salt';
  process.env['LOG_FORMAT'] = 'json';
  process.env['DEPLOYMENT_ID'] = `dep_${'1'.repeat(32)}`;
  process.env['APP_SOURCE_SHA'] = '2'.repeat(40);
  process.env['DEPLOY_MODE'] = 'normal';

  if (runtimeProfile.target.kind !== 'aws' || runtimeProfile.external.kind !== 'aws') {
    throw new Error('Expected target AWS runtime profile');
  }
  installStaticRuntimeConfigReferenceResolver(
    new Map([
      [runtimeProfile.external.secretReferences.sessionCapabilitySecret, capabilitySecret],
      [runtimeProfile.external.secretReferences.sessionCapabilityTtlSeconds, '300'],
      [runtimeProfile.external.secretReferences.turnstileSecretKey, 'resolved-turnstile-secret'],
      [runtimeProfile.external.secretReferences.voteSecretEncryptionKey, `0x${'3'.repeat(64)}`],
      [runtimeProfile.external.secretReferences.expectedOriginVerifyHeader, originVerifyHeader],
      [runtimeProfile.external.secretReferences.logIpHashSalt, 'resolved-finalize-handler-log-hash-salt'],
    ]),
    {
      expectedAccountId: runtimeProfile.external.accountId,
      expectedDeploymentEnvironment: runtimeProfile.target.deploymentEnvironment,
      expectedRegion: runtimeProfile.external.region,
    },
  );
  return runtimeProfile;
}

describe('finalizeSessionHandler', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries([...targetRuntimeEnvKeys].map((key) => [key, process.env[key]]));
    clearRuntimeConfigReferenceResolver();
    finalizeSessionUsecaseMock.mockResolvedValue({
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.VOTING_NOT_COMPLETE,
      },
    });
  });

  afterEach(() => {
    clearRuntimeConfigReferenceResolver();
    for (const key of targetRuntimeEnvKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('allows operator-gated develop finalization without a Turnstile token after origin verification', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const runtimeProfile = configureTargetRuntime('develop');
    const store = new MockSessionStore();
    const session = await store.createSession();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createTargetFinalizeTestApp(runtimeProfile).fetch(
      buildFinalizeRequest(session.sessionId, { 'X-Stark-Ballot-Origin-Verify': originVerifyHeader }),
      { requestContext: { http: { sourceIp: '203.0.113.10' } } },
    );

    const responseText = await response.clone().text();
    expect(finalizeSessionUsecaseMock, responseText).toHaveBeenCalledTimes(1);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const payload = await readJsonRecord(response, 'finalize usecase error');
    expect(getApiErrorCode(payload)).toBe(ApplicationErrorCode.VOTING_NOT_COMPLETE);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expectRequestStatusLog(loggerWarnSpy, 0, 400);
  });

  it('does not bypass finalization Turnstile outside the verified operator-gated develop path', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const runtimeProfile = configureTargetRuntime('main');
    const store = new MockSessionStore();
    const session = await store.createSession();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createTargetFinalizeTestApp(runtimeProfile).fetch(
      buildFinalizeRequest(session.sessionId, { 'X-Stark-Ballot-Origin-Verify': originVerifyHeader }),
      { requestContext: { http: { sourceIp: '203.0.113.10' } } },
    );

    expect(response.status, await response.clone().text()).toBe(403);
    const payload = await readJsonRecord(response, 'finalize Turnstile failure');
    expect(getApiErrorCode(payload)).toBe(ErrorCode.CAPTCHA_FAILED);
    expect(finalizeSessionUsecaseMock).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledTimes(2);
    expect(loggerWarnSpy.mock.calls[0]).toEqual([
      'turnstile validation failed',
      {
        event: 'turnstile_failed',
        turnstile: { status: 'failed', error_code: 'CAPTCHA_FAILED' },
      },
    ]);
    expectRequestStatusLog(loggerWarnSpy, 1, 403);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Unhandled API error',
      expect.objectContaining({ name: 'ApiError', message: 'Turnstile token is required' }),
      { event: 'api_error', public_code: ErrorCode.CAPTCHA_FAILED },
    );
  });
});
