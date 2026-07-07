import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { ApplicationErrorCode } from '@stark-ballot/application/finalize/finalization-types';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import type { SessionData } from '@stark-ballot/domain/types/server';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { finalizeSessionHandler } from './finalize';

const finalizeSessionUsecaseMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/application/finalize/usecases/finalize-session', () => ({
  finalizeSessionUsecase: finalizeSessionUsecaseMock,
}));

const capabilitySecret = 'finalize-handler-test-session-capability-secret';
const sessionId = 'session-finalize-1';
const expectedImageId = `0x${'ab'.repeat(32)}`;
const originVerifyHeader = 'origin-header-secret-0123456789abcdef';
const envKeys = [
  'SESSION_CAPABILITY_SECRET',
  'RUNTIME_DEPLOYMENT_ENV',
  'TARGET_AWS_RUNTIME',
  'EXPECTED_ORIGIN_VERIFY_HEADER',
  'TARGET_DEVELOP_OPERATOR_GATE_ENABLED',
  'TURNSTILE_BYPASS',
  'TURNSTILE_SECRET_KEY',
  'EXPECTED_IMAGE_ID',
  'EXPECTED_IMAGEID_POC',
  'EXPECTED_IMAGE_ID_VARIANT',
  'USE_MOCK_ZKVM',
  'RISC0_DEV_MODE',
  'FORCE_DEV_MODE',
] as const;

function buildSession(): SessionData {
  const now = Date.now();
  return {
    sessionId,
    contractGeneration: resolveCurrentContractGeneration(),
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: `0x${'11'.repeat(32)}`,
    logId: `0x${'22'.repeat(32)}`,
    votes: new Map(),
    botCount: 0,
    finalized: false,
    userVoteIndex: 0,
    createdAt: now,
    lastActivity: now,
  };
}

function buildFinalizeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://develop.example/api/finalize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SESSION_ID_HEADER]: sessionId,
      [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId }, capabilitySecret),
      ...headers,
    },
    body: JSON.stringify({ scenarioId: 'S0' }),
  });
}

describe('finalizeSessionHandler', () => {
  let originalEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
    process.env['TURNSTILE_BYPASS'] = '0';
    process.env['EXPECTED_IMAGE_ID'] = expectedImageId;
    process.env['USE_MOCK_ZKVM'] = 'false';
    delete process.env['EXPECTED_IMAGEID_POC'];
    delete process.env['EXPECTED_IMAGE_ID_VARIANT'];
    delete process.env['RISC0_DEV_MODE'];
    delete process.env['FORCE_DEV_MODE'];
    finalizeSessionUsecaseMock.mockResolvedValue({
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.VOTING_NOT_COMPLETE,
      },
    });
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.clearAllMocks();
  });

  it('allows operator-gated develop finalization without a Turnstile token after origin verification', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = originVerifyHeader;
    process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'true';
    delete process.env['TURNSTILE_SECRET_KEY'];

    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildSession()),
    });

    const response = await finalizeSessionHandler({
      request: buildFinalizeRequest({ 'X-Stark-Ballot-Origin-Verify': originVerifyHeader }),
      store,
      clientIp: '127.0.0.1',
    });

    expect(finalizeSessionUsecaseMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const payload = await readJsonRecord(response, 'finalize usecase error');
    expect(getStringProperty(payload, 'error')).toBe(ApplicationErrorCode.VOTING_NOT_COMPLETE);
  });

  it('does not bypass finalization Turnstile outside the verified operator-gated develop path', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = originVerifyHeader;
    process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'true';
    process.env['TURNSTILE_SECRET_KEY'] = 'live-secret';

    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildSession()),
    });

    await expect(
      finalizeSessionHandler({
        request: buildFinalizeRequest(),
        store,
        clientIp: '127.0.0.1',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CAPTCHA_FAILED });
    expect(finalizeSessionUsecaseMock).not.toHaveBeenCalled();
  });
});
