import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyFinalizationStateUpdatePayload,
  type FinalizationStateUpdatePayload,
} from '@stark-ballot/application/finalize/finalization-state-update';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { buildCloseStatement } from '@stark-ballot/verification/public-audit-artifacts';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stark-ballot/diagnostics/canonicalEvents')>()),
  emitCanonicalEvent: emitCanonicalEventMock,
}));

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
  beforeEach(() => {
    emitCanonicalEventMock.mockClear();
  });

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
      observability: {
        source: 'writer_update',
        reason: 'RUNTIME_UPDATE_RECEIVED',
      },
    });
    expect(markFinalizationSucceeded).not.toHaveBeenCalled();
    expect(markFinalizationFailed).not.toHaveBeenCalled();
    expect(markFinalizationTimedOut).not.toHaveBeenCalled();
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'running',
      source: 'writer_update',
      reason: 'RUNTIME_UPDATE_RECEIVED',
      session_id_hash: hashSessionIdForLogging('session-running-update'),
      execution_id: 'exec-running-update',
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('session-running-update');
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

  it('categorizes an invalid finalization result before calling the failure store path', async () => {
    const state: FinalizationState = {
      status: 'failed',
      executionId: 'exec-invalid-result',
      queuedAt: 1_700_000_000_000,
      failedAt: 1_700_000_002_000,
      error: {
        code: 'FINALIZATION_RESULT_INVALID',
        message: 'Canonical finalization result is missing proof-bound journal data',
        category: 'artifact',
      },
    };
    const { store, markFinalizationSucceeded, markFinalizationFailed } = buildStore(state);

    await expect(
      applyFinalizationStateUpdatePayload({
        payload: {
          sessionId: 'session-invalid-result',
          executionId: 'exec-invalid-result',
          contractGeneration: '2026-04-zkvm-current-v1',
          status: 'SUCCEEDED',
          queuedAt: 1_700_000_000_000,
          startedAt: 1_700_000_001_000,
        },
        store,
      }),
    ).resolves.toEqual({
      sessionId: 'session-invalid-result',
      state,
    });

    expect(markFinalizationSucceeded).not.toHaveBeenCalled();
    expect(markFinalizationFailed).toHaveBeenCalledWith(
      'session-invalid-result',
      expect.objectContaining({
        error: {
          code: 'FINALIZATION_RESULT_INVALID',
          message: 'Canonical finalization result is missing proof-bound journal data',
          category: 'artifact',
        },
        observability: {
          source: 'writer_update',
          reason: 'FINALIZATION_RESULT_INVALID',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'writer_update',
      reason: 'FINALIZATION_RESULT_INVALID',
      session_id_hash: hashSessionIdForLogging('session-invalid-result'),
      execution_id: 'exec-invalid-result',
    });
  });

  it('uses the closed generic failure tuple when a failed update omits an error', async () => {
    const state: FinalizationState = {
      status: 'failed',
      executionId: 'exec-fallback-failure',
      queuedAt: 1_700_000_000_000,
      failedAt: 1_700_000_002_000,
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'Finalization failed',
        category: 'unknown',
      },
    };
    const { store, markFinalizationFailed } = buildStore(state);

    await expect(
      applyFinalizationStateUpdatePayload({
        payload: {
          sessionId: 'session-fallback-failure',
          executionId: 'exec-fallback-failure',
          contractGeneration: '2026-04-zkvm-current-v1',
          status: 'FAILED',
          queuedAt: 1_700_000_000_000,
        },
        store,
      }),
    ).resolves.toEqual({
      sessionId: 'session-fallback-failure',
      state,
    });

    expect(markFinalizationFailed).toHaveBeenCalledWith(
      'session-fallback-failure',
      expect.objectContaining({
        error: {
          code: 'FINALIZATION_FAILED',
          message: 'Finalization failed',
          category: 'unknown',
        },
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'writer_update',
      reason: 'RUNTIME_UPDATE_RECEIVED',
      session_id_hash: hashSessionIdForLogging('session-fallback-failure'),
      execution_id: 'exec-fallback-failure',
    });
  });

  it('preserves a closed incoming failure code as the writer/update reason', async () => {
    const state: FinalizationState = {
      status: 'failed',
      executionId: 'exec-prover-failure',
      queuedAt: 1_700_000_000_000,
      failedAt: 1_700_000_002_000,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Finalization failed',
        category: 'prover_execution',
      },
    };
    const { store, markFinalizationFailed } = buildStore(state);

    await applyFinalizationStateUpdatePayload({
      payload: {
        sessionId: 'session-prover-failure',
        executionId: 'exec-prover-failure',
        contractGeneration: '2026-04-zkvm-current-v1',
        status: 'FAILED',
        queuedAt: 1_700_000_000_000,
        failedAt: 1_700_000_002_000,
        error: state.error,
      },
      store,
    });

    expect(markFinalizationFailed).toHaveBeenCalledWith(
      'session-prover-failure',
      expect.objectContaining({
        observability: {
          source: 'writer_update',
          reason: 'PROVER_TASK_FAILED',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'writer_update',
      reason: 'PROVER_TASK_FAILED',
      session_id_hash: hashSessionIdForLogging('session-prover-failure'),
      execution_id: 'exec-prover-failure',
    });
  });

  it('records a successful writer/update transition attempt before calling the store', async () => {
    const state: FinalizationState = {
      status: 'succeeded',
      executionId: 'exec-success-update',
      queuedAt: 1_700_000_000_000,
      startedAt: 1_700_000_001_000,
      completedAt: 1_700_000_002_000,
    };
    const { store, markFinalizationSucceeded } = buildStore(state);
    const baseJournal = createTestJournal();
    const publicInputArtifact = createTestPublicInputArtifact({
      source: 'generated',
      typedAuthority: {
        electionId: baseJournal.electionId,
        electionConfigHash: baseJournal.electionConfigHash,
        votesCount: baseJournal.validVotes,
        treeSize: baseJournal.treeSize,
        totalExpected: baseJournal.totalExpected,
        bulletinRoot: baseJournal.bulletinRoot,
        logId: `0x${'2'.repeat(64)}`,
        timestamp: 1_700_000_002_000,
        methodVersion: baseJournal.methodVersion,
        recomputedInputCommitment: baseJournal.inputCommitment,
      },
    });
    const closeStatement = buildCloseStatement({
      logId: publicInputArtifact.typedAuthority.logId,
      treeSize: baseJournal.treeSize,
      timestamp: publicInputArtifact.typedAuthority.timestamp,
      bulletinRoot: baseJournal.bulletinRoot,
    });
    const journal = {
      ...baseJournal,
      sthDigest: closeStatement.sthDigest,
    };
    const finalizationResult = {
      ...buildFinalizationResultFromJournal({
        journal,
        imageId: `0x${'1'.repeat(64)}`,
        closeStatement,
      }),
      publicInputArtifact,
    };

    await applyFinalizationStateUpdatePayload({
      payload: {
        sessionId: 'session-success-update',
        executionId: 'exec-success-update',
        contractGeneration: '2026-04-zkvm-current-v1',
        status: 'SUCCEEDED',
        queuedAt: 1_700_000_000_000,
        startedAt: 1_700_000_001_000,
        completedAt: 1_700_000_002_000,
        finalizationResult,
      },
      store,
    });

    expect(markFinalizationSucceeded).toHaveBeenCalledTimes(1);
    expect(markFinalizationSucceeded).toHaveBeenCalledWith(
      'session-success-update',
      expect.objectContaining({
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'succeeded',
      source: 'writer_update',
      reason: 'RUNTIME_UPDATE_RECEIVED',
      session_id_hash: hashSessionIdForLogging('session-success-update'),
      execution_id: 'exec-success-update',
    });
  });

  it('records a timed-out writer/update transition attempt before calling the store', async () => {
    const state: FinalizationState = {
      status: 'timeout',
      executionId: 'exec-timeout-update',
      queuedAt: 1_700_000_000_000,
      startedAt: 1_700_000_001_000,
      timeoutAt: 1_700_000_002_000,
    };
    const { store, markFinalizationTimedOut } = buildStore(state);

    await applyFinalizationStateUpdatePayload({
      payload: {
        sessionId: 'session-timeout-update',
        executionId: 'exec-timeout-update',
        contractGeneration: '2026-04-zkvm-current-v1',
        status: 'TIMED_OUT',
        queuedAt: 1_700_000_000_000,
        startedAt: 1_700_000_001_000,
        timeoutAt: 1_700_000_002_000,
      },
      store,
    });

    expect(markFinalizationTimedOut).toHaveBeenCalledTimes(1);
    expect(markFinalizationTimedOut).toHaveBeenCalledWith(
      'session-timeout-update',
      expect.objectContaining({
        observability: {
          source: 'writer_update',
          reason: 'RUNTIME_UPDATE_RECEIVED',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'timeout',
      source: 'writer_update',
      reason: 'RUNTIME_UPDATE_RECEIVED',
      session_id_hash: hashSessionIdForLogging('session-timeout-update'),
      execution_id: 'exec-timeout-update',
    });
  });
});
