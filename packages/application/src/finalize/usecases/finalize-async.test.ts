import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { FinalizationQueue } from '@stark-ballot/application/finalize/finalization-queue';
import type { FinalizationFailedPayload } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import {
  finalizeAsync,
  type FinalizeAsyncDependencies,
} from '@stark-ballot/application/finalize/usecases/finalize-async';
import { createMockVoteStore } from '../__tests__/support/mockVoteStore';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { logger } from '@stark-ballot/diagnostics/logger';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: emitCanonicalEventMock,
}));

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

type MarkQueuedPayload = Parameters<FinalizeAsyncDependencies['store']['markFinalizationQueued']>[1];

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const QUEUED_AT = 1_730_000_000_000;
const FINALIZATION_ID = '01JCGXZ8M00000000000000000';
const SCENARIO_CONTEXT = {
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

function createZkvmInput(): ZkVMInput {
  return {
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: getDefaultElectionConfigHash(),
    bulletinRoot: '0x' + '1'.repeat(64),
    treeSize: 0,
    logId: '0x' + '2'.repeat(64),
    timestamp: QUEUED_AT,
    totalExpected: 0,
    votes: [],
  };
}

function createFailedState(finalizationId: string): FinalizationState {
  return {
    status: 'failed',
    finalizationId,
    queuedAtMs: QUEUED_AT,
    failedAtMs: QUEUED_AT + 1_000,
    error: {
      code: 'INVALID_FINALIZATION_ARTIFACT',
      message: 'Finalization artifact is invalid',
    },
  };
}

function createHarness(markQueued: (payload: MarkQueuedPayload) => FinalizationState | Promise<FinalizationState>) {
  const markFinalizationQueued = vi.fn(async (sessionId: string, payload: MarkQueuedPayload) => {
    const state = await markQueued(payload);
    if (state.status === 'succeeded') {
      throw new Error('This test harness does not create succeeded records');
    }
    return {
      sessionId,
      finalizationId: state.finalizationId,
      scenarioContext: payload.scenarioContext,
      state,
    };
  });
  const markFinalizationFailed = vi.fn((sessionId: string, payload: FinalizationFailedPayload) => {
    const state = createFailedState(payload.finalizationId);
    return Promise.resolve({
      sessionId,
      finalizationId: state.finalizationId,
      scenarioContext: SCENARIO_CONTEXT,
      state,
    });
  });
  const store = Object.assign(createMockVoteStore(), {
    markFinalizationQueued,
    markFinalizationFailed,
  }) as unknown as FinalizeAsyncDependencies['store'];
  const finalizationQueue: FinalizationQueue = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const persistAsyncProverInput = vi.fn().mockResolvedValue(undefined);

  return {
    store,
    markFinalizationQueued,
    finalizationQueue,
    persistAsyncProverInput,
    markFinalizationFailed,
  };
}

const existingAttemptStates: Array<[string, FinalizationState]> = [
  [
    'pending',
    {
      status: 'pending',
      finalizationId: 'exec-existing-pending',
      queuedAtMs: QUEUED_AT - 5_000,
    },
  ],
  [
    'running',
    {
      status: 'running',
      finalizationId: 'exec-existing-running',
      queuedAtMs: QUEUED_AT - 5_000,
      startedAtMs: QUEUED_AT - 4_000,
    },
  ],
];

async function runFinalizeAsync({
  state,
  persistError,
  publishError,
}: {
  state: FinalizationState | ((payload: MarkQueuedPayload) => FinalizationState);
  persistError?: Error;
  publishError?: Error;
}) {
  const harness = createHarness((payload) => (typeof state === 'function' ? state(payload) : state));
  if (persistError) {
    harness.persistAsyncProverInput.mockRejectedValueOnce(persistError);
  }
  if (publishError) {
    vi.mocked(harness.finalizationQueue.publish).mockRejectedValueOnce(publishError);
  }

  const result = await finalizeAsync(
    {
      sessionId: SESSION_ID,
      finalizationId: FINALIZATION_ID,
      queuedAtMs: QUEUED_AT,
      zkvmInput: createZkvmInput(),
      electionConfig: buildDefaultElectionConfig(),
      expectedImageId: '0x' + '3'.repeat(64),
      scenarios: ['S0'],
      scenarioContext: SCENARIO_CONTEXT,
      publishMaxAttempts: 2,
      inputSource: 's3',
    },
    {
      store: harness.store,
      finalizationQueue: harness.finalizationQueue,
      now: () => QUEUED_AT,
      persistAsyncProverInput: harness.persistAsyncProverInput,
    },
  );

  const queuedPayload = strictDefined(harness.markFinalizationQueued.mock.calls[0]?.[1], 'queued payload');
  return {
    result,
    queuedPayload,
    ...harness,
  };
}

describe('finalizeAsync duplicate and fail-closed queue handling', () => {
  beforeEach(() => {
    emitCanonicalEventMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(existingAttemptStates)(
    'short-circuits without upload or publish when an existing %s attempt wins markFinalizationQueued',
    async (_status, existingState) => {
      const { result, persistAsyncProverInput, finalizationQueue } = await runFinalizeAsync({
        state: existingState,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('Expected finalizeAsync to accept the existing attempt');
      }
      expect(result.value.payload.finalizationId).toBe(existingState.finalizationId);
      expect(result.value.payload.state).toEqual(existingState);
      expect(result.value.state).toEqual(existingState);
      expect(persistAsyncProverInput).not.toHaveBeenCalled();
      expect(finalizationQueue.publish).not.toHaveBeenCalled();
    },
  );

  it('short-circuits without upload or publish when a stale terminal attempt is returned', async () => {
    const existingState = createFailedState('exec-stale-terminal');

    const { result, persistAsyncProverInput, finalizationQueue } = await runFinalizeAsync({
      state: existingState,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected finalizeAsync to accept the existing terminal attempt');
    }
    expect(result.value.payload.finalizationId).toBe(existingState.finalizationId);
    expect(result.value.payload.state).toEqual(existingState);
    expect(result.value.state).toEqual(existingState);
    expect(persistAsyncProverInput).not.toHaveBeenCalled();
    expect(finalizationQueue.publish).not.toHaveBeenCalled();
  });

  it('short-circuits without upload or publish when queueing fail-closes the newly generated finalization', async () => {
    const { result, queuedPayload, persistAsyncProverInput, finalizationQueue } = await runFinalizeAsync({
      state: (payload) => createFailedState(payload.finalizationId),
    });
    const failedState = createFailedState(queuedPayload.finalizationId);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected finalizeAsync to return the fail-closed queued state');
    }
    expect(result.value.payload.finalizationId).toBe(queuedPayload.finalizationId);
    expect(result.value.payload.state).toEqual(failedState);
    expect(result.value.state).toEqual(failedState);
    expect(persistAsyncProverInput).not.toHaveBeenCalled();
    expect(finalizationQueue.publish).not.toHaveBeenCalled();
  });

  it('continues to upload and publish when queueing returns pending for the newly generated finalization', async () => {
    const { result, queuedPayload, persistAsyncProverInput, finalizationQueue, markFinalizationQueued } =
      await runFinalizeAsync({
        state: (payload) => ({
          status: 'pending',
          finalizationId: payload.finalizationId,
          queuedAtMs: payload.queuedAtMs,
        }),
      });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected finalizeAsync to accept the new attempt');
    }
    expect(result.value.payload.finalizationId).toBe(queuedPayload.finalizationId);
    expect(result.value.payload.state).toEqual({
      status: 'pending',
      finalizationId: queuedPayload.finalizationId,
      queuedAtMs: queuedPayload.queuedAtMs,
    });
    expect(result.value.state).toEqual(result.value.payload.state);
    expect(markFinalizationQueued).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        observability: {
          source: 'finalize',
          reason: 'FINALIZE_REQUESTED',
        },
      }),
    );
    expect(persistAsyncProverInput).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        finalizationId: queuedPayload.finalizationId,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
      }),
    );
    expect(persistAsyncProverInput.mock.calls[0]?.[0]).not.toHaveProperty('contractGeneration');
    expect(finalizationQueue.publish).toHaveBeenCalledTimes(1);
    expect(finalizationQueue.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        finalizationId: queuedPayload.finalizationId,
        inputSource: 's3',
      }),
      2,
    );
    expect(vi.mocked(finalizationQueue.publish).mock.calls[0]?.[0]).not.toHaveProperty('contractGeneration');
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'pending',
      source: 'finalize',
      reason: 'FINALIZE_REQUESTED',
      session_id_hash: hashSessionIdForLogging(SESSION_ID),
      finalization_id: queuedPayload.finalizationId,
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(SESSION_ID);
  });

  it('records the fail-closed transition attempt when target input persistence fails', async () => {
    const privateError = new Error('upload failed for s3://private-bucket/sessions/raw-session/input.json');
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { result, queuedPayload, finalizationQueue, markFinalizationFailed } = await runFinalizeAsync({
      state: (payload) => ({
        status: 'pending',
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
      }),
      persistError: privateError,
    });

    expect(result.ok).toBe(false);
    expect(finalizationQueue.publish).not.toHaveBeenCalled();
    expect(markFinalizationFailed).toHaveBeenCalledTimes(1);
    expect(markFinalizationFailed).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        error: {
          code: 'PROVER_INPUT_UPLOAD_FAILED',
          message: 'Failed to persist target async prover input',
        },
        observability: {
          source: 'finalize',
          reason: 'PROVER_INPUT_UPLOAD_FAILED',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'finalize',
      reason: 'PROVER_INPUT_UPLOAD_FAILED',
      session_id_hash: hashSessionIdForLogging(SESSION_ID),
      finalization_id: queuedPayload.finalizationId,
    });
    expect(errorLog.mock.calls).toEqual([['[API] Failed to persist target async prover input']]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateError.message);
    expect(JSON.stringify(markFinalizationFailed.mock.calls)).not.toContain(privateError.message);
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(privateError.message);
  });

  it('fails the persisted attempt with a closed reason when target input persistence is unavailable', async () => {
    const harness = createHarness((payload) => ({
      status: 'pending',
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
    }));

    const result = await finalizeAsync(
      {
        sessionId: SESSION_ID,
        finalizationId: FINALIZATION_ID,
        queuedAtMs: QUEUED_AT,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
        expectedImageId: '0x' + '3'.repeat(64),
        scenarios: ['S0'],
        scenarioContext: SCENARIO_CONTEXT,
        publishMaxAttempts: 2,
        inputSource: 's3',
      },
      {
        store: harness.store,
        finalizationQueue: harness.finalizationQueue,
        now: () => QUEUED_AT,
      },
    );

    const queuedPayload = strictDefined(harness.markFinalizationQueued.mock.calls[0]?.[1], 'queued payload');
    const failedCall = strictDefined(harness.markFinalizationFailed.mock.calls[0], 'failed call');
    expect(result.ok).toBe(false);
    expect(harness.finalizationQueue.publish).not.toHaveBeenCalled();
    expect(failedCall[0]).toBe(SESSION_ID);
    expect(failedCall[1]).toMatchObject({
      finalizationId: queuedPayload.finalizationId,
      error: { code: 'PROVER_INPUT_PERSISTENCE_UNAVAILABLE' },
      observability: {
        source: 'finalize',
        reason: 'PROVER_INPUT_PERSISTENCE_UNAVAILABLE',
      },
    });
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'finalize',
      reason: 'PROVER_INPUT_PERSISTENCE_UNAVAILABLE',
      session_id_hash: hashSessionIdForLogging(SESSION_ID),
      finalization_id: queuedPayload.finalizationId,
    });
  });

  it('records the fail-closed transition attempt when queue publication fails', async () => {
    const privateError = new Error('publish failed with token secret-private-value');
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { result, queuedPayload, markFinalizationFailed } = await runFinalizeAsync({
      state: (payload) => ({
        status: 'pending',
        finalizationId: payload.finalizationId,
        queuedAtMs: payload.queuedAtMs,
      }),
      publishError: privateError,
    });

    expect(result.ok).toBe(false);
    expect(markFinalizationFailed).toHaveBeenCalledTimes(1);
    expect(markFinalizationFailed).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        error: {
          code: 'SQS_PUBLISH_FAILED',
          message: 'Failed to enqueue finalization job',
        },
        observability: {
          source: 'finalize',
          reason: 'SQS_PUBLISH_FAILED',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'finalize',
      reason: 'SQS_PUBLISH_FAILED',
      session_id_hash: hashSessionIdForLogging(SESSION_ID),
      finalization_id: queuedPayload.finalizationId,
    });
    expect(errorLog.mock.calls).toEqual([['[API] Failed to publish finalize job']]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateError.message);
    expect(JSON.stringify(markFinalizationFailed.mock.calls)).not.toContain(privateError.message);
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(privateError.message);
  });
});
