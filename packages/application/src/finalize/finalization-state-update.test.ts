import { describe, expect, it, vi } from 'vitest';
import {
  applyFinalizationStateUpdatePayload,
  type FinalizationStateUpdatePayload,
} from '@stark-ballot/application/finalize/finalization-state-update';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';

function buildStore(state: FinalizationState): {
  store: FinalizationLifecycleStore & Pick<VoteStore, 'getSession'>;
  markFinalizationRunning: ReturnType<typeof vi.fn>;
  markFinalizationSucceeded: ReturnType<typeof vi.fn>;
  markFinalizationFailed: ReturnType<typeof vi.fn>;
  markFinalizationTimedOut: ReturnType<typeof vi.fn>;
} {
  const markFinalizationRunning = vi.fn(() => Promise.resolve(state));
  const markFinalizationSucceeded = vi.fn(() => Promise.resolve(state));
  const markFinalizationFailed = vi.fn(() => Promise.resolve(state));
  const markFinalizationTimedOut = vi.fn(() => Promise.resolve(state));

  return {
    store: {
      getSession: vi.fn(() => Promise.resolve(null)),
      finalizeSession: vi.fn(() => Promise.resolve(undefined)),
      markFinalizationQueued: vi.fn(() => Promise.resolve(state)),
      markFinalizationRunning,
      markFinalizationSucceeded,
      markFinalizationFailed,
      markFinalizationTimedOut,
    },
    markFinalizationRunning,
    markFinalizationSucceeded,
    markFinalizationFailed,
    markFinalizationTimedOut,
  };
}

function buildRunningPayload(overrides: Partial<Record<keyof FinalizationStateUpdatePayload, unknown>> = {}) {
  return {
    sessionId: 'session-running-update',
    executionId: 'exec-running-update',
    contractGeneration: '2026-04-zkvm-current-v1',
    status: 'RUNNING',
    queuedAt: 1_700_000_000_000,
    startedAt: 1_700_000_001_000,
    ...overrides,
  } as unknown as FinalizationStateUpdatePayload;
}

describe('applyFinalizationStateUpdatePayload', () => {
  it('applies RUNNING updates through the lifecycle store and returns the applied state', async () => {
    const state: FinalizationState = {
      status: 'running',
      executionId: 'exec-running-update',
      queuedAt: 1_700_000_000_000,
      startedAt: 1_700_000_001_000,
    };
    const {
      store,
      markFinalizationRunning,
      markFinalizationSucceeded,
      markFinalizationFailed,
      markFinalizationTimedOut,
    } = buildStore(state);

    await expect(
      applyFinalizationStateUpdatePayload({
        payload: buildRunningPayload(),
        store,
      }),
    ).resolves.toEqual({
      sessionId: 'session-running-update',
      state,
    });

    expect(markFinalizationRunning).toHaveBeenCalledWith('session-running-update', {
      executionId: 'exec-running-update',
      contractGeneration: '2026-04-zkvm-current-v1',
      queuedAt: 1_700_000_000_000,
      startedAt: 1_700_000_001_000,
    });
    expect(markFinalizationSucceeded).not.toHaveBeenCalled();
    expect(markFinalizationFailed).not.toHaveBeenCalled();
    expect(markFinalizationTimedOut).not.toHaveBeenCalled();
  });

  it('returns an existing terminal failed state unchanged when RUNNING is blocked by the store guard', async () => {
    const failedState: FinalizationState = {
      status: 'failed',
      executionId: 'exec-running-update',
      queuedAt: 1_700_000_000_000,
      failedAt: 1_700_000_002_000,
      error: {
        code: 'USER_CANCELLED',
        message: 'User cancelled finalization',
      },
    };
    const { store, markFinalizationRunning } = buildStore(failedState);

    await expect(
      applyFinalizationStateUpdatePayload({
        payload: buildRunningPayload(),
        store,
      }),
    ).resolves.toEqual({
      sessionId: 'session-running-update',
      state: failedState,
    });

    expect(markFinalizationRunning).toHaveBeenCalledTimes(1);
  });
});
