import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { buildFinalizationResultFromJournal } from './finalization-result';
import { describe, it, expect, vi } from 'vitest';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from './finalization-id';
import type { FinalizationRecord } from './finalization-record';
import {
  reconcileFinalization,
  type FinalizationReconciliationPorts,
  type FinalizationExecutionObservation,
} from './reconcile-finalization';

const sessionId = asSessionId('reconciliation-session');
const finalizationId = asFinalizationId('reconciliation-execution');
const nowMs = 2_000_000;
const input = { sessionId, finalizationId, nowMs, dispatchDeadlineMs: 900_000 };
function setup(status: 'pending' | 'running' = 'pending', queuedAtMs = 100_000) {
  const record: FinalizationRecord = {
    sessionId,
    finalizationId,
    scenarioContext: {
      scenarios: [],
      tamperMode: 'none',
      claimedCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 0,
      summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
    },
    state:
      status === 'pending'
        ? { status, finalizationId, queuedAtMs }
        : { status, finalizationId, queuedAtMs, startedAtMs: queuedAtMs + 1000 },
  };
  const store = {
    getCurrentFinalizationRecord: vi
      .fn<FinalizationReconciliationPorts['store']['getCurrentFinalizationRecord']>()
      .mockResolvedValue(record),
    markFinalizationFailed: vi
      .fn<FinalizationReconciliationPorts['store']['markFinalizationFailed']>()
      .mockResolvedValue(record),
    markFinalizationTimedOut: vi
      .fn<FinalizationReconciliationPorts['store']['markFinalizationTimedOut']>()
      .mockResolvedValue(record),
  };
  const observeExecution = vi
    .fn<FinalizationReconciliationPorts['observeExecution']>()
    .mockResolvedValue({ status: 'missing' });
  return { record, store, observeExecution };
}

describe('finalization reconciliation', () => {
  it('discovers a dispatch that never started and records its timeout without a reader', async () => {
    const ports = setup();
    await reconcileFinalization(input, ports);
    expect(ports.observeExecution).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(ports.store.markFinalizationFailed).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        finalizationId,
        error: expect.objectContaining({ code: 'FINALIZATION_DISPATCH_TIMEOUT' }),
        observability: { source: 'reconcile', reason: 'FINALIZATION_DISPATCH_TIMEOUT' },
      }),
    );
  });
  it.each([59_999, 900_000, 900_001])('respects dispatch deadline at age %i', async (age) => {
    const ports = setup('pending', nowMs - age);
    await reconcileFinalization(input, ports);
    expect(ports.observeExecution).toHaveBeenCalledTimes(age < 60_000 ? 0 : 1);
    expect(ports.store.markFinalizationFailed).toHaveBeenCalledTimes(age > 900_000 ? 1 : 0);
  });
  it.each(['succeeded', 'failed', 'timed_out', 'aborted'] as const)(
    'rejects unrecorded pending outcome %s',
    async (status) => {
      const ports = setup();
      ports.observeExecution.mockResolvedValue({ status, stoppedAtMs: nowMs - 60_000 });
      await reconcileFinalization(input, ports);
      expect(ports.store.markFinalizationFailed).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ error: expect.objectContaining({ code: 'FINALIZATION_OUTCOME_UNRECORDED' }) }),
      );
    },
  );
  it.each([
    ['failed', 'PROVER_EXECUTION_FAILED'],
    ['aborted', 'PROVER_EXECUTION_ABORTED'],
    ['succeeded', 'FINALIZATION_OUTCOME_UNRECORDED'],
  ] as const)('records running execution %s without treating execution success as proof', async (status, code) => {
    const ports = setup('running');
    ports.observeExecution.mockResolvedValue({ status, stoppedAtMs: nowMs - 60_000 });
    await reconcileFinalization(input, ports);
    expect(ports.store.markFinalizationFailed).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ error: expect.objectContaining({ code }) }),
    );
  });
  it('persists a running execution timeout', async () => {
    const ports = setup('running');
    ports.observeExecution.mockResolvedValue({ status: 'timed_out', stoppedAtMs: nowMs - 60_000 });
    await reconcileFinalization(input, ports);
    expect(ports.store.markFinalizationTimedOut).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ finalizationId, timeoutAtMs: nowMs - 60_000 }),
    );
  });
  it.each<FinalizationExecutionObservation>([
    { status: 'running' },
    { status: 'succeeded', stoppedAtMs: nowMs - 59_999 },
  ])('waits for ongoing execution or delayed writer: $status', async (observation) => {
    const ports = setup();
    ports.observeExecution.mockResolvedValue(observation);
    await reconcileFinalization(input, ports);
    expect(ports.store.markFinalizationFailed).not.toHaveBeenCalled();
  });
  it('propagates observation and persistence failures for worker retry, never returns projected state', async () => {
    const ports = setup();
    ports.observeExecution.mockRejectedValueOnce(new Error('observation failed'));
    await expect(reconcileFinalization(input, ports)).rejects.toThrow('observation failed');
    ports.store.markFinalizationFailed.mockRejectedValueOnce(new Error('write failed'));
    await expect(reconcileFinalization(input, ports)).rejects.toThrow('write failed');
    expect(ports.store.getCurrentFinalizationRecord).toHaveBeenCalledTimes(3);
  });
  it('re-reads a concurrent cancellation after CAS rejection and ignores duplicate work', async () => {
    const ports = setup();
    const cancelled: FinalizationRecord = {
      ...ports.record,
      state: {
        status: 'failed',
        finalizationId,
        queuedAtMs: 100_000,
        failedAtMs: nowMs,
        error: { code: 'USER_CANCELLED', message: 'Cancelled' },
      },
    };
    ports.store.markFinalizationFailed.mockImplementation(async () => {
      ports.store.getCurrentFinalizationRecord.mockResolvedValue(cancelled);
      throw new Error('CAS rejected');
    });
    await reconcileFinalization(input, ports);
    await reconcileFinalization(input, ports);
    expect(ports.observeExecution).toHaveBeenCalledTimes(1);
    expect(ports.store.markFinalizationFailed).toHaveBeenCalledTimes(1);
  });
  it('preserves a successful writer that wins CAS and ignores later duplicate reconciliation', async () => {
    const ports = setup('running');
    const journal = createTestJournal();
    const [A, B, C, D, E] = journal.verifiedTally;
    const scenarioContext = {
      ...ports.record.scenarioContext,
      claimedCounts: { A, B, C, D, E },
      claimedTotalVotes: journal.validVotes,
    };
    const succeeded: FinalizationRecord = {
      sessionId,
      finalizationId,
      scenarioContext,
      state: { status: 'succeeded', finalizationId, queuedAtMs: 100_000, startedAtMs: 101_000, completedAtMs: nowMs },
      finalizationResult: {
        finalizationId,
        ...buildFinalizationResultFromJournal({ journal, scenarioContext, imageId: `0x${'1'.repeat(64)}` }),
      },
    };
    ports.observeExecution.mockResolvedValue({ status: 'succeeded', stoppedAtMs: nowMs - 60_000 });
    ports.store.markFinalizationFailed.mockImplementation(async () => {
      ports.store.getCurrentFinalizationRecord.mockResolvedValue(succeeded);
      throw new Error('Writer won CAS');
    });
    await reconcileFinalization(input, ports);
    await reconcileFinalization(input, ports);
    expect(ports.store.markFinalizationFailed).toHaveBeenCalledTimes(1);
    expect(ports.observeExecution).toHaveBeenCalledTimes(1);
    expect(await ports.store.getCurrentFinalizationRecord(sessionId)).toBe(succeeded);
  });

  it('ignores stale identity, missing records and out-of-order candidates', async () => {
    const ports = setup();
    await reconcileFinalization({ ...input, finalizationId: asFinalizationId('stale-execution') }, ports);
    ports.store.getCurrentFinalizationRecord.mockResolvedValue(null);
    await reconcileFinalization(input, ports);
    expect(ports.observeExecution).not.toHaveBeenCalled();
  });
});
