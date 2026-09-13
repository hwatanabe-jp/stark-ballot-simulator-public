import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import type { ArtifactReader } from '@stark-ballot/application/verification/artifact-reader';
import {
  getApiErrorCode,
  readJsonRecord,
  requireDataRecord,
} from '@stark-ballot/test-support/testing/response-helpers';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { MockSessionStore } from '@stark-ballot/aws-adapters/store/mockSessionStore';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { logger } from '@stark-ballot/diagnostics/logger';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import {
  clearRuntimeConfigReferenceResolver,
  installStaticRuntimeConfigReferenceResolver,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { getNumberProperty, getRecordProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { createHonoApp } from '../routes/hono';

const botVoterMocks = vi.hoisted(() => ({
  startBotVoting: vi.fn((_sessionId: import('@stark-ballot/domain/types/identifiers').SessionId) => Promise.resolve()),
}));

vi.mock('@stark-ballot/application/bot/botVoter', () => ({
  BotVoter: vi.fn(function BotVoter() {
    return {
      startBotVoting: botVoterMocks.startBotVoting,
    };
  }),
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

const voteRateLimitMocks = vi.hoisted(() => ({
  enforceVoteRateLimit: vi.fn(() => Promise.resolve({ clientIp: '203.0.113.10' })),
  consumeVoteRateLimit: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../middleware/rateLimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/rateLimit')>()),
  enforceVoteRateLimit: voteRateLimitMocks.enforceVoteRateLimit,
  consumeVoteRateLimit: voteRateLimitMocks.consumeVoteRateLimit,
}));

const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';
const originVerifyHeader = 'origin-header-secret-0123456789abcdef';
const localProfile = localRuntimeProfile();

function expectUnauthorizedRequestLog(spy: MockInstance<typeof logger.warn>): void {
  const call = spy.mock.calls[0];
  const fields = call?.[1];
  expect(spy).toHaveBeenCalledTimes(1);
  expect(call?.[0]).toBe('request completed');
  expect(getStringProperty(fields, 'event')).toBe('http_request');
  expect(getNumberProperty(getRecordProperty(fields, 'http'), 'status')).toBe(401);
}

function createLocalVoteTestApp() {
  return createHonoApp({ runtimeProfile: localProfile });
}

function createTargetVoteTestApp(runtimeProfile: ResolvedRuntimeProfile) {
  const artifactReader: ArtifactReader = {
    read: () => Promise.resolve({ kind: 'notFound' }),
  };
  return createHonoApp({
    runtimeProfile,
    artifactDeliveryDependencyOverrides: { artifactReader },
  });
}

function configureTargetRuntime(): ResolvedRuntimeProfile {
  const profile = targetRuntimeProfile('develop');
  for (const [name, value] of Object.entries(targetRuntimeProfileEnv('develop'))) {
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }
  vi.stubEnv('SESSION_CAPABILITY_SECRET', '');
  vi.stubEnv('SESSION_CAPABILITY_TTL_SECONDS', '');
  vi.stubEnv('VOTE_SECRET_ENCRYPTION_KEY', '');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  vi.stubEnv('EXPECTED_ORIGIN_VERIFY_HEADER', originVerifyHeader);
  vi.stubEnv('LOG_IP_HASH_SALT', 'resolved-vote-handler-log-hash-salt');
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
      [profile.external.secretReferences.expectedOriginVerifyHeader, originVerifyHeader],
      [profile.external.secretReferences.logIpHashSalt, 'resolved-vote-handler-log-hash-salt'],
    ]),
    {
      expectedAccountId: profile.external.accountId,
      expectedDeploymentEnvironment: profile.target.deploymentEnvironment,
      expectedRegion: profile.external.region,
    },
  );
  return profile;
}

function buildVoteRequest({
  sessionId,
  capabilityToken,
  electionId,
  includeTurnstileToken = true,
  originVerifyHeader,
  includeLegacySessionHeader = false,
}: {
  sessionId: string;
  capabilityToken?: string;
  electionId: string;
  includeTurnstileToken?: boolean;
  originVerifyHeader?: string;
  includeLegacySessionHeader?: boolean;
}): Request {
  const rand = `0x${'11'.repeat(32)}`;
  const commitment = computeCommitment(electionId, 0, rand);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (includeLegacySessionHeader) {
    headers['X-Session-ID'] = sessionId;
  }
  if (capabilityToken) {
    headers[SESSION_CAPABILITY_HEADER] = capabilityToken;
  }
  if (originVerifyHeader) {
    headers['X-Stark-Ballot-Origin-Verify'] = originVerifyHeader;
  }

  return new Request(`http://localhost/api/sessions/${encodeURIComponent(sessionId)}/votes`, {
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

  beforeEach(() => {
    clearRuntimeConfigReferenceResolver();
    vi.stubEnv('SESSION_CAPABILITY_SECRET', capabilitySecret);
    store = new MockSessionStore();
  });

  afterEach(() => {
    clearRuntimeConfigReferenceResolver();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    botVoterMocks.startBotVoting.mockReset().mockResolvedValue(undefined);
    vi.restoreAllMocks();
  });

  it('requires a session capability token for vote submission', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const session = await store.createSession();
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createLocalVoteTestApp().request(
      buildVoteRequest({ sessionId: session.sessionId, electionId: session.electionId }),
    );

    expect(response.status).toBe(401);
    const payload = await readJsonRecord(response, 'vote missing capability');
    expect(getApiErrorCode(payload)).toBe(ErrorCode.SESSION_CAPABILITY_REQUIRED);
    expectUnauthorizedRequestLog(loggerWarnSpy);
  });

  it('does not treat the obsolete identity header as vote authorization', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const session = await store.createSession();
    const getSessionIdentitySpy = vi.spyOn(store, 'getSessionIdentity');
    const getVotingRecordSpy = vi.spyOn(store, 'getVotingRecord');
    const addVoteSpy = vi.spyOn(store, 'addVote');
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createLocalVoteTestApp().request(
      buildVoteRequest({
        sessionId: session.sessionId,
        electionId: session.electionId,
        includeLegacySessionHeader: true,
      }),
    );

    expect(response.status).toBe(401);
    expect(getApiErrorCode(await readJsonRecord(response, 'obsolete vote identity header'))).toBe(
      ErrorCode.SESSION_CAPABILITY_REQUIRED,
    );
    expect(getSessionIdentitySpy).not.toHaveBeenCalled();
    expect(getVotingRecordSpy).not.toHaveBeenCalled();
    expect(addVoteSpy).not.toHaveBeenCalled();
    expectUnauthorizedRequestLog(loggerWarnSpy);
  });

  it('waits for bot persistence and recovers the original receipt after a failed attempt', async () => {
    const session = await store.createSession();
    const capabilityToken = createSessionCapabilityToken(
      { sessionId: session.sessionId, nowMs: Date.now(), ttlSeconds: 300 },
      capabilitySecret,
    );
    vi.mocked(getGlobalStore).mockReturnValue(store);
    const app = createLocalVoteTestApp();
    const request = () =>
      buildVoteRequest({ sessionId: session.sessionId, electionId: session.electionId, capabilityToken });
    const pending = Promise.withResolvers<void>();
    botVoterMocks.startBotVoting.mockReturnValueOnce(pending.promise);
    let responded = false;
    const first = Promise.resolve(app.request(request())).then((response) => {
      responded = true;
      return response;
    });
    await vi.waitFor(() => expect(botVoterMocks.startBotVoting).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(responded).toBe(false);
    pending.reject(new Error('Bot storage unavailable'));
    expect((await first).status).toBe(500);
    const saved = await store.getVotingRecord(session.sessionId);
    const original = saved?.votes.get(0);
    expect(original).toBeDefined();
    const retry = await app.request(request());
    expect(retry.status).toBe(200);
    const data = requireDataRecord(await readJsonRecord(retry, 'retried vote'), 'receipt');
    expect(data).toMatchObject({
      voteId: original?.voteId,
      castAtMs: original?.timestamp,
      bulletinRootAtCast: original?.rootAtCast,
    });
    expect((await store.getVotingRecord(session.sessionId))?.votes.size).toBe(1);
    const replay = await app.request(request());
    expect(replay.status).toBe(200);
    expect(requireDataRecord(await readJsonRecord(replay, 'replayed vote'), 'receipt')).toEqual(data);
  });

  it('recovers a stored user vote after bot failure and admits concurrent identical requests', async () => {
    const { BotVoter } = await vi.importActual<typeof import('@stark-ballot/application/bot/botVoter')>(
      '@stark-ballot/application/bot/botVoter',
    );
    botVoterMocks.startBotVoting.mockImplementation((sessionId) => new BotVoter(store).startBotVoting(sessionId));
    const session = await store.createSession();
    const capabilityToken = createSessionCapabilityToken(
      { sessionId: session.sessionId, nowMs: Date.now(), ttlSeconds: 300 },
      capabilitySecret,
    );
    vi.mocked(getGlobalStore).mockReturnValue(store);
    const app = createLocalVoteTestApp();
    const request = () =>
      buildVoteRequest({ sessionId: session.sessionId, electionId: session.electionId, capabilityToken });
    vi.spyOn(store, 'addBotVotes').mockRejectedValueOnce(new Error('Interrupted bot write'));
    expect((await app.request(request())).status).toBe(500);
    const original = (await store.getVotingRecord(session.sessionId))?.votes.get(0);
    const responses = await Promise.all([app.request(request()), app.request(request())]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(requireDataRecord(await readJsonRecord(response, 'completed submission'), 'receipt')).toMatchObject({
        voteId: original?.voteId,
        castAtMs: original?.timestamp,
      });
    }
    const complete = await store.getVotingRecord(session.sessionId);
    expect(complete?.votes.size).toBe(64);
    expect(complete?.botCount).toBe(63);
    const different = request();
    const body: unknown = await different.json();
    if (!body || typeof body !== 'object') throw new Error('Expected request');
    const changed = new Request(different.url, {
      method: 'POST',
      headers: different.headers,
      body: JSON.stringify({
        ...body,
        vote: 'B',
        commitment: computeCommitment(session.electionId, 1, `0x${'11'.repeat(32)}`),
      }),
    });
    const conflict = await app.request(changed);
    expect(conflict.status).toBe(400);
    expect(getApiErrorCode(await readJsonRecord(conflict, 'different opening'))).toBe('ALREADY_VOTED');
    expect((await store.getVotingRecord(session.sessionId))?.votes).toEqual(complete?.votes);
  });

  it('accepts vote submission when the session capability is valid', async () => {
    const session = await store.createSession();
    const addVoteSpy = vi.spyOn(store, 'addVote');
    const capabilityToken = createSessionCapabilityToken(
      {
        sessionId: session.sessionId,
        nowMs: Date.now(),
        ttlSeconds: 300,
      },
      capabilitySecret,
    );
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createLocalVoteTestApp().request(
      buildVoteRequest({
        sessionId: session.sessionId,
        capabilityToken,
        electionId: session.electionId,
      }),
    );

    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'vote success');
    const data = requireDataRecord(payload, 'vote success data');
    expect(data['commitment']).toBe(computeCommitment(session.electionId, 0, `0x${'11'.repeat(32)}`));
    expect(typeof data['castAtMs']).toBe('number');
    expect(data).not.toHaveProperty('timestamp');
    expect(payload).toHaveProperty('meta.requestId', expect.any(String));
    const submittedCommand = addVoteSpy.mock.calls[0]?.[1];
    expect(Object.keys(submittedCommand ?? {}).sort()).toEqual(['rand', 'timestamp', 'vote', 'voteId']);

    const persisted = await store.getVotingRecord(session.sessionId);
    if (!persisted || persisted.userParticipation.status !== 'cast') {
      throw new Error('Expected exact voting record with a cast user vote');
    }
    const persistedVote = persisted.votes.get(persisted.userParticipation.voteIndex);
    expect(persistedVote?.timestamp).toEqual(expect.any(Number));
    expect(persistedVote).not.toHaveProperty('castAtMs');
  });

  it('projects a typed persistence race through the declared duplicate-vote response', async () => {
    const session = await store.createSession();
    const capabilityToken = createSessionCapabilityToken(
      {
        sessionId: session.sessionId,
        nowMs: Date.now(),
        ttlSeconds: 300,
      },
      capabilitySecret,
    );
    vi.spyOn(store, 'addVote').mockResolvedValueOnce({
      ok: false,
      error: { code: 'DUPLICATE_VOTE', details: { duplicateKind: 'voteId' } },
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createLocalVoteTestApp().request(
      buildVoteRequest({
        sessionId: session.sessionId,
        capabilityToken,
        electionId: session.electionId,
      }),
    );

    expect(response.status).toBe(409);
    const payload = await readJsonRecord(response, 'vote persistence race');
    expect(getApiErrorCode(payload)).toBe(ErrorCode.DUPLICATE_VOTE);
    expect(getStringProperty(getRecordProperty(payload, 'error'), 'message')).toBe(
      'Vote ID already exists. This may be a system error. Please try again.',
    );
  });

  it('allows operator-gated develop vote submission without a Turnstile token after origin verification', async () => {
    const runtimeProfile = configureTargetRuntime();

    const session = await store.createSession();
    const capabilityToken = createSessionCapabilityToken(
      {
        sessionId: session.sessionId,
        nowMs: Date.now(),
        ttlSeconds: 300,
      },
      capabilitySecret,
    );
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createTargetVoteTestApp(runtimeProfile).fetch(
      buildVoteRequest({
        sessionId: session.sessionId,
        capabilityToken,
        electionId: session.electionId,
        includeTurnstileToken: false,
        originVerifyHeader,
      }),
      { requestContext: { http: { sourceIp: '203.0.113.10' } } },
    );

    expect(response.status).toBe(200);
    const payload = await readJsonRecord(response, 'operator-gated vote success');
    expect(payload['data']).toBeTruthy();
  });
});
