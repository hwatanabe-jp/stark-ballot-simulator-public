import { isFinalizationEventReason, type FinalizationEventReason } from '@stark-ballot/diagnostics/canonicalEvents';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import {
  type FinalizationRecord,
  type FinalizationResultRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import {
  FinalizationFailureCategory,
  type FinalizationId,
  type FinalizationResultAuthority,
  type FinalizationScenarioContext,
  type FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import {
  admitFinalizationResultAuthority,
  parseFinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-storage';

/**
 * Semantic authority loaded from the current finalization record. Persistence
 * revisions and adapter delivery/runtime metadata stay outside this shape.
 */
export interface FinalizationLifecycleAuthority {
  currentRecord: FinalizationRecord | null;
}

type FinalizationCommandBase = {
  sessionId: SessionId;
  finalizationId: FinalizationId;
  queuedAtMs: number;
  scenarioContext?: FinalizationScenarioContext;
  reason?: FinalizationEventReason;
};

export type FinalizationTransitionCommand =
  | (FinalizationCommandBase & {
      kind: 'queue';
      scenarioContext: FinalizationScenarioContext;
    })
  | (FinalizationCommandBase & {
      kind: 'start';
      startedAtMs: number;
    })
  | (FinalizationCommandBase & {
      kind: 'succeed';
      startedAtMs: number;
      completedAtMs: number;
      finalizationResult: FinalizationResultAuthority;
    })
  | (FinalizationCommandBase & {
      kind: 'fail';
      startedAtMs?: number;
      failedAtMs: number;
      error: Extract<FinalizationState, { status: 'failed' }>['error'];
    })
  | (FinalizationCommandBase & {
      kind: 'time_out';
      startedAtMs?: number;
      timeoutAtMs: number;
    })
  | (FinalizationCommandBase & {
      kind: 'cancel';
      startedAtMs?: number;
      failedAtMs: number;
      message: string;
    });

export interface FinalizationLifecycleMutations {
  nextRecord: FinalizationRecord;
}

export type InvalidFinalizationTransitionReason =
  | 'invalid_evaluation_time'
  | 'invalid_session_id'
  | 'invalid_finalization_id'
  | 'invalid_timestamp'
  | 'invalid_reason'
  | 'invalid_error'
  | 'invalid_finalization_result'
  | 'invalid_scenario_context';

export type FinalizationTransitionOutcome =
  | {
      kind: 'applied';
      state: FinalizationState;
      reason: FinalizationEventReason;
      mutations: FinalizationLifecycleMutations;
    }
  | {
      kind: 'idempotent';
      state: FinalizationState;
      reason: 'IDEMPOTENT_RETRY';
    }
  | {
      kind: 'rejected';
      state: FinalizationState | null;
      reason: FinalizationEventReason;
    }
  | {
      kind: 'invalid';
      state: FinalizationState | null;
      reason: InvalidFinalizationTransitionReason;
    };

type AdmittedFinalizationCommand = {
  kind: FinalizationTransitionCommand['kind'];
  sessionId: SessionId;
  finalizationId: FinalizationId;
  state: FinalizationState;
  reason: FinalizationEventReason;
  scenarioContext?: FinalizationScenarioContext;
  successfulResult?: FinalizationResultAuthority;
  invalidSuccessfulResult?: true;
};

const FINALIZATION_FAILURE_CATEGORIES = new Set<string>(Object.values(FinalizationFailureCategory));

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function currentState(authority: FinalizationLifecycleAuthority): FinalizationState | null {
  return authority.currentRecord?.state ?? null;
}

function invalidCommand(
  authority: FinalizationLifecycleAuthority,
  reason: InvalidFinalizationTransitionReason,
): FinalizationTransitionOutcome {
  return {
    kind: 'invalid',
    state: currentState(authority),
    reason,
  };
}

function resolveDefaultReason(command: FinalizationTransitionCommand): FinalizationEventReason {
  switch (command.kind) {
    case 'queue':
      return 'FINALIZE_REQUESTED';
    case 'start':
    case 'succeed':
      return 'RUNTIME_UPDATE_RECEIVED';
    case 'fail':
      return isFinalizationEventReason(command.error.code) ? command.error.code : 'FINALIZATION_FAILED';
    case 'time_out':
      return 'EXECUTION_TIMED_OUT';
    case 'cancel':
      return 'USER_CANCELLED';
  }
}

function hasValidBase(command: FinalizationTransitionCommand): InvalidFinalizationTransitionReason | null {
  if (typeof command.sessionId !== 'string' || !isSafeVerifierSegment(command.sessionId)) {
    return 'invalid_session_id';
  }
  if (typeof command.finalizationId !== 'string' || !isSafeVerifierSegment(command.finalizationId)) {
    return 'invalid_finalization_id';
  }
  if (!isNonNegativeInteger(command.queuedAtMs)) {
    return 'invalid_timestamp';
  }
  if (command.reason !== undefined && !isFinalizationEventReason(command.reason)) {
    return 'invalid_reason';
  }
  return null;
}

function hasValidStartedAt(queuedAtMs: number, startedAtMs: unknown): startedAtMs is number {
  return isNonNegativeInteger(startedAtMs) && startedAtMs >= queuedAtMs;
}

function hasValidOptionalStartedAt(queuedAtMs: number, startedAtMs: unknown): startedAtMs is number | undefined {
  return startedAtMs === undefined || hasValidStartedAt(queuedAtMs, startedAtMs);
}

function hasValidTerminalAt(earliestAtMs: number, terminalAtMs: unknown): terminalAtMs is number {
  return isNonNegativeInteger(terminalAtMs) && terminalAtMs >= earliestAtMs;
}

function hasValidFailureError(value: unknown): value is Extract<FinalizationState, { status: 'failed' }>['error'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['code'] === 'string' &&
    typeof candidate['message'] === 'string' &&
    (candidate['category'] === undefined ||
      (typeof candidate['category'] === 'string' && FINALIZATION_FAILURE_CATEGORIES.has(candidate['category'])))
  );
}

function admitScenarioContext(value: FinalizationScenarioContext | undefined): FinalizationScenarioContext | undefined {
  return value === undefined ? undefined : parseFinalizationScenarioContext(value);
}

function admitCommand(command: FinalizationTransitionCommand):
  | {
      admitted: true;
      command: AdmittedFinalizationCommand;
    }
  | {
      admitted: false;
      reason: InvalidFinalizationTransitionReason;
    } {
  const invalidBaseReason = hasValidBase(command);
  if (invalidBaseReason) {
    return { admitted: false, reason: invalidBaseReason };
  }
  const sessionId = asSessionId(command.sessionId);
  const finalizationId = parseFinalizationId(command.finalizationId);
  if (!finalizationId) {
    return { admitted: false, reason: 'invalid_finalization_id' };
  }
  if (command.kind === 'fail' && !hasValidFailureError(command.error)) {
    return { admitted: false, reason: 'invalid_error' };
  }
  const scenarioContext = admitScenarioContext(command.scenarioContext);
  if (command.scenarioContext !== undefined && !scenarioContext) {
    return { admitted: false, reason: 'invalid_scenario_context' };
  }
  if (command.kind === 'queue' && !scenarioContext) {
    return { admitted: false, reason: 'invalid_scenario_context' };
  }
  const reason = command.reason ?? resolveDefaultReason(command);
  const base = {
    kind: command.kind,
    sessionId,
    finalizationId,
    reason,
    ...(scenarioContext ? { scenarioContext } : {}),
  };

  switch (command.kind) {
    case 'queue':
      return {
        admitted: true,
        command: {
          ...base,
          state: {
            status: 'pending',
            finalizationId,
            queuedAtMs: command.queuedAtMs,
          },
        },
      };
    case 'start':
      if (!hasValidStartedAt(command.queuedAtMs, command.startedAtMs)) {
        return { admitted: false, reason: 'invalid_timestamp' };
      }
      return {
        admitted: true,
        command: {
          ...base,
          state: {
            status: 'running',
            finalizationId,
            queuedAtMs: command.queuedAtMs,
            startedAtMs: command.startedAtMs,
          },
        },
      };
    case 'succeed': {
      if (
        !hasValidStartedAt(command.queuedAtMs, command.startedAtMs) ||
        !hasValidTerminalAt(command.startedAtMs, command.completedAtMs)
      ) {
        return { admitted: false, reason: 'invalid_timestamp' };
      }
      const successfulResult = admitFinalizationResultAuthority(command.finalizationResult);
      return {
        admitted: true,
        command: {
          ...base,
          state: {
            status: 'succeeded',
            finalizationId,
            queuedAtMs: command.queuedAtMs,
            startedAtMs: command.startedAtMs,
            completedAtMs: command.completedAtMs,
          },
          ...(successfulResult?.journal
            ? { successfulResult }
            : {
                invalidSuccessfulResult: true,
              }),
        },
      };
    }
    case 'fail':
      if (
        !hasValidOptionalStartedAt(command.queuedAtMs, command.startedAtMs) ||
        !hasValidTerminalAt(command.startedAtMs ?? command.queuedAtMs, command.failedAtMs)
      ) {
        return { admitted: false, reason: 'invalid_timestamp' };
      }
      return {
        admitted: true,
        command: {
          ...base,
          state: {
            status: 'failed',
            finalizationId,
            queuedAtMs: command.queuedAtMs,
            ...(command.startedAtMs === undefined ? {} : { startedAtMs: command.startedAtMs }),
            failedAtMs: command.failedAtMs,
            error: command.error,
          },
        },
      };
    case 'time_out':
      if (
        !hasValidOptionalStartedAt(command.queuedAtMs, command.startedAtMs) ||
        !hasValidTerminalAt(command.startedAtMs ?? command.queuedAtMs, command.timeoutAtMs)
      ) {
        return { admitted: false, reason: 'invalid_timestamp' };
      }
      return {
        admitted: true,
        command: {
          ...base,
          state: {
            status: 'timeout',
            finalizationId,
            queuedAtMs: command.queuedAtMs,
            ...(command.startedAtMs === undefined ? {} : { startedAtMs: command.startedAtMs }),
            timeoutAtMs: command.timeoutAtMs,
          },
        },
      };
    case 'cancel':
      if (
        !hasValidOptionalStartedAt(command.queuedAtMs, command.startedAtMs) ||
        !hasValidTerminalAt(command.startedAtMs ?? command.queuedAtMs, command.failedAtMs) ||
        typeof command.message !== 'string' ||
        command.message.trim().length === 0
      ) {
        return { admitted: false, reason: 'invalid_error' };
      }
      return {
        admitted: true,
        command: {
          ...base,
          state: {
            status: 'failed',
            finalizationId,
            queuedAtMs: command.queuedAtMs,
            ...(command.startedAtMs === undefined ? {} : { startedAtMs: command.startedAtMs }),
            failedAtMs: command.failedAtMs,
            error: {
              code: 'USER_CANCELLED',
              message: command.message,
            },
          },
        },
      };
  }
}

function isTerminalState(state: FinalizationState): boolean {
  return state.status === 'succeeded' || state.status === 'failed' || state.status === 'timeout';
}

function resolveTerminalRejectionReason(state: FinalizationState): FinalizationEventReason {
  if (state.status === 'failed' && isFinalizationEventReason(state.error.code)) {
    return state.error.code;
  }
  return 'TERMINAL_STATE_STICKY';
}

function haveSameNonterminalState(left: FinalizationState, right: FinalizationState): boolean {
  if (left.status === 'pending' && right.status === 'pending') {
    return left.finalizationId === right.finalizationId && left.queuedAtMs === right.queuedAtMs;
  }
  if (left.status === 'running' && right.status === 'running') {
    return (
      left.finalizationId === right.finalizationId &&
      left.queuedAtMs === right.queuedAtMs &&
      left.startedAtMs === right.startedAtMs
    );
  }
  return false;
}

function haveSameScenarioContext(left: FinalizationScenarioContext, right: FinalizationScenarioContext): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildNextRecord(
  authority: FinalizationLifecycleAuthority,
  admitted: AdmittedFinalizationCommand,
): FinalizationRecord | undefined {
  const scenarioContext = admitted.scenarioContext ?? authority.currentRecord?.scenarioContext;
  if (!scenarioContext) {
    return undefined;
  }
  const base = {
    sessionId: admitted.sessionId,
    finalizationId: admitted.finalizationId,
    scenarioContext,
    state: admitted.state,
  };
  if (admitted.state.status !== 'succeeded') {
    return {
      ...base,
      state: admitted.state,
    };
  }
  if (!admitted.successfulResult) {
    return undefined;
  }
  const finalizationResult: FinalizationResultRecord = {
    finalizationId: admitted.finalizationId,
    ...admitted.successfulResult,
  };
  return {
    ...base,
    state: admitted.state,
    finalizationResult,
  };
}

/**
 * Evaluates one finalization lifecycle command without reading external state
 * or performing persistence, logging, or clock I/O.
 */
export function evaluateFinalizationTransition(input: {
  authority: FinalizationLifecycleAuthority;
  command: FinalizationTransitionCommand;
  evaluatedAtMs: number;
}): FinalizationTransitionOutcome {
  const { authority, command, evaluatedAtMs } = input;
  if (!isNonNegativeInteger(evaluatedAtMs)) {
    return invalidCommand(authority, 'invalid_evaluation_time');
  }

  const admission = admitCommand(command);
  if (!admission.admitted) {
    return invalidCommand(authority, admission.reason);
  }
  const admitted = admission.command;
  const record = authority.currentRecord;
  const state = record?.state ?? null;

  if (record && record.sessionId !== admitted.sessionId) {
    return invalidCommand(authority, 'invalid_session_id');
  }

  if (command.kind === 'cancel') {
    if (
      !state ||
      state.finalizationId !== admitted.state.finalizationId ||
      (state.status !== 'pending' && state.status !== 'running')
    ) {
      return {
        kind: 'rejected',
        state,
        reason: 'FINALIZATION_NOT_CANCELLABLE',
      };
    }
  } else if (state && state.finalizationId === admitted.state.finalizationId && isTerminalState(state)) {
    if (state.status === admitted.state.status) {
      return {
        kind: 'idempotent',
        state,
        reason: 'IDEMPOTENT_RETRY',
      };
    }
    return {
      kind: 'rejected',
      state,
      reason: resolveTerminalRejectionReason(state),
    };
  }

  if (state && state.finalizationId !== admitted.state.finalizationId) {
    return {
      kind: 'rejected',
      state,
      reason: 'EXECUTION_MISMATCH',
    };
  }

  if (admitted.invalidSuccessfulResult) {
    return invalidCommand(authority, 'invalid_finalization_result');
  }

  const nextRecord = buildNextRecord(authority, admitted);
  if (!nextRecord) {
    return invalidCommand(authority, 'invalid_scenario_context');
  }

  if (
    state &&
    haveSameNonterminalState(state, admitted.state) &&
    haveSameScenarioContext(record?.scenarioContext ?? nextRecord.scenarioContext, nextRecord.scenarioContext)
  ) {
    return {
      kind: 'idempotent',
      state,
      reason: 'IDEMPOTENT_RETRY',
    };
  }

  return {
    kind: 'applied',
    state: admitted.state,
    reason: admitted.reason,
    mutations: { nextRecord },
  };
}
