import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/errors/apiErrors';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getStringProperty } from '@/lib/utils/guards';
import { createSessionCapabilityToken } from '@/lib/security/sessionCapabilityToken';
import { computeCommitment } from '@/lib/zkvm/types';
import { MockSessionStore } from '@/lib/store/mockSessionStore';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@/lib/session/capability';
import { submitVoteHandler } from './vote';

const botVoterMocks = vi.hoisted(() => ({
  startBotVoting: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/bot/botVoter', () => ({
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
}: {
  sessionId: string;
  capabilityToken?: string;
  electionId: string;
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

  return new Request('http://localhost/api/vote', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      commitment,
      vote: 'A',
      rand,
      turnstileToken: 'test-turnstile-token',
    }),
  });
}

describe('submitVoteHandler', () => {
  let store: MockSessionStore;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      RUNTIME_DEPLOYMENT_ENV: process.env.RUNTIME_DEPLOYMENT_ENV,
      SESSION_CAPABILITY_SECRET: process.env.SESSION_CAPABILITY_SECRET,
      TURNSTILE_BYPASS: process.env.TURNSTILE_BYPASS,
      USE_MOCK_STORE: process.env.USE_MOCK_STORE,
    };
    process.env.RUNTIME_DEPLOYMENT_ENV = 'develop';
    process.env.SESSION_CAPABILITY_SECRET = capabilitySecret;
    process.env.TURNSTILE_BYPASS = '1';
    process.env.USE_MOCK_STORE = 'true';
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
    const data = payload.data;
    expect(data).toBeTruthy();
  });
});
