import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { FinalizationId, FinalizationState } from './finalization-types';
import type { FinalizationRecord } from './finalization-record';
import type { FinalizationLifecycleStore } from './finalization-store';
import { emitCanonicalEvent, type FinalizationEventReason } from '@stark-ballot/diagnostics/canonicalEvents';

export type FinalizationExecutionObservation =
  | { status: 'missing' | 'running' }
  | { status: 'succeeded' | 'failed' | 'timed_out' | 'aborted'; stoppedAtMs: number };

export interface FinalizationReconciliationPorts {
  store: Pick<
    FinalizationLifecycleStore,
    'getCurrentFinalizationRecord' | 'markFinalizationFailed' | 'markFinalizationTimedOut'
  >;
  observeExecution: (sessionId: SessionId, finalizationId: FinalizationId) => Promise<FinalizationExecutionObservation>;
}

/** Reconcile only current, persisted work; execution success never supplies proof authority. */
export async function reconcileFinalization(
  input: ReconciliationInput,
  ports: FinalizationReconciliationPorts,
): Promise<void> {
  const { sessionId, finalizationId, nowMs, dispatchDeadlineMs } = input;
  const current = await ports.store.getCurrentFinalizationRecord(sessionId);
  if (!isCurrentUnfinishedFinalization(current, finalizationId)) return;
  const state = current.state;
  if (nowMs - state.queuedAtMs < 60_000) return;
  const execution = await ports.observeExecution(sessionId, finalizationId);
  if (!shouldReconcileExecution(state, execution, nowMs, dispatchDeadlineMs)) return;
  const common = {
    finalizationId,
    queuedAtMs: state.queuedAtMs,
    ...(state.status === 'running' ? { startedAtMs: state.startedAtMs } : {}),
  };
  try {
    await writeReconciledOutcome(input, ports, { state, execution, common });
  } catch (error) {
    // A writer/cancellation/new finalization may win CAS. Re-read, never project an unpersisted failure.
    const latest = await ports.store.getCurrentFinalizationRecord(sessionId);
    if (!isCurrentUnfinishedFinalization(latest, finalizationId)) return;
    throw error;
  }
}

type ReconciliationInput = {
  sessionId: SessionId;
  finalizationId: FinalizationId;
  nowMs: number;
  dispatchDeadlineMs: number;
};
type ActiveFinalizationState = Extract<FinalizationState, { status: 'pending' | 'running' }>;

function isCurrentUnfinishedFinalization(
  record: FinalizationRecord | null | undefined,
  finalizationId: FinalizationId,
): record is FinalizationRecord & { state: ActiveFinalizationState } {
  return (
    !!record &&
    record.finalizationId === finalizationId &&
    (record.state.status === 'pending' || record.state.status === 'running')
  );
}

function shouldReconcileExecution(
  state: ActiveFinalizationState,
  execution: FinalizationExecutionObservation,
  nowMs: number,
  dispatchDeadlineMs: number,
): boolean {
  if (execution.status === 'running') return false;
  if (execution.status === 'missing' && (state.status !== 'pending' || nowMs - state.queuedAtMs <= dispatchDeadlineMs))
    return false;
  // Allow the direct writer to finish after the execution closes, including a delayed success write.
  if ('stoppedAtMs' in execution && nowMs - execution.stoppedAtMs < 60_000) return false;
  return true;
}

function resolveReconciliationFailureReason(
  state: ActiveFinalizationState,
  execution: FinalizationExecutionObservation,
): FinalizationEventReason {
  if (execution.status === 'missing') return 'FINALIZATION_DISPATCH_TIMEOUT';
  if (state.status === 'pending' || execution.status === 'succeeded' || execution.status === 'timed_out')
    return 'FINALIZATION_OUTCOME_UNRECORDED';
  return execution.status === 'failed' ? 'PROVER_EXECUTION_FAILED' : 'PROVER_EXECUTION_ABORTED';
}

async function writeReconciledOutcome(
  input: ReconciliationInput,
  ports: FinalizationReconciliationPorts,
  context: {
    state: ActiveFinalizationState;
    execution: FinalizationExecutionObservation;
    common: Pick<FinalizationState, 'finalizationId' | 'queuedAtMs'> & { startedAtMs?: number };
  },
): Promise<void> {
  const { sessionId, finalizationId, nowMs } = input;
  const { state, execution, common } = context;
  if (execution.status === 'timed_out' && state.status === 'running') {
    emitCanonicalEvent({
      event: 'finalize_transition_attempted',
      to: 'timeout',
      source: 'reconcile',
      reason: 'EXECUTION_TIMED_OUT',
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalization_id: finalizationId,
    });
    await ports.store.markFinalizationTimedOut(sessionId, {
      ...common,
      timeoutAtMs: execution.stoppedAtMs,
      observability: { source: 'reconcile', reason: 'EXECUTION_TIMED_OUT' },
    });
  } else {
    const reason = resolveReconciliationFailureReason(state, execution);
    emitCanonicalEvent({
      event: 'finalize_transition_attempted',
      to: 'failed',
      source: 'reconcile',
      reason,
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalization_id: finalizationId,
    });
    await ports.store.markFinalizationFailed(sessionId, {
      ...common,
      failedAtMs: 'stoppedAtMs' in execution ? execution.stoppedAtMs : nowMs,
      error: {
        code: reason,
        message:
          execution.status === 'missing'
            ? 'Finalization dispatch did not start before its deadline.'
            : `Finalization execution ${execution.status} without a recorded outcome.`,
      },
      observability: { source: 'reconcile', reason },
    });
  }
}
