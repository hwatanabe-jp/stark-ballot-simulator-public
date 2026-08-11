import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  FinalizationBitmapStore,
  FinalizationFailedPayload,
  FinalizationLifecycleStore,
  FinalizationQueuedPayload,
  FinalizationSucceededPayload,
} from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type { FinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-types';
import type {
  AwsFinalizationFailedPayload,
  AwsFinalizationRunningPayload,
  AwsFinalizationRuntimeState,
  AwsFinalizationRuntimeTransitionStore,
  AwsFinalizationSucceededPayload,
  AwsFinalizationTimedOutPayload,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { targetRuntimeProfileEnv } from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

interface RestoreBundleInput {
  profile: ResolvedRuntimeProfile;
  bundleS3Key: string;
  finalizationId: string;
  finalizedAtMs: number;
}

const mocks = vi.hoisted(() => {
  const state = {
    restoredResult: undefined as FinalizationResultAuthority | undefined,
    store: undefined as
      (FinalizationLifecycleStore & AwsFinalizationRuntimeTransitionStore & FinalizationBitmapStore) | undefined,
  };

  return {
    state,
    buildFinalizationResultFromS3Bundle: vi.fn<(options: RestoreBundleInput) => Promise<FinalizationResultAuthority>>(
      () => {
        if (!state.restoredResult) {
          throw new Error('restored result not configured');
        }
        return Promise.resolve(state.restoredResult);
      },
    ),
    readAsyncProverFailureCategory: vi.fn(() => Promise.resolve(undefined)),
    validateAsyncProverBundleKey: vi.fn(
      (_profile: unknown, sessionId: string, finalizationId: string, bundleS3Key: string) => {
        const expected = `sessions/${sessionId}/${finalizationId}/bundle.zip`;
        if (bundleS3Key !== expected) {
          throw new Error('Async prover bundle key must match the canonical session/finalization S3 layout');
        }
        return expected;
      },
    ),
  };
});

vi.mock('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver', () => ({
  ensureAwsRuntimeConfigReferencesLoaded: vi.fn(async () => await Promise.resolve(undefined)),
}));

vi.mock('@stark-ballot/runtime-config/env/validate', () => ({
  validateEnv: vi.fn(),
}));

vi.mock('@stark-ballot/runtime-config/env/observability', () => ({
  collectInvalidTargetObservabilityEnvNames: vi.fn(() => []),
  validateTargetObservabilityEnv: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(() => mocks.state.store),
}));

vi.mock('@stark-ballot/aws-adapters/finalize/async-prover-artifacts', () => ({
  buildFinalizationResultFromS3Bundle: mocks.buildFinalizationResultFromS3Bundle,
  readAsyncProverFailureCategory: mocks.readAsyncProverFailureCategory,
  validateAsyncProverBundleKey: mocks.validateAsyncProverBundleKey,
}));

const { handler } = await import('./handler');

const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
const finalizationId = '01HVN5WA1CEH94868G90QGJ7HX';
const queuedAtMs = 1_700_000_000_000;
const startedAtMs = 1_700_000_001_000;
const executionArn = 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1';
let consoleLogSpy: MockInstance<typeof console.log>;

function expectLifecycleOutput(to: string, reason: string): void {
  expect(consoleLogSpy.mock.calls).toHaveLength(2);
  expect(consoleLogSpy.mock.calls[0]).toHaveLength(1);
  expect(consoleLogSpy.mock.calls[1]).toHaveLength(1);
  expect(consoleLogSpy.mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      level: 'info',
      service: 'finalization-writer',
      event: 'finalize_transition_attempted',
      to,
      source: 'writer_update',
      reason,
      finalization_id: finalizationId,
    }),
  );
  expect(consoleLogSpy.mock.calls[1]?.[0]).toEqual(
    expect.objectContaining({
      level: 'info',
      service: 'finalization-writer',
      event: 'finalization_update_received',
      transport: 'direct_writer',
      auth_result: 'not_applicable',
      outcome_code: 'applied',
      finalization_id: finalizationId,
    }),
  );
  consoleLogSpy.mockClear();
}

function createStateMachinePayload(): Record<string, unknown> {
  return {
    recordType: 'prover-work',
    inputSource: 's3',
    sessionId,
    finalizationId,
    queuedAtMs,
    startedAtMs,
    expectedImageId: `0x${'1'.repeat(64)}`,
    inputS3Key: `sessions/${sessionId}/${finalizationId}/input.json`,
    outputS3Prefix: `sessions/${sessionId}/${finalizationId}/`,
    bundleS3Key: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
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
  expect(value).not.toHaveProperty('recordType');
  expect(value).not.toHaveProperty('expectedImageId');
  expect(value).not.toHaveProperty('inputS3Key');
  expect(value).not.toHaveProperty('outputS3Prefix');
  expect(value).not.toHaveProperty('bundleS3Key');
  expect(value).not.toHaveProperty('scenarios');
  expect(value).not.toHaveProperty('simulateTampering');
  expect(value).not.toHaveProperty('scenarioContext');
  expect(value).not.toHaveProperty('proverResult');
  expect(value).not.toHaveProperty('contractGeneration');
}

function getStepFunctionsArn(payload: object): string | undefined {
  const value = (payload as { stepFunctionsArn?: unknown }).stepFunctionsArn;
  return typeof value === 'string' ? value : undefined;
}

function createRestoredFinalizationResult(): FinalizationResultAuthority {
  const baseJournal = createTestJournal();
  const includedBitmap = Array.from({ length: baseJournal.treeSize }, (_, index) => index % 2 === 0);
  const seenBitmap = Array.from({ length: baseJournal.treeSize }, () => true);
  const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
  const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
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
    includedBitmapRoot,
    seenBitmapRoot,
    sthDigest: closeStatement.sthDigest,
  };
  const publicInputArtifact = createTestPublicInputArtifact({
    source: 'bundle',
    finalizationId,
    bundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
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
    bitmapData: {
      includedBitmap,
      includedBitmapRoot,
      seenBitmap,
      seenBitmapRoot,
      treeSize: journal.treeSize,
      finalizedAtMs: Date.parse('2026-06-17T00:00:05.000Z'),
    },
    bitmapProofSource: 'real',
  };
}

function createStore(): {
  store: FinalizationLifecycleStore & AwsFinalizationRuntimeTransitionStore & FinalizationBitmapStore;
  markFinalizationRunning: ReturnType<typeof vi.fn<FinalizationLifecycleStore['markFinalizationRunning']>>;
  markFinalizationSucceeded: ReturnType<typeof vi.fn<FinalizationLifecycleStore['markFinalizationSucceeded']>>;
  markFinalizationFailed: ReturnType<typeof vi.fn<FinalizationLifecycleStore['markFinalizationFailed']>>;
  markFinalizationTimedOut: ReturnType<typeof vi.fn<FinalizationLifecycleStore['markFinalizationTimedOut']>>;
  markAwsFinalizationRunning: ReturnType<
    typeof vi.fn<AwsFinalizationRuntimeTransitionStore['markAwsFinalizationRunning']>
  >;
  markAwsFinalizationSucceeded: ReturnType<
    typeof vi.fn<AwsFinalizationRuntimeTransitionStore['markAwsFinalizationSucceeded']>
  >;
} {
  const scenarioContext = {
    scenarios: ['S0'],
    tamperMode: 'none' as const,
    claimedCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    claimedTotalVotes: 0,
    summary: {
      ignoredCount: 0,
      recountedCount: 0,
      userRecountChoice: null,
    },
  };
  let currentRecord: FinalizationRecord = {
    sessionId,
    finalizationId,
    scenarioContext,
    state: {
      status: 'pending',
      finalizationId,
      queuedAtMs,
    },
  };
  const setCurrentRecord = (
    nextState: FinalizationRecord['state'],
    finalizationResult?: FinalizationSucceededPayload['finalizationResult'],
  ): FinalizationRecord => {
    if (nextState.status === 'succeeded') {
      if (!finalizationResult) {
        throw new Error('Succeeded test record requires a finalization result');
      }
      currentRecord = {
        sessionId,
        finalizationId: nextState.finalizationId,
        scenarioContext,
        state: nextState,
        finalizationResult: {
          ...finalizationResult,
          finalizationId: nextState.finalizationId,
        },
      };
      return currentRecord;
    }
    currentRecord = {
      sessionId,
      finalizationId: nextState.finalizationId,
      scenarioContext,
      state: nextState,
    };
    return currentRecord;
  };
  const markFinalizationRunning = vi.fn<FinalizationLifecycleStore['markFinalizationRunning']>(
    (_sessionId, payload) => {
      const state = {
        status: 'running' as const,
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
        startedAtMs: payload.startedAtMs,
      };
      return Promise.resolve(setCurrentRecord(state));
    },
  );
  const markFinalizationSucceeded = vi.fn<FinalizationLifecycleStore['markFinalizationSucceeded']>(
    (_sessionId, payload) => {
      const state = {
        status: 'succeeded' as const,
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
        startedAtMs: payload.startedAtMs,
        completedAtMs: payload.completedAtMs,
      };
      return Promise.resolve(setCurrentRecord(state, payload.finalizationResult));
    },
  );
  const markFinalizationFailed = vi.fn<FinalizationLifecycleStore['markFinalizationFailed']>((_sessionId, payload) => {
    const state = {
      status: 'failed' as const,
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      ...(payload.startedAtMs !== undefined ? { startedAtMs: payload.startedAtMs } : {}),
      failedAtMs: payload.failedAtMs,
      error: payload.error,
    };
    return Promise.resolve(setCurrentRecord(state));
  });
  const markFinalizationTimedOut = vi.fn<FinalizationLifecycleStore['markFinalizationTimedOut']>(
    (_sessionId, payload) => {
      const state = {
        status: 'timeout' as const,
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
        ...(payload.startedAtMs !== undefined ? { startedAtMs: payload.startedAtMs } : {}),
        timeoutAtMs: payload.timeoutAtMs,
      };
      return Promise.resolve(setCurrentRecord(state));
    },
  );
  const storeMarkAwsFinalizationRunning = vi.fn((_sessionId: string, payload: AwsFinalizationRunningPayload) => {
    const stepFunctionsArn = getStepFunctionsArn(payload);
    const state: AwsFinalizationRuntimeState = {
      status: 'running',
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      startedAtMs: payload.startedAtMs,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
    void markFinalizationRunning(_sessionId, {
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      startedAtMs: payload.startedAtMs,
    });
    return Promise.resolve(state);
  });
  const storeMarkAwsFinalizationSucceeded = vi.fn((_sessionId: string, payload: AwsFinalizationSucceededPayload) => {
    const stepFunctionsArn = getStepFunctionsArn(payload);
    const state: AwsFinalizationRuntimeState = {
      status: 'succeeded',
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      startedAtMs: payload.startedAtMs,
      completedAtMs: payload.completedAtMs,
      ...(payload.bundleMetadata ? { bundleMetadata: payload.bundleMetadata } : {}),
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
    void markFinalizationSucceeded(_sessionId, {
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      startedAtMs: payload.startedAtMs,
      completedAtMs: payload.completedAtMs,
      finalizationResult: payload.finalizationResult,
    });
    return Promise.resolve(state);
  });
  const storeMarkAwsFinalizationFailed = vi.fn((_sessionId: string, payload: AwsFinalizationFailedPayload) => {
    const stepFunctionsArn = getStepFunctionsArn(payload);
    const state: AwsFinalizationRuntimeState = {
      status: 'failed',
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      ...(payload.startedAtMs !== undefined ? { startedAtMs: payload.startedAtMs } : {}),
      failedAtMs: payload.failedAtMs,
      error: payload.error,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
    void markFinalizationFailed(_sessionId, {
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      ...(payload.startedAtMs !== undefined ? { startedAtMs: payload.startedAtMs } : {}),
      failedAtMs: payload.failedAtMs,
      error: payload.error,
    });
    return Promise.resolve(state);
  });
  const storeMarkAwsFinalizationTimedOut = vi.fn((_sessionId: string, payload: AwsFinalizationTimedOutPayload) => {
    const stepFunctionsArn = getStepFunctionsArn(payload);
    const state: AwsFinalizationRuntimeState = {
      status: 'timeout',
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      ...(payload.startedAtMs !== undefined ? { startedAtMs: payload.startedAtMs } : {}),
      timeoutAtMs: payload.timeoutAtMs,
      ...(stepFunctionsArn ? { stepFunctionsArn } : {}),
    };
    void markFinalizationTimedOut(_sessionId, {
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      ...(payload.startedAtMs !== undefined ? { startedAtMs: payload.startedAtMs } : {}),
      timeoutAtMs: payload.timeoutAtMs,
    });
    return Promise.resolve(state);
  });
  return {
    store: {
      getCurrentFinalizationRecord: vi.fn(() => Promise.resolve(currentRecord)),
      getFinalizationRecord: vi.fn((_sessionId: string, requestedFinalizationId: string) =>
        Promise.resolve(currentRecord.finalizationId === requestedFinalizationId ? currentRecord : null),
      ),
      markFinalizationQueued: vi.fn((_sessionId: string, payload: FinalizationQueuedPayload) => {
        currentRecord = {
          sessionId,
          finalizationId: payload.finalizationId,
          scenarioContext: payload.scenarioContext,
          state: {
            status: 'pending',
            finalizationId: payload.finalizationId,
            queuedAtMs: payload.queuedAtMs,
          },
        };
        return Promise.resolve(currentRecord);
      }),
      markFinalizationRunning,
      markFinalizationSucceeded,
      markFinalizationFailed,
      markFinalizationTimedOut,
      markAwsFinalizationRunning: storeMarkAwsFinalizationRunning,
      markAwsFinalizationSucceeded: storeMarkAwsFinalizationSucceeded,
      markAwsFinalizationFailed: storeMarkAwsFinalizationFailed,
      markAwsFinalizationTimedOut: storeMarkAwsFinalizationTimedOut,
      getBitmapData: () => Promise.resolve(null),
    },
    markFinalizationRunning,
    markFinalizationSucceeded,
    markFinalizationFailed,
    markFinalizationTimedOut,
    markAwsFinalizationRunning: storeMarkAwsFinalizationRunning,
    markAwsFinalizationSucceeded: storeMarkAwsFinalizationSucceeded,
  };
}

describe('target finalization-writer real parser admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env['VITE_SESSION_CREATE_TURNSTILE_REQUIRED'];
    delete process.env['SESSION_CAPABILITY_SECRET'];
    Object.assign(process.env, targetRuntimeProfileEnv());
    mocks.state.restoredResult = createRestoredFinalizationResult();
  });

  afterEach(() => {
    try {
      expect(consoleLogSpy).not.toHaveBeenCalled();
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('does not keep an unreachable error-shaped success response variant', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'infra/lambdas/finalization-writer/handler.ts'), 'utf8');

    expect(source).not.toContain("status: 'error'");
  });

  it('projects successful Step Functions payloads before strict application parsing', async () => {
    const { store, markFinalizationSucceeded, markAwsFinalizationSucceeded } = createStore();
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
        status: 'succeeded',
        finalizationId,
        completedAtMs: Date.parse('2026-06-17T00:00:05.000Z'),
      }),
    );
    expect(response.state).not.toHaveProperty('stepFunctionsArn');
    expect(response.state).not.toHaveProperty('bundleMetadata');

    const restoreOptions = mocks.buildFinalizationResultFromS3Bundle.mock.calls[0]?.[0];
    expect(restoreOptions?.profile.name).toBe('target-aws-async');
    expect(restoreOptions).toMatchObject({
      bundleS3Key: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
      finalizationId: finalizationId,
      finalizedAtMs: Date.parse('2026-06-17T00:00:05.000Z'),
    });
    expect(markFinalizationSucceeded).toHaveBeenCalledTimes(1);
    const succeededPayload = markFinalizationSucceeded.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(succeededPayload).toEqual(
      expect.objectContaining({
        finalizationId,
        queuedAtMs,
        startedAtMs,
        completedAtMs: Date.parse('2026-06-17T00:00:05.000Z'),
      }),
    );
    expect(succeededPayload).not.toHaveProperty('stepFunctionsArn');
    expect(succeededPayload).not.toHaveProperty('bundleMetadata');
    expectNoProverWorkFields(succeededPayload);
    expect(markAwsFinalizationSucceeded).toHaveBeenCalledOnce();
    expect(markAwsFinalizationSucceeded.mock.calls[0]?.[1].finalizationResult.bitmapData).toEqual(
      mocks.state.restoredResult?.bitmapData,
    );
    expectLifecycleOutput('succeeded', 'RUNTIME_UPDATE_RECEIVED');
  });

  it('keeps successful finalization compatible when the restored result has no bitmap evidence', async () => {
    const { store } = createStore();
    mocks.state.store = store;
    const restoredResult = createRestoredFinalizationResult();
    delete restoredResult.bitmapData;
    delete restoredResult.bitmapProofSource;
    mocks.state.restoredResult = restoredResult;

    await expect(
      handler({
        status: 'SUCCEEDED',
        executionArn,
        payload: createStateMachinePayload(),
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'success', sessionId }));

    expectLifecycleOutput('succeeded', 'RUNTIME_UPDATE_RECEIVED');
  });

  it('keeps pending authority when the atomic successful commit fails and repairs it on callback retry', async () => {
    const { store, markAwsFinalizationSucceeded } = createStore();
    mocks.state.store = store;
    markAwsFinalizationSucceeded.mockRejectedValueOnce(new Error('atomic successful finalization commit unavailable'));
    const event = {
      status: 'SUCCEEDED',
      executionArn,
      payload: createStateMachinePayload(),
    };

    await expect(handler(event)).rejects.toThrow('atomic successful finalization commit unavailable');

    await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toMatchObject({
      state: { status: 'pending' },
    });
    expect(consoleLogSpy.mock.calls).toHaveLength(2);
    expect(consoleLogSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        event: 'finalization_update_received',
        outcome_code: 'application_failed',
        finalization_id: finalizationId,
      }),
    );
    expect(consoleLogSpy.mock.calls).not.toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            event: 'finalization_update_received',
            outcome_code: 'applied',
          }),
        ],
      ]),
    );
    consoleLogSpy.mockClear();

    await expect(handler(event)).resolves.toEqual(expect.objectContaining({ status: 'success', sessionId }));

    expect(markAwsFinalizationSucceeded).toHaveBeenCalledTimes(2);
    await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toMatchObject({
      state: { status: 'succeeded' },
    });
    expectLifecycleOutput('succeeded', 'RUNTIME_UPDATE_RECEIVED');
  });

  it('does not use the retired top-level s3BundleKey alias as current bundle identity', async () => {
    const { store, markFinalizationFailed } = createStore();
    mocks.state.store = store;
    const payload = createStateMachinePayload();
    delete payload['bundleS3Key'];
    payload['s3BundleKey'] = 'sessions/retired-alias/other-execution/bundle.zip';

    const response = await handler({
      status: 'SUCCEEDED',
      executionArn,
      payload,
    });

    expect(response.status).toBe('success');
    expect(response.state.status).toBe('failed');
    expect(response.state.finalizationId).toBe(finalizationId);
    if (response.state.status !== 'failed') {
      throw new Error('Expected missing current bundle identity to fail finalization');
    }
    expect(response.state.error.code).toBe('FINALIZATION_BUNDLE_KEY_MISSING');
    expect(mocks.buildFinalizationResultFromS3Bundle).not.toHaveBeenCalled();
    expect(markFinalizationFailed).toHaveBeenCalledTimes(1);
    const failedCall = markFinalizationFailed.mock.calls[0] as
      [sessionId: string, payload: FinalizationFailedPayload] | undefined;
    expect(failedCall?.[0]).toBe(sessionId);
    expect(failedCall?.[1].finalizationId).toBe(finalizationId);
    expect(failedCall?.[1].error.code).toBe('FINALIZATION_BUNDLE_KEY_MISSING');
    expectLifecycleOutput('failed', 'FINALIZATION_BUNDLE_KEY_MISSING');
  });

  it('normalizes RUNNING direct events and returns the applied running state', async () => {
    const { store, markFinalizationRunning } = createStore();
    const proverStartedAtIso = '2026-06-17T00:00:01.000Z';
    const payload = createStateMachinePayload();
    delete payload['startedAtMs'];
    mocks.state.store = store;

    const response = await handler({
      status: 'RUNNING',
      executionArn,
      startedAtIso: proverStartedAtIso,
      payload,
    });

    expect(response).toEqual({
      status: 'success',
      sessionId,
      state: {
        status: 'running',
        finalizationId,
        queuedAtMs,
        startedAtMs: Date.parse(proverStartedAtIso),
      },
    });
    expect(markFinalizationRunning).toHaveBeenCalledTimes(1);
    const runningPayload = markFinalizationRunning.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(runningPayload).toEqual(
      expect.objectContaining({
        finalizationId,
        queuedAtMs,
        startedAtMs: Date.parse(proverStartedAtIso),
      }),
    );
    expect(runningPayload).not.toHaveProperty('stepFunctionsArn');
    expectNoProverWorkFields(runningPayload);
    expectLifecycleOutput('running', 'RUNTIME_UPDATE_RECEIVED');
  });

  it('returns a terminal failed state when RUNNING is blocked by a cancelled session', async () => {
    const { store, markFinalizationFailed, markAwsFinalizationRunning } = createStore();
    const failedState: NonNullable<AwsFinalizationRuntimeState> = {
      status: 'failed',
      finalizationId,
      queuedAtMs,
      failedAtMs: startedAtMs,
      error: {
        code: 'USER_CANCELLED',
        message: 'User cancelled finalization',
      },
    };
    markAwsFinalizationRunning.mockResolvedValueOnce(failedState);
    await markFinalizationFailed(sessionId, {
      finalizationId,
      queuedAtMs,
      failedAtMs: startedAtMs,
      error: failedState.error,
    });
    mocks.state.store = store;

    const response = await handler({
      status: 'RUNNING',
      executionArn,
      startedAtIso: '2026-06-17T00:00:01.000Z',
      payload: createStateMachinePayload(),
    });

    expect(response).toEqual({
      status: 'success',
      sessionId,
      state: failedState,
    });
    expectLifecycleOutput('running', 'RUNTIME_UPDATE_RECEIVED');
  });

  it('projects failed Step Functions payloads with extra work fields before strict application parsing', async () => {
    const { store, markFinalizationFailed } = createStore();
    mocks.state.store = store;

    const response = await handler({
      status: 'FAILED',
      executionArn,
      failedAtIso: '2026-06-17T00:00:05.000Z',
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
    expect(response.state).not.toHaveProperty('stepFunctionsArn');

    expect(markFinalizationFailed).toHaveBeenCalledTimes(1);
    const failedPayload = markFinalizationFailed.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(failedPayload).toEqual(
      expect.objectContaining({
        finalizationId,
        queuedAtMs,
        startedAtMs,
        failedAtMs: Date.parse('2026-06-17T00:00:05.000Z'),
        error: {
          code: 'PROVER_TASK_FAILED',
          message: 'Target prover task failed',
          category: 'prover_execution',
        },
      }),
    );
    expect(failedPayload).not.toHaveProperty('stepFunctionsArn');
    expectNoProverWorkFields(failedPayload);
    expectLifecycleOutput('failed', 'PROVER_TASK_FAILED');
  });

  it('projects timed-out Step Functions payloads with extra work fields before strict application parsing', async () => {
    const { store, markFinalizationTimedOut } = createStore();
    const timeoutAtIso = '2026-06-17T00:00:10.000Z';
    mocks.state.store = store;

    const response = await handler({
      status: 'TIMED_OUT',
      executionArn,
      timeoutAtIso,
      payload: {
        ...createStateMachinePayload(),
        error: {
          Error: 'States.Timeout',
          Cause: 'private Step Functions timeout cause',
        },
      },
    });

    expect(response).toEqual(
      expect.objectContaining({
        status: 'success',
        sessionId,
      }),
    );
    expect(response.state).not.toHaveProperty('stepFunctionsArn');

    expect(markFinalizationTimedOut).toHaveBeenCalledTimes(1);
    const timedOutPayload = markFinalizationTimedOut.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(timedOutPayload).toEqual(
      expect.objectContaining({
        finalizationId,
        queuedAtMs,
        startedAtMs,
        timeoutAtMs: Date.parse(timeoutAtIso),
      }),
    );
    expect(timedOutPayload).not.toHaveProperty('stepFunctionsArn');
    expect(timedOutPayload).not.toHaveProperty('error');
    expectNoProverWorkFields(timedOutPayload);
    expectLifecycleOutput('timeout', 'RUNTIME_UPDATE_RECEIVED');
  });
});
