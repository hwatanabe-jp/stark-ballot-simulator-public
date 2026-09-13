import { describe, expect, it } from 'vitest';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationLifecycleApplyResult,
  FinalizationLifecycleLoadResult,
  FinalizationLifecyclePersistencePort,
  LoadedFinalizationLifecycle,
} from '@stark-ballot/application/finalize/finalization-transition-persistence';
import type {
  FinalizationLifecycleAuthority,
  FinalizationTransitionCommand,
} from '@stark-ballot/application/finalize/finalization-transition-policy';
import { coordinateFinalizationTransition } from '@stark-ballot/application/finalize/finalization-transition-coordinator';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';

const SESSION_ID = asSessionId('session-transition-coordinator');
const FINALIZATION_ID = asFinalizationId('exec-transition-coordinator');
const EVALUATED_AT_MS = 1_750_000_000_000;
const SCENARIO_CONTEXT = {
  scenarios: [],
  tamperMode: 'none' as const,
  claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 1,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

function pendingRecord(finalizationId = FINALIZATION_ID): FinalizationRecord {
  return {
    sessionId: SESSION_ID,
    finalizationId,
    scenarioContext: SCENARIO_CONTEXT,
    state: {
      status: 'pending',
      finalizationId,
      queuedAtMs: 10,
    },
  };
}

function createAuthority(currentRecord: FinalizationRecord | null = null): FinalizationLifecycleAuthority {
  return { currentRecord };
}

function createLoadedLifecycle(
  revision: string,
  authority: FinalizationLifecycleAuthority = createAuthority(),
): LoadedFinalizationLifecycle {
  return { revision, authority };
}

function createQueueCommand(
  overrides: Partial<Extract<FinalizationTransitionCommand, { kind: 'queue' }>> = {},
): Extract<FinalizationTransitionCommand, { kind: 'queue' }> {
  return {
    kind: 'queue',
    sessionId: SESSION_ID,
    finalizationId: FINALIZATION_ID,
    queuedAtMs: 10,
    scenarioContext: SCENARIO_CONTEXT,
    ...overrides,
  };
}

class ScriptedFinalizationPersistence implements FinalizationLifecyclePersistencePort {
  readonly loadCalls: Array<{ sessionId: SessionId; finalizationId: FinalizationId }> = [];
  readonly applyCalls: Array<
    Parameters<FinalizationLifecyclePersistencePort['applyFinalizationLifecycleMutation']>[0]
  > = [];
  private readonly loads: FinalizationLifecycleLoadResult[];
  private readonly applies: FinalizationLifecycleApplyResult[];

  constructor(loads: FinalizationLifecycleLoadResult[], applies: FinalizationLifecycleApplyResult[] = []) {
    this.loads = loads;
    this.applies = applies;
  }

  loadFinalizationLifecycle(
    sessionId: SessionId,
    finalizationId: FinalizationId,
  ): Promise<FinalizationLifecycleLoadResult> {
    this.loadCalls.push({ sessionId, finalizationId });
    const result = this.loads.shift();
    if (!result) {
      throw new Error('Unexpected lifecycle load');
    }
    return Promise.resolve(result);
  }

  applyFinalizationLifecycleMutation(
    input: Parameters<FinalizationLifecyclePersistencePort['applyFinalizationLifecycleMutation']>[0],
  ): Promise<FinalizationLifecycleApplyResult> {
    this.applyCalls.push(input);
    const result = this.applies.shift();
    if (!result) {
      throw new Error('Unexpected lifecycle apply');
    }
    return Promise.resolve(result);
  }
}

describe('coordinateFinalizationTransition', () => {
  it('loads and applies the exact lifecycle identity against the loaded revision', async () => {
    const loaded = createLoadedLifecycle('revision-1');
    const persisted = createLoadedLifecycle('revision-2', createAuthority(pendingRecord()));
    const persistence = new ScriptedFinalizationPersistence(
      [{ status: 'loaded', lifecycle: loaded }],
      [{ status: 'applied', lifecycle: persisted }],
    );

    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      lifecycle: persisted,
      staleConflicts: 0,
      outcome: {
        kind: 'applied',
        state: { status: 'pending', finalizationId: FINALIZATION_ID, queuedAtMs: 10 },
      },
    });
    expect(persistence.loadCalls).toEqual([{ sessionId: SESSION_ID, finalizationId: FINALIZATION_ID }]);
    expect(persistence.applyCalls).toEqual([
      {
        sessionId: SESSION_ID,
        finalizationId: FINALIZATION_ID,
        expectedRevision: 'revision-1',
        mutations: {
          nextRecord: pendingRecord(),
        },
      },
    ]);
  });

  it('returns policy idempotency as already applied without an adapter metadata write', async () => {
    const loaded = createLoadedLifecycle('revision-idempotent', createAuthority(pendingRecord()));
    const persistence = new ScriptedFinalizationPersistence([{ status: 'loaded', lifecycle: loaded }]);

    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
      }),
    ).resolves.toEqual({
      status: 'already_applied',
      source: 'policy',
      lifecycle: loaded,
      staleConflicts: 0,
      outcome: {
        kind: 'idempotent',
        state: pendingRecord().state,
        reason: 'IDEMPOTENT_RETRY',
      },
    });
    expect(persistence.applyCalls).toEqual([]);
  });

  it('returns semantic rejection and invalid admission without writing', async () => {
    const current = pendingRecord(asFinalizationId('exec-current'));
    const rejectedLifecycle = createLoadedLifecycle('revision-rejected', createAuthority(current));
    const rejectedPersistence = new ScriptedFinalizationPersistence([
      { status: 'loaded', lifecycle: rejectedLifecycle },
    ]);
    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence: rejectedPersistence,
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      lifecycle: rejectedLifecycle,
      outcome: { kind: 'rejected', state: current.state, reason: 'EXECUTION_MISMATCH' },
    });
    expect(rejectedPersistence.applyCalls).toEqual([]);

    const invalidLifecycle = createLoadedLifecycle('revision-invalid');
    const invalidPersistence = new ScriptedFinalizationPersistence([{ status: 'loaded', lifecycle: invalidLifecycle }]);
    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand({ finalizationId: '../unsafe' as FinalizationId }),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence: invalidPersistence,
      }),
    ).resolves.toMatchObject({
      status: 'invalid',
      lifecycle: invalidLifecycle,
      outcome: { kind: 'invalid', reason: 'invalid_finalization_id' },
    });
    expect(invalidPersistence.applyCalls).toEqual([]);
  });

  it.each(['load', 'apply'] as const)('fails closed on an invalid record during %s', async (stage) => {
    const error = new Error(`invalid ${stage} record`);
    const loaded = createLoadedLifecycle('revision-1');
    const invalid = { status: 'invalid_record' as const, error };
    const persistence =
      stage === 'load'
        ? new ScriptedFinalizationPersistence([invalid])
        : new ScriptedFinalizationPersistence([{ status: 'loaded', lifecycle: loaded }], [invalid]);

    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
      }),
    ).resolves.toEqual({
      status: 'invalid_record',
      stage,
      error,
      staleConflicts: 0,
    });
  });

  it('reloads and reevaluates after a stale apply before succeeding', async () => {
    const initial = createLoadedLifecycle('revision-1');
    const reloaded = createLoadedLifecycle('revision-2');
    const persisted = createLoadedLifecycle('revision-3', createAuthority(pendingRecord()));
    const persistence = new ScriptedFinalizationPersistence(
      [
        { status: 'loaded', lifecycle: initial },
        { status: 'loaded', lifecycle: reloaded },
      ],
      [
        { status: 'stale', lifecycle: reloaded },
        { status: 'applied', lifecycle: persisted },
      ],
    );

    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
        staleRetryLimit: 1,
      }),
    ).resolves.toMatchObject({
      status: 'applied',
      lifecycle: persisted,
      staleConflicts: 1,
    });
    expect(persistence.loadCalls).toEqual([
      { sessionId: SESSION_ID, finalizationId: FINALIZATION_ID },
      { sessionId: SESSION_ID, finalizationId: FINALIZATION_ID },
    ]);
    expect(persistence.applyCalls.map((call) => call.expectedRevision)).toEqual(['revision-1', 'revision-2']);
  });

  it('converges to already applied when the reloaded record contains the requested state', async () => {
    const initial = createLoadedLifecycle('revision-1');
    const concurrent = createLoadedLifecycle('revision-2', createAuthority(pendingRecord()));
    const persistence = new ScriptedFinalizationPersistence(
      [
        { status: 'loaded', lifecycle: initial },
        { status: 'loaded', lifecycle: concurrent },
      ],
      [{ status: 'stale', lifecycle: concurrent }],
    );

    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
        staleRetryLimit: 1,
      }),
    ).resolves.toMatchObject({
      status: 'already_applied',
      source: 'policy',
      lifecycle: concurrent,
      staleConflicts: 1,
    });
    expect(persistence.applyCalls).toHaveLength(1);
  });

  it('returns the latest stale lifecycle when the bounded retry budget is exhausted', async () => {
    const initial = createLoadedLifecycle('revision-1');
    const stale = createLoadedLifecycle('revision-2');
    const persistence = new ScriptedFinalizationPersistence(
      [{ status: 'loaded', lifecycle: initial }],
      [{ status: 'stale', lifecycle: stale }],
    );

    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
        staleRetryLimit: 0,
      }),
    ).resolves.toMatchObject({
      status: 'stale',
      lifecycle: stale,
      staleConflicts: 1,
      outcome: { kind: 'applied' },
    });
    expect(persistence.applyCalls).toHaveLength(1);
  });

  it('preserves the persistence already-applied result as a distinct outcome', async () => {
    const loaded = createLoadedLifecycle('revision-1');
    const concurrent = createLoadedLifecycle('revision-2');
    const persistence = new ScriptedFinalizationPersistence(
      [{ status: 'loaded', lifecycle: loaded }],
      [{ status: 'already_applied', lifecycle: concurrent }],
    );
    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
      }),
    ).resolves.toMatchObject({
      status: 'already_applied',
      source: 'persistence',
      lifecycle: concurrent,
      staleConflicts: 0,
      outcome: { kind: 'applied' },
    });
  });

  it.each([
    ['load', { status: 'missing' as const }],
    ['apply', { status: 'missing' as const }],
  ])('distinguishes a missing lifecycle during %s', async (stage, missingResult) => {
    const loaded = createLoadedLifecycle('revision-1');
    const persistence =
      stage === 'load'
        ? new ScriptedFinalizationPersistence([missingResult])
        : new ScriptedFinalizationPersistence([{ status: 'loaded', lifecycle: loaded }], [missingResult]);
    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
      }),
    ).resolves.toEqual({
      status: 'missing',
      stage,
      staleConflicts: 0,
    });
  });

  it.each(['load', 'apply'] as const)('distinguishes a persistence failure during %s', async (stage) => {
    const error = new Error(`${stage} failed`);
    const loaded = createLoadedLifecycle('revision-1');
    const failure = { status: 'persistence_failure' as const, error };
    const persistence =
      stage === 'load'
        ? new ScriptedFinalizationPersistence([failure])
        : new ScriptedFinalizationPersistence([{ status: 'loaded', lifecycle: loaded }], [failure]);
    await expect(
      coordinateFinalizationTransition({
        command: createQueueCommand(),
        evaluatedAtMs: EVALUATED_AT_MS,
        persistence,
      }),
    ).resolves.toEqual({
      status: 'persistence_failure',
      stage,
      error,
      staleConflicts: 0,
    });
  });

  it.each([
    ['missing', { status: 'missing' as const }],
    ['failure', { status: 'persistence_failure' as const, error: new Error('reload failed') }],
    ['invalid', { status: 'invalid_record' as const, error: new Error('reload invalid') }],
  ])('reports %s encountered while reloading after a conflict', async (_label, reloadResult) => {
    const loaded = createLoadedLifecycle('revision-1');
    const stale = createLoadedLifecycle('revision-2');
    const persistence = new ScriptedFinalizationPersistence(
      [{ status: 'loaded', lifecycle: loaded }, reloadResult],
      [{ status: 'stale', lifecycle: stale }],
    );

    const result = await coordinateFinalizationTransition({
      command: createQueueCommand(),
      evaluatedAtMs: EVALUATED_AT_MS,
      persistence,
      staleRetryLimit: 1,
    });
    expect(result).toMatchObject({
      status:
        reloadResult.status === 'persistence_failure'
          ? 'persistence_failure'
          : reloadResult.status === 'invalid_record'
            ? 'invalid_record'
            : 'missing',
      stage: 'load',
      staleConflicts: 1,
    });
  });
});
