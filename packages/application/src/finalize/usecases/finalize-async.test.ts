import { describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@stark-ballot/domain/types/server';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import type { FinalizationQueue } from '@stark-ballot/application/finalize/finalization-queue';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import { finalizeAsync } from '@stark-ballot/application/finalize/usecases/finalize-async';
import { createMockVoteStore, type MockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

type MarkQueuedPayload = Parameters<MockVoteStore['markFinalizationQueued']>[1];

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CONTRACT_GENERATION = resolveCurrentContractGeneration();
const QUEUED_AT = 1_730_000_000_000;

function createSession(): SessionData {
  return {
    sessionId: SESSION_ID,
    contractGeneration: CONTRACT_GENERATION,
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: getDefaultElectionConfigHash(),
    electionConfig: buildDefaultElectionConfig(),
    votes: new Map(),
    botCount: 0,
    finalized: false,
    createdAt: QUEUED_AT,
    lastActivity: QUEUED_AT,
  };
}

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

function createFailedState(executionId: string): FinalizationState {
  return {
    status: 'failed',
    executionId,
    queuedAt: QUEUED_AT,
    failedAt: QUEUED_AT + 1_000,
    error: {
      code: 'UNSUPPORTED_CURRENT_ARTIFACT',
      message: 'Current finalization artifact is unsupported',
    },
  };
}

function createHarness(markQueued: (payload: MarkQueuedPayload) => FinalizationState | Promise<FinalizationState>) {
  const markFinalizationQueued = vi.fn((_sessionId: string, payload: MarkQueuedPayload) =>
    Promise.resolve(markQueued(payload)),
  );
  const store = createMockVoteStore({
    getSession: (sessionId) => Promise.resolve(sessionId === SESSION_ID ? createSession() : null),
    markFinalizationQueued,
  });
  const finalizationQueue: FinalizationQueue = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const persistAsyncProverInput = vi.fn().mockResolvedValue(undefined);

  return {
    store,
    markFinalizationQueued,
    finalizationQueue,
    persistAsyncProverInput,
  };
}

const existingAttemptStates: Array<[string, FinalizationState]> = [
  [
    'pending',
    {
      status: 'pending',
      executionId: 'exec-existing-pending',
      queuedAt: QUEUED_AT - 5_000,
    },
  ],
  [
    'running',
    {
      status: 'running',
      executionId: 'exec-existing-running',
      queuedAt: QUEUED_AT - 5_000,
      startedAt: QUEUED_AT - 4_000,
    },
  ],
];

async function runFinalizeAsync({
  state,
}: {
  state: FinalizationState | ((payload: MarkQueuedPayload) => FinalizationState);
}) {
  const harness = createHarness((payload) => (typeof state === 'function' ? state(payload) : state));

  const result = await finalizeAsync(
    {
      sessionId: SESSION_ID,
      session: createSession(),
      contractGeneration: CONTRACT_GENERATION,
      zkvmInput: createZkvmInput(),
      electionConfig: buildDefaultElectionConfig(),
      expectedImageId: '0x' + '3'.repeat(64),
      scenarios: ['S0'],
      queueUrl: 'https://queue.example.com',
      publishMaxAttempts: 2,
      targetAwsRuntime: true,
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
      expect(result.value.payload.executionId).toBe(existingState.executionId);
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
    expect(result.value.payload.executionId).toBe(existingState.executionId);
    expect(result.value.payload.state).toEqual(existingState);
    expect(result.value.state).toEqual(existingState);
    expect(persistAsyncProverInput).not.toHaveBeenCalled();
    expect(finalizationQueue.publish).not.toHaveBeenCalled();
  });

  it('short-circuits without upload or publish when queueing fail-closes the newly generated execution', async () => {
    const { result, queuedPayload, persistAsyncProverInput, finalizationQueue } = await runFinalizeAsync({
      state: (payload) => createFailedState(payload.executionId),
    });
    const failedState = createFailedState(queuedPayload.executionId);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected finalizeAsync to return the fail-closed queued state');
    }
    expect(result.value.payload.executionId).toBe(queuedPayload.executionId);
    expect(result.value.payload.state).toEqual(failedState);
    expect(result.value.state).toEqual(failedState);
    expect(persistAsyncProverInput).not.toHaveBeenCalled();
    expect(finalizationQueue.publish).not.toHaveBeenCalled();
  });

  it('continues to upload and publish when queueing returns pending for the newly generated execution', async () => {
    const { result, queuedPayload, persistAsyncProverInput, finalizationQueue } = await runFinalizeAsync({
      state: (payload) => ({
        status: 'pending',
        executionId: payload.executionId,
        queuedAt: payload.queuedAt,
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected finalizeAsync to accept the new attempt');
    }
    expect(result.value.payload.executionId).toBe(queuedPayload.executionId);
    expect(result.value.payload.state).toEqual({
      status: 'pending',
      executionId: queuedPayload.executionId,
      queuedAt: queuedPayload.queuedAt,
    });
    expect(result.value.state).toEqual(result.value.payload.state);
    expect(persistAsyncProverInput).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        executionId: queuedPayload.executionId,
        contractGeneration: CONTRACT_GENERATION,
        zkvmInput: createZkvmInput(),
        electionConfig: buildDefaultElectionConfig(),
      }),
    );
    expect(finalizationQueue.publish).toHaveBeenCalledTimes(1);
    expect(finalizationQueue.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        executionId: queuedPayload.executionId,
        contractGeneration: CONTRACT_GENERATION,
      }),
      2,
    );
  });
});
