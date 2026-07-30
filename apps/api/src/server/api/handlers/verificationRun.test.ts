import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionData } from '@stark-ballot/domain/types/server';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import {
  admitAwsPersistedFinalizationResultBranch,
  admitAwsPersistedFinalizationStateBranch,
  type AwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { readJsonRecord, requireDataRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';
import { logger } from '@stark-ballot/diagnostics/logger';
import { runVerificationHandler } from './verificationRun';

const verificationWorkerMocks = vi.hoisted(() => ({
  invokeVerificationWorker: vi.fn(),
}));
const verifierServiceMocks = vi.hoisted(() => ({
  invokeVerifierService: vi.fn(),
}));
const verificationQueueMocks = vi.hoisted(() => ({
  publishVerificationWorkMessage: vi.fn(),
}));

vi.mock('../adapters/verificationWorkerClient', () => ({
  invokeVerificationWorker: verificationWorkerMocks.invokeVerificationWorker,
}));
vi.mock('@stark-ballot/node-adapters/verifier-service-client', () => ({
  invokeVerifierService: verifierServiceMocks.invokeVerifierService,
}));
vi.mock('@stark-ballot/aws-adapters/sqs/publishVerificationWorkMessage', () => ({
  publishVerificationWorkMessage: verificationQueueMocks.publishVerificationWorkMessage,
}));

const capabilitySecret = 'verification-run-handler-secret-0123456789abcdef';
const expectedImageId = `0x${'ab'.repeat(32)}`;
const sessionId = 'session-verification-run-1';
const executionId = 'execution-verification-run-1';
const validVerificationReport = {
  status: 'success' as const,
  verifier_version: '0.1.0',
  verified_at: '2026-06-17T00:00:00.000Z',
  duration_ms: 42,
  expected_image_id: expectedImageId,
  receipt_image_id: expectedImageId,
  dev_mode_receipt: false,
  errors: [],
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

function buildFinalizationResult(
  overrides: Partial<AwsPersistedFinalizationResult> = {},
  verificationStatus: VerificationStatus = 'not_run',
): AwsPersistedFinalizationResult {
  const journal = createTestJournal({
    validVotes: 1,
    totalExpected: 1,
    seenIndicesCount: 1,
  });
  const s3BundleKey = bundleKeyFor(sessionId, executionId);

  return {
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: expectedImageId,
    journal,
    publicInputArtifact: createTestPublicInputArtifact({
      source: 'bundle',
      executionId,
      bundleKey: s3BundleKey,
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        methodVersion: journal.methodVersion,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        votesCount: journal.validVotes,
        recomputedInputCommitment: journal.inputCommitment,
      },
    }),
    verificationExecutionId: executionId,
    s3BundleKey,
    verificationResult: {
      status: verificationStatus,
      executionId,
      s3BundleKey,
      s3ReportKey: reportKeyFor(sessionId, executionId),
    },
    ...overrides,
  };
}

function buildFinalizedSession(finalizationResult: AwsPersistedFinalizationResult): SessionData {
  const now = Date.now();
  return {
    sessionId,
    contractGeneration: resolveCurrentContractGeneration(),
    finalizationContractGeneration: resolveCurrentContractGeneration(),
    hasPersistedFinalizationBranch: true,
    votes: new Map(),
    botCount: 0,
    finalized: true,
    createdAt: now,
    lastActivity: now,
    finalizationResult: admitAwsPersistedFinalizationResultBranch(finalizationResult),
  };
}

function buildFinalizedSessionWithStateBundleMetadata(finalizationResult: AwsPersistedFinalizationResult): SessionData {
  const session = buildFinalizedSession(finalizationResult);
  session.finalizationState = admitAwsPersistedFinalizationStateBranch({
    status: 'succeeded',
    executionId,
    queuedAt: 100,
    startedAt: 200,
    completedAt: 300,
    bundleMetadata: {
      s3BundleKey: bundleKeyFor(sessionId, executionId),
      s3UploadedAt: '2026-07-05T14:14:49.078Z',
    },
  });
  return session;
}

function authHeaders(): Headers {
  return new Headers({
    [SESSION_ID_HEADER]: sessionId,
    [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId }, capabilitySecret),
    'Content-Type': 'application/json',
  });
}

function request(body: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/verification/run', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

function createVerificationRunStore(finalizationResult: AwsPersistedFinalizationResult) {
  const repairFinalizationResult = vi.fn<(sessionId: string) => Promise<void>>(() => Promise.resolve());
  const markVerificationRunning = vi.fn<
    (
      sessionId: string,
      payload: { executionId: string; report?: unknown; verificationWorkQueuedAt?: string },
    ) => Promise<void>
  >(() => Promise.resolve());
  const rollbackVerificationResult = vi.fn<(sessionId: string, payload: { executionId: string }) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const completeVerificationResult = vi.fn<
    (sessionId: string, payload: { executionId: string; verificationResult: unknown }) => Promise<void>
  >(() => Promise.resolve());
  const recordAwsVerificationDeliveryMetadata = vi.fn<
    (sessionId: string, executionId: string, metadata: Record<string, unknown>) => Promise<void>
  >(() => Promise.resolve());
  const store = createMockVoteStore({
    getSession: () => Promise.resolve(buildFinalizedSession(finalizationResult)),
    repairFinalizationResult,
    markVerificationRunning,
    rollbackVerificationResult,
    completeVerificationResult,
    recordAwsVerificationDeliveryMetadata,
  });

  return {
    store,
    repairFinalizationResult,
    markVerificationRunning,
    rollbackVerificationResult,
    completeVerificationResult,
    recordAwsVerificationDeliveryMetadata,
  };
}

function conditionalCheckFailed(): Error {
  return Object.assign(new Error('ConditionalCheckFailedException'), { name: 'ConditionalCheckFailedException' });
}

interface WorkerResponseOverride {
  sessionId?: string;
  executionId?: string;
  s3?: {
    bundleKey?: string;
    reportKey?: string;
  };
}

const workerScopeMismatchCases: ReadonlyArray<[string, WorkerResponseOverride]> = [
  ['sessionId', { sessionId: 'other-session' }],
  ['executionId', { executionId: 'other-execution' }],
  ['bundleKey', { s3: { bundleKey: bundleKeyFor('other-session', executionId) } }],
  ['reportKey', { s3: { reportKey: reportKeyFor(sessionId, 'other-execution') } }],
];

describe('runVerificationHandler', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      SESSION_CAPABILITY_SECRET: process.env['SESSION_CAPABILITY_SECRET'],
      USE_MOCK_STORE: process.env['USE_MOCK_STORE'],
      EXPECTED_IMAGE_ID: process.env['EXPECTED_IMAGE_ID'],
      EXPECTED_IMAGEID_POC: process.env['EXPECTED_IMAGEID_POC'],
      EXPECTED_IMAGE_ID_VARIANT: process.env['EXPECTED_IMAGE_ID_VARIANT'],
      VERIFIER_WORK_DIR: process.env['VERIFIER_WORK_DIR'],
      TARGET_AWS_RUNTIME: process.env['TARGET_AWS_RUNTIME'],
      VERIFICATION_WORK_QUEUE_URL: process.env['VERIFICATION_WORK_QUEUE_URL'],
    };
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    process.env['USE_MOCK_STORE'] = 'true';
    process.env['EXPECTED_IMAGE_ID'] = expectedImageId;
    delete process.env['EXPECTED_IMAGEID_POC'];
    delete process.env['EXPECTED_IMAGE_ID_VARIANT'];
    delete process.env['TARGET_AWS_RUNTIME'];
    delete process.env['VERIFICATION_WORK_QUEUE_URL'];
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('persists canonical repair before returning an already-complete idempotent response', async () => {
    const storedResult = buildFinalizationResult({}, 'success');
    const { store, repairFinalizationResult } = createVerificationRunStore(storedResult);

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'local verification run response');
    const data = requireDataRecord(payload, 'local verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('success');
    expect(getStringProperty(data, 'verificationExecutionId')).toBe(executionId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(verificationWorkerMocks.invokeVerificationWorker).not.toHaveBeenCalled();
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
    expect(repairFinalizationResult).toHaveBeenCalledTimes(1);
    expect(repairFinalizationResult).toHaveBeenCalledWith(sessionId);
  });

  it('returns an already-running idempotent response without starting a new verifier run', async () => {
    const { store, repairFinalizationResult, markVerificationRunning } = createVerificationRunStore(
      buildFinalizationResult({}, 'running'),
    );

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'local verification run response');
    const data = requireDataRecord(payload, 'local verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(getStringProperty(data, 'verificationExecutionId')).toBe(executionId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(verificationWorkerMocks.invokeVerificationWorker).not.toHaveBeenCalled();
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
    expect(repairFinalizationResult).toHaveBeenCalledTimes(1);
    expect(markVerificationRunning).not.toHaveBeenCalled();
  });

  it('repairs target running verifier state that was persisted before queue publication', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['VERIFICATION_WORK_QUEUE_URL'] = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify';
    verificationQueueMocks.publishVerificationWorkMessage.mockResolvedValue(undefined);
    const { store, repairFinalizationResult, markVerificationRunning } = createVerificationRunStore(
      buildFinalizationResult({}, 'running'),
    );

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'target verification run repair response');
    const data = requireDataRecord(payload, 'target verification run repair data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(getStringProperty(data, 'verificationExecutionId')).toBe(executionId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(repairFinalizationResult).toHaveBeenCalledTimes(1);
    const [publishedMessage] = verificationQueueMocks.publishVerificationWorkMessage.mock.calls[0] as [
      {
        sessionId: string;
        executionId: string;
        queuedAt: number;
        bundleKey: string;
        expectedImageId: string;
      },
    ];
    expect(publishedMessage).toEqual({
      sessionId,
      executionId,
      queuedAt: publishedMessage.queuedAt,
      bundleKey: bundleKeyFor(sessionId, executionId),
      expectedImageId,
    });
    expect(Number.isInteger(publishedMessage.queuedAt)).toBe(true);
    const [, runningPayload] = markVerificationRunning.mock.calls[0] ?? [];
    expect(runningPayload).toEqual({
      executionId,
      verificationWorkQueuedAt: runningPayload?.verificationWorkQueuedAt,
    });
    expect(typeof runningPayload?.verificationWorkQueuedAt).toBe('string');
    expect(verificationWorkerMocks.invokeVerificationWorker).not.toHaveBeenCalled();
  });

  it('returns an already-failed idempotent response for polling after terminal worker failure', async () => {
    const { store, repairFinalizationResult, markVerificationRunning, completeVerificationResult } =
      createVerificationRunStore(buildFinalizationResult({}, 'failed'));

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'failed verification run response');
    const data = requireDataRecord(payload, 'failed verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
    expect(getStringProperty(data, 'verificationExecutionId')).toBe(executionId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(verificationWorkerMocks.invokeVerificationWorker).not.toHaveBeenCalled();
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
    expect(repairFinalizationResult).toHaveBeenCalledTimes(1);
    expect(markVerificationRunning).not.toHaveBeenCalled();
    expect(completeVerificationResult).not.toHaveBeenCalled();
  });

  it('persists running and completed verifier state with the stored execution authority', async () => {
    verificationWorkerMocks.invokeVerificationWorker.mockResolvedValue({
      status: 'success',
      sessionId,
      executionId,
      verifierStatus: 'success',
      verificationReport: validVerificationReport,
      s3: {
        bundleKey: bundleKeyFor(sessionId, executionId),
        reportKey: reportKeyFor(sessionId, executionId),
        uploadedAt: '2026-06-17T00:00:00.000Z',
      },
    });
    const { store, markVerificationRunning, completeVerificationResult, recordAwsVerificationDeliveryMetadata } =
      createVerificationRunStore(buildFinalizationResult());

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'local verification run response');
    const data = requireDataRecord(payload, 'local verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('success');
    expect(getStringProperty(data, 'verificationExecutionId')).toBe(executionId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(false);
    expect(verificationWorkerMocks.invokeVerificationWorker).toHaveBeenCalledWith({
      mode: 's3_bundle',
      sessionId,
      executionId,
      bundleKey: bundleKeyFor(sessionId, executionId),
      expectedImageId,
    });
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, { executionId });
    expect(recordAwsVerificationDeliveryMetadata).toHaveBeenCalledWith(sessionId, executionId, {
      s3BundleKey: bundleKeyFor(sessionId, executionId),
      s3ReportKey: reportKeyFor(sessionId, executionId),
      s3UploadedAt: '2026-06-17T00:00:00.000Z',
    });
    expect(completeVerificationResult).toHaveBeenCalledWith(sessionId, {
      executionId,
      verificationResult: {
        status: 'success',
        report: validVerificationReport,
      },
    });
  });

  it('enqueues target verification work and returns running without synchronous Lambda invoke', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['VERIFICATION_WORK_QUEUE_URL'] = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify';
    verificationQueueMocks.publishVerificationWorkMessage.mockResolvedValue(undefined);
    const { store, markVerificationRunning, completeVerificationResult, rollbackVerificationResult } =
      createVerificationRunStore(buildFinalizationResult());

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'target verification run response');
    const data = requireDataRecord(payload, 'target verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(getStringProperty(data, 'verificationExecutionId')).toBe(executionId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(false);
    expect(markVerificationRunning).toHaveBeenNthCalledWith(1, sessionId, { executionId });
    const [publishedMessage] = verificationQueueMocks.publishVerificationWorkMessage.mock.calls[0] as [
      {
        sessionId: string;
        executionId: string;
        queuedAt: number;
        bundleKey: string;
        expectedImageId: string;
      },
    ];
    expect(publishedMessage).toEqual({
      sessionId,
      executionId,
      queuedAt: publishedMessage.queuedAt,
      bundleKey: bundleKeyFor(sessionId, executionId),
      expectedImageId,
    });
    expect(Number.isInteger(publishedMessage.queuedAt)).toBe(true);
    const [, runningPayload] = markVerificationRunning.mock.calls[1] ?? [];
    expect(runningPayload).toEqual({
      executionId,
      verificationWorkQueuedAt: runningPayload?.verificationWorkQueuedAt,
    });
    expect(typeof runningPayload?.verificationWorkQueuedAt).toBe('string');
    expect(verificationWorkerMocks.invokeVerificationWorker).not.toHaveBeenCalled();
    expect(completeVerificationResult).not.toHaveBeenCalled();
    expect(rollbackVerificationResult).not.toHaveBeenCalled();
  });

  it('falls back to succeeded finalization state bundle metadata for target verification work', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['VERIFICATION_WORK_QUEUE_URL'] = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify';
    verificationQueueMocks.publishVerificationWorkMessage.mockResolvedValue(undefined);
    const finalizationResult = buildFinalizationResult();
    delete finalizationResult.s3BundleKey;
    delete finalizationResult.verificationResult;
    const markVerificationRunning = vi.fn<
      (
        sessionId: string,
        payload: { executionId: string; report?: unknown; verificationWorkQueuedAt?: string },
      ) => Promise<void>
    >(() => Promise.resolve());
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildFinalizedSessionWithStateBundleMetadata(finalizationResult)),
      repairFinalizationResult: vi.fn(() => Promise.resolve()),
      markVerificationRunning,
    });

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });

    expect(response.status).toBe(200);
    const [publishedMessage] = verificationQueueMocks.publishVerificationWorkMessage.mock.calls[0] as [
      {
        sessionId: string;
        executionId: string;
        queuedAt: number;
        bundleKey: string;
        expectedImageId: string;
      },
    ];
    expect(publishedMessage).toEqual({
      sessionId,
      executionId,
      queuedAt: publishedMessage.queuedAt,
      bundleKey: bundleKeyFor(sessionId, executionId),
      expectedImageId,
    });
    expect(Number.isInteger(publishedMessage.queuedAt)).toBe(true);
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, { executionId });
  });

  it('returns an idempotent running response when a duplicate target request wins the same execution race', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['VERIFICATION_WORK_QUEUE_URL'] = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/verify';
    const getSession = vi
      .fn<() => Promise<SessionData | null>>()
      .mockResolvedValueOnce(buildFinalizedSession(buildFinalizationResult({}, 'not_run')))
      .mockResolvedValueOnce(buildFinalizedSession(buildFinalizationResult({}, 'running')));
    const markVerificationRunning = vi.fn<() => Promise<void>>(() => Promise.reject(conditionalCheckFailed()));
    const store = createMockVoteStore({
      getSession,
      repairFinalizationResult: vi.fn(() => Promise.resolve()),
      markVerificationRunning,
    });

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'target duplicate verification run response');
    const data = requireDataRecord(payload, 'target duplicate verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('running');
    expect(getStringProperty(data, 'verificationExecutionId')).toBe(executionId);
    expect(getBooleanProperty(data, 'idempotent')).toBe(true);
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, { executionId });
    expect(verificationQueueMocks.publishVerificationWorkMessage).not.toHaveBeenCalled();
    expect(verificationWorkerMocks.invokeVerificationWorker).not.toHaveBeenCalled();
  });

  it.each(workerScopeMismatchCases)(
    'rolls back running verifier state when the worker response has mismatched %s',
    async (_field, responseOverrides) => {
      verificationWorkerMocks.invokeVerificationWorker.mockResolvedValue({
        status: 'success',
        sessionId,
        executionId,
        verifierStatus: 'success',
        verificationReport: validVerificationReport,
        s3: {
          bundleKey: bundleKeyFor(sessionId, executionId),
          reportKey: reportKeyFor(sessionId, executionId),
          uploadedAt: '2026-06-17T00:00:00.000Z',
          ...responseOverrides.s3,
        },
        ...responseOverrides,
      });
      const { store, markVerificationRunning, rollbackVerificationResult, recordAwsVerificationDeliveryMetadata } =
        createVerificationRunStore(buildFinalizationResult());

      const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
      const payload = await readJsonRecord(response, 'mismatched worker scope response');

      expect(response.status).toBe(500);
      expect(getStringProperty(payload, 'error')).toBe('INTERNAL_ERROR');
      expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, { executionId });
      expect(recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
      expect(rollbackVerificationResult).toHaveBeenCalledWith(sessionId, { executionId });
    },
  );

  it('rolls back running verifier state when the worker report payload is malformed', async () => {
    verificationWorkerMocks.invokeVerificationWorker.mockRejectedValue(
      new Error('verification-worker response verificationReport.status is invalid'),
    );
    const initialResult = buildFinalizationResult({}, 'not_run');
    const { store, markVerificationRunning, rollbackVerificationResult } = createVerificationRunStore(initialResult);

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'malformed worker report response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe('INTERNAL_ERROR');
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, { executionId });
    expect(rollbackVerificationResult).toHaveBeenCalledWith(sessionId, { executionId });
  });

  it('rolls back running verifier state when the verifier invocation fails', async () => {
    verificationWorkerMocks.invokeVerificationWorker.mockRejectedValue(new Error('worker unavailable'));
    const initialResult = buildFinalizationResult({}, 'not_run');
    const { store, markVerificationRunning, rollbackVerificationResult } = createVerificationRunStore(initialResult);

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'verification run failure response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe('INTERNAL_ERROR');
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, { executionId });
    expect(rollbackVerificationResult).toHaveBeenCalledWith(sessionId, { executionId });
  });

  it('does not log private worker error response content', async () => {
    const privateArtifactText =
      'input.json contained vote opening 7; s3://private-bucket/sessions/private-session/private-execution/input.json';
    const privateToken = 'v1.private-capability-token-material.private-signature-material';
    verificationWorkerMocks.invokeVerificationWorker.mockResolvedValue({
      status: 'error',
      message: privateArtifactText,
      details: {
        privateArtifactText,
        privateToken,
      },
    });
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { store, markVerificationRunning, rollbackVerificationResult } = createVerificationRunStore(
      buildFinalizationResult({}, 'not_run'),
    );

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'private worker error response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe('INTERNAL_ERROR');
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, { executionId });
    expect(rollbackVerificationResult).toHaveBeenCalledWith(sessionId, { executionId });
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[VerificationRun] Verifier runner returned an error response',
      expect.objectContaining({
        worker_response_status: 'error',
        worker_details_present: true,
      }),
    );
    const capturedLogs = JSON.stringify(loggerErrorSpy.mock.calls);
    expect(capturedLogs).not.toContain(privateArtifactText);
    expect(capturedLogs).not.toContain(privateToken);
    expect(capturedLogs).not.toContain('s3://private-bucket');
    expect(capturedLogs).not.toContain('input.json contained vote opening');
  });

  it('persists local-bundle verifier state without own undefined delivery fields', async () => {
    const verifierWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stark-ballot-local-verifier-'));
    process.env['VERIFIER_WORK_DIR'] = verifierWorkDir;
    const bundlePath = path.join(verifierWorkDir, sessionId, executionId);
    await fs.mkdir(bundlePath, { recursive: true });
    await fs.writeFile(path.join(bundlePath, 'public-input.json'), '{}', 'utf-8');
    verifierServiceMocks.invokeVerifierService.mockResolvedValue({
      status: 'failed',
      report: validVerificationReport,
    });
    const localResult = buildFinalizationResult({}, 'not_run');
    delete localResult.s3BundleKey;
    localResult.publicInputArtifact = createTestPublicInputArtifact({
      source: 'generated',
      executionId,
      typedAuthority: {
        electionId: localResult.journal.electionId,
        electionConfigHash: localResult.journal.electionConfigHash,
        methodVersion: localResult.journal.methodVersion,
        bulletinRoot: localResult.journal.bulletinRoot,
        treeSize: localResult.journal.treeSize,
        totalExpected: localResult.journal.totalExpected,
        votesCount: localResult.journal.validVotes,
        recomputedInputCommitment: localResult.journal.inputCommitment,
      },
    });
    localResult.verificationResult = {
      status: 'not_run',
      executionId,
    };
    const { store, markVerificationRunning, completeVerificationResult, recordAwsVerificationDeliveryMetadata } =
      createVerificationRunStore(localResult);

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'local verification run response');
    const data = requireDataRecord(payload, 'local verification run data');

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'verificationStatus')).toBe('failed');
    expect(verifierServiceMocks.invokeVerifierService).toHaveBeenCalledWith({
      bundlePath,
      expectedImageId,
      reportPath: path.join(bundlePath, 'verification.json'),
    });
    expect(markVerificationRunning).toHaveBeenCalledWith(sessionId, { executionId });
    expect(recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(completeVerificationResult).toHaveBeenCalledWith(sessionId, {
      executionId,
      verificationResult: {
        status: 'failed',
        report: validVerificationReport,
      },
    });
  });

  it('fails closed for stale execution locators before invoking the verifier', async () => {
    const staleResult = buildFinalizationResult({
      verificationExecutionId: 'stale-execution',
      verificationResult: {
        status: 'not_run',
        executionId: 'stale-execution',
        s3BundleKey: bundleKeyFor(sessionId, executionId),
        s3ReportKey: reportKeyFor(sessionId, executionId),
      },
    });
    const { store, markVerificationRunning, completeVerificationResult } = createVerificationRunStore(staleResult);

    const response = await runVerificationHandler({ request: request(), store, clientIp: '127.0.0.1' });
    const payload = await readJsonRecord(response, 'stale execution response');

    expect(response.status).toBe(500);
    expect(getStringProperty(payload, 'error')).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
    expect(verificationWorkerMocks.invokeVerificationWorker).not.toHaveBeenCalled();
    expect(markVerificationRunning).not.toHaveBeenCalled();
    expect(completeVerificationResult).not.toHaveBeenCalled();
  });
});
