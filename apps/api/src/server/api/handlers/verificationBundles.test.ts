import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationId,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { ArtifactReader, ArtifactReadResult } from '@stark-ballot/application/verification/artifact-reader';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import type { SessionIdentityRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { logger } from '@stark-ballot/diagnostics/logger';
import { localRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { createMockVoteStore, type MockVoteStore } from '../../test-support/mockVoteStore';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getNumberProperty, getObjectProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { createHonoApp } from '../routes/hono';

const canonicalEventMocks = vi.hoisted(() => ({
  emitCanonicalEvent: vi.fn(),
}));

vi.mock('@stark-ballot/diagnostics/canonicalEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stark-ballot/diagnostics/canonicalEvents')>()),
  emitCanonicalEvent: canonicalEventMocks.emitCanonicalEvent,
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';
const logId = `0x${'2'.repeat(64)}`;
const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 1,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

function readerReturning(result: ArtifactReadResult): ArtifactReader {
  return {
    read: vi.fn().mockResolvedValue(result),
  };
}

async function requestArtifactRoute(
  store: MockVoteStore,
  artifactReader: ArtifactReader,
  request: Request,
): Promise<Response> {
  vi.mocked(getGlobalStore).mockReturnValue(store);
  return createHonoApp({
    runtimeProfile: localRuntimeProfile(),
    artifactDeliveryDependencyOverrides: { artifactReader },
  }).request(request);
}

function buildIdentity(sessionId: SessionId): SessionIdentityRecord {
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
    createdAtMs: Date.now(),
  };
}

function buildVotingRecord(sessionId: SessionId): SessionVotingRecord {
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

function buildFinalizedRecord(sessionId: SessionId, finalizationId: FinalizationId): FinalizationRecord {
  const now = Date.now();
  const journal = createTestJournal({
    validVotes: 1,
    totalExpected: 1,
    seenIndicesCount: 1,
  });
  return {
    sessionId,
    finalizationId,
    scenarioContext,
    state: {
      status: 'succeeded',
      finalizationId,
      queuedAtMs: now - 2_000,
      startedAtMs: now - 1_000,
      completedAtMs: now,
    },
    finalizationResult: {
      finalizationId,
      ...buildFinalizationResultFromJournal({
        journal,
        imageId: `0x${'12'.repeat(32)}`,
      }),
    },
  };
}

function buildStore(
  sessionId: SessionId,
  finalizationId: FinalizationId,
  overrides: Partial<MockVoteStore> = {},
): MockVoteStore {
  const identity = buildIdentity(sessionId);
  const voting = buildVotingRecord(sessionId);
  const finalization = buildFinalizedRecord(sessionId, finalizationId);
  return createMockVoteStore({
    getSessionIdentity: vi.fn((requestedSessionId: string) =>
      Promise.resolve(requestedSessionId === sessionId ? identity : null),
    ),
    getVotingRecord: vi.fn((requestedSessionId: string) =>
      Promise.resolve(requestedSessionId === sessionId ? voting : null),
    ),
    getCurrentFinalizationRecord: vi.fn((requestedSessionId: string) =>
      Promise.resolve(requestedSessionId === sessionId ? finalization : null),
    ),
    ...overrides,
  });
}

async function expectStandardError(response: Response, expected: { status: number; code: string }): Promise<void> {
  const payload = await readJsonRecord(response, 'artifact route error');
  expect(response.status).toBe(expected.status);
  expect(StandardErrorResponseSchema.safeParse(payload).success).toBe(true);
  expect(getApiErrorCode(payload)).toBe(expected.code);
}

function expectRequestStatusLogs(spy: MockInstance<typeof logger.warn>, statuses: readonly number[]): void {
  expect(spy).toHaveBeenCalledTimes(statuses.length);
  for (const [index, status] of statuses.entries()) {
    const call = spy.mock.calls[index];
    const fields = call?.[1];
    expect(call?.[0]).toBe('request completed');
    expect(getStringProperty(fields, 'event')).toBe('http_request');
    expect(getNumberProperty(getObjectProperty(fields, 'http'), 'status')).toBe(status);
  }
}

describe('verification artifact route integration', () => {
  const sessionId = asSessionId('session-1');
  const finalizationId = asFinalizationId('finalization-1');

  beforeEach(() => {
    vi.stubEnv('SESSION_CAPABILITY_SECRET', capabilitySecret);
    canonicalEventMocks.emitCanonicalEvent.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it.each([
    'amplify-starkballotsimulator-dev-honoapi-lambda',
    'custom-prod-worker',
    'stark-ballot-simulator-stark-dev-develop-public-api',
  ])('uses the explicitly injected reader regardless of Lambda name %s', async (functionName) => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', functionName);
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const artifactReader = readerReturning({
      kind: 'full',
      bytes,
      totalBytes: bytes.byteLength,
      representation: {},
    });
    const store = buildStore(sessionId, finalizationId);
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await requestArtifactRoute(
      store,
      artifactReader,
      new Request(`http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/artifacts/bundle`, {
        headers: { [SESSION_CAPABILITY_HEADER]: token },
      }),
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
    expect(artifactReader.read).toHaveBeenCalledOnce();
  });

  it('rejects missing and cross-session capabilities before store or reader access', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const getSessionIdentity = vi.fn();
    const getVotingRecord = vi.fn();
    const getCurrentFinalizationRecord = vi.fn();
    const store = createMockVoteStore({
      getSessionIdentity,
      getVotingRecord,
      getCurrentFinalizationRecord,
    });
    const artifactReader = readerReturning({ kind: 'notFound' });
    const wrongSessionToken = createSessionCapabilityToken(
      { sessionId: asSessionId('other-session') },
      capabilitySecret,
    );
    const url = `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/artifacts/bundle`;

    const missing = await requestArtifactRoute(store, artifactReader, new Request(url));
    const mismatched = await requestArtifactRoute(
      store,
      artifactReader,
      new Request(url, {
        headers: { [SESSION_CAPABILITY_HEADER]: wrongSessionToken },
      }),
    );

    expect(missing.status).toBe(401);
    expect(mismatched.status).toBe(401);
    expect(getSessionIdentity).not.toHaveBeenCalled();
    expect(getVotingRecord).not.toHaveBeenCalled();
    expect(getCurrentFinalizationRecord).not.toHaveBeenCalled();
    expect(artifactReader.read).not.toHaveBeenCalled();
    expect(canonicalEventMocks.emitCanonicalEvent).not.toHaveBeenCalled();
    expectRequestStatusLogs(loggerWarnSpy, [401, 401]);
  });

  it.each([
    {
      label: 'legacy bundle delivery metadata',
      path: 'bundle',
      deliveryMetadata: {
        s3BundleKey: `archive/${sessionId}/${finalizationId}/bundle.zip`,
      },
      expectedCode: 'BUNDLE_NOT_FOUND',
    },
    {
      label: 'legacy report delivery metadata',
      path: 'report',
      deliveryMetadata: {
        s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
        s3ReportKey: `archive/${sessionId}/${finalizationId}/verification.json`,
      },
      expectedCode: 'REPORT_NOT_FOUND',
    },
  ])(
    'rejects a stale finalization without falling back to $label',
    async ({ path, deliveryMetadata, expectedCode }) => {
      const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const getAwsVerificationDeliveryMetadata = vi.fn().mockResolvedValue(deliveryMetadata);
      const artifactReader = readerReturning({
        kind: 'full',
        bytes: Uint8Array.from([1]),
        totalBytes: 1,
        representation: {},
      });
      const store = buildStore(sessionId, asFinalizationId('current-finalization'), {
        getAwsVerificationDeliveryMetadata,
      });
      const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

      const response = await requestArtifactRoute(
        store,
        artifactReader,
        new Request(`http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/artifacts/${path}`, {
          headers: { [SESSION_CAPABILITY_HEADER]: token },
        }),
      );

      await expectStandardError(response, {
        status: 404,
        code: expectedCode,
      });
      expect(getAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
      expect(artifactReader.read).not.toHaveBeenCalled();
      expectRequestStatusLogs(loggerWarnSpy, [404]);
    },
  );

  it.each([
    ['bundle', 'BUNDLE_NOT_FOUND'],
    ['report', 'REPORT_NOT_FOUND'],
  ])('binds %s delivery to the exact current finalization', async (artifact, code) => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const artifactReader = readerReturning({ kind: 'notFound' });
    const store = buildStore(sessionId, finalizationId);
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await requestArtifactRoute(
      store,
      artifactReader,
      new Request(`http://localhost/api/sessions/${sessionId}/finalizations/stale-finalization/artifacts/${artifact}`, {
        headers: { [SESSION_CAPABILITY_HEADER]: token },
      }),
    );

    await expectStandardError(response, { status: 404, code });
    expect(artifactReader.read).not.toHaveBeenCalled();
    expectRequestStatusLogs(loggerWarnSpy, [404]);
  });

  it('preserves declared range errors through Hono response admission', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const artifactReader = readerReturning({ kind: 'invalidRange', totalBytes: 1024 });
    const store = buildStore(sessionId, finalizationId);
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await requestArtifactRoute(
      store,
      artifactReader,
      new Request(`http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/artifacts/bundle`, {
        headers: {
          [SESSION_CAPABILITY_HEADER]: token,
          Range: 'bytes=2000-1000',
        },
      }),
    );

    await expectStandardError(response, { status: 416, code: 'INVALID_RANGE' });
    expect(response.headers.get('Content-Range')).toBe('bytes */1024');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expectRequestStatusLogs(loggerWarnSpy, [416]);
  });

  it('normalizes missing reports and bounded reader failures without exposing storage details', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const store = buildStore(sessionId, finalizationId);
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);
    const reportUrl = `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/artifacts/report`;
    const missingReader = readerReturning({ kind: 'notFound' });
    const failedReader = readerReturning({ kind: 'unavailable', failureKind: 'accessDenied' });

    const missing = await requestArtifactRoute(
      store,
      missingReader,
      new Request(reportUrl, { headers: { [SESSION_CAPABILITY_HEADER]: token } }),
    );
    const failed = await requestArtifactRoute(
      store,
      failedReader,
      new Request(reportUrl, { headers: { [SESSION_CAPABILITY_HEADER]: token } }),
    );

    await expectStandardError(missing, { status: 404, code: 'REPORT_NOT_FOUND' });
    await expectStandardError(failed, { status: 500, code: 'REPORT_DOWNLOAD_FAILED' });
    expect(JSON.stringify(canonicalEventMocks.emitCanonicalEvent.mock.calls)).not.toContain('s3://');
    expect(JSON.stringify(canonicalEventMocks.emitCanonicalEvent.mock.calls)).not.toContain('verification.json');
    expectRequestStatusLogs(loggerWarnSpy, [404]);
    expectRequestStatusLogs(loggerErrorSpy, [500]);
  });
});
