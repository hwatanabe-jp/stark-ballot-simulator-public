import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { MockSessionStore } from '@stark-ballot/aws-adapters/store/mockSessionStore';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { submitVoteHandler } from './vote';

const botVoterMocks = vi.hoisted(() => ({
  startBotVoting: vi.fn(() => Promise.resolve()),
}));

vi.mock('@stark-ballot/application/bot/botVoter', () => ({
  BotVoter: vi.fn(function BotVoter() {
    return {
      startBotVoting: botVoterMocks.startBotVoting,
    };
  }),
}));

const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';

function buildVoteRequest({
  sessionId,
  capabilityToken,
  electionId,
  includeTurnstileToken = true,
  originVerifyHeader,
}: {
  sessionId: string;
  capabilityToken?: string;
  electionId: string;
  includeTurnstileToken?: boolean;
  originVerifyHeader?: string;
}): Request {
  const rand = `0x${'11'.repeat(32)}`;
  const commitment = computeCommitment(electionId, 0, rand);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [SESSION_ID_HEADER]: sessionId,
  };
  if (capabilityToken) {
    headers[SESSION_CAPABILITY_HEADER] = capabilityToken;
  }
  if (originVerifyHeader) {
    headers['X-Stark-Ballot-Origin-Verify'] = originVerifyHeader;
  }

  return new Request('http://localhost/api/vote', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commitment,
      vote: 'A',
      rand,
      ...(includeTurnstileToken ? { turnstileToken: 'test-turnstile-token' } : {}),
    }),
  });
}

describe('submitVoteHandler', () => {
  let store: MockSessionStore;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      RUNTIME_DEPLOYMENT_ENV: process.env['RUNTIME_DEPLOYMENT_ENV'],
      SESSION_CAPABILITY_SECRET: process.env['SESSION_CAPABILITY_SECRET'],
      TURNSTILE_BYPASS: process.env['TURNSTILE_BYPASS'],
      TURNSTILE_SECRET_KEY: process.env['TURNSTILE_SECRET_KEY'],
      TARGET_AWS_RUNTIME: process.env['TARGET_AWS_RUNTIME'],
      EXPECTED_ORIGIN_VERIFY_HEADER: process.env['EXPECTED_ORIGIN_VERIFY_HEADER'],
      TARGET_DEVELOP_OPERATOR_GATE_ENABLED: process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'],
      USE_MOCK_STORE: process.env['USE_MOCK_STORE'],
    };
    process.env['RUNTIME_DEPLOYMENT_ENV'] = 'develop';
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    process.env['TURNSTILE_BYPASS'] = '1';
    process.env['USE_MOCK_STORE'] = 'true';
    store = new MockSessionStore();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.clearAllMocks();
  });

  it('requires a session capability token for vote submission', async () => {
    const session = await store.createSession();
    if (!session.electionId) {
      throw new Error('mock session missing electionId');
    }

    const response = await submitVoteHandler({
      request: buildVoteRequest({ sessionId: session.sessionId, electionId: session.electionId }),
      store,
      clientIp: '127.0.0.1',
    });

    expect(response.status).toBe(401);
    const payload = await readJsonRecord(response, 'vote missing capability');
    expect(getStringProperty(payload, 'error')).toBe(ErrorCode.SESSION_CAPABILITY_REQUIRED);
  });

  it('accepts vote submission when the session capability is valid', async () => {
    const session = await store.createSession();
    if (!session.electionId) {
      throw new Error('mock session missing electionId');
    }
    const capabilityToken = createSessionCapabilityToken(
      {
        sessionId: session.sessionId,
        nowMs: Date.now(),
        ttlSeconds: 300,
      },
      capabilitySecret,
    );

    const response = await submitVoteHandler({
      request: buildVoteRequest({
        sessionId: session.sessionId,
        capabilityToken,
        electionId: session.electionId,
      }),
      store,
      clientIp: '127.0.0.1',
    });

    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'vote success');
    const data = payload['data'];
    expect(data).toBeTruthy();
  });

  it('allows operator-gated develop vote submission without a Turnstile token after origin verification', async () => {
    const originVerifyHeader = 'origin-header-secret-0123456789abcdef';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = originVerifyHeader;
    process.env['TARGET_DEVELOP_OPERATOR_GATE_ENABLED'] = 'true';
    process.env['TURNSTILE_BYPASS'] = '0';
    delete process.env['TURNSTILE_SECRET_KEY'];

    const session = await store.createSession();
    if (!session.electionId) {
      throw new Error('mock session missing electionId');
    }
    const capabilityToken = createSessionCapabilityToken(
      {
        sessionId: session.sessionId,
        nowMs: Date.now(),
        ttlSeconds: 300,
      },
      capabilitySecret,
    );

    const response = await submitVoteHandler({
      request: buildVoteRequest({
        sessionId: session.sessionId,
        capabilityToken,
        electionId: session.electionId,
        includeTurnstileToken: false,
        originVerifyHeader,
      }),
      store,
      clientIp: '127.0.0.1',
    });

    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'operator-gated vote success');
    expect(payload['data']).toBeTruthy();
  });
});
