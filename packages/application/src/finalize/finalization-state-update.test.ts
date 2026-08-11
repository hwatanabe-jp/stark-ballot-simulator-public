import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyFinalizationStateUpdatePayload,
  type FinalizationStateUpdatePayload,
} from '@stark-ballot/application/finalize/finalization-state-update';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import type {
  FinalizationResultAuthority,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
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
  store: Pick<
    FinalizationLifecycleStore,
    | 'getFinalizationRecord'
    | 'markFinalizationRunning'
    | 'markFinalizationSucceeded'
    | 'markFinalizationFailed'
    | 'markFinalizationTimedOut'
  >;
  markFinalizationRunning: ReturnType<typeof vi.fn>;
  markFinalizationSucceeded: ReturnType<typeof vi.fn>;
  markFinalizationFailed: ReturnType<typeof vi.fn>;
  markFinalizationTimedOut: ReturnType<typeof vi.fn>;
  getFinalizationRecord: ReturnType<typeof vi.fn>;
} {
  const scenarioContext = {
    scenarios: [],
    tamperMode: 'none' as const,
    claimedCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    claimedTotalVotes: 0,
    summary: {
      ignoredCount: 0,
      recountedCount: 0,
      userRecountChoice: null,
    },
  };
  const buildRecord = (
    sessionId: string,
    nextState: FinalizationState,
    finalizationResult?: FinalizationResultAuthority,
  ): FinalizationRecord => {
    if (nextState.status !== 'succeeded') {
      return {
        sessionId,
        finalizationId: nextState.finalizationId,
        scenarioContext,
        state: nextState,
      };
    }
    if (!finalizationResult) {
      throw new Error('Succeeded test record requires a finalization result');
    }
    return {
      sessionId,
      finalizationId: nextState.finalizationId,
      scenarioContext,
      state: nextState,
      finalizationResult: {
        finalizationId: nextState.finalizationId,
        ...finalizationResult,
      },
    };
  };
  const markFinalizationRunning = vi.fn<FinalizationLifecycleStore['markFinalizationRunning']>((sessionId) =>
    Promise.resolve(buildRecord(sessionId, state)),
  );
  const markFinalizationSucceeded = vi.fn<FinalizationLifecycleStore['markFinalizationSucceeded']>(
    (sessionId, payload) => Promise.resolve(buildRecord(sessionId, state, payload.finalizationResult)),
  );
  const markFinalizationFailed = vi.fn<FinalizationLifecycleStore['markFinalizationFailed']>((sessionId) =>
    Promise.resolve(buildRecord(sessionId, state)),
  );
  const markFinalizationTimedOut = vi.fn<FinalizationLifecycleStore['markFinalizationTimedOut']>((sessionId) =>
    Promise.resolve(buildRecord(sessionId, state)),
  );
  const getFinalizationRecord = vi.fn<FinalizationLifecycleStore['getFinalizationRecord']>(
    (sessionId, finalizationId) =>
      Promise.resolve({
        sessionId,
        finalizationId,
        scenarioContext,
        state: {
          status: 'pending' as const,
          finalizationId,
          queuedAtMs: 1_700_000_000_000,
        },
      }),
  );

  return {
    store: {
      getFinalizationRecord,
      markFinalizationRunning,
      markFinalizationSucceeded,
      markFinalizationFailed,
      markFinalizationTimedOut,
    },
    markFinalizationRunning,
    markFinalizationSucceeded,
    markFinalizationFailed,
    markFinalizationTimedOut,
    getFinalizationRecord,
  };
}

function buildRunningPayload(overrides: Partial<Record<keyof FinalizationStateUpdatePayload, unknown>> = {}) {
  return {
    sessionId: 'session-running-update',
    finalizationId: 'exec-running-update',
    status: 'RUNNING',
    queuedAtMs: 1_700_000_000_000,
    startedAtMs: 1_700_000_001_000,
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
      finalizationId: 'exec-running-update',
      queuedAtMs: 1_700_000_000_000,
      startedAtMs: 1_700_000_001_000,
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
      finalizationId: 'exec-running-update',
      queuedAtMs: 1_700_000_000_000,
      startedAtMs: 1_700_000_001_000,
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
      finalization_id: 'exec-running-update',
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('session-running-update');
  });

  it('returns an existing terminal failed state unchanged when RUNNING is blocked by the store guard', async () => {
    const failedState: FinalizationState = {
      status: 'failed',
      finalizationId: 'exec-running-update',
      queuedAtMs: 1_700_000_000_000,
      failedAtMs: 1_700_000_002_000,
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
      finalizationId: 'exec-invalid-result',
      queuedAtMs: 1_700_000_000_000,
      failedAtMs: 1_700_000_002_000,
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
          finalizationId: 'exec-invalid-result',
          status: 'SUCCEEDED',
          queuedAtMs: 1_700_000_000_000,
          startedAtMs: 1_700_000_001_000,
          completedAtMs: 1_700_000_002_000,
          finalizationResult: {} as FinalizationResultAuthority,
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
      finalization_id: 'exec-invalid-result',
    });
  });

  it('rejects a success update when its exact finalization record is unavailable', async () => {
    const state: FinalizationState = {
      status: 'succeeded',
      finalizationId: 'exec-missing-record',
      queuedAtMs: 1_700_000_000_000,
      startedAtMs: 1_700_000_001_000,
      completedAtMs: 1_700_000_002_000,
    };
    const { store, getFinalizationRecord, markFinalizationSucceeded, markFinalizationFailed } = buildStore(state);
    getFinalizationRecord.mockResolvedValueOnce(null);

    await expect(
      applyFinalizationStateUpdatePayload({
        payload: {
          sessionId: 'session-missing-record',
          finalizationId: 'exec-missing-record',
          status: 'SUCCEEDED',
          queuedAtMs: 1_700_000_000_000,
          startedAtMs: 1_700_000_001_000,
          completedAtMs: 1_700_000_002_000,
          finalizationResult: {} as FinalizationResultAuthority,
        },
        store,
      }),
    ).rejects.toThrow('Finalization record unavailable');

    expect(markFinalizationSucceeded).not.toHaveBeenCalled();
    expect(markFinalizationFailed).not.toHaveBeenCalled();
  });

  it('applies an explicitly admitted closed generic failure tuple', async () => {
    const state: FinalizationState = {
      status: 'failed',
      finalizationId: 'exec-generic-failure',
      queuedAtMs: 1_700_000_000_000,
      failedAtMs: 1_700_000_002_000,
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
          sessionId: 'session-generic-failure',
          finalizationId: 'exec-generic-failure',
          status: 'FAILED',
          queuedAtMs: 1_700_000_000_000,
          failedAtMs: 1_700_000_002_000,
          error: state.error,
        },
        store,
      }),
    ).resolves.toEqual({
      sessionId: 'session-generic-failure',
      state,
    });

    expect(markFinalizationFailed).toHaveBeenCalledWith(
      'session-generic-failure',
      expect.objectContaining({
        error: {
          code: 'FINALIZATION_FAILED',
          message: 'Finalization failed',
          category: 'unknown',
        },
        observability: {
          source: 'writer_update',
          reason: 'FINALIZATION_FAILED',
        },
      }),
    );
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'writer_update',
      reason: 'FINALIZATION_FAILED',
      session_id_hash: hashSessionIdForLogging('session-generic-failure'),
      finalization_id: 'exec-generic-failure',
    });
  });

  it('preserves a closed incoming failure code as the writer/update reason', async () => {
    const state: FinalizationState = {
      status: 'failed',
      finalizationId: 'exec-prover-failure',
      queuedAtMs: 1_700_000_000_000,
      failedAtMs: 1_700_000_002_000,
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
        finalizationId: 'exec-prover-failure',
        status: 'FAILED',
        queuedAtMs: 1_700_000_000_000,
        failedAtMs: 1_700_000_002_000,
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
      finalization_id: 'exec-prover-failure',
    });
  });

  it('records a successful writer/update transition attempt before calling the store', async () => {
    const state: FinalizationState = {
      status: 'succeeded',
      finalizationId: 'exec-success-update',
      queuedAtMs: 1_700_000_000_000,
      startedAtMs: 1_700_000_001_000,
      completedAtMs: 1_700_000_002_000,
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
        finalizationId: 'exec-success-update',
        status: 'SUCCEEDED',
        queuedAtMs: 1_700_000_000_000,
        startedAtMs: 1_700_000_001_000,
        completedAtMs: 1_700_000_002_000,
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
      finalization_id: 'exec-success-update',
    });
  });

  it('records a timed-out writer/update transition attempt before calling the store', async () => {
    const state: FinalizationState = {
      status: 'timeout',
      finalizationId: 'exec-timeout-update',
      queuedAtMs: 1_700_000_000_000,
      startedAtMs: 1_700_000_001_000,
      timeoutAtMs: 1_700_000_002_000,
    };
    const { store, markFinalizationTimedOut } = buildStore(state);

    await applyFinalizationStateUpdatePayload({
      payload: {
        sessionId: 'session-timeout-update',
        finalizationId: 'exec-timeout-update',
        status: 'TIMED_OUT',
        queuedAtMs: 1_700_000_000_000,
        startedAtMs: 1_700_000_001_000,
        timeoutAtMs: 1_700_000_002_000,
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
      finalization_id: 'exec-timeout-update',
    });
  });
});
