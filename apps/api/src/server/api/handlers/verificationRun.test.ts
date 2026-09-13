import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type { VerificationResultRecord } from '@stark-ballot/application/finalize/finalization-result-store';
import type {
  FinalizationId,
  FinalizationResultAuthority,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import type { AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type { AwsFinalizationRuntimeMetadata } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { createMockVoteStore, type MockVoteStore } from '../../test-support/mockVoteStore';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import type { SessionIdentityRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import {
  localRuntimeProfile,
  targetRuntimeProfileEnv,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import {
  getApiErrorCode,
  readJsonRecord,
  requireDataRecord,
} from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { FinalizeRateLimitContext } from '../middleware/rateLimit';
import { runVerificationHandler } from './verificationRun';

const verifierServiceMocks = vi.hoisted(() => ({
  invokeVerifierService: vi.fn(),
}));
const verificationQueueMocks = vi.hoisted(() => ({
  publishVerificationWorkMessage: vi.fn(),
}));

vi.mock('@stark-ballot/node-adapters/verifier-service-client', () => ({
  invokeVerifierService: verifierServiceMocks.invokeVerifierService,
}));
vi.mock('@stark-ballot/aws-adapters/sqs/publishVerificationWorkMessage', () => ({
  publishVerificationWorkMessage: verificationQueueMocks.publishVerificationWorkMessage,
}));

const capabilitySecret = 'verification-run-handler-secret-0123456789abcdef';
const expectedImageId = `0x${'ab'.repeat(32)}`;
const sessionId = asSessionId('session-verification-run-1');
const finalizationId = asFinalizationId('execution-verification-run-1');
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
const localVerificationRuntimeProfile = localRuntimeProfile();
const targetVerificationRuntimeProfile = resolveRuntimeProfile({
  ...targetRuntimeProfileEnv(),
  EXPECTED_IMAGE_ID: expectedImageId,
});
const quiescedVerificationRuntimeProfile = resolveRuntimeProfile({
  ...targetRuntimeProfileEnv(),
  RUNTIME_PROFILE: 'target-aws-async-quiesced',
  EXPECTED_IMAGE_ID: expectedImageId,
});
const validVerificationReport = {
  status: 'success' as const,
  verifier_version: '0.1.0',
  verified_at: '2026-06-17T00:00:00.000Z',
  duration_ms: 42,
  expected_image_id: expectedImageId,
  receipt_image_id: expectedImageId,
  dev_mode_receipt: false,
};

function bundleKeyFor(id: string, execId: string): string {
  return `sessions/${id}/${execId}/bundle.zip`;
}

function reportKeyFor(id: string, execId: string): string {
  return `sessions/${id}/${execId}/verification.json`;
}

function getBooleanProperty(value: Record<string, unknown>, key: string): boolean | undefined {
  const candidate = value[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
}

function buildFinalizationResult(overrides: Partial<FinalizationResultAuthority> = {}): FinalizationResultAuthority {
  const journal = createTestJournal({
    validVotes: 1,
    totalExpected: 1,
    seenIndicesCount: 1,
  });

  return {
    ...buildFinalizationResultFromJournal({
      journal,
      imageId: expectedImageId,
      scenarioContext,
    }),
    ...overrides,
  };
}

function buildIdentity(): SessionIdentityRecord {
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

function buildVotingRecord(): SessionVotingRecord {
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

function buildFinalizationRecord(
  finalizationResult: FinalizationResultAuthority,
  recordFinalizationId: FinalizationId = finalizationId,
): FinalizationRecord {
  const now = Date.now();
  return {
    sessionId,
    finalizationId: recordFinalizationId,
    scenarioContext,
    state: {
      status: 'succeeded',
      finalizationId: recordFinalizationId,
      queuedAtMs: now - 2_000,
      startedAtMs: now - 1_000,
      completedAtMs: now,
    },
    finalizationResult: {
      finalizationId: recordFinalizationId,
      ...finalizationResult,
    },
  };
}

function verificationRecord(verificationResult: VerificationResult): VerificationResultRecord {
  return {
    sessionId,
    finalizationId,
    verificationResult,
  };
}

interface VerificationRunStoreOptions {
  verificationResult?: VerificationResult | null;
  deliveryMetadata?: AwsVerificationDeliveryMetadataInput | null;
  runtimeMetadata?: AwsFinalizationRuntimeMetadata;
  storeOverrides?: Partial<MockVoteStore>;
}

function createVerificationRunStore(
  finalizationResult: FinalizationResultAuthority,
  options: VerificationRunStoreOptions = {},
) {
  const identity = buildIdentity();
  const voting = buildVotingRecord();
  const finalization = buildFinalizationRecord(finalizationResult);
  const selectedVerificationResult = Object.hasOwn(options, 'verificationResult')
    ? options.verificationResult
    : ({ status: 'not_run' } satisfies VerificationResult);
  const selectedDeliveryMetadata = Object.hasOwn(options, 'deliveryMetadata')
    ? options.deliveryMetadata
    : ({ s3BundleKey: bundleKeyFor(sessionId, finalizationId) } satisfies AwsVerificationDeliveryMetadataInput);
  const markVerificationRunning = vi.fn<MockVoteStore['markVerificationRunning']>(
    (requestedSessionId, requestedFinalizationId) =>
      Promise.resolve({
        sessionId: requestedSessionId,
        finalizationId: requestedFinalizationId,
        verificationResult: { status: 'running' },
      }),
  );
  const rollbackVerificationResult = vi.fn<MockVoteStore['rollbackVerificationResult']>(() => Promise.resolve());
  const completeVerificationResult = vi.fn<MockVoteStore['completeVerificationResult']>(
    (requestedSessionId, requestedFinalizationId, verificationResult) =>
      Promise.resolve({
        sessionId: requestedSessionId,
        finalizationId: requestedFinalizationId,
        verificationResult,
      }),
  );
  const recordAwsVerificationDeliveryMetadata = vi.fn<MockVoteStore['recordAwsVerificationDeliveryMetadata']>(() =>
    Promise.resolve(),
  );
  const store = createMockVoteStore({
    getSessionIdentity: (requestedSessionId) => Promise.resolve(requestedSessionId === sessionId ? identity : null),
    getVotingRecord: (requestedSessionId) => Promise.resolve(requestedSessionId === sessionId ? voting : null),
    getCurrentFinalizationRecord: (requestedSessionId) =>
      Promise.resolve(requestedSessionId === sessionId ? finalization : null),
    getVerificationResultRecord: (requestedSessionId, requestedFinalizationId) =>
      Promise.resolve(
        requestedSessionId === sessionId && requestedFinalizationId === finalizationId && selectedVerificationResult
          ? verificationRecord(selectedVerificationResult)
          : null,
      ),
    getAwsVerificationDeliveryMetadata: (requestedSessionId, requestedFinalizationId) =>
      Promise.resolve(
        requestedSessionId === sessionId && requestedFinalizationId === finalizationId
          ? (selectedDeliveryMetadata ?? undefined)
          : undefined,
      ),
    getAwsFinalizationRuntimeMetadata: () => Promise.resolve(options.runtimeMetadata),
    markVerificationRunning,
    rollbackVerificationResult,
    completeVerificationResult,
    recordAwsVerificationDeliveryMetadata,
    ...options.storeOverrides,
  });

  return {
    store,
    markVerificationRunning,
    rollbackVerificationResult,
    completeVerificationResult,
    recordAwsVerificationDeliveryMetadata,
  };
}

function conditionalCheckFailed(): Error {
  return Object.assign(new Error('ConditionalCheckFailedException'), { name: 'ConditionalCheckFailedException' });
}

async function invokeVerificationRun(
  store: MockVoteStore,
  requestedFinalizationId = finalizationId,
  runtimeProfile: ResolvedRuntimeProfile = localVerificationRuntimeProfile,
): Promise<Response> {
  const [identity, voting, finalization] = await Promise.all([
    store.getSessionIdentity(sessionId),
    store.getVotingRecord(sessionId),
    store.getCurrentFinalizationRecord(sessionId),
  ]);
  if (!identity || !voting) {
    throw new Error('Expected verification-run test lifecycle records to exist.');
  }
  const session: SessionReadModel = { identity, voting, finalization };
  const finalizeRateLimit: FinalizeRateLimitContext = {
    clientIp: '127.0.0.1',
    rateLimiter: {
      checkZkVmRateLimit: vi.fn(() => Promise.resolve({ allowed: true, remainingExecutions: 1 })),
      checkGlobalLimit: vi.fn(() => Promise.resolve({ allowed: true, currentCount: 0, limit: 1 })),
      recordZkVmExecution: vi.fn(() => Promise.resolve()),
      incrementGlobalCount: vi.fn(() => Promise.resolve(1)),
    },
    shouldRecord: false,
  };

  return runVerificationHandler({
    input: {
      params: {
        sessionId,
        finalizationId: requestedFinalizationId,
      },
      headers: {
        [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId }, capabilitySecret),
      },
      body: {},
    },
    context: {
      runtimeProfile,
      store,
      requestId: 'verification-run-test-request',
      requestOrigin: 'http://localhost',
      clientIp: '127.0.0.1',
      operatorGatedDevelop: false,
      sessionId,
      finalizationId: asFinalizationId(requestedFinalizationId),
      session,
      finalizeRateLimit,
    },
  });
}

async function prepareLocalBundle(): Promise<{ bundlePath: string; reportPath: string }> {
  const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stark-ballot-local-verifier-'));
  vi.stubEnv('VERIFIER_WORK_DIR', verifierWorkDir);
  const bundlePath = path.join(verifierWorkDir, sessionId, finalizationId);
  await fs.mkdir(bundlePath, { recursive: true });
  await fs.writeFile(path.join(bundlePath, 'public-input.json'), '{}', 'utf-8');
  return {
    bundlePath,
    reportPath: path.join(bundlePath, 'verification.json'),
  };
}

describe('runVerificationHandler', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_CAPABILITY_SECRET', capabilitySecret);
    vi.stubEnv('EXPECTED_IMAGE_ID', expectedImageId);
    vi.stubEnv('EXPECTED_IMAGE_ID_VARIANT', undefined);
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('exposes no persisted-result repair port', () => {
    const { store } = createVerificationRunStore(buildFinalizationResult());

    expect(store).not.toHaveProperty('repairFinalizationResult');
  });

  it('returns an already-complete idempotent response without persistence repair', async () => {
    const storedResult = buildFinalizationResult();
    const { store } = createVerificationRunStore(storedResult, {
      verificationResult: { status: 'success' },
    });

    const response = await invokeVerificationRun(store);
    const payload = await readJsonRecord(response, 'local verification run response');
    const data = requireDataRecord(payload, 'local verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('success');
    expect(getStringProperty(data, 'finalizationId')).toBe(finalizationId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
  });

  it('returns an already-running idempotent response without starting a new verifier run', async () => {
    await prepareLocalBundle();
    const { store, markVerificationRunning } = createVerificationRunStore(buildFinalizationResult(), {
      verificationResult: { status: 'running' },
      deliveryMetadata: null,
    });

    const response = await invokeVerificationRun(store);
    const payload = await readJsonRecord(response, 'local verification run response');
    const data = requireDataRecord(payload, 'local verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(getStringProperty(data, 'finalizationId')).toBe(finalizationId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
    expect(markVerificationRunning).not.toHaveBeenCalled();
  });

  it('enqueues target running verifier state persisted before its queued marker', async () => {
    verificationQueueMocks.publishVerificationWorkMessage.mockResolvedValue(undefined);
    const { store, markVerificationRunning, recordAwsVerificationDeliveryMetadata } = createVerificationRunStore(
      buildFinalizationResult(),
      {
        verificationResult: { status: 'running' },
      },
    );

    const response = await invokeVerificationRun(store, finalizationId, targetVerificationRuntimeProfile);
    const payload = await readJsonRecord(response, 'target verification run recovery response');
    const data = requireDataRecord(payload, 'target verification run recovery data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(getStringProperty(data, 'finalizationId')).toBe(finalizationId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    const [publishedProfile, publishedMessage] = verificationQueueMocks.publishVerificationWorkMessage.mock
      .calls[0] as [
      ResolvedRuntimeProfile,
      {
        sessionId: string;
        finalizationId: string;
        queuedAtMs: number;
        bundleKey: string;
        expectedImageId: string;
      },
    ];
    expect(publishedProfile).toBe(targetVerificationRuntimeProfile);
    expect(publishedMessage).toEqual({
      sessionId,
      finalizationId,
      queuedAtMs: publishedMessage.queuedAtMs,
      bundleKey: bundleKeyFor(sessionId, finalizationId),
      expectedImageId,
    });
    expect(Number.isInteger(publishedMessage.queuedAtMs)).toBe(true);
    expect(recordAwsVerificationDeliveryMetadata.mock.calls[0]).toEqual([
      sessionId,
      finalizationId,
      {
        s3BundleKey: bundleKeyFor(sessionId, finalizationId),
        verificationWorkQueuedAtMs: publishedMessage.queuedAtMs,
      },
    ]);
    const recordedMetadata = recordAwsVerificationDeliveryMetadata.mock.calls[0]?.[2];
    expect(typeof recordedMetadata?.verificationWorkQueuedAtMs).toBe('number');
    expect(markVerificationRunning).not.toHaveBeenCalled();
  });

  it('returns an already-failed idempotent response for polling after terminal verifier failure', async () => {
    const { store, markVerificationRunning, completeVerificationResult } = createVerificationRunStore(
      buildFinalizationResult(),
      { verificationResult: { status: 'failed' } },
    );

    const response = await invokeVerificationRun(store);
    const payload = await readJsonRecord(response, 'failed verification run response');
    const data = requireDataRecord(payload, 'failed verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
    expect(getStringProperty(data, 'finalizationId')).toBe(finalizationId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
    expect(markVerificationRunning).not.toHaveBeenCalled();
    expect(completeVerificationResult).not.toHaveBeenCalled();
  });

  it('fails closed when path finalization authority does not match the current result', async () => {
    const { store, markVerificationRunning, rollbackVerificationResult, completeVerificationResult } =
      createVerificationRunStore(buildFinalizationResult());

    const response = await invokeVerificationRun(store, asFinalizationId('other-finalization'));
    const payload = await readJsonRecord(response, 'mismatched path finalization response');

    expect(response.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
    expect(markVerificationRunning).not.toHaveBeenCalled();
    expect(rollbackVerificationResult).not.toHaveBeenCalled();
    expect(completeVerificationResult).not.toHaveBeenCalled();
  });

  it('rejects S3 delivery metadata under a local runtime profile', async () => {
    const { store, markVerificationRunning, completeVerificationResult, recordAwsVerificationDeliveryMetadata } =
      createVerificationRunStore(buildFinalizationResult());

    const response = await invokeVerificationRun(store);
    const payload = await readJsonRecord(response, 'local S3 profile mismatch response');

    expect(response.status).toBe(500);
    expect(getApiErrorCode(payload)).toBe('INTERNAL_ERROR');
    expect(markVerificationRunning).not.toHaveBeenCalled();
    expect(recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(completeVerificationResult).not.toHaveBeenCalled();
    expect(verifierServiceMocks.invokeVerifierService).not.toHaveBeenCalled();
  });

  it('enqueues target verification work and returns running without synchronous Lambda invoke', async () => {
    verificationQueueMocks.publishVerificationWorkMessage.mockResolvedValue(undefined);
    const {
      store,
      markVerificationRunning,
      completeVerificationResult,
      rollbackVerificationResult,
      recordAwsVerificationDeliveryMetadata,
    } = createVerificationRunStore(buildFinalizationResult());

    const response = await invokeVerificationRun(store, finalizationId, targetVerificationRuntimeProfile);
    const payload = await readJsonRecord(response, 'target verification run response');
    const data = requireDataRecord(payload, 'target verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(getStringProperty(data, 'finalizationId')).toBe(finalizationId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(false);
    expect(markVerificationRunning).toHaveBeenCalledOnce();
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, finalizationId);
    const [publishedProfile, publishedMessage] = verificationQueueMocks.publishVerificationWorkMessage.mock
      .calls[0] as [
      ResolvedRuntimeProfile,
      {
        sessionId: string;
        finalizationId: string;
        queuedAtMs: number;
        bundleKey: string;
        expectedImageId: string;
      },
    ];
    expect(publishedProfile).toBe(targetVerificationRuntimeProfile);
    expect(publishedMessage).toEqual({
      sessionId,
      finalizationId,
      queuedAtMs: publishedMessage.queuedAtMs,
      bundleKey: bundleKeyFor(sessionId, finalizationId),
      expectedImageId,
    });
    expect(Number.isInteger(publishedMessage.queuedAtMs)).toBe(true);
    expect(recordAwsVerificationDeliveryMetadata.mock.calls[0]).toEqual([
      sessionId,
      finalizationId,
      {
        s3BundleKey: bundleKeyFor(sessionId, finalizationId),
        verificationWorkQueuedAtMs: publishedMessage.queuedAtMs,
      },
    ]);
    const recordedMetadata = recordAwsVerificationDeliveryMetadata.mock.calls[0]?.[2];
    expect(typeof recordedMetadata?.verificationWorkQueuedAtMs).toBe('number');
    expect(completeVerificationResult).not.toHaveBeenCalled();
    expect(rollbackVerificationResult).not.toHaveBeenCalled();
  });

  it('enqueues verification work with target delivery authority under the quiesced profile', async () => {
    verificationQueueMocks.publishVerificationWorkMessage.mockResolvedValue(undefined);
    const { store, markVerificationRunning, recordAwsVerificationDeliveryMetadata } =
      createVerificationRunStore(buildFinalizationResult());

    const response = await invokeVerificationRun(store, finalizationId, quiescedVerificationRuntimeProfile);
    const payload = await readJsonRecord(response, 'quiesced target verification run response');
    const data = requireDataRecord(payload, 'quiesced target verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(verificationQueueMocks.publishVerificationWorkMessage).toHaveBeenCalledWith(
      quiescedVerificationRuntimeProfile,
      expect.objectContaining({
        sessionId,
        finalizationId,
        bundleKey: bundleKeyFor(sessionId, finalizationId),
        expectedImageId,
      }),
    );
    expect(recordAwsVerificationDeliveryMetadata).toHaveBeenCalledWith(
      sessionId,
      finalizationId,
      expect.objectContaining({
        s3BundleKey: bundleKeyFor(sessionId, finalizationId),
      }),
    );
  });

  it('rejects missing delivery metadata without falling back to finalization runtime bundle metadata', async () => {
    verificationQueueMocks.publishVerificationWorkMessage.mockResolvedValue(undefined);
    const getAwsFinalizationRuntimeMetadata = vi.fn().mockResolvedValue({
      bundleMetadata: {
        s3BundleKey: bundleKeyFor(sessionId, finalizationId),
        s3UploadedAtMs: 1783260889078,
      },
    });
    const { store, markVerificationRunning } = createVerificationRunStore(buildFinalizationResult(), {
      deliveryMetadata: null,
      storeOverrides: { getAwsFinalizationRuntimeMetadata },
    });

    const response = await invokeVerificationRun(store, finalizationId, targetVerificationRuntimeProfile);
    const payload = await readJsonRecord(response, 'target missing delivery metadata response');

    expect(response.status).toBe(500);
    expect(getApiErrorCode(payload)).toBe('INTERNAL_ERROR');
    expect(getAwsFinalizationRuntimeMetadata).not.toHaveBeenCalled();
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
    expect(markVerificationRunning).not.toHaveBeenCalled();
  });

  it('returns an idempotent running response when a duplicate target request wins the same execution race', async () => {
    const getVerificationResultRecord = vi
      .fn<MockVoteStore['getVerificationResultRecord']>()
      .mockResolvedValueOnce(verificationRecord({ status: 'not_run' }))
      .mockResolvedValueOnce(verificationRecord({ status: 'running' }));
    const markVerificationRunning = vi.fn<MockVoteStore['markVerificationRunning']>(() =>
      Promise.reject(conditionalCheckFailed()),
    );
    const { store } = createVerificationRunStore(buildFinalizationResult(), {
      storeOverrides: {
        getVerificationResultRecord,
        markVerificationRunning,
      },
    });

    const response = await invokeVerificationRun(store, finalizationId, targetVerificationRuntimeProfile);
    const payload = await readJsonRecord(response, 'target duplicate verification run response');
    const data = requireDataRecord(payload, 'target duplicate verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(getStringProperty(data, 'finalizationId')).toBe(finalizationId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
  });

  it('rolls back running verifier state when the local verifier invocation fails', async () => {
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await prepareLocalBundle();
    verifierServiceMocks.invokeVerifierService.mockRejectedValue(new Error('verifier unavailable'));
    const initialResult = buildFinalizationResult();
    const { store, markVerificationRunning, rollbackVerificationResult } = createVerificationRunStore(initialResult, {
      deliveryMetadata: null,
    });

    const response = await invokeVerificationRun(store);
    const payload = await readJsonRecord(response, 'verification run failure response');

    expect(response.status).toBe(500);
    expect(getApiErrorCode(payload)).toBe('INTERNAL_ERROR');
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(rollbackVerificationResult).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith('[VerificationRun] Verifier invocation failed', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalizationId,
      bundleMode: 'local_bundle',
      error_kind: 'error',
    });
  });

  it('does not log private local verifier error content', async () => {
    await prepareLocalBundle();
    const privateArtifactText =
      'input.json contained vote opening 7; s3://private-bucket/sessions/private-session/private-execution/input.json';
    const privateToken = 'v1.private-capability-token-material.private-signature-material';
    verifierServiceMocks.invokeVerifierService.mockRejectedValue(
      new Error(`${privateArtifactText}; token=${privateToken}`),
    );
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { store, markVerificationRunning, rollbackVerificationResult } = createVerificationRunStore(
      buildFinalizationResult(),
      { deliveryMetadata: null },
    );

    const response = await invokeVerificationRun(store);
    const payload = await readJsonRecord(response, 'private local verifier error response');

    expect(response.status).toBe(500);
    expect(getApiErrorCode(payload)).toBe('INTERNAL_ERROR');
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(rollbackVerificationResult).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[VerificationRun] Verifier invocation failed',
      expect.objectContaining({
        error_kind: 'error',
      }),
    );
    const capturedLogs = JSON.stringify(loggerErrorSpy.mock.calls);
    expect(capturedLogs).not.toContain(privateArtifactText);
    expect(capturedLogs).not.toContain(privateToken);
    expect(capturedLogs).not.toContain('s3://private-bucket');
    expect(capturedLogs).not.toContain('input.json contained vote opening');
  });

  it('persists local-bundle verifier state without own undefined delivery fields', async () => {
    const { bundlePath, reportPath } = await prepareLocalBundle();
    verifierServiceMocks.invokeVerifierService.mockResolvedValue({
      status: 'failed',
      report: validVerificationReport,
    });
    const localResult = buildFinalizationResult();
    const { store, markVerificationRunning, completeVerificationResult, recordAwsVerificationDeliveryMetadata } =
      createVerificationRunStore(localResult, { deliveryMetadata: null });

    const response = await invokeVerificationRun(store);
    const payload = await readJsonRecord(response, 'local verification run response');
    const data = requireDataRecord(payload, 'local verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
    expect(verifierServiceMocks.invokeVerifierService).toHaveBeenCalledWith({
      bundlePath,
      expectedImageId,
      reportPath,
    });
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(completeVerificationResult).toHaveBeenCalledWith(sessionId, finalizationId, {
      status: 'failed',
      report: validVerificationReport,
    });
  });

  it('fails closed for stale execution locators before invoking the verifier', async () => {
    const { store, markVerificationRunning, completeVerificationResult } = createVerificationRunStore(
      buildFinalizationResult(),
      {
        deliveryMetadata: {
          s3BundleKey: bundleKeyFor(sessionId, 'stale-execution'),
          s3ReportKey: reportKeyFor(sessionId, 'stale-execution'),
        },
      },
    );

    const response = await invokeVerificationRun(store);
    const payload = await readJsonRecord(response, 'stale execution response');

    expect(response.status).toBe(500);
    expect(getApiErrorCode(payload)).toBe('INTERNAL_ERROR');
    expect(markVerificationRunning).not.toHaveBeenCalled();
    expect(completeVerificationResult).not.toHaveBeenCalled();
  });
});
