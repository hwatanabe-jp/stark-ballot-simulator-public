import type {
  FinalizationLifecyclePersistencePort,
  LoadedFinalizationLifecycle,
} from '@stark-ballot/application/finalize/finalization-transition-persistence';
import {
  evaluateFinalizationTransition,
  type FinalizationTransitionCommand,
  type FinalizationTransitionOutcome,
} from '@stark-ballot/application/finalize/finalization-transition-policy';

export type FinalizationTransitionStaleRetryLimit = 0 | 1 | 2 | 3;

type AppliedPolicyOutcome = Extract<FinalizationTransitionOutcome, { kind: 'applied' }>;

export type FinalizationTransitionCoordinationResult =
  | {
      status: 'applied';
      lifecycle: LoadedFinalizationLifecycle;
      outcome: AppliedPolicyOutcome;
      staleConflicts: number;
    }
  | {
      status: 'already_applied';
      source: 'policy';
      lifecycle: LoadedFinalizationLifecycle;
      outcome: Extract<FinalizationTransitionOutcome, { kind: 'idempotent' }>;
      staleConflicts: number;
    }
  | {
      status: 'already_applied';
      source: 'persistence';
      lifecycle: LoadedFinalizationLifecycle;
      outcome: AppliedPolicyOutcome;
      staleConflicts: number;
    }
  | {
      status: 'rejected';
      lifecycle: LoadedFinalizationLifecycle;
      outcome: Extract<FinalizationTransitionOutcome, { kind: 'rejected' }>;
      staleConflicts: number;
    }
  | {
      status: 'invalid';
      lifecycle: LoadedFinalizationLifecycle;
      outcome: Extract<FinalizationTransitionOutcome, { kind: 'invalid' }>;
      staleConflicts: number;
    }
  | {
      status: 'stale';
      lifecycle: LoadedFinalizationLifecycle;
      outcome: AppliedPolicyOutcome;
      staleConflicts: number;
    }
  | {
      status: 'missing';
      stage: 'load' | 'apply';
      staleConflicts: number;
    }
  | {
      status: 'persistence_failure';
      stage: 'load' | 'apply';
      error: unknown;
      staleConflicts: number;
    }
  | {
      status: 'invalid_record';
      stage: 'load' | 'apply';
      error: unknown;
      staleConflicts: number;
    };

export interface CoordinateFinalizationTransitionInput {
  command: FinalizationTransitionCommand;
  evaluatedAtMs: number;
  persistence: FinalizationLifecyclePersistencePort;
  staleRetryLimit?: FinalizationTransitionStaleRetryLimit;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled finalization transition outcome: ${String(value)}`);
}

/**
 * Coordinates one semantic transition against a revisioned persistence port.
 *
 * The caller supplies evaluation time and a bounded retry limit so this
 * application service remains deterministic and performs no clock or runtime
 * configuration I/O.
 */
export async function coordinateFinalizationTransition(
  input: CoordinateFinalizationTransitionInput,
): Promise<FinalizationTransitionCoordinationResult> {
  const { command, evaluatedAtMs, persistence, staleRetryLimit = 1 } = input;
  const { sessionId, finalizationId } = command;
  let staleConflicts = 0;

  for (;;) {
    const loadResult = await persistence.loadFinalizationLifecycle(sessionId, finalizationId);
    switch (loadResult.status) {
      case 'missing':
        return { status: 'missing', stage: 'load', staleConflicts };
      case 'invalid_record':
        return {
          status: 'invalid_record',
          stage: 'load',
          error: loadResult.error,
          staleConflicts,
        };
      case 'persistence_failure':
        return {
          status: 'persistence_failure',
          stage: 'load',
          error: loadResult.error,
          staleConflicts,
        };
      case 'loaded':
        break;
      default:
        return assertNever(loadResult);
    }

    const lifecycle = loadResult.lifecycle;
    const outcome = evaluateFinalizationTransition({
      authority: lifecycle.authority,
      command,
      evaluatedAtMs,
    });

    switch (outcome.kind) {
      case 'idempotent':
        return {
          status: 'already_applied',
          source: 'policy',
          lifecycle,
          outcome,
          staleConflicts,
        };
      case 'rejected':
        return {
          status: 'rejected',
          lifecycle,
          outcome,
          staleConflicts,
        };
      case 'invalid':
        return {
          status: 'invalid',
          lifecycle,
          outcome,
          staleConflicts,
        };
      case 'applied':
        break;
      default:
        return assertNever(outcome);
    }

    const applyResult = await persistence.applyFinalizationLifecycleMutation({
      sessionId,
      finalizationId,
      expectedRevision: lifecycle.revision,
      mutations: outcome.mutations,
    });
    switch (applyResult.status) {
      case 'applied':
        return {
          status: 'applied',
          lifecycle: applyResult.lifecycle,
          outcome,
          staleConflicts,
        };
      case 'already_applied':
        return {
          status: 'already_applied',
          source: 'persistence',
          lifecycle: applyResult.lifecycle,
          outcome,
          staleConflicts,
        };
      case 'missing':
        return {
          status: 'missing',
          stage: 'apply',
          staleConflicts,
        };
      case 'invalid_record':
        return {
          status: 'invalid_record',
          stage: 'apply',
          error: applyResult.error,
          staleConflicts,
        };
      case 'persistence_failure':
        return {
          status: 'persistence_failure',
          stage: 'apply',
          error: applyResult.error,
          staleConflicts,
        };
      case 'stale':
        staleConflicts += 1;
        if (staleConflicts > staleRetryLimit) {
          return {
            status: 'stale',
            lifecycle: applyResult.lifecycle,
            outcome,
            staleConflicts,
          };
        }
        break;
      default:
        return assertNever(applyResult);
    }
  }
}
