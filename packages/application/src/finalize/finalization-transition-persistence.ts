import type {
  FinalizationLifecycleAuthority,
  FinalizationLifecycleMutations,
} from '@stark-ballot/application/finalize/finalization-transition-policy';

/**
 * Adapter-neutral optimistic concurrency token. Concrete stores may derive it
 * from a record version, file snapshot, or the exact fields in a condition.
 */
export type FinalizationLifecycleRevision = string;

export interface LoadedFinalizationLifecycle {
  authority: FinalizationLifecycleAuthority;
  revision: FinalizationLifecycleRevision;
}

export type FinalizationLifecycleLoadResult =
  | {
      status: 'loaded';
      lifecycle: LoadedFinalizationLifecycle;
    }
  | {
      status: 'missing';
    }
  | {
      status: 'invalid_record';
      error: unknown;
    }
  | {
      status: 'persistence_failure';
      error: unknown;
    };

export type FinalizationLifecycleApplyResult =
  | {
      status: 'applied';
      lifecycle: LoadedFinalizationLifecycle;
    }
  | {
      status: 'already_applied';
      lifecycle: LoadedFinalizationLifecycle;
    }
  | {
      status: 'stale';
      lifecycle: LoadedFinalizationLifecycle;
    }
  | {
      status: 'missing';
    }
  | {
      status: 'invalid_record';
      error: unknown;
    }
  | {
      status: 'persistence_failure';
      error: unknown;
    };

/**
 * Persistence capability consumed by coordinators that evaluate the pure
 * policy and then attempt one expected-current mutation.
 */
export interface FinalizationLifecyclePersistencePort {
  loadFinalizationLifecycle(sessionId: string, finalizationId: string): Promise<FinalizationLifecycleLoadResult>;

  applyFinalizationLifecycleMutation(input: {
    sessionId: string;
    finalizationId: string;
    expectedRevision: FinalizationLifecycleRevision;
    mutations: FinalizationLifecycleMutations;
  }): Promise<FinalizationLifecycleApplyResult>;
}
