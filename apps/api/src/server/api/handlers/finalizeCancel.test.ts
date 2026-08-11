import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type { SessionIdentityRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import { logger } from '@stark-ballot/diagnostics/logger';
import { createMockVoteStore, type MockVoteStore } from '../../__tests__/support/mockVoteStore';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { getNumberProperty, getRecordProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';
import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import {
  clearRuntimeConfigReferenceResolver,
  installStaticRuntimeConfigReferenceResolver,
} from '@stark-ballot/runtime-config/env/runtimeConfigReferences';
import type { FinalizationDependencyOverrides } from '../../composition/finalizationDependencies';
import { createHonoApp, ORIGIN_VERIFY_HEADER } from '../routes/hono';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: emitCanonicalEventMock,
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';
const originVerifyHeader = 'origin-header-secret-0123456789abcdef';
const logId = `0x${'2'.repeat(64)}`;
const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 0,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

function createCapabilityToken(sessionId: string): string {
  return createSessionCapabilityToken({ sessionId, ttlSeconds: 300 }, capabilitySecret);
}

type TargetRuntimeProfile = Extract<ResolvedRuntimeProfile, { readonly target: { readonly kind: 'aws' } }>;

function isTargetRuntimeProfile(profile: ResolvedRuntimeProfile): profile is TargetRuntimeProfile {
  return profile.name === 'target-aws-async' || profile.name === 'target-aws-async-quiesced';
}

function requireTargetRuntimeProfile(profile: ResolvedRuntimeProfile): TargetRuntimeProfile {
  if (!isTargetRuntimeProfile(profile)) {
    throw new Error('Expected target AWS runtime profile');
  }
  return profile;
}

const asyncRuntimeProfile = requireTargetRuntimeProfile(targetRuntimeProfile());
const quiescedAsyncRuntimeProfile = requireTargetRuntimeProfile(
  resolveRuntimeProfile({
    ...targetRuntimeProfileEnv(),
    RUNTIME_PROFILE: 'target-aws-async-quiesced',
  }),
);

function buildIdentity(sessionId: string): SessionIdentityRecord {
  const now = Date.now();
  return {
    sessionId,
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: `0x${'1'.repeat(64)}`,
    electionConfig: {
      totalExpected: 1,
      choices: ['A', 'B', 'C', 'D', 'E'],
      version: 'test-v1',
      botCount: 0,
      merkleTreeDepth: 1,
    },
    logId,
    createdAtMs: now,
  };
}

function buildVotingRecord(sessionId: string): SessionVotingRecord {
  return {
    sessionId,
    votes: new Map(),
    bulletin: new SimpleBulletinBoard(logId),
    bulletinRootHistory: [],
    botCount: 0,
    userParticipation: { status: 'not_cast' },
    lastActivityMs: Date.now(),
  };
}

function buildFinalizationRecord(sessionId: string, state: FinalizationState): FinalizationRecord {
  if (state.status !== 'succeeded') {
    return {
      sessionId,
      finalizationId: state.finalizationId,
      scenarioContext,
      state,
    };
  }
  const authority = buildFinalizationResultFromJournal({
    journal: createTestJournal(),
    imageId: `0x${'1'.repeat(64)}`,
  });
  return {
    sessionId,
    finalizationId: state.finalizationId,
    scenarioContext,
    state,
    finalizationResult: {
      finalizationId: state.finalizationId,
      ...authority,
    },
  };
}

function buildStore(
  sessionId: string,
  state: FinalizationState,
  overrides: Partial<MockVoteStore> = {},
): MockVoteStore {
  const identity = buildIdentity(sessionId);
  const voting = buildVotingRecord(sessionId);
  const finalization = buildFinalizationRecord(sessionId, state);
  return createMockVoteStore({
    getSessionIdentity: (requestedSessionId) => Promise.resolve(requestedSessionId === sessionId ? identity : null),
    getVotingRecord: (requestedSessionId) => Promise.resolve(requestedSessionId === sessionId ? voting : null),
    getCurrentFinalizationRecord: (requestedSessionId) =>
      Promise.resolve(requestedSessionId === sessionId ? finalization : null),
    getAwsFinalizationRuntimeMetadata: () => Promise.resolve(undefined),
    ...overrides,
  });
}

function buildSucceededState(finalizationId = 'exec-123456'): Extract<FinalizationState, { status: 'succeeded' }> {
  const now = Date.now();
  return {
    status: 'succeeded',
    finalizationId,
    queuedAtMs: now - 2000,
    startedAtMs: now - 1000,
    completedAtMs: now,
  };
}

function installTargetRuntimeTestEnvironment(): void {
  const env = targetRuntimeProfileEnv();
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      vi.stubEnv(name, value);
    }
  }
  for (const name of [
    'SESSION_CAPABILITY_SECRET',
    'SESSION_CAPABILITY_TTL_SECONDS',
    'VOTE_SECRET_ENCRYPTION_KEY',
    'TURNSTILE_SECRET_KEY',
    'FINALIZE_CALLBACK_SECRET',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('EXPECTED_ORIGIN_VERIFY_HEADER', originVerifyHeader);
  vi.stubEnv('LOG_IP_HASH_SALT', 'resolved-finalize-cancel-log-hash-salt');
  vi.stubEnv('LOG_FORMAT', 'json');
  vi.stubEnv('DEPLOYMENT_ID', `dep_${'1'.repeat(32)}`);
  vi.stubEnv('APP_SOURCE_SHA', '2'.repeat(40));
  vi.stubEnv('DEPLOY_MODE', 'normal');
  installStaticRuntimeConfigReferenceResolver(
    new Map([
      [env['SESSION_CAPABILITY_SECRET_REF'] ?? '', capabilitySecret],
      [env['SESSION_CAPABILITY_TTL_SECONDS_REF'] ?? '', '3600'],
      [env['VOTE_SECRET_ENCRYPTION_KEY_REF'] ?? '', '11'.repeat(32)],
      [env['TURNSTILE_SECRET_KEY_REF'] ?? '', 'turnstile-secret-value'],
      [env['EXPECTED_ORIGIN_VERIFY_HEADER_REF'] ?? '', originVerifyHeader],
      [env['LOG_IP_HASH_SALT_REF'] ?? '', 'resolved-finalize-cancel-log-hash-salt'],
    ]),
    { expectedDeploymentEnvironment: 'develop' },
  );
}

function createCancelTestApp(runtimeProfile: ResolvedRuntimeProfile) {
  if (runtimeProfile.target.kind === 'aws') {
    installTargetRuntimeTestEnvironment();
    vi.stubEnv('RUNTIME_PROFILE', runtimeProfile.name);
  } else {
    vi.stubEnv('RUNTIME_PROFILE', runtimeProfile.name);
    vi.stubEnv('SESSION_CAPABILITY_SECRET', capabilitySecret);
  }
  const finalizationDependencyOverrides: FinalizationDependencyOverrides = {
    enforceFinalizeCancelRateLimit: () => Promise.resolve({ clientIp: '203.0.113.10' }),
    stopFinalizationExecution: () => Promise.resolve(),
  };
  return createHonoApp({
    runtimeProfile,
    finalizationDependencyOverrides,
  });
}

async function expectStandardErrorResponse(
  response: Response,
  expected: { status: number; error: string },
): Promise<Record<string, unknown>> {
  const payload = await readJsonRecord(response, 'finalize cancel error response');
  expect(StandardErrorResponseSchema.safeParse(payload).success).toBe(true);
  expect(response.status).toBe(expected.status);
  expect(getApiErrorCode(payload)).toBe(expected.error);
  expect(payload).not.toHaveProperty('statusCode');
  return payload;
}

function expectRequestStatusLog(spy: MockInstance<typeof logger.warn>, expectedStatus: number): void {
  const call = spy.mock.calls[0];
  const fields = call?.[1];
  expect(spy).toHaveBeenCalledTimes(1);
  expect(call?.[0]).toBe('request completed');
  expect(getStringProperty(fields, 'event')).toBe('http_request');
  expect(getNumberProperty(getRecordProperty(fields, 'http'), 'status')).toBe(expectedStatus);
}

describe('cancelFinalizationHandler', () => {
  beforeEach(() => {
    emitCanonicalEventMock.mockClear();
  });

  afterEach(() => {
    clearRuntimeConfigReferenceResolver();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns a standard error envelope when async finalization is disabled', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const sessionId = 'session-disabled';
    const finalizationId = 'exec-123456';
    const store = buildStore(sessionId, buildSucceededState(finalizationId));
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createCancelTestApp(localRuntimeProfile()).request(
      `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/cancel`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SESSION_CAPABILITY_HEADER]: createCapabilityToken(sessionId),
        },
        body: JSON.stringify({}),
      },
    );

    await expectStandardErrorResponse(response, {
      status: 404,
      error: 'ASYNC_FINALIZATION_DISABLED',
    });
    expectRequestStatusLog(loggerWarnSpy, 404);
  });

  it('returns a standard error envelope when the finalization state is not cancellable', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const sessionId = 'session-1';
    const token = createCapabilityToken(sessionId);
    const store = buildStore(sessionId, buildSucceededState());
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createCancelTestApp(asyncRuntimeProfile).request(
      new Request(`http://localhost/api/sessions/${sessionId}/finalizations/exec-123456/cancel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SESSION_CAPABILITY_HEADER]: token,
          [ORIGIN_VERIFY_HEADER]: originVerifyHeader,
        },
        body: JSON.stringify({}),
      }),
    );

    await expectStandardErrorResponse(response, {
      status: 409,
      error: 'FINALIZATION_NOT_CANCELLABLE',
    });
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'cancel',
      reason: 'FINALIZATION_NOT_CANCELLABLE',
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalization_id: 'exec-123456',
    });
    expectRequestStatusLog(loggerWarnSpy, 409);
  });

  it('records a privacy-safe cancellation transition attempt at the caller boundary', async () => {
    const sessionId = 'session-cancel-attempt';
    const finalizationId = 'exec-cancel-attempt';
    const now = Date.now();
    const token = createCapabilityToken(sessionId);
    const pendingState: Extract<FinalizationState, { status: 'pending' }> = {
      status: 'pending',
      finalizationId,
      queuedAtMs: now - 2000,
    };
    const failedState: Extract<FinalizationState, { status: 'failed' }> = {
      status: 'failed' as const,
      finalizationId,
      queuedAtMs: now - 2000,
      failedAtMs: now,
      error: {
        code: 'USER_CANCELLED',
        message: 'Cancelled by user request',
      },
    };
    const markAwsFinalizationFailed = vi
      .fn<MockVoteStore['markAwsFinalizationFailed']>()
      .mockResolvedValue(failedState);
    const store = buildStore(sessionId, pendingState, {
      markAwsFinalizationFailed,
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);

    const response = await createCancelTestApp(asyncRuntimeProfile).request(
      new Request(`http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/cancel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SESSION_CAPABILITY_HEADER]: token,
          [ORIGIN_VERIFY_HEADER]: originVerifyHeader,
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    expect(markAwsFinalizationFailed).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        observability: {
          source: 'cancel',
          reason: 'USER_CANCELLED',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'cancel',
      reason: 'USER_CANCELLED',
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalization_id: finalizationId,
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(sessionId);
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(capabilitySecret);
  });

  it('cancels a pending finalization under the quiesced target profile', async () => {
    const sessionId = 'session-quiesced-cancel';
    const finalizationId = 'exec-quiesced-cancel';
    const now = Date.now();
    const pendingState: Extract<FinalizationState, { status: 'pending' }> = {
      status: 'pending',
      finalizationId,
      queuedAtMs: now - 2000,
    };
    const failedState: Extract<FinalizationState, { status: 'failed' }> = {
      status: 'failed',
      finalizationId,
      queuedAtMs: pendingState.queuedAtMs,
      failedAtMs: now,
      error: {
        code: 'USER_CANCELLED',
        message: 'Cancelled by user request',
      },
    };
    const markAwsFinalizationFailed = vi
      .fn<MockVoteStore['markAwsFinalizationFailed']>()
      .mockResolvedValue(failedState);
    vi.mocked(getGlobalStore).mockReturnValue(
      buildStore(sessionId, pendingState, {
        markAwsFinalizationFailed,
      }),
    );

    const response = await createCancelTestApp(quiescedAsyncRuntimeProfile).request(
      new Request(`http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/cancel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SESSION_CAPABILITY_HEADER]: createCapabilityToken(sessionId),
          [ORIGIN_VERIFY_HEADER]: originVerifyHeader,
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    expect(markAwsFinalizationFailed).toHaveBeenCalledTimes(1);
    const cancellationCall = markAwsFinalizationFailed.mock.calls[0];
    if (!cancellationCall) {
      throw new Error('Expected quiesced cancellation state transition.');
    }
    expect(cancellationCall[0]).toBe(sessionId);
    expect(cancellationCall[1]).toMatchObject({
      finalizationId,
      error: { code: 'USER_CANCELLED' },
    });
  });
});
