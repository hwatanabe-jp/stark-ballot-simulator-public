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
  finalizationId: string;
}

export interface FinalizationPersistenceOutcome {
  sessionId: string;
  requestedFinalizationId: string;
  requestedTo: FinalizationEventState;
  before?: ObservedFinalizationState;
  actual: ObservedFinalizationState;
  actualReason?: FinalizationEventReason;
  authoritativeWrite: boolean;
  metadata?: FinalizationTransitionMetadata;
}

export interface FinalizationStorePersistenceOutcome {
  sessionId: string;
  requestedFinalizationId: string;
  requestedTo: FinalizationEventState;
  before?: ObservedFinalizationState;
  actual: FinalizationState;
  semanticReason?: FinalizationEventReason;
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
  return left?.status === right.status && left.finalizationId === right.finalizationId;
}

function resolveRejectionReason({
  requestedFinalizationId,
  actual,
  actualReason,
  authoritativeWrite,
}: FinalizationPersistenceOutcome): FinalizationEventReason {
  if (actual.finalizationId !== requestedFinalizationId) {
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

function emitObservedTransition(
  outcome: FinalizationPersistenceOutcome,
  metadata: FinalizationTransitionMetadata,
  sessionIdHash: string,
  changed: boolean,
): void {
  emitCanonicalEvent({
    event: 'finalize_state_transition',
    from: changed ? (outcome.before?.status ?? 'none') : outcome.actual.status,
    to: outcome.actual.status,
    source: metadata.source,
    reason: changed ? (outcome.actualReason ?? metadata.reason) : 'IDEMPOTENT_RETRY',
    changed,
    session_id_hash: sessionIdHash,
    finalization_id: outcome.actual.finalizationId,
  });
}

function recordAdmittedTransition(
  outcome: FinalizationPersistenceOutcome,
  metadata: FinalizationTransitionMetadata,
  sessionIdHash: string,
): void {
  const changed = outcome.authoritativeWrite && !hasSameState(outcome.before, outcome.actual);
  if (changed && outcome.before === undefined && outcome.actual.status === 'pending') {
    emitCanonicalEvent({
      event: 'finalization_admitted',
      finalization_id: outcome.actual.finalizationId,
    });
  }
  emitObservedTransition(outcome, metadata, sessionIdHash, changed);
}

export function recordFinalizationPersistenceOutcome(outcome: FinalizationPersistenceOutcome): void {
  try {
    const metadata = outcome.metadata ?? resolveDefaultMetadata(outcome.requestedTo);
    const sessionIdHash = hashSessionIdForLogging(outcome.sessionId);
    const requestWasAdmitted =
      outcome.actual.status === outcome.requestedTo &&
      outcome.actual.finalizationId === outcome.requestedFinalizationId;

    if (requestWasAdmitted) {
      recordAdmittedTransition(outcome, metadata, sessionIdHash);
      return;
    }

    if (outcome.authoritativeWrite && !hasSameState(outcome.before, outcome.actual)) {
      emitObservedTransition(outcome, metadata, sessionIdHash, true);
    }

    emitCanonicalEvent({
      event: 'finalize_state_update_rejected',
      to: outcome.requestedTo,
      source: metadata.source,
      reason: resolveRejectionReason(outcome),
      session_id_hash: sessionIdHash,
      finalization_id: outcome.requestedFinalizationId,
    });
  } catch {
    // Observability is downstream of persistence and must never alter its result.
  }
}

export function recordFinalizationStorePersistenceOutcome(outcome: FinalizationStorePersistenceOutcome): void {
  const stateReason =
    outcome.actual.status === 'failed' && isFinalizationEventReason(outcome.actual.error.code)
      ? outcome.actual.error.code
      : undefined;
  const actualReason = outcome.semanticReason ?? stateReason;
  recordFinalizationPersistenceOutcome({
    sessionId: outcome.sessionId,
    requestedFinalizationId: outcome.requestedFinalizationId,
    requestedTo: outcome.requestedTo,
    ...(outcome.before
      ? {
          before: {
            status: outcome.before.status,
            finalizationId: outcome.before.finalizationId,
          },
        }
      : {}),
    actual: {
      status: outcome.actual.status,
      finalizationId: outcome.actual.finalizationId,
    },
    ...(actualReason ? { actualReason } : {}),
    authoritativeWrite: outcome.authoritativeWrite,
    ...(outcome.metadata ? { metadata: outcome.metadata } : {}),
  });
}
