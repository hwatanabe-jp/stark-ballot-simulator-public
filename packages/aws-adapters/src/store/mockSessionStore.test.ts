import { describe, it, expect, beforeEach } from 'vitest';
import { MockSessionStore } from './mockSessionStore';
import type { VoteData } from '@stark-ballot/domain/types/server';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { createTestCommitment } from '@stark-ballot/test-support/testing/commitment-test-helpers';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { addHexPrefix } from '@stark-ballot/domain/utils/hex';
import {
  CorruptOrUnreadableFinalizedStateBoundaryError,
  resolveCurrentContractGeneration,
  resolveSessionFinalizationArtifactState,
  UnsupportedCurrentArtifactBoundaryError,
} from '@stark-ballot/domain/contract';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import {
  admitAwsPersistedFinalizationStateBranch,
  parseAwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { buildFinalizationArtifactS3Keys } from '@stark-ballot/aws-adapters/finalize/artifact-key-layout';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function getVerificationExecutionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const executionId = (value as { verificationExecutionId?: unknown }).verificationExecutionId;
  return typeof executionId === 'string' ? executionId : undefined;
}

// Use string literals instead of importing VoteChoice
const VoteChoice = {
  A: 'A' as const,
  B: 'B' as const,
  C: 'C' as const,
  D: 'D' as const,
  E: 'E' as const,
};

describe('MockSessionStore', () => {
  let store: MockSessionStore;
  let sessionId: string;

  const finalizeSessionForBitmap = async (targetSessionId: string): Promise<void> => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
    });

    await store.finalizeSession(
      targetSessionId,
      {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: journal.imageId ?? '0x' + '1'.repeat(64),
        journal,
      },
      resolveCurrentContractGeneration(),
      'exec-bitmap',
    );
  };

  const createStoredFinalizationResult = (executionId: string, journal = createTestJournal()) => ({
    ...buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    }),
    verificationExecutionId: executionId,
  });

  beforeEach(async () => {
    store = new MockSessionStore();
    const session = await store.createSession();
    sessionId = session.sessionId;
  });

  it('does not expose standalone receipt-board publication', () => {
    expect('saveReceiptToBoard' in store).toBe(false);
    expect(Reflect.get(store, 'saveReceiptToBoard')).toBeUndefined();
  });

  describe('finalization state transitions', () => {
    it('persists proof-bundle delivery metadata without requiring locators on pure authority', async () => {
      const authority = buildFinalizationResultFromJournal({
        journal: createTestJournal(),
        imageId: '0x' + '1'.repeat(64),
      });
      authority.verificationResult = {
        status: 'success',
      };
      const keys = buildFinalizationArtifactS3Keys(sessionId, 'exec-1');
      await store.recordAwsProofBundlePublication(sessionId, 'exec-1', {
        s3BundleKey: keys.bundleS3Key,
        s3ReportKey: keys.reportS3Key,
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
      });

      await store.finalizeSession(sessionId, authority, resolveCurrentContractGeneration(), 'exec-1');

      expect(Object.hasOwn(authority.verificationResult, 'executionId')).toBe(false);
      expect(Object.hasOwn(authority.verificationResult, 's3BundleKey')).toBe(false);
      const session = await store.getSession(sessionId);
      const persisted = parseAwsPersistedFinalizationResult(session?.finalizationResult);
      expect(persisted).toMatchObject({
        verificationExecutionId: 'exec-1',
        s3BundleKey: keys.bundleS3Key,
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
        verificationResult: {
          status: 'success',
          executionId: 'exec-1',
          s3BundleKey: keys.bundleS3Key,
          s3ReportKey: keys.reportS3Key,
          s3UploadedAt: '2026-01-01T00:00:00.000Z',
        },
      });
    });

    it('seeds the finalization contract generation when scenario context is persisted before queueing', async () => {
      const executionId = 'ulid-queue-after-context';
      const queuedAt = 1730000000000;

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration: resolveCurrentContractGeneration(),
        scenarioContext: {
          scenarios: ['S2'],
          tamperMode: 'claim',
          claimedCounts: { A: 0, B: 2, C: 1, D: 0, E: 0 },
          claimedTotalVotes: 3,
          summary: {
            ignoredCount: 0,
            recountedCount: 1,
            userRecountChoice: 'B',
          },
        },
      });

      const session = await store.getSession(sessionId);
      expect(session?.finalizationContractGeneration).toBe(resolveCurrentContractGeneration());
      expect(session?.finalizationState).toEqual({
        status: 'pending',
        executionId,
        queuedAt,
      });
      expect(session?.finalizationScenarioContext).toEqual({
        scenarios: ['S2'],
        tamperMode: 'claim',
        claimedCounts: { A: 0, B: 2, C: 1, D: 0, E: 0 },
        claimedTotalVotes: 3,
        summary: {
          ignoredCount: 0,
          recountedCount: 1,
          userRecountChoice: 'B',
        },
      });
    });

    it('records queued → running → succeeded transitions with metadata', async () => {
      const executionId = 'ulid-01HVN5WA1CEH94868G90QGJ7HX';
      const queuedAt = 1730000000000;
      const startedAt = queuedAt + 1_000;
      const completedAt = startedAt + 360_000;
      const journal = createTestJournal();
      const finalizationResult = createStoredFinalizationResult(executionId, journal);
      const keys = buildFinalizationArtifactS3Keys(sessionId, executionId);

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      let session = await store.getSession(sessionId);
      expect(session?.finalizationState).toEqual({
        status: 'pending',
        executionId,
        queuedAt,
      });

      await store.markAwsFinalizationRunning(sessionId, {
        executionId,
        queuedAt,
        startedAt,
        contractGeneration: resolveCurrentContractGeneration(),
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
      });

      session = await store.getSession(sessionId);
      expect(session?.finalizationState).toEqual({
        status: 'running',
        executionId,
        queuedAt,
        startedAt,
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
      });

      await store.markAwsFinalizationSucceeded(sessionId, {
        executionId,
        queuedAt,
        startedAt,
        completedAt,
        contractGeneration: resolveCurrentContractGeneration(),
        bundleMetadata: {
          s3BundleKey: keys.bundleS3Key,
          s3UploadedAt: '2025-10-26T12:34:56.000Z',
        },
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
        finalizationResult,
      });

      session = await store.getSession(sessionId);
      expect(session?.finalizationState).toEqual({
        status: 'succeeded',
        executionId,
        queuedAt,
        startedAt,
        completedAt,
        bundleMetadata: {
          s3BundleKey: keys.bundleS3Key,
          s3UploadedAt: '2025-10-26T12:34:56.000Z',
        },
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
      });
      expect(session?.finalized).toBe(true);
      expect(parseAwsPersistedFinalizationResult(session?.finalizationResult)).toMatchObject({
        verificationExecutionId: executionId,
        s3BundleKey: keys.bundleS3Key,
        s3UploadedAt: '2025-10-26T12:34:56.000Z',
      });
    });

    it('keeps AWS-runtime running state when competing stale executions arrive', async () => {
      const executionId = 'exec-winning';
      const queuedAt = 1730000000000;
      const startedAt = queuedAt + 1_000;
      const contractGeneration = resolveCurrentContractGeneration();
      const stepFunctionsArn = 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-winning';
      const expectedRunningState = {
        status: 'running' as const,
        executionId,
        queuedAt,
        startedAt,
        stepFunctionsArn,
      };

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration,
      });
      await store.markAwsFinalizationRunning(sessionId, {
        executionId,
        queuedAt,
        startedAt,
        contractGeneration,
        stepFunctionsArn,
      });

      await expect(
        store.markFinalizationQueued(sessionId, {
          executionId: 'exec-stale-queued',
          queuedAt: queuedAt - 5_000,
          contractGeneration,
        }),
      ).resolves.toEqual(expectedRunningState);
      await expect(
        store.markAwsFinalizationRunning(sessionId, {
          executionId: 'exec-stale-running',
          queuedAt: queuedAt - 4_000,
          startedAt: startedAt - 4_000,
          contractGeneration,
          stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-stale-running',
        }),
      ).resolves.toEqual(expectedRunningState);
      await expect(
        store.markFinalizationRunning(sessionId, {
          executionId: 'exec-stale-pure-running',
          queuedAt: queuedAt - 3_000,
          startedAt: startedAt - 3_000,
          contractGeneration,
        }),
      ).resolves.toEqual(expectedRunningState);
      await expect(
        store.markAwsFinalizationSucceeded(sessionId, {
          executionId: 'exec-stale-succeeded',
          queuedAt: queuedAt - 2_000,
          startedAt: startedAt - 2_000,
          completedAt: startedAt + 2_000,
          contractGeneration,
          finalizationResult: createStoredFinalizationResult('exec-stale-succeeded'),
        }),
      ).resolves.toEqual(expectedRunningState);
      await expect(
        store.markAwsFinalizationFailed(sessionId, {
          executionId: 'exec-stale-failed',
          queuedAt: queuedAt - 1_000,
          startedAt: startedAt - 1_000,
          failedAt: startedAt + 3_000,
          contractGeneration,
          error: { code: 'STALE_EXECUTION', message: 'stale execution failed after winner started' },
        }),
      ).resolves.toEqual(expectedRunningState);
      await expect(
        store.markAwsFinalizationTimedOut(sessionId, {
          executionId: 'exec-stale-timeout',
          queuedAt: queuedAt - 500,
          startedAt: startedAt - 500,
          timeoutAt: startedAt + 4_000,
          contractGeneration,
        }),
      ).resolves.toEqual(expectedRunningState);

      const session = await store.getSession(sessionId);
      expect(session?.finalizationState).toEqual(expectedRunningState);
      expect(session?.finalized).toBe(false);
      expect(session?.finalizationResult).toBeUndefined();
    });

    it('keeps USER_CANCELLED failed state when a running transition with the same executionId arrives later', async () => {
      const executionId = 'exec-cancelled-sticky';
      const queuedAt = 1730000000000;
      const failedAt = queuedAt + 2_000;
      const contractGeneration = resolveCurrentContractGeneration();
      const expectedFailedState = {
        status: 'failed' as const,
        executionId,
        queuedAt,
        failedAt,
        error: { code: 'USER_CANCELLED', message: 'User cancelled finalization' },
      };

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration,
      });
      await store.markAwsFinalizationFailed(sessionId, {
        executionId,
        queuedAt,
        failedAt,
        contractGeneration,
        error: expectedFailedState.error,
      });

      const nextState = await store.markAwsFinalizationRunning(sessionId, {
        executionId,
        queuedAt,
        startedAt: failedAt + 1_000,
        contractGeneration,
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-cancelled',
      });

      const session = await store.getSession(sessionId);
      expect(nextState).toEqual(expectedFailedState);
      expect(session?.finalizationState).toEqual(expectedFailedState);
      expect(session?.finalized).toBe(false);
      expect(session?.finalizationResult).toBeUndefined();
    });

    it('keeps terminal finalization states when same-executionId lifecycle transitions arrive later', async () => {
      const executionId = 'exec-terminal-sticky';
      const queuedAt = 1730000000000;
      const startedAt = queuedAt + 1_000;
      const completedAt = startedAt + 1_000;
      const failedAt = startedAt + 2_000;
      const timeoutAt = startedAt + 3_000;
      const contractGeneration = resolveCurrentContractGeneration();

      const terminalSetups = [
        {
          status: 'succeeded',
          setup: async (targetSessionId: string) => {
            await store.markFinalizationQueued(targetSessionId, {
              executionId,
              queuedAt,
              contractGeneration,
            });
            return store.markAwsFinalizationSucceeded(targetSessionId, {
              executionId,
              queuedAt,
              startedAt,
              completedAt,
              contractGeneration,
              finalizationResult: createStoredFinalizationResult(executionId),
            });
          },
          expectSideEffects: async (targetSessionId: string) => {
            const session = await store.getSession(targetSessionId);
            expect(session?.finalized).toBe(true);
            expect(getVerificationExecutionId(session?.finalizationResult)).toBe(executionId);
          },
        },
        {
          status: 'failed',
          setup: async (targetSessionId: string) => {
            await store.markFinalizationQueued(targetSessionId, {
              executionId,
              queuedAt,
              contractGeneration,
            });
            return store.markAwsFinalizationFailed(targetSessionId, {
              executionId,
              queuedAt,
              failedAt,
              contractGeneration,
              error: { code: 'USER_CANCELLED', message: 'User cancelled finalization' },
            });
          },
          expectSideEffects: async (targetSessionId: string) => {
            const session = await store.getSession(targetSessionId);
            expect(session?.finalized).toBe(false);
            expect(session?.finalizationResult).toBeUndefined();
          },
        },
        {
          status: 'timeout',
          setup: async (targetSessionId: string) => {
            await store.markFinalizationQueued(targetSessionId, {
              executionId,
              queuedAt,
              contractGeneration,
            });
            return store.markAwsFinalizationTimedOut(targetSessionId, {
              executionId,
              queuedAt,
              startedAt,
              timeoutAt,
              contractGeneration,
            });
          },
          expectSideEffects: async (targetSessionId: string) => {
            const session = await store.getSession(targetSessionId);
            expect(session?.finalized).toBe(false);
            expect(session?.finalizationResult).toBeUndefined();
          },
        },
      ];
      const transitionAttempts: Array<{ name: string; run: (targetSessionId: string) => Promise<unknown> }> = [
        {
          name: 'pure queued',
          run: (targetSessionId) =>
            store.markFinalizationQueued(targetSessionId, {
              executionId,
              queuedAt: queuedAt + 10_000,
              contractGeneration,
            }),
        },
        {
          name: 'pure running',
          run: (targetSessionId) =>
            store.markFinalizationRunning(targetSessionId, {
              executionId,
              queuedAt,
              startedAt: startedAt + 10_000,
              contractGeneration,
            }),
        },
        {
          name: 'AWS running',
          run: (targetSessionId) =>
            store.markAwsFinalizationRunning(targetSessionId, {
              executionId,
              queuedAt,
              startedAt: startedAt + 20_000,
              contractGeneration,
              stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-running',
            }),
        },
        {
          name: 'pure succeeded',
          run: (targetSessionId) =>
            store.markFinalizationSucceeded(targetSessionId, {
              executionId,
              queuedAt,
              startedAt,
              completedAt: completedAt + 10_000,
              contractGeneration,
              finalizationResult: createStoredFinalizationResult(executionId),
            }),
        },
        {
          name: 'AWS succeeded',
          run: (targetSessionId) =>
            store.markAwsFinalizationSucceeded(targetSessionId, {
              executionId,
              queuedAt,
              startedAt,
              completedAt: completedAt + 20_000,
              contractGeneration,
              finalizationResult: createStoredFinalizationResult(executionId),
            }),
        },
        {
          name: 'pure failed',
          run: (targetSessionId) =>
            store.markFinalizationFailed(targetSessionId, {
              executionId,
              queuedAt,
              startedAt,
              failedAt: failedAt + 10_000,
              contractGeneration,
              error: { code: 'LATE_FAILURE', message: 'late pure failure' },
            }),
        },
        {
          name: 'AWS failed',
          run: (targetSessionId) =>
            store.markAwsFinalizationFailed(targetSessionId, {
              executionId,
              queuedAt,
              startedAt,
              failedAt: failedAt + 20_000,
              contractGeneration,
              error: { code: 'USER_CANCELLED', message: 'late cancellation' },
            }),
        },
        {
          name: 'pure timeout',
          run: (targetSessionId) =>
            store.markFinalizationTimedOut(targetSessionId, {
              executionId,
              queuedAt,
              startedAt,
              timeoutAt: timeoutAt + 10_000,
              contractGeneration,
            }),
        },
        {
          name: 'AWS timeout',
          run: (targetSessionId) =>
            store.markAwsFinalizationTimedOut(targetSessionId, {
              executionId,
              queuedAt,
              startedAt,
              timeoutAt: timeoutAt + 20_000,
              contractGeneration,
            }),
        },
      ];

      for (const terminalSetup of terminalSetups) {
        for (const transitionAttempt of transitionAttempts) {
          const targetSession = await store.createSession();
          const expectedTerminalState = await terminalSetup.setup(targetSession.sessionId);

          const nextState = await transitionAttempt.run(targetSession.sessionId);

          await terminalSetup.expectSideEffects(targetSession.sessionId);
          const session = await store.getSession(targetSession.sessionId);
          expect(nextState, `${terminalSetup.status} should ignore ${transitionAttempt.name}`).toEqual(
            expectedTerminalState,
          );
          expect(session?.finalizationState).toEqual(expectedTerminalState);
        }
      }
    });

    it('does not apply success side effects when same-executionId success arrives after failure', async () => {
      const executionId = 'exec-failed-then-success';
      const queuedAt = 1730000000000;
      const startedAt = queuedAt + 1_000;
      const failedAt = startedAt + 1_000;
      const completedAt = failedAt + 1_000;
      const contractGeneration = resolveCurrentContractGeneration();

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration,
      });
      const expectedFailedState = await store.markAwsFinalizationFailed(sessionId, {
        executionId,
        queuedAt,
        startedAt,
        failedAt,
        contractGeneration,
        error: { code: 'USER_CANCELLED', message: 'User cancelled finalization' },
      });

      const nextState = await store.markAwsFinalizationSucceeded(sessionId, {
        executionId,
        queuedAt,
        startedAt,
        completedAt,
        contractGeneration,
        finalizationResult: createStoredFinalizationResult(executionId),
      });

      const session = await store.getSession(sessionId);
      expect(session?.finalized).toBe(false);
      expect(session?.finalizationResult).toBeUndefined();
      expect(nextState).toEqual(expectedFailedState);
      expect(session?.finalizationState).toEqual(expectedFailedState);
    });

    it('rejects widened pure lifecycle payloads that include AWS runtime metadata', async () => {
      const executionId = 'exec-pure-runtime-metadata';
      const queuedAt = 1730000000000;
      const startedAt = queuedAt + 1_000;
      const completedAt = startedAt + 2_000;
      const stepFunctionsArn = 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-pure';
      const finalizationResult = createStoredFinalizationResult(executionId);

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      const runningPayload = {
        executionId,
        queuedAt,
        startedAt,
        contractGeneration: resolveCurrentContractGeneration(),
        stepFunctionsArn,
      };
      await expect(store.markFinalizationRunning(sessionId, runningPayload)).rejects.toThrow(
        'Pure finalization lifecycle methods do not accept AWS runtime metadata',
      );

      const succeededPayload = {
        executionId,
        queuedAt,
        startedAt,
        completedAt,
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationResult,
        bundleMetadata: {
          s3BundleKey: 'sessions/abc/execution-1/bundle.zip',
          s3UploadedAt: '2025-10-26T12:34:56.000Z',
        },
        stepFunctionsArn,
      };
      await expect(store.markFinalizationSucceeded(sessionId, succeededPayload)).rejects.toThrow(
        'Pure finalization lifecycle methods do not accept AWS runtime metadata',
      );

      const failedPayload = {
        executionId,
        queuedAt,
        startedAt,
        failedAt: completedAt,
        contractGeneration: resolveCurrentContractGeneration(),
        error: { code: 'TEST_FAILURE', message: 'failed during metadata boundary test' },
        stepFunctionsArn,
      };
      await expect(store.markFinalizationFailed(sessionId, failedPayload)).rejects.toThrow(
        'Pure finalization lifecycle methods do not accept AWS runtime metadata',
      );

      const timedOutPayload = {
        executionId,
        queuedAt,
        startedAt,
        timeoutAt: completedAt,
        contractGeneration: resolveCurrentContractGeneration(),
        stepFunctionsArn,
      };
      await expect(store.markFinalizationTimedOut(sessionId, timedOutPayload)).rejects.toThrow(
        'Pure finalization lifecycle methods do not accept AWS runtime metadata',
      );

      const session = await store.getSession(sessionId);
      expect(session?.finalizationState).toEqual({
        status: 'pending',
        executionId,
        queuedAt,
      });
    });

    it('prevents stale execution updates via idempotency guard', async () => {
      const executionId = 'ulid-01HVN5WA1CEH94868G90QGJ7HX';

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt: 1730000000000,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      await store.markFinalizationRunning(sessionId, {
        executionId,
        queuedAt: 1730000000000,
        startedAt: 1730000005000,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      // Attempt to overwrite with a different executionId should be ignored
      await store.markFinalizationQueued(sessionId, {
        executionId: 'ulid-older',
        queuedAt: 1720000000000,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      const session = await store.getSession(sessionId);
      expect(session?.finalizationState).toEqual({
        status: 'running',
        executionId,
        queuedAt: 1730000000000,
        startedAt: 1730000005000,
      });
    });

    it('ignores duplicate terminal verification completion for the same execution', async () => {
      const executionId = 'exec-verification-terminal';

      await store.finalizeSession(
        sessionId,
        createStoredFinalizationResult(executionId),
        resolveCurrentContractGeneration(),
        executionId,
      );
      await store.markVerificationRunning(sessionId, { executionId });
      await store.completeVerificationResult(sessionId, {
        executionId,
        verificationResult: { status: 'success' },
      });
      await store.completeVerificationResult(sessionId, {
        executionId,
        verificationResult: { status: 'failed' },
      });

      const session = await store.getSession(sessionId);
      const finalizationResult = parseAwsPersistedFinalizationResult(session?.finalizationResult);
      expect(finalizationResult?.verificationResult).toMatchObject({
        status: 'success',
        executionId,
      });
    });

    it('ignores stale verification completion for a superseded execution', async () => {
      const executionId = 'exec-verification-current';

      await store.finalizeSession(
        sessionId,
        createStoredFinalizationResult(executionId),
        resolveCurrentContractGeneration(),
        executionId,
      );
      await store.markVerificationRunning(sessionId, { executionId });
      await store.completeVerificationResult(sessionId, {
        executionId: 'exec-verification-stale',
        verificationResult: { status: 'failed' },
      });

      const session = await store.getSession(sessionId);
      const finalizationResult = parseAwsPersistedFinalizationResult(session?.finalizationResult);
      expect(finalizationResult?.verificationResult).toMatchObject({
        status: 'running',
        executionId,
      });
    });

    it('fails closed when async writes carry a stale contract generation', async () => {
      const executionId = 'ulid-01HVN5WA1CEH94868G90QGJ7HX';
      const queuedAt = 1730000000000;

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration: 'stale-contract-generation',
      });

      const session = await store.getSession(sessionId);
      expect(session?.finalizationState).toMatchObject({
        status: 'failed',
        executionId,
        queuedAt,
        error: {
          code: 'UNSUPPORTED_CURRENT_ARTIFACT',
        },
      });
      expect(session?.finalized).toBe(false);
      expect(resolveSessionFinalizationArtifactState(session ?? { finalized: false })).toBe(
        'unsupported_current_artifact',
      );
    });

    it('rejects finalization writes that carry a foreign bundle locator', async () => {
      const executionId = 'exec-foreign-bundle';

      await expect(
        store.finalizeSession(
          sessionId,
          {
            ...createStoredFinalizationResult(executionId, createTestJournal()),
            s3BundleKey: 'sessions/other-session/other-exec/bundle.zip',
          } as ReturnType<typeof createStoredFinalizationResult>,
          resolveCurrentContractGeneration(),
          executionId,
        ),
      ).rejects.toThrow(CorruptOrUnreadableFinalizedStateBoundaryError);
    });

    it('treats the persisted wrapper generation as authoritative after the branch exists', async () => {
      const executionId = 'ulid-wrapper-stale';
      const queuedAt = 1730000000000;

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      const session = await store.getSession(sessionId);
      if (!session) {
        throw new Error('Expected session to exist');
      }
      session.finalizationContractGeneration = 'stale-contract-generation';

      const nextState = await store.markFinalizationRunning(sessionId, {
        executionId,
        queuedAt,
        startedAt: queuedAt + 1000,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      expect(nextState).toMatchObject({
        status: 'failed',
        executionId,
        queuedAt,
        error: {
          code: 'UNSUPPORTED_CURRENT_ARTIFACT',
        },
      });

      const updated = await store.getSession(sessionId);
      expect(updated?.finalizationArtifactState).toBe('unsupported_current_artifact');
      expect(updated?.finalizationState).toMatchObject({
        status: 'failed',
        executionId,
        queuedAt,
      });
      expect(resolveSessionFinalizationArtifactState(updated ?? { finalized: false })).toBe(
        'unsupported_current_artifact',
      );
    });

    it('converges stale branches before returning early on executionId mismatch', async () => {
      const queuedAt = 1730000000000;

      await store.markFinalizationQueued(sessionId, {
        executionId: 'exec-original',
        queuedAt,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      const session = await store.getSession(sessionId);
      if (!session) {
        throw new Error('Expected session to exist');
      }
      session.finalizationContractGeneration = 'stale-contract-generation';

      const nextState = await store.markFinalizationRunning(sessionId, {
        executionId: 'exec-new',
        queuedAt: queuedAt + 5000,
        startedAt: queuedAt + 6000,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      expect(nextState).toMatchObject({
        status: 'failed',
        executionId: 'exec-original',
        queuedAt,
        error: {
          code: 'UNSUPPORTED_CURRENT_ARTIFACT',
        },
      });

      const updated = await store.getSession(sessionId);
      expect(updated?.finalizationArtifactState).toBe('unsupported_current_artifact');
      expect(updated?.finalizationState).toMatchObject({
        status: 'failed',
        executionId: 'exec-original',
        queuedAt,
      });
    });

    it('rejects write-side updates against a corrupt finalization branch', async () => {
      const session = await store.getSession(sessionId);
      if (!session) {
        throw new Error('Expected session to exist');
      }

      session.finalizationState = admitAwsPersistedFinalizationStateBranch({
        status: 'pending',
        executionId: 'exec-corrupt-branch',
        queuedAt: 1730000000000,
      });
      delete session.finalizationContractGeneration;

      const journal = createTestJournal();
      await expect(
        store.finalizeSession(
          sessionId,
          {
            tally: {
              counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
              totalVotes: 1,
              tamperedCount: 0,
            },
            imageId: '0x' + '1'.repeat(64),
            journal,
          },
          resolveCurrentContractGeneration(),
          'exec-corrupt-write',
        ),
      ).rejects.toMatchObject({
        code: 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
        artifactState: 'corrupt_or_unreadable',
      });
    });

    it('allows backfill repairs to clear a stale finalization tombstone', async () => {
      const executionId = 'ulid-repair-stale';
      const queuedAt = 1730000000000;

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration: resolveCurrentContractGeneration(),
      });

      const session = await store.getSession(sessionId);
      if (!session) {
        throw new Error('Expected session to exist');
      }
      session.finalizationContractGeneration = 'stale-contract-generation';
      session.finalizationArtifactState = 'unsupported_current_artifact';

      await store.updateFinalizationArtifactMetadata(sessionId, {
        finalizationContractGeneration: resolveCurrentContractGeneration(),
      });

      const repaired = await store.getSession(sessionId);
      expect(repaired?.finalizationContractGeneration).toBe(resolveCurrentContractGeneration());
      expect(repaired?.finalizationArtifactState).toBeUndefined();
      expect(resolveSessionFinalizationArtifactState(repaired ?? { finalized: false })).toBe('supported');
    });

    it('does not publish receipts or consume board indexes for stale finalization publication attempts', async () => {
      await store.updateFinalizationArtifactMetadata(sessionId, {
        finalizationContractGeneration: 'stale-contract-generation',
      });

      await expect(
        store.finalizeSessionWithReceiptPublication(
          sessionId,
          createStoredFinalizationResult('exec-stale'),
          resolveCurrentContractGeneration(),
          { receipt: '{"receipt":"stale"}', timestamp: 1000 },
          'exec-stale',
        ),
      ).rejects.toThrow(UnsupportedCurrentArtifactBoundaryError);

      let session = await store.getSession(sessionId);
      expect(session?.finalized).toBe(false);
      expect(session?.finalizationResult).toBeUndefined();

      const nextSession = await store.createSession();
      const publication = await store.finalizeSessionWithReceiptPublication(
        nextSession.sessionId,
        createStoredFinalizationResult('exec-current'),
        resolveCurrentContractGeneration(),
        { receipt: '{"receipt":"current"}', timestamp: 2000 },
        'exec-current',
      );

      expect(publication.boardIndex).toBe(100);
      session = await store.getSession(nextSession.sessionId);
      const finalizationResult = parseAwsPersistedFinalizationResult(session?.finalizationResult);
      expect(getVerificationExecutionId(session?.finalizationResult)).toBe('exec-current');
      expect(finalizationResult?.receiptPublication).toMatchObject({
        boardIndex: 100,
        timestamp: 2000,
      });
    });

    it('does not publish receipts or consume board indexes for corrupt finalization publication attempts', async () => {
      await store.updateFinalizationArtifactMetadata(sessionId, {
        finalizationArtifactState: 'corrupt_or_unreadable',
      });

      await expect(
        store.finalizeSessionWithReceiptPublication(
          sessionId,
          createStoredFinalizationResult('exec-corrupt'),
          resolveCurrentContractGeneration(),
          { receipt: '{"receipt":"corrupt"}', timestamp: 1000 },
          'exec-corrupt',
        ),
      ).rejects.toThrow(CorruptOrUnreadableFinalizedStateBoundaryError);

      const session = await store.getSession(sessionId);
      expect(session?.finalized).toBe(false);
      expect(session?.finalizationResult).toBeUndefined();
      if (!session) {
        throw new Error('Expected session to exist');
      }
      delete session.finalizationArtifactState;

      const publication = await store.finalizeSessionWithReceiptPublication(
        sessionId,
        createStoredFinalizationResult('exec-current-after-corrupt'),
        resolveCurrentContractGeneration(),
        { receipt: '{"receipt":"current"}', timestamp: 2000 },
        'exec-current-after-corrupt',
      );

      expect(publication.boardIndex).toBe(100);
      const finalizationResult = parseAwsPersistedFinalizationResult(session.finalizationResult);
      expect(getVerificationExecutionId(session.finalizationResult)).toBe('exec-current-after-corrupt');
      expect(finalizationResult?.receiptPublication).toMatchObject({
        boardIndex: 100,
        timestamp: 2000,
      });
    });

    it('rejects finalization metadata writes through updateSession', async () => {
      await expect(
        store.updateSession(sessionId, {
          finalizationArtifactState: 'corrupt_or_unreadable',
        } as Parameters<MockSessionStore['updateSession']>[1]),
      ).rejects.toThrow('dedicated store capability');
    });

    it('rejects vote and CT writes through updateSession', async () => {
      await expect(
        store.updateSession(sessionId, {
          votes: new Map(),
        } as Parameters<MockSessionStore['updateSession']>[1]),
      ).rejects.toThrow('dedicated store capability');
      await expect(
        store.updateSession(sessionId, {
          userVoteIndex: 0,
        } as Parameters<MockSessionStore['updateSession']>[1]),
      ).rejects.toThrow('dedicated store capability');
    });
  });

  it('does not refresh lastActivity on read-only getSession calls', async () => {
    const session = await store.getSession(sessionId);
    if (!session) {
      throw new Error('Expected session to exist');
    }

    session.lastActivity = 1234;
    const reloaded = await store.getSession(sessionId);

    expect(reloaded?.lastActivity).toBe(1234);
  });

  it('excludes fail-closed live sessions from the active session count', async () => {
    expect(await store.getActiveSessionCount()).toBe(1);

    const session = await store.getSession(sessionId);
    if (!session) {
      throw new Error('Expected session to exist');
    }

    session.finalizationArtifactState = 'corrupt_or_unreadable';
    expect(await store.getActiveSessionCount()).toBe(0);
  });

  it('fails closed when addBotVotes targets a stale live session', async () => {
    const session = await store.getSession(sessionId);
    if (!session) {
      throw new Error('Expected session to exist');
    }
    session.contractGeneration = 'stale-contract-generation';

    const { commitment, random } = createTestCommitment(0);
    await expect(
      store.addBotVotes(sessionId, [
        {
          voteId: generateVoteId(),
          vote: VoteChoice.A,
          rand: random,
          commit: commitment,
          path: [],
          timestamp: Date.now(),
        },
      ]),
    ).rejects.toThrow('Session not found');

    const reloaded = await store.getSession(sessionId);
    expect(reloaded?.botCount).toBe(0);
  });

  it('reconciles stale botCount before assigning bot vote indices', async () => {
    const userVote = createTestCommitment(0);
    const firstBotVoteId = generateVoteId();
    const firstBotVote = createTestCommitment(1);
    const secondBotVoteId = generateVoteId();
    const secondBotVote = createTestCommitment(2);

    await store.addVote(sessionId, {
      voteId: generateVoteId(),
      vote: VoteChoice.A,
      rand: userVote.random,
      commit: userVote.commitment,
      path: [],
      timestamp: Date.now(),
    });

    await store.addBotVotes(sessionId, [
      {
        voteId: firstBotVoteId,
        vote: VoteChoice.B,
        rand: firstBotVote.random,
        commit: firstBotVote.commitment,
        path: [],
        timestamp: Date.now(),
      },
    ]);

    const session = await store.getSession(sessionId);
    if (!session) {
      throw new Error('Expected session to exist');
    }
    session.botCount = 0;

    await store.addBotVotes(sessionId, [
      {
        voteId: secondBotVoteId,
        vote: VoteChoice.C,
        rand: secondBotVote.random,
        commit: secondBotVote.commitment,
        path: [],
        timestamp: Date.now(),
      },
    ]);

    const reloaded = await store.getSession(sessionId);
    expect(Array.from(reloaded?.votes.keys() ?? [])).toEqual([0, 1, 2]);
    expect(reloaded?.votes.get(1)?.voteId).toBe(firstBotVoteId);
    expect(reloaded?.votes.get(2)?.voteId).toBe(secondBotVoteId);
    expect(reloaded?.bulletin?.getSize()).toBe(3);
    expect(reloaded?.botCount).toBe(2);
  });

  it('repairs a missing userVoteIndex from the canonical vote at index zero before appending bot votes', async () => {
    const userVote = createTestCommitment(0);
    const botVote = createTestCommitment(1);
    const botVoteId = generateVoteId();

    await store.addVote(sessionId, {
      voteId: generateVoteId(),
      vote: VoteChoice.A,
      rand: userVote.random,
      commit: userVote.commitment,
      path: [],
      timestamp: Date.now(),
    });

    const session = await store.getSession(sessionId);
    if (!session) {
      throw new Error('Expected session to exist');
    }
    delete session.userVoteIndex;

    await store.addBotVotes(sessionId, [
      {
        voteId: botVoteId,
        vote: VoteChoice.B,
        rand: botVote.random,
        commit: botVote.commitment,
        path: [],
        timestamp: Date.now(),
      },
    ]);

    const reloaded = await store.getSession(sessionId);
    expect(reloaded?.userVoteIndex).toBe(0);
    expect(Array.from(reloaded?.votes.keys() ?? [])).toEqual([0, 1]);
    expect(reloaded?.votes.get(1)?.voteId).toBe(botVoteId);
    expect(reloaded?.botCount).toBe(1);
  });

  it('fails closed when addBotVotes is called before the user vote exists', async () => {
    const botVote = createTestCommitment(1);

    await expect(
      store.addBotVotes(sessionId, [
        {
          voteId: generateVoteId(),
          vote: VoteChoice.B,
          rand: botVote.random,
          commit: botVote.commitment,
          path: [],
          timestamp: Date.now(),
        },
      ]),
    ).rejects.toThrow('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');

    const reloaded = await store.getSession(sessionId);
    expect(reloaded?.votes.size).toBe(0);
    expect(reloaded?.botCount).toBe(0);
  });

  it('fails closed when addBotVotes sees a non-canonical user vote index', async () => {
    const userVote = createTestCommitment(0);
    const botVote = createTestCommitment(1);

    await store.addVote(sessionId, {
      voteId: generateVoteId(),
      vote: VoteChoice.A,
      rand: userVote.random,
      commit: userVote.commitment,
      path: [],
      timestamp: Date.now(),
    });

    const session = await store.getSession(sessionId);
    if (!session) {
      throw new Error('Expected session to exist');
    }
    const existingVote = session.votes.get(0);
    if (!existingVote) {
      throw new Error('Expected stored vote at index 0');
    }
    const alternateVote = createTestCommitment(2);
    session.votes.set(1, {
      ...existingVote,
      voteId: generateVoteId(),
      rand: alternateVote.random,
      commit: alternateVote.commitment,
    });
    session.userVoteIndex = 1;

    await expect(
      store.addBotVotes(sessionId, [
        {
          voteId: generateVoteId(),
          vote: VoteChoice.B,
          rand: botVote.random,
          commit: botVote.commitment,
          path: [],
          timestamp: Date.now(),
        },
      ]),
    ).rejects.toThrow('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');
  });

  it('fails closed when addBotVotes sees sparse vote indices', async () => {
    const userVote = createTestCommitment(0);
    const firstBotVote = createTestCommitment(1);
    const nextBotVote = createTestCommitment(2);

    await store.addVote(sessionId, {
      voteId: generateVoteId(),
      vote: VoteChoice.A,
      rand: userVote.random,
      commit: userVote.commitment,
      path: [],
      timestamp: Date.now(),
    });

    await store.addBotVotes(sessionId, [
      {
        voteId: generateVoteId(),
        vote: VoteChoice.B,
        rand: firstBotVote.random,
        commit: firstBotVote.commitment,
        path: [],
        timestamp: Date.now(),
      },
    ]);

    const session = await store.getSession(sessionId);
    if (!session) {
      throw new Error('Expected session to exist');
    }
    const storedBotVote = session.votes.get(1);
    if (!storedBotVote) {
      throw new Error('Expected stored bot vote at index 1');
    }
    session.votes.delete(1);
    session.votes.set(2, storedBotVote);

    await expect(
      store.addBotVotes(sessionId, [
        {
          voteId: generateVoteId(),
          vote: VoteChoice.C,
          rand: nextBotVote.random,
          commit: nextBotVote.commitment,
          path: [],
          timestamp: Date.now(),
        },
      ]),
    ).rejects.toThrow('NON_CANONICAL_CT_VOTE_INDICES');
  });

  it('does not leave a ghost user vote behind when cast-time CT state is unavailable', async () => {
    const session = await store.getSession(sessionId);
    if (!session) {
      throw new Error('Expected session to exist');
    }
    delete session.bulletin;

    const voteId = generateVoteId();
    const { commitment, random } = createTestCommitment(0);

    await expect(
      store.addVote(sessionId, {
        voteId,
        vote: VoteChoice.A,
        rand: random,
        commit: commitment,
        path: [],
        timestamp: Date.now(),
      }),
    ).rejects.toThrow('CT_PROOF_UNAVAILABLE');

    const reloaded = await store.getSession(sessionId);
    expect(reloaded?.votes.size).toBe(0);
    expect(reloaded?.userVoteIndex).toBeUndefined();
    await expect(store.getVoteById(sessionId, voteId)).resolves.toBeNull();
  });

  it('applies bot vote batches atomically when a later CT append fails', async () => {
    const userVote = createTestCommitment(0);
    await store.addVote(sessionId, {
      voteId: generateVoteId(),
      vote: VoteChoice.A,
      rand: userVote.random,
      commit: userVote.commitment,
      path: [],
      timestamp: Date.now(),
    });

    const successfulBotVoteId = generateVoteId();
    const firstBotVote = createTestCommitment(1);
    const secondBotVote = createTestCommitment(2);

    await expect(
      store.addBotVotes(sessionId, [
        {
          voteId: successfulBotVoteId,
          vote: VoteChoice.B,
          rand: firstBotVote.random,
          commit: firstBotVote.commitment,
          path: [],
          timestamp: Date.now(),
        },
        {
          voteId: 'not-a-uuid',
          vote: VoteChoice.C,
          rand: secondBotVote.random,
          commit: secondBotVote.commitment,
          path: [],
          timestamp: Date.now(),
        },
      ]),
    ).rejects.toThrow('Invalid vote ID format');

    const reloaded = await store.getSession(sessionId);
    expect(reloaded?.votes.size).toBe(1);
    expect(reloaded?.botCount).toBe(0);
    expect(reloaded?.bulletin?.getSize()).toBe(1);
    await expect(store.getVoteById(sessionId, successfulBotVoteId)).resolves.toBeNull();
  });

  describe('getVoteById', () => {
    it('returns the exact cast-time bulletin root from addVote', async () => {
      const voteId = generateVoteId();
      const voteData: VoteData = {
        voteId,
        vote: VoteChoice.A,
        rand: '0x' + 'a'.repeat(64),
        commit: '0x' + 'b'.repeat(64),
        path: [],
        timestamp: Date.now(),
      };

      const result = await store.addVote(sessionId, voteData);
      const session = await store.getSession(sessionId);
      const storedVote = session?.votes.get(0);

      expect(result.leafIndex).toBe(0);
      expect(result.merklePath).toEqual(expect.any(Array));
      expect(result.bulletinRootAtCast).toBe(storedVote?.rootAtCast);
    });

    it('should retrieve vote by voteId', async () => {
      // Arrange
      const voteId = generateVoteId();
      const voteData: VoteData = {
        voteId,
        vote: VoteChoice.A,
        rand: '0x' + 'a'.repeat(64),
        commit: '0x' + 'b'.repeat(64),
        path: [],
        timestamp: Date.now(),
      };

      await store.addVote(sessionId, voteData);

      // Act
      const result = await store.getVoteById(sessionId, voteId);

      // Assert
      expect(result).toBeDefined();
      expect(result?.voteData.voteId).toBe(voteId);
      expect(result?.voteData.vote).toBe(VoteChoice.A);
    });

    it('should return null for non-existent voteId', async () => {
      // Act
      const result = await store.getVoteById(sessionId, 'non-existent-id');

      // Assert
      expect(result).toBeNull();
    });

    it('should return null for wrong sessionId', async () => {
      // Arrange
      const voteId = generateVoteId();
      const voteData: VoteData = {
        voteId,
        vote: VoteChoice.B,
        rand: '0x' + 'c'.repeat(64),
        commit: '0x' + 'd'.repeat(64),
        path: [],
        timestamp: Date.now(),
      };

      await store.addVote(sessionId, voteData);

      // Act
      const result = await store.getVoteById('wrong-session-id', voteId);

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('getVoteByIdWithProof', () => {
    it('should retrieve vote with Merkle proof', async () => {
      // Arrange
      const session = await store.getSession(sessionId);
      if (!session) {
        throw new Error('Expected session to be available');
      }
      const electionId = session.electionId;
      if (!electionId) {
        throw new Error('Expected electionId to be set');
      }
      const voteId = generateVoteId();
      const random = '0x' + 'e'.repeat(64);
      const choiceNumber = VoteChoice.C.charCodeAt(0) - 'A'.charCodeAt(0);
      const expectedCommitment = computeCommitment(electionId, choiceNumber, random);

      const voteData: VoteData = {
        voteId,
        vote: VoteChoice.C,
        rand: random,
        commit: '0x' + 'f'.repeat(64), // Will be replaced by store
        path: [],
        timestamp: Date.now(),
      };

      await store.addVote(sessionId, voteData);
      // Add a bot vote so the current tree size differs from the cast-time size
      const botCommitment = createTestCommitment(0);
      await store.addBotVotes(sessionId, [
        {
          voteId: generateVoteId(),
          vote: VoteChoice.A,
          rand: botCommitment.random,
          commit: botCommitment.commitment,
          path: [],
          timestamp: Date.now(),
        },
      ]);

      // Act
      const result = await store.getVoteByIdWithProof(sessionId, voteId);

      // Assert
      expect(result).toBeDefined();
      expect(result?.voteData.voteId).toBe(voteId);
      expect(result?.voteData.commit).toBe(expectedCommitment); // Check computed commitment
      expect(result?.leafIndex).toBe(0); // First vote
      expect(result?.merklePath).toBeInstanceOf(Array);
      expect(result?.bulletinRootAtCast).toBeDefined();
      expect(result?.treeSize).toBe(1);
      expect(result).not.toHaveProperty('proofMode');

      const bulletin = session.bulletin;
      if (!bulletin) {
        throw new Error('Expected bulletin board to be available');
      }
      const ctProof = bulletin.getInclusionProof(voteId, 1);
      if (!ctProof) {
        throw new Error('Expected CT inclusion proof');
      }
      expect(result?.merklePath).toEqual(ctProof.proofNodes.map((node) => addHexPrefix(node)));
      expect(result?.bulletinRootAtCast).toBe(addHexPrefix(ctProof.rootHash));
    });

    it('should not fall back to incremental proof when CT proof derivation fails', async () => {
      const session = await store.getSession(sessionId);
      if (!session) {
        throw new Error('Expected session to be available');
      }
      if (!session.bulletin) {
        throw new Error('Expected bulletin board to be available');
      }

      const voteId = generateVoteId();
      const { commitment, random } = createTestCommitment(0);
      await store.addVote(sessionId, {
        voteId,
        vote: VoteChoice.A,
        rand: random,
        commit: commitment,
        path: [],
        timestamp: Date.now(),
      });

      vi.spyOn(session.bulletin, 'getInclusionProof').mockImplementation(() => {
        throw new Error('ct failure');
      });

      await expect(store.getVoteByIdWithProof(sessionId, voteId)).rejects.toThrow();
    });

    it('should fail closed when stored rootAtCast is missing', async () => {
      const voteId = generateVoteId();
      const { commitment, random } = createTestCommitment(0);
      await store.addVote(sessionId, {
        voteId,
        vote: VoteChoice.A,
        rand: random,
        commit: commitment,
        path: [],
        timestamp: Date.now(),
      });

      const session = await store.getSession(sessionId);
      if (!session) {
        throw new Error('Expected session to be available');
      }
      const storedVote = session.votes.get(0);
      if (!storedVote) {
        throw new Error('Expected stored vote');
      }
      delete storedVote.rootAtCast;

      await expect(store.getVoteByIdWithProof(sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
    });

    it('should include correct bulletin index', async () => {
      // Arrange - Add multiple votes
      const votes: VoteData[] = [];
      for (let i = 0; i < 3; i++) {
        const { commitment, random } = createTestCommitment(0); // Choice A
        const voteData: VoteData = {
          voteId: generateVoteId(),
          vote: VoteChoice.A,
          rand: random,
          commit: commitment,
          path: [],
          timestamp: Date.now() + i * 1000,
        };
        votes.push(voteData);
        await store.addVote(sessionId, voteData);
      }

      // Act - Get the second vote (index 1)
      const secondVote = strictDefined(votes[1]);
      if (!secondVote.voteId) {
        throw new Error('Expected second vote to have a voteId');
      }
      const result = await store.getVoteByIdWithProof(sessionId, secondVote.voteId);

      // Assert
      expect(result).toBeDefined();
      expect(result?.leafIndex).toBe(1); // Should be at index 1
      expect(result?.voteData.voteId).toBe(secondVote.voteId);
    });
  });

  describe('voteId indexing', () => {
    it('should maintain voteId index across multiple votes', async () => {
      // Arrange - Add multiple votes
      const voteIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const voteId = generateVoteId();
        voteIds.push(voteId);
        const { commitment, random } = createTestCommitment(3); // Choice D
        const voteData: VoteData = {
          voteId,
          vote: VoteChoice.D,
          rand: random,
          commit: commitment,
          path: [],
          timestamp: Date.now() + i * 100,
        };
        await store.addVote(sessionId, voteData);
      }

      // Act & Assert - Verify all votes can be retrieved
      for (const voteId of voteIds) {
        const result = await store.getVoteById(sessionId, voteId);
        expect(result).toBeDefined();
        expect(result?.voteData.voteId).toBe(voteId);
      }
    });
  });

  describe('commitment domain separation', () => {
    it('should store commitments that match the election-scoped hash', async () => {
      const session = await store.getSession(sessionId);
      expect(session).toBeTruthy();
      const electionId = session?.electionId;
      expect(electionId).toBeDefined();
      if (!electionId) {
        throw new Error('Expected electionId to be set');
      }

      const random = '0x' + '1'.repeat(64);
      const voteData: VoteData = {
        voteId: generateVoteId(),
        vote: VoteChoice.A,
        rand: random,
        commit: '0x' + '2'.repeat(64), // legacy placeholder
        path: [],
        timestamp: Date.now(),
      };

      await store.addVote(sessionId, voteData);

      const updatedSession = await store.getSession(sessionId);
      const storedVote = updatedSession?.votes.get(0);
      expect(storedVote).toBeDefined();
      if (!storedVote) {
        throw new Error('Expected stored vote at index 0');
      }

      const choiceNumber = VoteChoice.A.charCodeAt(0) - 'A'.charCodeAt(0);
      const expectedCommitment = computeCommitment(electionId, choiceNumber, random);

      expect(storedVote.commit).toBe(expectedCommitment);
    });
  });

  describe('bitmap data isolation', () => {
    it('returns bitmap data only for the matching session', async () => {
      const otherSession = await store.createSession();
      const bitmapForPrimary = {
        includedBitmap: [true, false, true, false],
        includedBitmapRoot: '0x' + 'a'.repeat(64),
        treeSize: 4,
        finalizedAt: Date.now(),
      };

      await finalizeSessionForBitmap(sessionId);
      await store.saveBitmapData(sessionId, bitmapForPrimary);

      const ownBitmap = await store.getBitmapData(sessionId);
      const otherBitmap = await store.getBitmapData(otherSession.sessionId);

      expect(ownBitmap).toEqual({
        sessionId,
        ...bitmapForPrimary,
      });
      expect(otherBitmap).toBeNull();
    });

    it('keeps session A and session B bitmap data separated', async () => {
      const sessionA = await store.createSession();
      const sessionB = await store.createSession();

      await finalizeSessionForBitmap(sessionA.sessionId);
      await finalizeSessionForBitmap(sessionB.sessionId);

      await store.saveBitmapData(sessionA.sessionId, {
        includedBitmap: [true, false],
        includedBitmapRoot: '0x' + 'b'.repeat(64),
        treeSize: 2,
        finalizedAt: 111,
      });
      await store.saveBitmapData(sessionB.sessionId, {
        includedBitmap: [false, true],
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        treeSize: 2,
        finalizedAt: 222,
      });

      const bitmapA = await store.getBitmapData(sessionA.sessionId);
      const bitmapB = await store.getBitmapData(sessionB.sessionId);

      expect(bitmapA?.includedBitmapRoot).toBe('0x' + 'b'.repeat(64));
      expect(bitmapB?.includedBitmapRoot).toBe('0x' + 'c'.repeat(64));
    });
  });
});
