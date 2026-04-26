/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { FinalizationState } from '../../../../src/types/server';
import { evaluateDispatchPreconditions } from '../dispatch-guard';

function buildState(state: FinalizationState): FinalizationState {
  return state;
}

describe('evaluateDispatchPreconditions', () => {
  it('allows dispatch when session exists and finalization is pending with matching execution', () => {
    const result = evaluateDispatchPreconditions(
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      },
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        finalizationState: buildState({
          status: 'pending',
          executionId: '01HVN5WA1CEH94868G90QGJ7HX',
          queuedAt: 1730000000000,
        }),
      },
    );

    expect(result).toEqual({ ok: true });
  });

  it('rejects when session does not exist', () => {
    const result = evaluateDispatchPreconditions(
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      },
      null,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('rejects when finalization state is missing', () => {
    const result = evaluateDispatchPreconditions(
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      },
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        finalizationState: null,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'FINALIZATION_STATE_MISSING',
    });
  });

  it('rejects when executionId does not match session state', () => {
    const result = evaluateDispatchPreconditions(
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      },
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        finalizationState: buildState({
          status: 'pending',
          executionId: '01HVN5WA1CEH94868G90QGJ7HY',
          queuedAt: 1730000000000,
        }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'EXECUTION_ID_MISMATCH',
    });
  });

  it('rejects when session is not in pending state', () => {
    const result = evaluateDispatchPreconditions(
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      },
      {
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        finalizationState: buildState({
          status: 'running',
          executionId: '01HVN5WA1CEH94868G90QGJ7HX',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
        }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'FINALIZATION_NOT_PENDING',
    });
  });
});
