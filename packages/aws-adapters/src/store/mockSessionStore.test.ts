import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationResultAuthority,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import { logger } from '@stark-ballot/diagnostics/logger';
import type {
  BotVoteCommand,
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
  UserVoteCommand,
} from '@stark-ballot/domain/types/sessionRecords';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { MockSessionStore } from './mockSessionStore';
import { computeSuccessfulFinalizationReceiptHash } from './successfulFinalizationReceipt';

const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 1,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function getPrivateMap<T>(store: MockSessionStore, property: string): Map<string, T> {
  const value: unknown = Reflect.get(store, property);
  if (!(value instanceof Map)) {
    throw new Error(`Expected ${property} to be a Map`);
  }
  return value as Map<string, T>;
}

function scopedKey(sessionId: string, finalizationId: string): string {
  return `${sessionId}\u0000${finalizationId}`;
}

function buildVote(choice: UserVoteCommand['vote'], randomNibble: string, voteId = generateVoteId()): UserVoteCommand {
  return {
    voteId,
    vote: choice,
    rand: `0x${randomNibble.repeat(64)}`,
    timestamp: 1_730_000_000_000,
  };
}

function buildBotVote(choice: BotVoteCommand['vote'], randomNibble: string): BotVoteCommand {
  return {
    vote: choice,
    rand: `0x${randomNibble.repeat(64)}`,
  };
}

function buildResult(journal = createTestJournal()): FinalizationResultAuthority {
  return buildFinalizationResultFromJournal({
    journal,
    imageId: journal.imageId ?? `0x${'1'.repeat(64)}`,
  });
}

function buildSucceededRecord(
  sessionId: SessionId,
  finalizationId: string,
  result = buildResult(),
): Extract<FinalizationRecord, { state: { status: 'succeeded' } }> {
  const admittedFinalizationId = asFinalizationId(finalizationId);
  return {
    sessionId,
    finalizationId: admittedFinalizationId,
    scenarioContext,
    state: {
      status: 'succeeded',
      finalizationId: admittedFinalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
    },
    finalizationResult: {
      finalizationId: admittedFinalizationId,
      ...result,
    },
  };
}

describe('MockSessionStore', () => {
  let store: MockSessionStore;
  let identity: SessionIdentityRecord;
  let sessionId: SessionId;
  let warnLog: MockInstance<typeof logger.warn>;

  function consumeRejectedTransitionLogs(
    ...expected: Array<{ finalizationId: string; reason: string; to: string }>
  ): void {
    expect(warnLog).toHaveBeenCalledTimes(expected.length);
    expected.forEach(({ finalizationId, reason, to }, index) => {
      expect(warnLog).toHaveBeenNthCalledWith(
        index + 1,
        'finalize_state_update_rejected',
        expect.objectContaining({
          event: 'finalize_state_update_rejected',
          finalization_id: finalizationId,
          reason,
          to,
        }),
      );
    });
    warnLog.mockClear();
  }

  async function succeed(
    finalizationId: string,
    targetSessionId: SessionId = sessionId,
  ): Promise<Extract<FinalizationRecord, { state: { status: 'succeeded' } }>> {
    const record = await store.markFinalizationSucceeded(targetSessionId, {
      finalizationId: asFinalizationId(finalizationId),
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
      scenarioContext,
      finalizationResult: buildResult(),
    });
    if (record.state.status !== 'succeeded') {
      throw new Error('Expected succeeded finalization');
    }
    return record as Extract<FinalizationRecord, { state: { status: 'succeeded' } }>;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    store = new MockSessionStore();
    identity = await store.createSession();
    sessionId = identity.sessionId;
  });

  afterEach(() => {
    try {
      expect(warnLog).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not expose standalone receipt-board publication', () => {
    expect('saveReceiptToBoard' in store).toBe(false);
    expect(Reflect.get(store, 'saveReceiptToBoard')).toBeUndefined();
  });

  it('creates complete separate identity and voting records', async () => {
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');

    expect(identity.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identity.electionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identity.electionConfigHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(identity.logId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(identity.createdAtMs).toEqual(expect.any(Number));
    expect(voting).toMatchObject({
      sessionId,
      botCount: 0,
      userParticipation: { status: 'not_cast' },
    });
    expect(voting.votes.size).toBe(0);
    expect(voting.bulletinRootHistory).toEqual([]);
    expect(voting.bulletin.getLogId()).toBe(identity.logId);
    expect(await store.getCurrentFinalizationRecord(sessionId)).toBeNull();
    expect('getSession' in store).toBe(false);
  });

  it('rejects a duplicate vote ID without changing vote or bulletin indexes', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));
    const before = requireValue(await store.getVotingRecord(sessionId), 'voting record');

    await expect(store.addVote(sessionId, buildVote('B', 'b', voteId))).resolves.toEqual({
      ok: false,
      error: { code: 'DUPLICATE_VOTE', details: { duplicateKind: 'voteId' } },
    });

    const after = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    expect(after.votes).toEqual(before.votes);
    expect(after.bulletin.getSize()).toBe(1);
    expect(after.bulletinRootHistory).toEqual(before.bulletinRootHistory);
    expect(after.userParticipation).toEqual({ status: 'cast', voteIndex: 0 });
  });

  it('records one verification observation per current finalization idempotently', async () => {
    const finalizationId = asFinalizationId('verification-observation');
    await succeed(finalizationId);

    await expect(
      store.recordVerificationObservation(sessionId, finalizationId, {
        fingerprint: 'a'.repeat(64),
        observedAt: 100,
      }),
    ).resolves.toEqual({ status: 'recorded' });
    await expect(
      store.recordVerificationObservation(sessionId, finalizationId, {
        fingerprint: 'a'.repeat(64),
        observedAt: 101,
      }),
    ).resolves.toEqual({ status: 'idempotent' });
    await expect(
      store.recordVerificationObservation(sessionId, finalizationId, {
        fingerprint: 'b'.repeat(64),
        observedAt: 102,
      }),
    ).resolves.toEqual({ status: 'conflict', reason: 'fingerprint_mismatch' });
    expect(store.getVerificationObservation(sessionId, finalizationId)).toEqual({
      finalizationId,
      fingerprint: 'a'.repeat(64),
      observedAt: 100,
    });
  });

  it('rejects a verification observation for a stale finalization', async () => {
    await succeed('verification-current');

    await expect(
      store.recordVerificationObservation(sessionId, 'verification-stale', {
        fingerprint: 'c'.repeat(64),
        observedAt: 100,
      }),
    ).resolves.toEqual({ status: 'conflict', reason: 'finalization_mismatch' });
    expect(store.getVerificationObservation(sessionId, 'verification-stale')).toBeNull();
  });

  it('persists proof-bundle delivery metadata outside pure finalization authority', async () => {
    await store.recordAwsProofBundlePublication(sessionId, asFinalizationId('delivery-separate'), {
      s3BundleKey: `sessions/${sessionId}/delivery-separate/bundle.zip`,
      s3ReportKey: `sessions/${sessionId}/delivery-separate/verification.json`,
      s3UploadedAtMs: 35,
    });

    expect(await store.getCurrentFinalizationRecord(sessionId)).toBeNull();
    expect(await store.getAwsVerificationDeliveryMetadata(sessionId, asFinalizationId('delivery-separate'))).toEqual({
      s3BundleKey: `sessions/${sessionId}/delivery-separate/bundle.zip`,
      s3ReportKey: `sessions/${sessionId}/delivery-separate/verification.json`,
      s3UploadedAtMs: 35,
    });
  });

  it('deletes staged delivery metadata when an expired session is evicted', async () => {
    const finalizationId = asFinalizationId('expired-delivery');
    await store.recordAwsProofBundlePublication(sessionId, finalizationId, {
      s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
      s3UploadedAtMs: 35,
    });
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    getPrivateMap<SessionVotingRecord>(store, 'votingRecords').set(sessionId, {
      ...voting,
      lastActivityMs: Date.now() - 5 * 60 * 1000 - 1,
    });

    await expect(store.getActiveSessionCount()).resolves.toBe(0);

    await expect(store.getSessionIdentity(sessionId)).resolves.toBeNull();
    await expect(store.getAwsVerificationDeliveryMetadata(sessionId, finalizationId)).resolves.toBeUndefined();
  });

  it('persists scenario context on queue without a contract generation', async () => {
    const record = await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('queue-context'),
      queuedAtMs: 10,
      scenarioContext: {
        ...scenarioContext,
        scenarios: ['S2'],
        tamperMode: 'claim',
      },
    });

    expect(record).toMatchObject({
      sessionId,
      finalizationId: 'queue-context',
      scenarioContext: {
        scenarios: ['S2'],
        tamperMode: 'claim',
      },
      state: {
        status: 'pending',
        finalizationId: 'queue-context',
        queuedAtMs: 10,
      },
    });
    expect(Object.hasOwn(record, 'contractGeneration')).toBe(false);
  });

  it('records queued to running to succeeded transitions with adapter metadata separate', async () => {
    const finalizationId = asFinalizationId('transition-success');
    await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    await store.markAwsFinalizationRunning(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:test',
    });
    await store.markAwsFinalizationSucceeded(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
      finalizationResult: buildResult(),
      bundleMetadata: {
        s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
        s3UploadedAtMs: 31,
      },
    });

    const record = requireValue(await store.getCurrentFinalizationRecord(sessionId), 'finalization');
    expect(record.state.status).toBe('succeeded');
    expect(record).not.toHaveProperty('stepFunctionsArn');
    expect(record).not.toHaveProperty('bundleMetadata');
    expect(record.finalizationResult).not.toHaveProperty('s3BundleKey');
    expect(await store.getAwsFinalizationRuntimeMetadata(sessionId, finalizationId)).toEqual({
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:test',
      bundleMetadata: {
        s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
        s3UploadedAtMs: 31,
      },
    });
  });

  it('keeps the current running state when a competing stale finalization arrives', async () => {
    await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('running-current'),
      queuedAtMs: 10,
      scenarioContext,
    });
    await store.markAwsFinalizationRunning(sessionId, {
      finalizationId: asFinalizationId('running-current'),
      queuedAtMs: 10,
      startedAtMs: 20,
    });

    await expect(
      store.markAwsFinalizationRunning(sessionId, {
        finalizationId: asFinalizationId('running-stale'),
        queuedAtMs: 11,
        startedAtMs: 21,
        scenarioContext,
        stepFunctionsArn: 'arn:stale',
      }),
    ).resolves.toMatchObject({ status: 'running', finalizationId: 'running-current' });
    expect(await store.getAwsFinalizationRuntimeMetadata(sessionId, asFinalizationId('running-stale'))).toBeUndefined();
    consumeRejectedTransitionLogs({
      finalizationId: 'running-stale',
      reason: 'EXECUTION_MISMATCH',
      to: 'running',
    });
  });

  it('keeps USER_CANCELLED failed state when a running update arrives later', async () => {
    const finalizationId = asFinalizationId('cancel-sticky');
    await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    const failed = await store.markFinalizationFailed(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      failedAtMs: 20,
      error: { code: 'USER_CANCELLED', message: 'Cancelled by user' },
    });
    const retried = await store.markFinalizationRunning(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 21,
    });

    expect(failed.state).toMatchObject({ status: 'failed', error: { code: 'USER_CANCELLED' } });
    expect(retried).toEqual(failed);
    consumeRejectedTransitionLogs({
      finalizationId,
      reason: 'USER_CANCELLED',
      to: 'running',
    });
  });

  it('keeps terminal finalization states sticky', async () => {
    for (const status of ['succeeded', 'failed', 'timeout'] as const) {
      const localStore = new MockSessionStore();
      const localIdentity = await localStore.createSession();
      const finalizationId = asFinalizationId(`terminal-${status}`);
      if (status === 'succeeded') {
        await localStore.markFinalizationSucceeded(localIdentity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          scenarioContext,
          finalizationResult: buildResult(),
        });
      } else if (status === 'failed') {
        await localStore.markFinalizationFailed(localIdentity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          failedAtMs: 30,
          scenarioContext,
          error: { code: 'FAILED', message: 'failure' },
        });
      } else {
        await localStore.markFinalizationTimedOut(localIdentity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          timeoutAtMs: 30,
          scenarioContext,
        });
      }

      const retried = await localStore.markFinalizationRunning(localIdentity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 40,
      });
      expect(retried.state.status).toBe(status);
    }
    consumeRejectedTransitionLogs(
      { finalizationId: 'terminal-succeeded', reason: 'TERMINAL_STATE_STICKY', to: 'running' },
      { finalizationId: 'terminal-failed', reason: 'TERMINAL_STATE_STICKY', to: 'running' },
      { finalizationId: 'terminal-timeout', reason: 'TERMINAL_STATE_STICKY', to: 'running' },
    );
  });

  it('does not apply success side effects when success arrives after failure', async () => {
    const finalizationId = asFinalizationId('failure-before-success');
    await store.markFinalizationFailed(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      failedAtMs: 20,
      scenarioContext,
      error: { code: 'FAILED', message: 'failure' },
    });

    await expect(
      store.markAwsFinalizationSucceeded(sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        finalizationResult: buildResult(),
        stepFunctionsArn: 'arn:late',
        bundleMetadata: { s3BundleKey: 'late/bundle.zip', s3UploadedAtMs: 31 },
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(await store.getAwsFinalizationRuntimeMetadata(sessionId, finalizationId)).toBeUndefined();
    expect(await store.getAwsVerificationDeliveryMetadata(sessionId, finalizationId)).toBeUndefined();
  });

  it('rejects widened pure lifecycle payloads', async () => {
    await expect(
      store.markFinalizationQueued(sessionId, {
        finalizationId: 'widened-queued',
        queuedAtMs: 10,
        scenarioContext,
        contractGeneration: 'retired',
      } as never),
    ).rejects.toThrow('Invalid queued finalization payload');
    await expect(
      store.markFinalizationRunning(sessionId, {
        finalizationId: 'widened-running',
        queuedAtMs: 10,
        startedAtMs: 20,
        scenarioContext,
        stepFunctionsArn: 'arn:not-pure',
      } as never),
    ).rejects.toThrow('Invalid running finalization payload');
    await expect(
      store.markFinalizationSucceeded(sessionId, {
        finalizationId: 'widened-succeeded',
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: buildResult(),
        bundleMetadata: {},
      } as never),
    ).rejects.toThrow('Invalid succeeded finalization payload');
    await expect(
      store.markFinalizationFailed(sessionId, {
        finalizationId: 'widened-failed',
        queuedAtMs: 10,
        failedAtMs: 20,
        scenarioContext,
        error: { code: 'FAILED', message: 'failure' },
        stepFunctionsArn: 'arn:not-pure',
      } as never),
    ).rejects.toThrow('Invalid failed finalization payload');
    await expect(
      store.markFinalizationTimedOut(sessionId, {
        finalizationId: 'widened-timeout',
        queuedAtMs: 10,
        timeoutAtMs: 20,
        scenarioContext,
        contractGeneration: 'retired',
      } as never),
    ).rejects.toThrow('Invalid timed-out finalization payload');
  });

  it('prevents stale execution updates through the explicit current index', async () => {
    const current = await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('indexed-current'),
      queuedAtMs: 10,
      scenarioContext,
    });
    await store.markFinalizationRunning(sessionId, {
      finalizationId: asFinalizationId('indexed-stale'),
      queuedAtMs: 11,
      startedAtMs: 21,
      scenarioContext,
    });

    expect(await store.getCurrentFinalizationRecord(sessionId)).toEqual(current);
    expect(await store.getFinalizationRecord(sessionId, asFinalizationId('indexed-stale'))).toBeNull();
    consumeRejectedTransitionLogs({
      finalizationId: 'indexed-stale',
      reason: 'EXECUTION_MISMATCH',
      to: 'running',
    });
  });

  it('ignores duplicate terminal verification completion for the same finalization', async () => {
    const finalizationId = asFinalizationId('verification-terminal');
    await succeed(finalizationId);
    const completed = await store.completeVerificationResult(sessionId, finalizationId, {
      status: 'success',
    });

    await expect(
      store.completeVerificationResult(sessionId, finalizationId, {
        status: 'failed',
        failureCategory: 'verifier_crash',
      }),
    ).resolves.toEqual(completed);
  });

  it('rejects stale verification completion for another finalization', async () => {
    await succeed('verification-authority');

    await expect(
      store.completeVerificationResult(sessionId, asFinalizationId('verification-stale'), {
        status: 'success',
      }),
    ).rejects.toThrow('Finalization is unavailable for verification');
    expect(await store.getVerificationResultRecord(sessionId, asFinalizationId('verification-stale'))).toBeNull();
  });

  it('rejects retired contract-generation fields without mutating authority', async () => {
    await expect(
      store.markFinalizationQueued(sessionId, {
        finalizationId: 'retired-generation',
        queuedAtMs: 10,
        scenarioContext,
        contractGeneration: 'current-v0',
      } as never),
    ).rejects.toThrow('Invalid queued finalization payload');
    expect(await store.getCurrentFinalizationRecord(sessionId)).toBeNull();
  });

  it('rejects finalization results that carry a foreign bundle locator', async () => {
    await expect(
      store.markFinalizationSucceeded(sessionId, {
        finalizationId: asFinalizationId('foreign-locator'),
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: {
          ...buildResult(),
          s3BundleKey: 'foreign/bundle.zip',
        } as never,
      }),
    ).rejects.toThrow('invalid_finalization_result');
    expect(await store.getCurrentFinalizationRecord(sessionId)).toBeNull();
  });

  it('keeps the exact semantic record authoritative after an adapter branch exists', async () => {
    const finalizationId = asFinalizationId('semantic-authority');
    await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    await store.markAwsFinalizationRunning(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      stepFunctionsArn: 'arn:runtime',
    });

    const record = requireValue(await store.getCurrentFinalizationRecord(sessionId), 'finalization');
    expect(Object.keys(record).sort()).toEqual(['finalizationId', 'scenarioContext', 'sessionId', 'state']);
    expect(record.state).toEqual({
      status: 'running',
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
    });
    expect(await store.getAwsFinalizationRuntimeMetadata(sessionId, finalizationId)).toEqual({
      stepFunctionsArn: 'arn:runtime',
    });
  });

  it('does not reconcile historical records into the explicit current index', async () => {
    const current = await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('current-record'),
      queuedAtMs: 10,
      scenarioContext,
    });
    const historicalFinalizationId = asFinalizationId('historical-record');
    const historical: FinalizationRecord = {
      sessionId,
      finalizationId: historicalFinalizationId,
      scenarioContext,
      state: {
        status: 'pending',
        finalizationId: historicalFinalizationId,
        queuedAtMs: 11,
      },
    };
    getPrivateMap<FinalizationRecord>(store, 'finalizationRecords').set(
      scopedKey(sessionId, 'historical-record'),
      historical,
    );

    expect(await store.getCurrentFinalizationRecord(sessionId)).toEqual(current);
    expect(await store.getFinalizationRecord(sessionId, historicalFinalizationId)).toEqual(historical);
  });

  it('rejects write-side updates against a corrupt current finalization record', async () => {
    const finalizationId = asFinalizationId('corrupt-write');
    const record = await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    getPrivateMap<unknown>(store, 'finalizationRecords').set(scopedKey(sessionId, finalizationId), {
      ...record,
      legacyGeneration: 'retired',
    });

    await expect(
      store.markFinalizationRunning(sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
      }),
    ).rejects.toThrow('Current finalization record is missing or invalid');
  });

  it('does not expose repair APIs or repair corrupt finalization records on read', async () => {
    const finalizationId = asFinalizationId('corrupt-no-repair');
    const record = await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    const corrupt = { ...record, repairMarker: true };
    const records = getPrivateMap<unknown>(store, 'finalizationRecords');
    records.set(scopedKey(sessionId, finalizationId), corrupt);

    await expect(store.getCurrentFinalizationRecord(sessionId)).rejects.toThrow(
      'Current finalization record is missing or invalid',
    );
    expect('repairSession' in store).toBe(false);
    expect(records.get(scopedKey(sessionId, finalizationId))).toBe(corrupt);
  });

  it('does not publish receipts or consume board indexes for stale attempts', async () => {
    await succeed('receipt-current');
    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(sessionId, 'receipt-stale'),
        receipt: { receipt: 'stale', timestamp: 40 },
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow('Stale successful finalization commit');

    const fresh = await store.createSession();
    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(fresh.sessionId, 'receipt-fresh'),
        receipt: { receipt: 'fresh', timestamp: 41 },
        bitmap: { availability: 'unavailable' },
      }),
    ).resolves.toMatchObject({ receiptPublication: { boardIndex: 100 } });
  });

  it('does not publish receipts or consume board indexes for corrupt current records', async () => {
    const finalizationId = asFinalizationId('receipt-corrupt');
    const record = await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    getPrivateMap<unknown>(store, 'finalizationRecords').set(scopedKey(sessionId, finalizationId), {
      ...record,
      corrupt: true,
    });

    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(sessionId, finalizationId),
        receipt: { receipt: 'corrupt', timestamp: 40 },
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow('Current finalization record is missing or invalid');

    const fresh = await store.createSession();
    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(fresh.sessionId, 'receipt-after-corrupt'),
        receipt: { receipt: 'fresh', timestamp: 41 },
        bitmap: { availability: 'unavailable' },
      }),
    ).resolves.toMatchObject({ receiptPublication: { boardIndex: 100 } });
  });

  it('does not partially publish a successful outcome when voting authority disappears before commit', async () => {
    const finalizationId = asFinalizationId('missing-voting-before-success');
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const result = buildResult({
      ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    });
    getPrivateMap<SessionVotingRecord>(store, 'votingRecords').delete(sessionId);

    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(sessionId, finalizationId, result),
        receipt: { receipt: '{"atomic":true}', timestamp: 30 },
        verificationResult: { status: 'success' },
        bitmap: {
          availability: 'available',
          data: { includedBitmap, includedBitmapRoot, treeSize: 1, finalizedAtMs: 30 },
        },
        runtimeMetadata: {
          stepFunctionsArn: 'arn:aws:states:local:execution:missing-voting',
          bundleMetadata: {
            s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
            s3UploadedAtMs: 31,
          },
        },
      }),
    ).rejects.toThrow('Session voting record is missing or invalid');

    await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toBeNull();
    await expect(store.getVerificationResultRecord(sessionId, finalizationId)).resolves.toBeNull();
    await expect(store.getBitmapData(sessionId, finalizationId)).resolves.toBeNull();
    await expect(store.getAwsFinalizationRuntimeMetadata(sessionId, finalizationId)).resolves.toBeUndefined();
    await expect(store.getAwsVerificationDeliveryMetadata(sessionId, finalizationId)).resolves.toBeUndefined();
    expect(Reflect.get(store, 'receiptCounter')).toBe(100);
  });

  it('does not partially publish a successful outcome when staged bitmap persistence fails', async () => {
    const finalizationId = asFinalizationId('bitmap-write-failure-before-success');
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const result = buildResult({
      ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    });
    const pending = await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    // Keep the native method so the prototype spy can fail only the staged bitmap write.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalSet = Map.prototype.set;
    const mapSet = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value,
    ) {
      if (
        key === scopedKey(sessionId, finalizationId) &&
        typeof value === 'object' &&
        value !== null &&
        'includedBitmap' in value
      ) {
        throw new Error('forced bitmap write failure');
      }
      return originalSet.call(this, key, value);
    });

    try {
      await expect(
        store.commitSuccessfulFinalization({
          record: buildSucceededRecord(sessionId, finalizationId, result),
          receipt: { receipt: '{"atomic":true}', timestamp: 30 },
          verificationResult: { status: 'success' },
          bitmap: {
            availability: 'available',
            data: { includedBitmap, includedBitmapRoot, treeSize: 1, finalizedAtMs: 30 },
          },
          runtimeMetadata: {
            stepFunctionsArn: 'arn:aws:states:local:execution:bitmap-write-failure',
            bundleMetadata: {
              s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
              s3UploadedAtMs: 31,
            },
          },
        }),
      ).rejects.toThrow('forced bitmap write failure');
    } finally {
      mapSet.mockRestore();
    }

    await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toEqual(pending);
    await expect(store.getVerificationResultRecord(sessionId, finalizationId)).resolves.toBeNull();
    await expect(store.getBitmapData(sessionId, finalizationId)).resolves.toBeNull();
    await expect(store.getAwsFinalizationRuntimeMetadata(sessionId, finalizationId)).resolves.toBeUndefined();
    await expect(store.getAwsVerificationDeliveryMetadata(sessionId, finalizationId)).resolves.toBeUndefined();
    expect(getPrivateMap<unknown>(store, 'receipts').has(scopedKey(sessionId, finalizationId))).toBe(false);
    expect(Reflect.get(store, 'receiptCounter')).toBe(100);
  });

  it.each(['bitmap', 'verification'] as const)(
    'rejects a preterminal %s orphan without changing pending authority',
    async (kind) => {
      const finalizationId = asFinalizationId(`mock-preterminal-${kind}-orphan`);
      const includedBitmap = [true];
      const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
      const result = buildResult({
        ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
        includedBitmapRoot,
        seenBitmapRoot: includedBitmapRoot,
      });
      const pending = await store.markFinalizationQueued(sessionId, {
        finalizationId,
        queuedAtMs: 10,
        scenarioContext,
      });
      if (kind === 'bitmap') {
        getPrivateMap<unknown>(store, 'bitmapRecords').set(scopedKey(sessionId, finalizationId), {
          sessionId,
          finalizationId,
          includedBitmap,
          includedBitmapRoot,
          treeSize: 1,
          finalizedAtMs: 30,
        });
      } else {
        getPrivateMap<unknown>(store, 'verificationResultRecords').set(scopedKey(sessionId, finalizationId), {
          sessionId,
          finalizationId,
          verificationResult: { status: 'running' },
        });
      }

      await expect(
        store.commitSuccessfulFinalization({
          record: buildSucceededRecord(sessionId, finalizationId, result),
          bitmap: { availability: 'unavailable' },
        }),
      ).rejects.toThrow('Successful finalization artifacts exist before terminal authority');
      await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toEqual(pending);
    },
  );

  it('rejects a preterminal receipt orphan without changing pending authority', async () => {
    const finalizationId = asFinalizationId('mock-preterminal-receipt-orphan');
    const pending = await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    const receipt = { receipt: '{"orphan":true}', timestamp: 30 };
    getPrivateMap<unknown>(store, 'receipts').set(scopedKey(sessionId, finalizationId), {
      receiptHash: computeSuccessfulFinalizationReceiptHash(receipt),
      boardIndex: 100,
      receipt,
    });

    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(sessionId, finalizationId),
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow('Successful finalization receipt exists before terminal authority');
    await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toEqual(pending);
    expect(Reflect.get(store, 'receiptCounter')).toBe(100);
  });

  it('routes direct success through the atomic commit and rejects a preterminal bitmap orphan', async () => {
    const finalizationId = asFinalizationId('mock-direct-success-bitmap-orphan');
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const result = buildResult({
      ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    });
    const pending = await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    getPrivateMap<unknown>(store, 'bitmapRecords').set(scopedKey(sessionId, finalizationId), {
      sessionId,
      finalizationId,
      includedBitmap,
      includedBitmapRoot,
      treeSize: 1,
      finalizedAtMs: 30,
    });

    await expect(
      store.markFinalizationSucceeded(sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: result,
      }),
    ).rejects.toThrow('Successful finalization artifacts exist before terminal authority');
    await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toEqual(pending);
  });

  it.each(['missing', 'not-advanced'] as const)(
    'rejects an idempotent receipt replay when the in-memory counter is %s',
    async (counterState) => {
      const finalizationId = asFinalizationId(`mock-receipt-counter-${counterState}`);
      const input = {
        record: buildSucceededRecord(sessionId, finalizationId),
        receipt: { receipt: '{"counter":true}', timestamp: 30 },
        bitmap: { availability: 'unavailable' as const },
      };
      const committed = await store.commitSuccessfulFinalization(input);
      Reflect.set(
        store,
        'receiptCounter',
        counterState === 'missing' ? undefined : (committed.receiptPublication?.boardIndex ?? 100),
      );

      await expect(store.commitSuccessfulFinalization(input)).rejects.toThrow(
        'Receipt board counter does not cover the persisted publication',
      );
      await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toEqual(committed.record);
    },
  );

  it('rejects an idempotent replay when the persisted receipt hash is corrupt', async () => {
    const finalizationId = asFinalizationId('mock-corrupt-receipt-hash');
    const input = {
      record: buildSucceededRecord(sessionId, finalizationId),
      receipt: { receipt: '{"exact":true}', timestamp: 30 },
      bitmap: { availability: 'unavailable' as const },
    };
    const committed = await store.commitSuccessfulFinalization(input);
    const entry = getPrivateMap<{ receiptHash: string }>(store, 'receipts').get(scopedKey(sessionId, finalizationId));
    if (!entry) {
      throw new Error('Expected persisted receipt');
    }
    entry.receiptHash = `0x${'f'.repeat(64)}`;

    await expect(store.commitSuccessfulFinalization(input)).rejects.toThrow('Invalid persisted finalization receipt');
    await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toEqual(committed.record);
  });

  it('does not refresh activity on read-only record access', async () => {
    const before = requireValue(await store.getVotingRecord(sessionId), 'voting record');

    await store.getSessionIdentity(sessionId);
    await store.getVotingRecord(sessionId);
    await store.getSessionVotingSummary(sessionId);
    await store.getCurrentFinalizationRecord(sessionId);

    const after = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    expect(after.lastActivityMs).toBe(before.lastActivityMs);
  });

  it('excludes fail-closed live sessions from the active session count', async () => {
    const identities = getPrivateMap<unknown>(store, 'identityRecords');
    identities.set(sessionId, {
      ...identity,
      legacyGeneration: 'retired',
    });

    await expect(store.getActiveSessionCount()).resolves.toBe(0);
  });

  it('summarizes a batch of bot votes in one debug log entry', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    await store.addVote(sessionId, buildVote('A', 'a'));
    await store.addBotVotes(sessionId, [buildBotVote('B', 'b'), buildBotVote('C', 'c')]);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      '[MockStore] Bot votes added:',
      expect.objectContaining({
        addedCount: 2,
        totalBotCount: 2,
        firstBotIndex: 1,
        lastBotIndex: 2,
        bulletinSize: 3,
      }),
    );
  });

  it('fails closed when addBotVotes targets a finalized session', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('finalized-vote-authority'),
      queuedAtMs: 10,
      scenarioContext,
    });

    await expect(store.addBotVotes(sessionId, [buildBotVote('B', 'b')])).resolves.toEqual({
      ok: false,
      error: { code: 'SESSION_FINALIZED' },
    });
  });

  it('fails closed on stale botCount without reconciling it', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    getPrivateMap<SessionVotingRecord>(store, 'votingRecords').set(sessionId, {
      ...voting,
      botCount: 1,
    });

    await expect(store.addBotVotes(sessionId, [buildBotVote('B', 'b')])).rejects.toThrow(
      'Session voting record bot count is inconsistent',
    );
    expect(getPrivateMap<SessionVotingRecord>(store, 'votingRecords').get(sessionId)?.botCount).toBe(1);
  });

  it('fails closed on missing user participation without repairing index zero', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    getPrivateMap<unknown>(store, 'votingRecords').set(sessionId, {
      ...voting,
      userParticipation: undefined,
    });

    await expect(store.addBotVotes(sessionId, [buildBotVote('B', 'b')])).rejects.toThrow(
      'Session voting record is missing or invalid',
    );
    expect(
      (getPrivateMap<Record<string, unknown>>(store, 'votingRecords').get(sessionId) ?? {})['userParticipation'],
    ).toBeUndefined();
  });

  it('fails closed when addBotVotes sees a non-canonical user vote index', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    getPrivateMap<SessionVotingRecord>(store, 'votingRecords').set(sessionId, {
      ...voting,
      userParticipation: { status: 'cast', voteIndex: 1 },
    });

    await expect(store.addBotVotes(sessionId, [buildBotVote('B', 'b')])).rejects.toThrow(
      'Session voting record is missing or invalid',
    );
  });

  it('fails closed when addBotVotes sees sparse vote indices', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    const userVote = requireValue(voting.votes.get(0), 'user vote');
    getPrivateMap<SessionVotingRecord>(store, 'votingRecords').set(sessionId, {
      ...voting,
      votes: new Map([
        [0, userVote],
        [2, { ...userVote, voteId: generateVoteId() }],
      ]),
      botCount: 1,
    });

    await expect(store.addBotVotes(sessionId, [buildBotVote('B', 'b')])).rejects.toThrow(
      'NON_CANONICAL_CT_VOTE_INDICES',
    );
  });

  it('does not leave a ghost user vote when CT state is unavailable', async () => {
    const voting = requireValue(
      getPrivateMap<SessionVotingRecord>(store, 'votingRecords').get(sessionId),
      'internal voting record',
    );
    vi.spyOn(voting.bulletin, 'getLogId').mockImplementation(() => {
      throw new Error('CT unavailable');
    });

    await expect(store.addVote(sessionId, buildVote('A', 'a'))).rejects.toThrow('CT unavailable');
    const persisted = requireValue(
      getPrivateMap<SessionVotingRecord>(store, 'votingRecords').get(sessionId),
      'internal voting record',
    );
    expect(persisted.votes.size).toBe(0);
    expect(persisted.bulletinRootHistory).toEqual([]);
    expect(persisted.userParticipation).toEqual({ status: 'not_cast' });
  });

  it('applies bot vote batches atomically when a later CT append fails', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    const before = requireValue(await store.getVotingRecord(sessionId), 'voting record');

    await expect(store.addBotVotes(sessionId, [buildBotVote('B', 'b'), buildBotVote('B', 'b')])).rejects.toThrow(
      'Commitment already exists',
    );
    const after = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    expect(after.votes).toEqual(before.votes);
    expect(after.bulletinRootHistory).toEqual(before.bulletinRootHistory);
    expect(after.bulletin.getSize()).toBe(before.bulletin.getSize());
    expect(after.botCount).toBe(0);
  });

  it('returns the exact cast-time bulletin root from addVote', async () => {
    const result = await store.addVote(sessionId, buildVote('A', 'a'));
    if (!result.ok) {
      throw new Error(`Expected vote persistence, received ${result.error.code}`);
    }
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');

    expect(result.value.bulletinRootAtCast).toBe(voting.votes.get(0)?.rootAtCast);
    expect(result.value.bulletinRootAtCast).toBe(`0x${voting.bulletin.getRootAtSize(1)}`);
  });

  it('retrieves a vote by voteId', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));

    await expect(store.getVoteById(sessionId, voteId)).resolves.toMatchObject({
      index: 0,
      voteData: { voteId, vote: 'A' },
    });
  });

  it('returns null for a non-existent voteId', async () => {
    await expect(store.getVoteById(sessionId, generateVoteId())).resolves.toBeNull();
  });

  it('returns null when the vote belongs to another session', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));
    const other = await store.createSession();

    await expect(store.getVoteById(other.sessionId, voteId)).resolves.toBeNull();
  });

  it('retrieves a vote with its exact Merkle proof', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));

    await expect(store.getVoteByIdWithProof(sessionId, voteId)).resolves.toMatchObject({
      leafIndex: 0,
      treeSize: 1,
      merklePath: [],
      voteData: { voteId },
    });
  });

  it('does not fall back to incremental proof when CT proof derivation fails', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));
    const voting = requireValue(
      getPrivateMap<SessionVotingRecord>(store, 'votingRecords').get(sessionId),
      'internal voting record',
    );
    vi.spyOn(voting.bulletin, 'getInclusionProof').mockImplementation(() => {
      throw new Error('broken proof');
    });

    await expect(store.getVoteByIdWithProof(sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when stored rootAtCast is missing', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));
    const voting = requireValue(
      getPrivateMap<SessionVotingRecord>(store, 'votingRecords').get(sessionId),
      'internal voting record',
    );
    const storedVote = requireValue(voting.votes.get(0), 'stored vote');
    const { rootAtCast: _rootAtCast, ...withoutRoot } = storedVote;
    void _rootAtCast;
    voting.votes.set(0, withoutRoot as StoredVoteRecord);

    await expect(store.getVoteByIdWithProof(sessionId, voteId)).resolves.toBeNull();
    await expect(store.getVotingRecord(sessionId)).resolves.toBeNull();
  });

  it('includes the correct bulletin index', async () => {
    const voteId = generateVoteId();
    const result = await store.addVote(sessionId, buildVote('A', 'a', voteId));
    if (!result.ok) {
      throw new Error(`Expected vote persistence, received ${result.error.code}`);
    }

    expect(result.value.leafIndex).toBe(0);
    await expect(store.getVoteProof(voteId)).resolves.toMatchObject({ leafIndex: 0, treeSize: 1 });
  });

  it('maintains the voteId index across multiple votes', async () => {
    const userVoteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', userVoteId));
    await store.addBotVotes(sessionId, [buildBotVote('B', 'b'), buildBotVote('C', 'c')]);
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');
    const firstBotId = requireValue(voting.votes.get(1), 'first bot vote').voteId;
    const secondBotId = requireValue(voting.votes.get(2), 'second bot vote').voteId;

    await expect(store.getVoteById(sessionId, userVoteId)).resolves.toMatchObject({ index: 0 });
    await expect(store.getVoteById(sessionId, firstBotId)).resolves.toMatchObject({ index: 1 });
    await expect(store.getVoteById(sessionId, secondBotId)).resolves.toMatchObject({ index: 2 });
  });

  it('stores commitments that match the election-scoped hash', async () => {
    const vote = buildVote('C', 'c');
    await store.addVote(sessionId, vote);
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting record');

    expect(voting.votes.get(0)?.commit).toBe(computeCommitment(identity.electionId, 2, vote.rand));
  });

  it('returns bitmap data only for the matching session and finalization', async () => {
    const finalizationId = asFinalizationId('bitmap-match');
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const journal = {
      ...createTestJournal({ totalExpected: 1 }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    };
    const bitmap = {
      includedBitmap: [true],
      includedBitmapRoot,
      treeSize: 1,
      finalizedAtMs: 30,
    };
    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(sessionId, finalizationId, buildResult(journal)),
      bitmap: { availability: 'available', data: bitmap },
    });
    const other = await store.createSession();

    await expect(store.getBitmapData(sessionId, finalizationId)).resolves.toMatchObject({
      sessionId,
      finalizationId,
      includedBitmap: [true],
    });
    await expect(store.getBitmapData(sessionId, asFinalizationId('bitmap-other'))).resolves.toBeNull();
    await expect(store.getBitmapData(other.sessionId, finalizationId)).resolves.toBeNull();
  });

  it('keeps bitmap data separated between sessions', async () => {
    const finalizationId = asFinalizationId('bitmap-separated');
    const other = await store.createSession();
    for (const [targetSessionId, includedBitmap, finalizedAtMs] of [
      [sessionId, [true], 30],
      [other.sessionId, [false], 31],
    ] as const) {
      const includedBitmapRoot = computeIncludedBitmapRoot([...includedBitmap]);
      const journal = {
        ...createTestJournal({ totalExpected: 1 }),
        includedBitmapRoot,
        seenBitmapRoot: includedBitmapRoot,
      };
      await store.commitSuccessfulFinalization({
        record: buildSucceededRecord(targetSessionId, finalizationId, buildResult(journal)),
        bitmap: {
          availability: 'available',
          data: { includedBitmap: [...includedBitmap], includedBitmapRoot, treeSize: 1, finalizedAtMs },
        },
      });
    }

    await expect(store.getBitmapData(sessionId, finalizationId)).resolves.toMatchObject({
      includedBitmap: [true],
    });
    await expect(store.getBitmapData(other.sessionId, finalizationId)).resolves.toMatchObject({
      includedBitmap: [false],
    });
  });
});
