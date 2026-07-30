import {
  emitCanonicalEvent,
  isFinalizationEventReason,
  type FinalizationEventReason,
  type FinalizationEventState,
  type FinalizationTransitionMetadata,
} from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';

export interface ObservedFinalizationState {
  status: FinalizationEventState;
  executionId: string;
}

export interface FinalizationPersistenceOutcome {
  sessionId: string;
  requestedExecutionId: string;
  requestedTo: FinalizationEventState;
  before?: ObservedFinalizationState;
  actual: ObservedFinalizationState;
  actualReason?: FinalizationEventReason;
  authoritativeWrite: boolean;
  metadata?: FinalizationTransitionMetadata;
}

export interface FinalizationStorePersistenceOutcome {
  sessionId: string;
  requestedExecutionId: string;
  requestedTo: FinalizationEventState;
  before?: ObservedFinalizationState;
  actual: FinalizationState;
  authoritativeWrite: boolean;
  metadata?: FinalizationTransitionMetadata;
}

const TERMINAL_FINALIZATION_STATES = new Set<FinalizationEventState>(['succeeded', 'failed', 'timeout']);

function resolveDefaultMetadata(requestedTo: FinalizationEventState): FinalizationTransitionMetadata {
  switch (requestedTo) {
    case 'pending':
      return { source: 'finalize', reason: 'FINALIZE_REQUESTED' };
    case 'running':
      return { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' };
    case 'succeeded':
      return { source: 'writer_update', reason: 'RUNTIME_UPDATE_RECEIVED' };
    case 'failed':
      return { source: 'reconcile', reason: 'FINALIZATION_FAILED' };
    case 'timeout':
      return { source: 'reconcile', reason: 'EXECUTION_TIMED_OUT' };
  }
}

function hasSameState(left: ObservedFinalizationState | undefined, right: ObservedFinalizationState): boolean {
  return left?.status === right.status && left.executionId === right.executionId;
}

function resolveRejectionReason({
  requestedExecutionId,
  actual,
  actualReason,
  authoritativeWrite,
}: FinalizationPersistenceOutcome): FinalizationEventReason {
  if (actual.executionId !== requestedExecutionId) {
    return 'EXECUTION_MISMATCH';
  }
  if (TERMINAL_FINALIZATION_STATES.has(actual.status)) {
    return actualReason ?? 'TERMINAL_STATE_STICKY';
  }
  if (actualReason) {
    return actualReason;
  }
  return authoritativeWrite ? 'TERMINAL_STATE_STICKY' : 'CONDITIONAL_WRITE_CONFLICT';
}

export function recordFinalizationPersistenceOutcome(outcome: FinalizationPersistenceOutcome): void {
  try {
    const metadata = outcome.metadata ?? resolveDefaultMetadata(outcome.requestedTo);
    const sessionIdHash = hashSessionIdForLogging(outcome.sessionId);
    const requestWasAdmitted =
      outcome.actual.status === outcome.requestedTo && outcome.actual.executionId === outcome.requestedExecutionId;

    if (requestWasAdmitted) {
      const changed = outcome.authoritativeWrite && !hasSameState(outcome.before, outcome.actual);
      emitCanonicalEvent({
        event: 'finalize_state_transition',
        from: changed ? (outcome.before?.status ?? 'none') : outcome.actual.status,
        to: outcome.actual.status,
        source: metadata.source,
        reason: changed ? metadata.reason : 'IDEMPOTENT_RETRY',
        changed,
        session_id_hash: sessionIdHash,
        execution_id: outcome.actual.executionId,
      });
      return;
    }

    if (outcome.authoritativeWrite && !hasSameState(outcome.before, outcome.actual)) {
      emitCanonicalEvent({
        event: 'finalize_state_transition',
        from: outcome.before?.status ?? 'none',
        to: outcome.actual.status,
        source: metadata.source,
        reason: outcome.actualReason ?? metadata.reason,
        changed: true,
        session_id_hash: sessionIdHash,
        execution_id: outcome.actual.executionId,
      });
    }

    emitCanonicalEvent({
      event: 'finalize_state_update_rejected',
      to: outcome.requestedTo,
      source: metadata.source,
      reason: resolveRejectionReason(outcome),
      session_id_hash: sessionIdHash,
      execution_id: outcome.requestedExecutionId,
    });
  } catch {
    // Observability is downstream of persistence and must never alter its result.
  }
}

export function recordFinalizationStorePersistenceOutcome(outcome: FinalizationStorePersistenceOutcome): void {
  const actualReason =
    outcome.actual.status === 'failed' && isFinalizationEventReason(outcome.actual.error.code)
      ? outcome.actual.error.code
      : undefined;
  recordFinalizationPersistenceOutcome({
    sessionId: outcome.sessionId,
    requestedExecutionId: outcome.requestedExecutionId,
    requestedTo: outcome.requestedTo,
    ...(outcome.before
      ? {
          before: {
            status: outcome.before.status,
            executionId: outcome.before.executionId,
          },
        }
      : {}),
    actual: {
      status: outcome.actual.status,
      executionId: outcome.actual.executionId,
    },
    ...(actualReason ? { actualReason } : {}),
    authoritativeWrite: outcome.authoritativeWrite,
    ...(outcome.metadata ? { metadata: outcome.metadata } : {}),
  });
}
