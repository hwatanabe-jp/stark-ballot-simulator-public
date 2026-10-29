import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import {
  evaluateFinalizationTransition,
  type FinalizationLifecycleAuthority,
  type FinalizationTransitionCommand,
} from '@stark-ballot/application/finalize/finalization-transition-policy';
import type {
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';

const SESSION_ID = asSessionId('session-policy-current');
const FINALIZATION_ID = asFinalizationId('exec-policy-current');
const OTHER_FINALIZATION_ID = asFinalizationId('exec-policy-other');
const QUEUED_AT_MS = 1_700_000_000_000;
const STARTED_AT_MS = QUEUED_AT_MS + 1_000;
const TERMINAL_AT_MS = STARTED_AT_MS + 1_000;
const EVALUATED_AT_MS = TERMINAL_AT_MS + 1_000;

function createResult(): FinalizationResultAuthority {
  return buildFinalizationResultFromJournal({
    journal: createTestJournal(),
    imageId: `0x${'1'.repeat(64)}`,
  });
}

const SCENARIO_CONTEXT: FinalizationScenarioContext = {
  scenarios: ['S2'],
  tamperMode: 'claim',
  claimedCounts: { A: 0, B: 2, C: 1, D: 0, E: 0 },
  claimedTotalVotes: 3,
  summary: {
    ignoredCount: 0,
    recountedCount: 1,
    userRecountChoice: 'B',
  },
};

function createRecord(state: FinalizationState): FinalizationRecord {
  const base = {
    sessionId: SESSION_ID,
    finalizationId: state.finalizationId,
    scenarioContext: SCENARIO_CONTEXT,
    state,
  };
  return state.status === 'succeeded'
    ? {
        ...base,
        state,
        finalizationResult: {
          finalizationId: state.finalizationId,
          ...createResult(),
        },
      }
    : { ...base, state };
}

function createAuthority(currentState: FinalizationState | null): FinalizationLifecycleAuthority {
  return {
    currentRecord: currentState ? createRecord(currentState) : null,
  };
}

type FinalizationCommandKind = FinalizationTransitionCommand['kind'];
type FinalizationCommandOfKind<Kind extends FinalizationCommandKind> = Extract<
  FinalizationTransitionCommand,
  { kind: Kind }
>;

function createCommand<Kind extends FinalizationCommandKind>(
  kind: Kind,
  finalizationId = FINALIZATION_ID,
): FinalizationCommandOfKind<Kind> {
  const base = {
    sessionId: SESSION_ID,
    finalizationId,
    queuedAtMs: QUEUED_AT_MS,
    scenarioContext: SCENARIO_CONTEXT,
  };
  switch (kind) {
    case 'queue':
      return { ...base, kind } as FinalizationCommandOfKind<Kind>;
    case 'start':
      return { ...base, kind, startedAtMs: STARTED_AT_MS } as FinalizationCommandOfKind<Kind>;
    case 'succeed':
      return {
        ...base,
        kind,
        startedAtMs: STARTED_AT_MS,
        completedAtMs: TERMINAL_AT_MS,
        finalizationResult: createResult(),
      } as FinalizationCommandOfKind<Kind>;
    case 'fail':
      return {
        ...base,
        kind,
        startedAtMs: STARTED_AT_MS,
        failedAtMs: TERMINAL_AT_MS,
        error: {
          code: 'PROVER_TASK_FAILED',
          message: 'Prover task failed',
          category: 'prover_execution',
        },
      } as FinalizationCommandOfKind<Kind>;
    case 'time_out':
      return {
        ...base,
        kind,
        startedAtMs: STARTED_AT_MS,
        timeoutAtMs: TERMINAL_AT_MS,
      } as FinalizationCommandOfKind<Kind>;
    case 'cancel':
      return {
        ...base,
        kind,
        startedAtMs: STARTED_AT_MS,
        failedAtMs: TERMINAL_AT_MS,
        message: 'Cancelled by user request',
      } as FinalizationCommandOfKind<Kind>;
  }
}

const STATES = [
  ['none', null],
  ['pending', { status: 'pending', finalizationId: FINALIZATION_ID, queuedAtMs: QUEUED_AT_MS }],
  [
    'running',
    {
      status: 'running',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: QUEUED_AT_MS,
      startedAtMs: STARTED_AT_MS,
    },
  ],
  [
    'succeeded',
    {
      status: 'succeeded',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: QUEUED_AT_MS,
      startedAtMs: STARTED_AT_MS,
      completedAtMs: TERMINAL_AT_MS,
    },
  ],
  [
    'failed',
    {
      status: 'failed',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: QUEUED_AT_MS,
      startedAtMs: STARTED_AT_MS,
      failedAtMs: TERMINAL_AT_MS,
      error: { code: 'USER_CANCELLED', message: 'Cancelled by user request' },
    },
  ],
  [
    'timeout',
    {
      status: 'timeout',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: QUEUED_AT_MS,
      startedAtMs: STARTED_AT_MS,
      timeoutAtMs: TERMINAL_AT_MS,
    },
  ],
] as const satisfies ReadonlyArray<readonly [string, FinalizationState | null]>;

const COMMAND_KINDS = ['queue', 'start', 'succeed', 'fail', 'time_out', 'cancel'] as const;

function targetStatus(kind: FinalizationTransitionCommand['kind']): FinalizationState['status'] {
  switch (kind) {
    case 'queue':
      return 'pending';
    case 'start':
      return 'running';
    case 'succeed':
      return 'succeeded';
    case 'fail':
    case 'cancel':
      return 'failed';
    case 'time_out':
      return 'timeout';
  }
}

const EXPECTED_OUTCOMES = {
  none: {
    queue: 'applied',
    start: 'applied',
    succeed: 'applied',
    fail: 'applied',
    time_out: 'applied',
    cancel: 'rejected',
  },
  pending: {
    queue: 'idempotent',
    start: 'applied',
    succeed: 'applied',
    fail: 'applied',
    time_out: 'applied',
    cancel: 'applied',
  },
  running: {
    queue: 'applied',
    start: 'idempotent',
    succeed: 'applied',
    fail: 'applied',
    time_out: 'applied',
    cancel: 'applied',
  },
  succeeded: {
    queue: 'rejected',
    start: 'rejected',
    succeed: 'idempotent',
    fail: 'rejected',
    time_out: 'rejected',
    cancel: 'rejected',
  },
  failed: {
    queue: 'rejected',
    start: 'rejected',
    succeed: 'rejected',
    fail: 'idempotent',
    time_out: 'rejected',
    cancel: 'rejected',
  },
  timeout: {
    queue: 'rejected',
    start: 'rejected',
    succeed: 'rejected',
    fail: 'rejected',
    time_out: 'idempotent',
    cancel: 'rejected',
  },
} satisfies Record<(typeof STATES)[number][0], Record<FinalizationCommandKind, 'applied' | 'idempotent' | 'rejected'>>;

describe('evaluateFinalizationTransition state/command table', () => {
  it.each(
    STATES.flatMap(([stateName, state]) =>
      COMMAND_KINDS.map((commandKind) => ({
        stateName,
        state,
        commandKind,
      })),
    ),
  )('$stateName + $commandKind preserves the characterized transition policy', ({ stateName, state, commandKind }) => {
    const outcome = evaluateFinalizationTransition({
      authority: createAuthority(state),
      command: createCommand(commandKind),
      evaluatedAtMs: EVALUATED_AT_MS,
    });

    expect(outcome.kind).toBe(EXPECTED_OUTCOMES[stateName][commandKind]);
    if (outcome.kind === 'applied') {
      expect(outcome.state.status).toBe(targetStatus(commandKind));
    }
  });

  it.each(COMMAND_KINDS.filter((kind) => kind !== 'cancel'))(
    'rejects a stale finalization identity for %s without mutation',
    (kind) => {
      const currentState: FinalizationState = {
        status: 'running',
        finalizationId: FINALIZATION_ID,
        queuedAtMs: QUEUED_AT_MS,
        startedAtMs: STARTED_AT_MS,
      };
      expect(
        evaluateFinalizationTransition({
          authority: createAuthority(currentState),
          command: createCommand(kind, OTHER_FINALIZATION_ID),
          evaluatedAtMs: EVALUATED_AT_MS,
        }),
      ).toEqual({
        kind: 'rejected',
        state: currentState,
        reason: 'EXECUTION_MISMATCH',
      });
    },
  );

  it('keeps a failed terminal reason when a later callback targets another state', () => {
    const currentState: FinalizationState = {
      status: 'failed',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: QUEUED_AT_MS,
      failedAtMs: TERMINAL_AT_MS,
      error: { code: 'USER_CANCELLED', message: 'Cancelled by user request' },
    };
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(currentState),
        command: createCommand('succeed'),
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({
      kind: 'rejected',
      state: currentState,
      reason: 'USER_CANCELLED',
    });
  });
});

describe('evaluateFinalizationTransition record mutations', () => {
  it('returns one exact queued record without generation or adapter artifact fields', () => {
    const outcome = evaluateFinalizationTransition({
      authority: createAuthority(null),
      command: { ...createCommand('queue'), reason: 'FINALIZE_REQUESTED' },
      evaluatedAtMs: EVALUATED_AT_MS,
    });

    expect(outcome).toEqual({
      kind: 'applied',
      state: {
        status: 'pending',
        finalizationId: FINALIZATION_ID,
        queuedAtMs: QUEUED_AT_MS,
      },
      reason: 'FINALIZE_REQUESTED',
      mutations: {
        nextRecord: {
          sessionId: SESSION_ID,
          finalizationId: FINALIZATION_ID,
          scenarioContext: SCENARIO_CONTEXT,
          state: {
            status: 'pending',
            finalizationId: FINALIZATION_ID,
            queuedAtMs: QUEUED_AT_MS,
          },
        },
      },
    });
  });

  it('binds a successful result to the record finalization identity', () => {
    const result = createResult();
    const outcome = evaluateFinalizationTransition({
      authority: createAuthority({
        status: 'running',
        finalizationId: FINALIZATION_ID,
        queuedAtMs: QUEUED_AT_MS,
        startedAtMs: STARTED_AT_MS,
      }),
      command: { ...createCommand('succeed'), finalizationResult: result },
      evaluatedAtMs: EVALUATED_AT_MS,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') {
      expect(outcome.mutations.nextRecord.finalizationResult).toEqual({
        finalizationId: FINALIZATION_ID,
        ...result,
      });
    }
  });

  it('treats exact repeated nonterminal commands as idempotent but applies changed timestamps', () => {
    const currentState: FinalizationState = {
      status: 'running',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: QUEUED_AT_MS,
      startedAtMs: STARTED_AT_MS,
    };
    const authority = createAuthority(currentState);
    expect(
      evaluateFinalizationTransition({
        authority,
        command: createCommand('start'),
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({
      kind: 'idempotent',
      state: currentState,
      reason: 'IDEMPOTENT_RETRY',
    });
    expect(
      evaluateFinalizationTransition({
        authority,
        command: { ...createCommand('start'), startedAtMs: STARTED_AT_MS + 1 },
        evaluatedAtMs: EVALUATED_AT_MS,
      }).kind,
    ).toBe('applied');
  });
});

describe('evaluateFinalizationTransition command admission', () => {
  it.each([
    ['queued', { ...createCommand('queue'), queuedAtMs: -1 }],
    ['started', { ...createCommand('start'), startedAtMs: QUEUED_AT_MS - 1 }],
    ['completed', { ...createCommand('succeed'), completedAtMs: STARTED_AT_MS - 1 }],
    ['failed', { ...createCommand('fail'), failedAtMs: STARTED_AT_MS - 1 }],
    ['timeout', { ...createCommand('time_out'), timeoutAtMs: STARTED_AT_MS - 1 }],
  ] as const)('rejects an invalid %s timestamp without mutation', (_label, command) => {
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(null),
        command,
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({ kind: 'invalid', state: null, reason: 'invalid_timestamp' });
  });

  it.each(['', '../unsafe', 'with space'])('rejects invalid finalization identity %j', (finalizationId) => {
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(null),
        command: createCommand('queue', finalizationId as FinalizationId),
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({ kind: 'invalid', state: null, reason: 'invalid_finalization_id' });
  });

  it('rejects malformed failure data and proof-less success data', () => {
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(null),
        command: { ...createCommand('fail'), error: null } as unknown as FinalizationTransitionCommand,
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({ kind: 'invalid', state: null, reason: 'invalid_error' });
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(null),
        command: {
          ...createCommand('succeed'),
          finalizationResult: { ...createResult(), journal: undefined },
        } as unknown as FinalizationTransitionCommand,
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({ kind: 'invalid', state: null, reason: 'invalid_finalization_result' });
  });

  it('resolves terminal and stale authority before admitting a success result', () => {
    const invalidSuccess = {
      ...createCommand('succeed'),
      finalizationResult: {},
    } as FinalizationTransitionCommand;
    const terminalState: FinalizationState = {
      status: 'failed',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: QUEUED_AT_MS,
      failedAtMs: TERMINAL_AT_MS,
      error: { code: 'USER_CANCELLED', message: 'Cancelled by user request' },
    };
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(terminalState),
        command: invalidSuccess,
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({ kind: 'rejected', state: terminalState, reason: 'USER_CANCELLED' });

    const currentState: FinalizationState = {
      status: 'running',
      finalizationId: OTHER_FINALIZATION_ID,
      queuedAtMs: QUEUED_AT_MS,
      startedAtMs: STARTED_AT_MS,
    };
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(currentState),
        command: invalidSuccess,
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({ kind: 'rejected', state: currentState, reason: 'EXECUTION_MISMATCH' });
  });

  it('rejects invalid scenario context and evaluation time', () => {
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(null),
        command: {
          ...createCommand('queue'),
          scenarioContext: { ...SCENARIO_CONTEXT, tamperMode: 'unsupported' },
        } as unknown as FinalizationTransitionCommand,
        evaluatedAtMs: EVALUATED_AT_MS,
      }),
    ).toEqual({ kind: 'invalid', state: null, reason: 'invalid_scenario_context' });
    expect(
      evaluateFinalizationTransition({
        authority: createAuthority(null),
        command: createCommand('queue'),
        evaluatedAtMs: Number.NaN,
      }),
    ).toEqual({ kind: 'invalid', state: null, reason: 'invalid_evaluation_time' });
  });
});
