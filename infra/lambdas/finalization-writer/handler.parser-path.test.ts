import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type {
  FinalizationFailedPayload,
  FinalizationLifecycleStore,
  FinalizationQueuedPayload,
  FinalizationRunningPayload,
  FinalizationSucceededPayload,
  FinalizationTimedOutPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type {
  AwsFinalizationRuntimeState,
  AwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import type {
  AwsFinalizationFailedPayload,
  AwsFinalizationRunningPayload,
  AwsFinalizationRuntimeTransitionStore,
  AwsFinalizationSucceededPayload,
  AwsFinalizationTimedOutPayload,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';

const mocks = vi.hoisted(() => {
  const state = {
    restoredResult: undefined as AwsPersistedFinalizationResult | undefined,
    store: undefined as
      (FinalizationLifecycleStore & AwsFinalizationRuntimeTransitionStore & Pick<VoteStore, 'getSession'>) | undefined,
  };

  return {
    state,
    buildFinalizationResultFromS3Bundle: vi.fn(() => {
      if (!state.restoredResult) {
        throw new Error('restored result not configured');
      }
      return Promise.resolve(state.restoredResult);
    }),
    buildAsyncProverArtifactKeys: vi.fn((sessionId: string, executionId: string) => ({
      inputS3Key: `sessions/${sessionId}/${executionId}/input.json`,
      outputS3Prefix: `sessions/${sessionId}/${executionId}/`,
      bundleS3Key: `sessions/${sessionId}/${executionId}/bundle.zip`,
    })),
    validateAsyncProverBundleKey: vi.fn((sessionId: string, executionId: string, bundleS3Key: string) => {
      const expected = `sessions/${sessionId}/${executionId}/bundle.zip`;
      if (bundleS3Key !== expected) {
        throw new Error('Async prover bundle key must match the canonical session/execution S3 layout');
      }
      return expected;
    }),
  };
});

vi.mock('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver', () => ({
  ensureAwsRuntimeConfigReferencesLoaded: vi.fn(async () => await Promise.resolve(undefined)),
}));

vi.mock('@stark-ballot/runtime-config/env/validate', () => ({
  validateEnv: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(() => mocks.state.store),
}));

vi.mock('@stark-ballot/aws-adapters/finalize/async-prover-artifacts', () => ({
  buildAsyncProverArtifactKeys: mocks.buildAsyncProverArtifactKeys,
  buildFinalizationResultFromS3Bundle: mocks.buildFinalizationResultFromS3Bundle,
  validateAsyncProverBundleKey: mocks.validateAsyncProverBundleKey,
}));

const { handler } = await import('./handler');

const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
const executionId = '01HVN5WA1CEH94868G90QGJ7HX';
const contractGeneration = '2026-04-zkvm-current-v1';
const queuedAt = 1_700_000_000_000;
const startedAt = 1_700_000_001_000;
const executionArn = 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1';

function createStateMachinePayload(): Record<string, unknown> {
  return {
    messageVersion: 1,
    sessionId,
    contractGeneration,
    executionId,
    queuedAt,
    startedAt,
    expectedImageId: `0x${'1'.repeat(64)}`,
    inputS3Key: `sessions/${sessionId}/${executionId}/input.json`,
    outputS3Prefix: `sessions/${sessionId}/${executionId}/`,
    bundleS3Key: `sessions/${sessionId}/${executionId}/bundle.zip`,
    scenarios: ['S0'],
    simulateTampering: false,
    scenarioContext: {
      scenarios: ['S0'],
      tamperMode: 'none',
    },
    proverResult: {
      ExecutionStoppedAt: '2026-06-17T00:00:05.000Z',
    },
  };
}

function expectNoProverWorkFields(value: Record<string, unknown>): void {
  expect(value).not.toHaveProperty('messageVersion');
  expect(value).not.toHaveProperty('expectedImageId');
  expect(value).not.toHaveProperty('inputS3Key');
  expect(value).not.toHaveProperty('outputS3Prefix');
  expect(value).not.toHaveProperty('bundleS3Key');
  expect(value).not.toHaveProperty('scenarios');
  expect(value).not.toHaveProperty('simulateTampering');
  expect(value).not.toHaveProperty('scenarioContext');
  expect(value).not.toHaveProperty('proverResult');
}

function getStepFunctionsArn(payload: object): string | undefined {
  const value = (payload as { stepFunctionsArn?: unknown }).stepFunctionsArn;
  return typeof value === 'string' ? value : undefined;
}

function createRestoredFinalizationResult(): AwsPersistedFinalizationResult {
  const baseJournal = createTestJournal();
  const electionManifest = buildElectionManifest(baseJournal.electionId, buildDefaultElectionConfig());
  const closeStatement = buildCloseStatement({
    logId: `0x${'3'.repeat(64)}`,
    treeSize: baseJournal.treeSize,
    timestamp: 1_700_000_005,
    bulletinRoot: baseJournal.bulletinRoot,
  });
  const journal = {
    ...baseJournal,
    electionConfigHash: electionManifest.electionConfigHash,
    sthDigest: closeStatement.sthDigest,
  };
  const publicInputArtifact = createTestPublicInputArtifact({
    source: 'bundle',
    executionId,
    bundleKey: `sessions/${sessionId}/${executionId}/bundle.zip`,
    typedAuthority: {
      electionId: journal.electionId,
      electionConfigHash: journal.electionConfigHash,
      methodVersion: journal.methodVersion,
      bulletinRoot: journal.bulletinRoot,
      treeSize: journal.treeSize,
      totalExpected: journal.totalExpected,
      votesCount: journal.validVotes,
      logId: closeStatement.logId,
      timestamp: closeStatement.timestamp,
      recomputedInputCommitment: journal.inputCommitment,
    },
  });

  return {
    ...buildFinalizationResultFromJournal({
      journal,
      imageId: `0x${'2'.repeat(64)}`,
      electionManifest,
      closeStatement,
    }),
    publicInputArtifact,
    verificationExecutionId: executionId,
    s3BundleKey: `sessions/${sessionId}/${executionId}/bundle.zip`,
    s3UploadedAt: '2026-06-17T00:00:05.000Z',
  };
}

function createStore(): {
  store: FinalizationLifecycleStore & AwsFinalizationRuntimeTransitionStore & Pick<VoteStore, 'getSession'>;
  markFinalizationRunning: ReturnType<typeof vi.fn>;
  markFinalizationSucceeded: ReturnType<typeof vi.fn>;
  markFinalizationFailed: ReturnType<typeof vi.fn>;
  markFinalizationTimedOut: ReturnType<typeof vi.fn>;
  markAwsFinalizationRunning: ReturnType<typeof vi.fn>;
} {
  const getSession = vi.fn(() => Promise.resolve(null));
  const markFinalizationRunning = vi.fn((_sessionId: string, payload: FinalizationRunningPayload) => {
    return Promise.resolve({
      status: 'running' as const,
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
    });
  });
  const markFinalizationSucceeded = vi.fn((_sessionId: string, payload: FinalizationSucceededPayload) => {
    return Promise.resolve({
      status: 'succeeded' as const,
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
    });
  });
  const markFinalizationFailed = vi.fn((_sessionId: string, payload: FinalizationFailedPayload) => {
    return Promise.resolve({
      status: 'failed' as const,
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      failedAt: payload.failedAt,
      error: payload.error,
    });
  });
  const markFinalizationTimedOut = vi.fn((_sessionId: string, payload: FinalizationTimedOutPayload) => {
    return Promise.resolve({
      status: 'timeout' as const,
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      timeoutAt: payload.timeoutAt,
    });
  });
  const storeMarkAwsFinalizationRunning = vi.fn((_sessionId: string, payload: AwsFinalizationRunningPayload) => {
    const stepFunctionsArn = getStepFunctionsArn(payload);
    const state: AwsFinalizationRuntimeState = {
      status: 'running',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
    void markFinalizationRunning(_sessionId, {
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      contractGeneration: payload.contractGeneration,
      startedAt: payload.startedAt,
    });
    return Promise.resolve(state);
  });
  const storeMarkAwsFinalizationSucceeded = vi.fn((_sessionId: string, payload: AwsFinalizationSucceededPayload) => {
    const stepFunctionsArn = getStepFunctionsArn(payload);
    const state: AwsFinalizationRuntimeState = {
      status: 'succeeded',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
      ...(payload.bundleMetadata ? { bundleMetadata: payload.bundleMetadata } : {}),
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
    void markFinalizationSucceeded(_sessionId, {
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      contractGeneration: payload.contractGeneration,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
      finalizationResult: payload.finalizationResult,
    });
    return Promise.resolve(state);
  });
  const storeMarkAwsFinalizationFailed = vi.fn((_sessionId: string, payload: AwsFinalizationFailedPayload) => {
    const stepFunctionsArn = getStepFunctionsArn(payload);
    const state: AwsFinalizationRuntimeState = {
      status: 'failed',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      failedAt: payload.failedAt,
      error: payload.error,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
    void markFinalizationFailed(_sessionId, {
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      contractGeneration: payload.contractGeneration,
      ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      failedAt: payload.failedAt,
      error: payload.error,
    });
    return Promise.resolve(state);
  });
  const storeMarkAwsFinalizationTimedOut = vi.fn((_sessionId: string, payload: AwsFinalizationTimedOutPayload) => {
    const stepFunctionsArn = getStepFunctionsArn(payload);
    const state: AwsFinalizationRuntimeState = {
      status: 'timeout',
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      timeoutAt: payload.timeoutAt,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
    void markFinalizationTimedOut(_sessionId, {
      executionId: payload.executionId,
      queuedAt: payload.queuedAt,
      contractGeneration: payload.contractGeneration,
      ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      timeoutAt: payload.timeoutAt,
    });
    return Promise.resolve(state);
  });

  return {
    store: {
      getSession,
      finalizeSession: vi.fn(() => Promise.resolve(undefined)),
      markFinalizationQueued: vi.fn((_sessionId: string, payload: FinalizationQueuedPayload) =>
        Promise.resolve({
          status: 'pending' as const,
          executionId: payload.executionId,
          queuedAt: payload.queuedAt,
        }),
      ),
      markFinalizationRunning,
      markFinalizationSucceeded,
      markFinalizationFailed,
      markFinalizationTimedOut,
      markAwsFinalizationRunning: storeMarkAwsFinalizationRunning,
      markAwsFinalizationSucceeded: storeMarkAwsFinalizationSucceeded,
      markAwsFinalizationFailed: storeMarkAwsFinalizationFailed,
      markAwsFinalizationTimedOut: storeMarkAwsFinalizationTimedOut,
    },
    markFinalizationRunning,
    markFinalizationSucceeded,
    markFinalizationFailed,
    markFinalizationTimedOut,
    markAwsFinalizationRunning: storeMarkAwsFinalizationRunning,
  };
}

describe('target finalization-writer real parser admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.restoredResult = createRestoredFinalizationResult();
  });

  it('does not keep an unreachable error-shaped success response variant', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'infra/lambdas/finalization-writer/handler.ts'), 'utf8');

    expect(source).not.toContain("status: 'error'");
  });

  it('projects successful Step Functions payloads before strict application parsing', async () => {
    const { store, markFinalizationSucceeded } = createStore();
    mocks.state.store = store;

    const response = await handler({
      status: 'SUCCEEDED',
      executionArn,
      payload: createStateMachinePayload(),
    });

    expect(response).toEqual(
      expect.objectContaining({
        status: 'success',
        sessionId,
      }),
    );
    expect(response.state).toEqual(
      expect.objectContaining({
        stepFunctionsArn: executionArn,
        bundleMetadata: {
          s3BundleKey: `sessions/${sessionId}/${executionId}/bundle.zip`,
          s3UploadedAt: '2026-06-17T00:00:05.000Z',
        },
      }),
    );

    expect(mocks.buildFinalizationResultFromS3Bundle).toHaveBeenCalledWith({
      bundleS3Key: `sessions/${sessionId}/${executionId}/bundle.zip`,
      verificationExecutionId: executionId,
      s3UploadedAt: '2026-06-17T00:00:05.000Z',
      finalizedAt: Date.parse('2026-06-17T00:00:05.000Z'),
    });
    expect(markFinalizationSucceeded).toHaveBeenCalledTimes(1);
    const succeededPayload = markFinalizationSucceeded.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(succeededPayload).toEqual(
      expect.objectContaining({
        executionId,
        queuedAt,
        startedAt,
        completedAt: Date.parse('2026-06-17T00:00:05.000Z'),
      }),
    );
    expect(succeededPayload).not.toHaveProperty('stepFunctionsArn');
    expect(succeededPayload).not.toHaveProperty('bundleMetadata');
    expectNoProverWorkFields(succeededPayload);
  });

  it('normalizes RUNNING direct events and returns the applied running state', async () => {
    const { store, markFinalizationRunning } = createStore();
    const proverStartedAt = '2026-06-17T00:00:01.000Z';
    const payload = createStateMachinePayload();
    delete payload['startedAt'];
    mocks.state.store = store;

    const response = await handler({
      status: 'RUNNING',
      executionArn,
      startedAt: proverStartedAt,
      payload,
    });

    expect(response).toEqual({
      status: 'success',
      sessionId,
      state: {
        status: 'running',
        executionId,
        queuedAt,
        startedAt: Date.parse(proverStartedAt),
        stepFunctionsArn: executionArn,
      },
    });
    expect(markFinalizationRunning).toHaveBeenCalledTimes(1);
    const runningPayload = markFinalizationRunning.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(runningPayload).toEqual(
      expect.objectContaining({
        executionId,
        queuedAt,
        startedAt: Date.parse(proverStartedAt),
      }),
    );
    expect(runningPayload).not.toHaveProperty('stepFunctionsArn');
    expectNoProverWorkFields(runningPayload);
  });

  it('returns a terminal failed state when RUNNING is blocked by a cancelled session', async () => {
    const { store, markAwsFinalizationRunning } = createStore();
    const failedState: AwsFinalizationRuntimeState = {
      status: 'failed',
      executionId,
      queuedAt,
      failedAt: startedAt,
      error: {
        code: 'USER_CANCELLED',
        message: 'User cancelled finalization',
      },
      stepFunctionsArn: executionArn,
    };
    markAwsFinalizationRunning.mockResolvedValueOnce(failedState);
    mocks.state.store = store;

    const response = await handler({
      status: 'RUNNING',
      executionArn,
      startedAt: '2026-06-17T00:00:01.000Z',
      payload: createStateMachinePayload(),
    });

    expect(response).toEqual({
      status: 'success',
      sessionId,
      state: failedState,
    });
  });

  it('projects failed Step Functions payloads with extra work fields before strict application parsing', async () => {
    const { store, markFinalizationFailed } = createStore();
    mocks.state.store = store;

    const response = await handler({
      status: 'FAILED',
      executionArn,
      payload: createStateMachinePayload(),
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        details: {
          Error: 'States.TaskFailed',
          Cause: 'container exited',
        },
      },
    });

    expect(response).toEqual(
      expect.objectContaining({
        status: 'success',
        sessionId,
      }),
    );
    expect(response.state).toEqual(expect.objectContaining({ stepFunctionsArn: executionArn }));

    expect(markFinalizationFailed).toHaveBeenCalledTimes(1);
    const failedPayload = markFinalizationFailed.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(failedPayload).toEqual(
      expect.objectContaining({
        executionId,
        queuedAt,
        startedAt,
        error: {
          code: 'PROVER_TASK_FAILED',
          message: 'Target prover task failed',
          details: {
            code: 'PROVER_TASK_FAILED',
            message: 'Target prover task failed',
            details: {
              Error: 'States.TaskFailed',
              Cause: 'container exited',
            },
          },
        },
      }),
    );
    expect(failedPayload).not.toHaveProperty('stepFunctionsArn');
    expectNoProverWorkFields(failedPayload);
  });

  it('projects timed-out Step Functions payloads with extra work fields before strict application parsing', async () => {
    const { store, markFinalizationTimedOut } = createStore();
    const timeoutAt = '2026-06-17T00:00:10.000Z';
    mocks.state.store = store;

    const response = await handler({
      status: 'TIMED_OUT',
      executionArn,
      timeoutAt,
      payload: createStateMachinePayload(),
    });

    expect(response).toEqual(
      expect.objectContaining({
        status: 'success',
        sessionId,
      }),
    );
    expect(response.state).toEqual(expect.objectContaining({ stepFunctionsArn: executionArn }));

    expect(markFinalizationTimedOut).toHaveBeenCalledTimes(1);
    const timedOutPayload = markFinalizationTimedOut.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(timedOutPayload).toEqual(
      expect.objectContaining({
        executionId,
        queuedAt,
        startedAt,
        timeoutAt: Date.parse(timeoutAt),
      }),
    );
    expect(timedOutPayload).not.toHaveProperty('stepFunctionsArn');
    expectNoProverWorkFields(timedOutPayload);
  });
});
