import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type { VerificationResultStore } from '@stark-ballot/application/finalize/finalization-result-store';
import type {
  FinalizationResultAuthority,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import type { AwsFinalizationDeliveryMetadataStore } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type {
  AwsFinalizationRuntimeMetadataStore,
  AwsFinalizationRuntimeTransitionStore,
} from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { logger } from '@stark-ballot/diagnostics/logger';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { createTestCommitment } from '@stark-ballot/test-support/testing/commitment-test-helpers';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';

export type SessionStoreContract = VoteStore &
  FinalizationStore &
  VerificationResultStore &
  AwsFinalizationRuntimeTransitionStore &
  AwsFinalizationRuntimeMetadataStore &
  AwsFinalizationDeliveryMetadataStore;

export interface SessionStoreContractHarness {
  store: SessionStoreContract;
  reload?: () => Promise<SessionStoreContract>;
  failNextLifecycleWrite?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

export interface SessionStoreContractDefinition {
  name: string;
  createHarness(): Promise<SessionStoreContractHarness>;
  capabilities?: {
    durableReload?: boolean;
    lifecycleWriteFailure?: boolean;
  };
}

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

function buildVote(voteId: string, vote: 'A' | 'B' | 'C', randomNibble: string) {
  const commitment = createTestCommitment('ABC'.indexOf(vote), `0x${randomNibble.repeat(64)}`);
  return {
    voteId,
    vote,
    rand: commitment.random,
    commit: commitment.commitment,
    path: [],
    timestamp: 1_730_000_000_000,
  };
}

function buildFinalizationResult(journal = createTestJournal()): FinalizationResultAuthority {
  return buildFinalizationResultFromJournal({
    journal,
    imageId: journal.imageId ?? `0x${'1'.repeat(64)}`,
  });
}

function requireSucceededRecord(
  record: FinalizationRecord,
): Extract<FinalizationRecord, { state: { status: 'succeeded' } }> {
  if (record.state.status !== 'succeeded' || !record.finalizationResult) {
    throw new Error('Expected succeeded finalization record');
  }
  return record;
}

export function defineSessionStoreContract(definition: SessionStoreContractDefinition): void {
  describe(`${definition.name} shared session-store contract`, () => {
    let harness: SessionStoreContractHarness;

    beforeEach(async () => {
      harness = await definition.createHarness();
    });

    afterEach(async () => {
      await harness.cleanup?.();
    });

    it('creates separate complete identity and voting authority', async () => {
      const identity = await harness.store.createSession();
      const voting = requireValue(await harness.store.getVotingRecord(identity.sessionId), 'voting record');

      expect(identity.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(identity.electionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(identity.electionConfigHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(identity.logId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(identity.createdAtMs).toEqual(expect.any(Number));
      expect(voting).toMatchObject({
        sessionId: identity.sessionId,
        botCount: 0,
        userParticipation: { status: 'not_cast' },
      });
      expect(voting.votes.size).toBe(0);
      expect(voting.bulletin.getLogId()).toBe(identity.logId);
      expect(await harness.store.getCurrentFinalizationRecord(identity.sessionId)).toBeNull();
      expect('getSession' in harness.store).toBe(false);
      expect('updateSession' in harness.store).toBe(false);
    });

    it('appends and indexes one vote while rejecting duplicate writes atomically', async () => {
      const identity = await harness.store.createSession();
      const voteId = generateVoteId();
      await harness.store.addVote(identity.sessionId, buildVote(voteId, 'A', 'a'));
      const before = requireValue(await harness.store.getVotingRecord(identity.sessionId), 'voting record');

      await expect(harness.store.addVote(identity.sessionId, buildVote(voteId, 'B', 'b'))).rejects.toThrow(
        'Vote ID already exists',
      );

      const after = requireValue(await harness.store.getVotingRecord(identity.sessionId), 'voting record');
      expect(after.votes).toEqual(before.votes);
      expect(after.bulletinRootHistory).toEqual(before.bulletinRootHistory);
      expect(after.userParticipation).toEqual({ status: 'cast', voteIndex: 0 });
      await expect(harness.store.getVoteById(identity.sessionId, voteId)).resolves.toMatchObject({
        index: 0,
        voteData: { voteId, vote: 'A' },
      });
    });

    it('appends bot votes contiguously after the user vote and preserves exact proof lookup', async () => {
      const identity = await harness.store.createSession();
      const userVoteId = generateVoteId();
      const botVoteId = generateVoteId();
      await harness.store.addVote(identity.sessionId, buildVote(userVoteId, 'A', 'a'));
      await harness.store.addBotVotes(identity.sessionId, [buildVote(botVoteId, 'B', 'b')]);

      const voting = requireValue(await harness.store.getVotingRecord(identity.sessionId), 'voting record');
      expect(voting.botCount).toBe(1);
      expect(voting.votes.get(1)?.voteId).toBe(botVoteId);
      await expect(harness.store.getVoteByIdWithProof(identity.sessionId, botVoteId)).resolves.toMatchObject({
        leafIndex: 1,
        treeSize: 2,
        bulletinRootAtCast: voting.votes.get(1)?.rootAtCast,
      });
    });

    it('rejects bot votes before the user vote without changing voting authority', async () => {
      const identity = await harness.store.createSession();
      const before = requireValue(await harness.store.getVotingRecord(identity.sessionId), 'voting record');

      await expect(
        harness.store.addBotVotes(identity.sessionId, [buildVote(generateVoteId(), 'B', 'b')]),
      ).rejects.toThrow();

      expect(await harness.store.getVotingRecord(identity.sessionId)).toEqual(before);
    });

    it('exposes only the explicit activity mutation rather than a generic metadata patch', async () => {
      const identity = await harness.store.createSession();
      const before = requireValue(await harness.store.getVotingRecord(identity.sessionId), 'voting record');
      await harness.store.touchSession(identity.sessionId);
      const after = requireValue(await harness.store.getVotingRecord(identity.sessionId), 'voting record');

      expect(after.lastActivityMs).toBeGreaterThanOrEqual(before.lastActivityMs);
      expect('updateSession' in harness.store).toBe(false);
      expect('updateFinalizationArtifactMetadata' in harness.store).toBe(false);
    });

    it('persists queued, running, and succeeded semantic authority with adapter metadata separate', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-success';
      const queuedAtMs = 10;
      const startedAtMs = 20;
      const completedAtMs = 30;
      const queued = await harness.store.markFinalizationQueued(identity.sessionId, {
        finalizationId,
        queuedAtMs,
        scenarioContext,
      });
      expect(queued.state).toEqual({ status: 'pending', finalizationId, queuedAtMs });

      await harness.store.markAwsFinalizationRunning(identity.sessionId, {
        finalizationId,
        queuedAtMs,
        startedAtMs,
        stepFunctionsArn: 'arn:aws:states:local:000000000000:execution:contract:success',
      });
      await harness.store.recordAwsProofBundlePublication(identity.sessionId, finalizationId, {
        s3BundleKey: `sessions/${identity.sessionId}/${finalizationId}/bundle.zip`,
        s3UploadedAtMs: completedAtMs,
      });
      await harness.store.markAwsFinalizationSucceeded(identity.sessionId, {
        finalizationId,
        queuedAtMs,
        startedAtMs,
        completedAtMs,
        finalizationResult: buildFinalizationResult(),
        stepFunctionsArn: 'arn:aws:states:local:000000000000:execution:contract:success',
      });

      const current = requireValue(
        await harness.store.getCurrentFinalizationRecord(identity.sessionId),
        'current finalization',
      );
      expect(current.state).toMatchObject({ status: 'succeeded', finalizationId });
      expect(current.scenarioContext).toEqual(scenarioContext);
      expect(current).not.toHaveProperty('stepFunctionsArn');
      expect(current.finalizationResult).not.toHaveProperty('s3BundleKey');
      await expect(
        harness.store.getAwsFinalizationRuntimeMetadata(identity.sessionId, finalizationId),
      ).resolves.toMatchObject({
        stepFunctionsArn: 'arn:aws:states:local:000000000000:execution:contract:success',
      });
      await expect(
        harness.store.getAwsVerificationDeliveryMetadata(identity.sessionId, finalizationId),
      ).resolves.toMatchObject({
        s3BundleKey: `sessions/${identity.sessionId}/${finalizationId}/bundle.zip`,
        s3UploadedAtMs: completedAtMs,
      });
    });

    it('allows each direct semantic terminal path from a fresh session', async () => {
      const success = await harness.store.createSession();
      await expect(
        harness.store.markFinalizationSucceeded(success.sessionId, {
          finalizationId: 'contract-direct-success',
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          scenarioContext,
          finalizationResult: buildFinalizationResult(),
        }),
      ).resolves.toMatchObject({ state: { status: 'succeeded' } });

      const failed = await harness.store.createSession();
      await expect(
        harness.store.markFinalizationFailed(failed.sessionId, {
          finalizationId: 'contract-direct-failure',
          queuedAtMs: 10,
          failedAtMs: 20,
          scenarioContext,
          error: { code: 'FINALIZATION_FAILED', message: 'direct failure' },
        }),
      ).resolves.toMatchObject({ state: { status: 'failed' } });

      const timedOut = await harness.store.createSession();
      await expect(
        harness.store.markFinalizationTimedOut(timedOut.sessionId, {
          finalizationId: 'contract-direct-timeout',
          queuedAtMs: 10,
          timeoutAtMs: 20,
          scenarioContext,
        }),
      ).resolves.toMatchObject({ state: { status: 'timeout' } });
    });

    it('keeps terminal cancellation sticky against late callbacks and success side effects', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-cancelled';
      await harness.store.markFinalizationQueued(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        scenarioContext,
      });
      const cancelled = await harness.store.markFinalizationFailed(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        failedAtMs: 20,
        error: { code: 'USER_CANCELLED', message: 'cancelled by contract test' },
      });

      await expect(
        harness.store.markAwsFinalizationRunning(identity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 30,
          stepFunctionsArn: 'arn:aws:states:local:000000000000:execution:contract:late',
        }),
      ).resolves.toEqual(cancelled.state);
      await expect(
        harness.store.markFinalizationSucceeded(identity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 30,
          completedAtMs: 40,
          finalizationResult: buildFinalizationResult(),
        }),
      ).resolves.toEqual(cancelled);
      expect(await harness.store.getCurrentFinalizationRecord(identity.sessionId)).toEqual(cancelled);
    });

    it('emits the application cancellation reason after the durable transition', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-cancellation-reason';
      await harness.store.markFinalizationQueued(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        scenarioContext,
      });
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      try {
        await harness.store.markFinalizationFailed(identity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          failedAtMs: 20,
          error: { code: 'USER_CANCELLED', message: 'cancelled by contract test' },
        });
        const calls = info.mock.calls.filter(([message]) => message === 'finalize_state_transition');
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[1]).toMatchObject({
          from: 'pending',
          to: 'failed',
          changed: true,
          reason: 'USER_CANCELLED',
        });
      } finally {
        info.mockRestore();
      }
    });

    it('returns current authority for stale identities and characterizes same-id nonterminal replacement', async () => {
      const identity = await harness.store.createSession();
      const running = await harness.store.markFinalizationRunning(identity.sessionId, {
        finalizationId: 'contract-current',
        queuedAtMs: 10,
        startedAtMs: 20,
        scenarioContext,
      });

      await expect(
        harness.store.markFinalizationQueued(identity.sessionId, {
          finalizationId: 'contract-stale',
          queuedAtMs: 5,
          scenarioContext,
        }),
      ).resolves.toEqual(running);
      await expect(
        harness.store.markFinalizationQueued(identity.sessionId, {
          finalizationId: 'contract-current',
          queuedAtMs: 30,
          scenarioContext,
        }),
      ).resolves.toMatchObject({
        state: { status: 'pending', finalizationId: 'contract-current', queuedAtMs: 30 },
      });
    });

    it('returns the same authority for a repeated identical lifecycle command', async () => {
      const identity = await harness.store.createSession();
      const command = {
        finalizationId: 'contract-idempotent',
        queuedAtMs: 10,
        scenarioContext,
      };
      const first = await harness.store.markFinalizationQueued(identity.sessionId, command);
      const repeated = await harness.store.markFinalizationQueued(identity.sessionId, command);

      expect(repeated).toEqual(first);
      expect(await harness.store.getCurrentFinalizationRecord(identity.sessionId)).toEqual(first);
    });

    it('keeps AWS runtime metadata out of semantic authority on an idempotent retry', async () => {
      const identity = await harness.store.createSession();
      const payload = {
        finalizationId: 'contract-running-runtime-metadata',
        queuedAtMs: 10,
        startedAtMs: 20,
        scenarioContext,
      };
      const running = await harness.store.markFinalizationRunning(identity.sessionId, payload);
      await harness.store.markAwsFinalizationRunning(identity.sessionId, {
        ...payload,
        stepFunctionsArn: 'arn:aws:states:local:000000000000:execution:contract:runtime-metadata',
      });

      expect(await harness.store.getCurrentFinalizationRecord(identity.sessionId)).toEqual(running);
      expect(running).not.toHaveProperty('stepFunctionsArn');
    });

    it('fails closed for nonconforming lifecycle input and refuses success without a canonical result', async () => {
      const identity = await harness.store.createSession();
      await expect(
        harness.store.markFinalizationQueued(identity.sessionId, {
          finalizationId: 'contract-invalid-scenario',
          queuedAtMs: 10,
          scenarioContext: { ...scenarioContext, unknown: true } as never,
        }),
      ).rejects.toThrow('invalid_scenario_context');
      expect(await harness.store.getCurrentFinalizationRecord(identity.sessionId)).toBeNull();

      await harness.store.markFinalizationQueued(identity.sessionId, {
        finalizationId: 'contract-invalid-result',
        queuedAtMs: 10,
        scenarioContext,
      });
      await expect(
        harness.store.markFinalizationSucceeded(identity.sessionId, {
          finalizationId: 'contract-invalid-result',
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          finalizationResult: {} as FinalizationResultAuthority,
        }),
      ).rejects.toThrow('invalid_finalization_result');
      expect((await harness.store.getCurrentFinalizationRecord(identity.sessionId))?.state.status).toBe('pending');
    });

    it('records verification observation idempotently for only the current finalization', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-observation';
      await harness.store.markFinalizationSucceeded(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: buildFinalizationResult(),
      });
      const observation = {
        fingerprint: 'a'.repeat(64),
        observedAt: 1_750_000_000_000,
      };

      await expect(
        harness.store.recordVerificationObservation(identity.sessionId, finalizationId, observation),
      ).resolves.toEqual({ status: 'recorded' });
      await expect(
        harness.store.recordVerificationObservation(identity.sessionId, finalizationId, {
          ...observation,
          observedAt: observation.observedAt + 1,
        }),
      ).resolves.toEqual({ status: 'idempotent' });
      await expect(
        harness.store.recordVerificationObservation(identity.sessionId, finalizationId, {
          ...observation,
          fingerprint: 'c'.repeat(64),
        }),
      ).resolves.toEqual({ status: 'conflict', reason: 'fingerprint_mismatch' });
      await expect(
        harness.store.recordVerificationObservation(identity.sessionId, 'contract-observation-stale', observation),
      ).resolves.toEqual({ status: 'conflict', reason: 'finalization_mismatch' });
    });

    it('atomically commits one complete successful finalization outcome', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-successful-commit';
      const includedBitmap = [true, false];
      const seenBitmap = [true, true];
      const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
      const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: {
          status: 'succeeded',
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
        },
        finalizationResult: {
          finalizationId,
          ...buildFinalizationResult({
            ...createTestJournal({ totalExpected: 2, validVotes: 1, seenIndicesCount: 2 }),
            includedBitmapRoot,
            seenBitmapRoot,
          }),
        },
      });
      const bitmap = {
        availability: 'available' as const,
        data: {
          includedBitmap,
          includedBitmapRoot,
          seenBitmap,
          seenBitmapRoot,
          treeSize: 2,
          finalizedAtMs: 40,
        },
      };
      const input = {
        record,
        receipt: { receipt: '{"contract":"atomic"}', timestamp: 50 },
        bitmap,
        verificationResult: { status: 'success' as const },
      };

      const first = await harness.store.commitSuccessfulFinalization(input);
      const repeated = await harness.store.commitSuccessfulFinalization(input);

      expect(repeated).toEqual(first);
      expect(first.receiptPublication?.receiptHash).toMatch(/^0x[0-9a-f]{64}$/);
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(first.record);
      await expect(
        harness.store.getVerificationResultRecord(identity.sessionId, finalizationId),
      ).resolves.toMatchObject({ verificationResult: { status: 'success' } });
      await expect(harness.store.getBitmapData(identity.sessionId, finalizationId)).resolves.toEqual({
        sessionId: identity.sessionId,
        finalizationId,
        ...bitmap.data,
      });
      if (first.bitmap.availability === 'available') {
        first.bitmap.data.includedBitmap[0] = false;
        first.bitmap.data.seenBitmap?.fill(false);
      }
      first.record.state.completedAtMs = 999;
      first.record.finalizationResult.tally.totalVotes = 999;
      first.record.finalizationResult.journal.verifiedTally[0] = 999;
      input.record.finalizationResult.journal.verifiedTally[0] = 998;
      await expect(harness.store.getBitmapData(identity.sessionId, finalizationId)).resolves.toEqual({
        sessionId: identity.sessionId,
        finalizationId,
        ...bitmap.data,
      });
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(repeated.record);
    });

    it('preserves valid later async verification on a duplicate success callback without sync verification', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-later-async-verification';
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: {
          status: 'succeeded',
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
        },
        finalizationResult: { finalizationId, ...buildFinalizationResult() },
      });
      const input = { record, bitmap: { availability: 'unavailable' as const } };
      const committed = await harness.store.commitSuccessfulFinalization(input);
      await harness.store.markVerificationRunning(identity.sessionId, finalizationId);

      await expect(harness.store.commitSuccessfulFinalization(input)).resolves.toEqual(committed);
      await expect(
        harness.store.getVerificationResultRecord(identity.sessionId, finalizationId),
      ).resolves.toMatchObject({ verificationResult: { status: 'running' } });
    });

    it('derives receipt publication only from the receipt committed in the same operation', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-prepopulated-receipt-rejected';
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: {
          status: 'succeeded',
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
        },
        finalizationResult: {
          finalizationId,
          ...buildFinalizationResult(),
          receiptPublication: {
            receiptHash: `0x${'a'.repeat(64)}`,
            boardIndex: 100,
            timestamp: 30,
          },
        },
      });

      await expect(
        harness.store.commitSuccessfulFinalization({
          record,
          bitmap: { availability: 'unavailable' },
        }),
      ).rejects.toThrow('Successful finalization commit does not accept pre-populated receipt publication');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
    });

    it('exact-admits receipt input before successful finalization mutation', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-extra-receipt-field-rejected';
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: {
          status: 'succeeded',
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
        },
        finalizationResult: { finalizationId, ...buildFinalizationResult() },
      });

      await expect(
        harness.store.commitSuccessfulFinalization({
          record,
          receipt: { receipt: '{"contract":"exact"}', timestamp: 30, unexpected: true } as never,
          bitmap: { availability: 'unavailable' },
        }),
      ).rejects.toThrow('Invalid succeeded finalization receipt publication');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
    });

    it.each([
      [
        'non-boolean included bits',
        (value: Record<string, unknown>) => {
          const data = value['data'] as Record<string, unknown>;
          data['includedBitmap'] = [1];
        },
      ],
      [
        'non-finite finalized time',
        (value: Record<string, unknown>) => {
          const data = value['data'] as Record<string, unknown>;
          data['finalizedAtMs'] = Number.NaN;
        },
      ],
      [
        'negative finalized time',
        (value: Record<string, unknown>) => {
          const data = value['data'] as Record<string, unknown>;
          data['finalizedAtMs'] = -1;
        },
      ],
      [
        'unsafe finalized time',
        (value: Record<string, unknown>) => {
          const data = value['data'] as Record<string, unknown>;
          data['finalizedAtMs'] = Number.MAX_SAFE_INTEGER + 1;
        },
      ],
      [
        'non-finite tree size',
        (value: Record<string, unknown>) => {
          const data = value['data'] as Record<string, unknown>;
          data['treeSize'] = Number.NaN;
        },
      ],
      [
        'negative tree size',
        (value: Record<string, unknown>) => {
          const data = value['data'] as Record<string, unknown>;
          data['treeSize'] = -1;
        },
      ],
      [
        'unsafe tree size',
        (value: Record<string, unknown>) => {
          const data = value['data'] as Record<string, unknown>;
          data['treeSize'] = Number.MAX_SAFE_INTEGER + 1;
        },
      ],
      [
        'extra bitmap data fields',
        (value: Record<string, unknown>) => {
          const data = value['data'] as Record<string, unknown>;
          data['unexpected'] = true;
        },
      ],
      [
        'extra available disposition fields',
        (value: Record<string, unknown>) => {
          value['unexpected'] = true;
        },
      ],
    ])('rejects %s before successful finalization mutation', async (_label, mutate) => {
      const identity = await harness.store.createSession();
      const finalizationId = `contract-invalid-bitmap-${_label.replaceAll(' ', '-')}`;
      const includedBitmap = [true];
      const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: {
          status: 'succeeded',
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
        },
        finalizationResult: {
          finalizationId,
          ...buildFinalizationResult({
            ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
            includedBitmapRoot,
          }),
        },
      });
      const bitmap: Record<string, unknown> = {
        availability: 'available',
        data: {
          includedBitmap,
          includedBitmapRoot,
          treeSize: 1,
          finalizedAtMs: 30,
        },
      };
      mutate(bitmap);

      await expect(
        harness.store.commitSuccessfulFinalization({
          record,
          bitmap: bitmap as never,
        }),
      ).rejects.toThrow('Invalid finalization bitmap evidence');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
    });

    it('rejects extra unavailable bitmap disposition fields before mutation', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-invalid-unavailable-bitmap-shape';
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: {
          status: 'succeeded',
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
        },
        finalizationResult: { finalizationId, ...buildFinalizationResult() },
      });

      await expect(
        harness.store.commitSuccessfulFinalization({
          record,
          bitmap: { availability: 'unavailable', unexpected: true } as never,
        }),
      ).rejects.toThrow('Invalid finalization bitmap evidence');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
    });

    it.each([
      ['start before queue', { queuedAtMs: 10, startedAtMs: 9, completedAtMs: 30 }],
      ['completion before start', { queuedAtMs: 10, startedAtMs: 20, completedAtMs: 19 }],
    ])('rejects successful finalization chronology with %s', async (_label, timestamps) => {
      const identity = await harness.store.createSession();
      const finalizationId = `contract-invalid-chronology-${_label.replaceAll(' ', '-')}`;
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: { status: 'succeeded', finalizationId, ...timestamps },
        finalizationResult: { finalizationId, ...buildFinalizationResult() },
      });

      await expect(
        harness.store.commitSuccessfulFinalization({
          record,
          bitmap: { availability: 'unavailable' },
        }),
      ).rejects.toThrow('Invalid successful finalization lifecycle chronology');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
    });

    it('binds a successful commit to the exact pending queue time and scenario authority', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-pending-success-binding';
      const pending = await harness.store.markFinalizationQueued(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        scenarioContext,
      });
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext: { ...scenarioContext, claimedTotalVotes: 2 },
        state: {
          status: 'succeeded',
          finalizationId,
          queuedAtMs: 11,
          startedAtMs: 20,
          completedAtMs: 30,
        },
        finalizationResult: { finalizationId, ...buildFinalizationResult() },
      });

      await expect(
        harness.store.commitSuccessfulFinalization({
          record,
          bitmap: { availability: 'unavailable' },
        }),
      ).rejects.toThrow('Successful finalization commit does not match current lifecycle authority');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(pending);
    });

    it('binds a successful commit to the exact running start time', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-running-success-binding';
      const running = await harness.store.markFinalizationRunning(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
        scenarioContext,
      });
      const record = requireSucceededRecord({
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: {
          status: 'succeeded',
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 21,
          completedAtMs: 30,
        },
        finalizationResult: { finalizationId, ...buildFinalizationResult() },
      });

      await expect(
        harness.store.commitSuccessfulFinalization({
          record,
          bitmap: { availability: 'unavailable' },
        }),
      ).rejects.toThrow('Successful finalization commit does not match current lifecycle authority');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(running);
    });

    it('rejects embedded bitmap material on the direct lifecycle success command', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-embedded-bitmap-rejected';
      const includedBitmap = [true];
      const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
      const finalizationResult = buildFinalizationResult({
        ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
        includedBitmapRoot,
      });
      finalizationResult.bitmapData = {
        includedBitmap,
        includedBitmapRoot,
        treeSize: 1,
        finalizedAtMs: 30,
      };

      await expect(
        harness.store.markFinalizationSucceeded(identity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          scenarioContext,
          finalizationResult,
        }),
      ).rejects.toThrow('Direct finalization success does not accept embedded bitmap evidence');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
      await expect(harness.store.getBitmapData(identity.sessionId, finalizationId)).resolves.toBeNull();
    });

    it('rejects embedded bitmap material even when terminal authority is sticky', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-terminal-embedded-bitmap-rejected';
      const terminal = await harness.store.markFinalizationFailed(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        failedAtMs: 20,
        scenarioContext,
        error: { code: 'FAILED', message: 'terminal authority' },
      });
      const includedBitmap = [true];
      const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
      const finalizationResult = buildFinalizationResult({
        ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
        includedBitmapRoot,
      });
      finalizationResult.bitmapData = {
        includedBitmap,
        includedBitmapRoot,
        treeSize: 1,
        finalizedAtMs: 30,
      };

      await expect(
        harness.store.markFinalizationSucceeded(identity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          finalizationResult,
        }),
      ).rejects.toThrow('Direct finalization success does not accept embedded bitmap evidence');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(terminal);
    });

    it('rejects embedded receipt publication on the direct lifecycle success command', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-embedded-receipt-rejected';
      const finalizationResult = buildFinalizationResult();
      finalizationResult.receiptPublication = {
        receiptHash: `0x${'b'.repeat(64)}`,
        boardIndex: 100,
        timestamp: 30,
      };

      await expect(
        harness.store.markFinalizationSucceeded(identity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          scenarioContext,
          finalizationResult,
        }),
      ).rejects.toThrow('Direct finalization success does not accept embedded receipt publication');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
    });

    it('rejects embedded receipt publication from an AWS success callback before side effects', async () => {
      const identity = await harness.store.createSession();
      const finalizationId = 'contract-aws-embedded-receipt-rejected';
      const finalizationResult = buildFinalizationResult();
      finalizationResult.receiptPublication = {
        receiptHash: `0x${'c'.repeat(64)}`,
        boardIndex: 100,
        timestamp: 30,
      };

      await expect(
        harness.store.markAwsFinalizationSucceeded(identity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          scenarioContext,
          finalizationResult,
          stepFunctionsArn: 'arn:aws:states:local:execution:embedded-receipt',
          bundleMetadata: {
            s3BundleKey: `sessions/${identity.sessionId}/${finalizationId}/bundle.zip`,
            s3UploadedAtMs: 31,
          },
        }),
      ).rejects.toThrow('Successful finalization commit does not accept pre-populated receipt publication');
      await expect(harness.store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
      await expect(
        harness.store.getAwsFinalizationRuntimeMetadata(identity.sessionId, finalizationId),
      ).resolves.toBeUndefined();
      await expect(
        harness.store.getAwsVerificationDeliveryMetadata(identity.sessionId, finalizationId),
      ).resolves.toBeUndefined();
    });

    it('emits one canonical transition only after the lifecycle mutation succeeds', async () => {
      const identity = await harness.store.createSession();
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      try {
        await harness.store.markFinalizationQueued(identity.sessionId, {
          finalizationId: 'contract-event',
          queuedAtMs: 10,
          scenarioContext,
        });
        expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(1);
      } finally {
        info.mockRestore();
      }
    });

    if (definition.capabilities?.durableReload) {
      it('restores lifecycle, vote index, and observations after reload', async () => {
        const voteIdentity = await harness.store.createSession();
        const voteId = generateVoteId();
        await harness.store.addVote(voteIdentity.sessionId, buildVote(voteId, 'A', 'a'));

        const lifecycleIdentity = await harness.store.createSession();
        await harness.store.markFinalizationSucceeded(lifecycleIdentity.sessionId, {
          finalizationId: 'contract-reload',
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          scenarioContext,
          finalizationResult: buildFinalizationResult(),
        });
        await harness.store.recordVerificationObservation(lifecycleIdentity.sessionId, 'contract-reload', {
          fingerprint: 'b'.repeat(64),
          observedAt: 1_750_000_000_000,
        });

        const reloaded = await requireValue(harness.reload, 'reload capability')();
        expect(await reloaded.getVoteById(voteIdentity.sessionId, voteId)).toMatchObject({
          index: 0,
          voteData: { voteId },
        });
        expect(await reloaded.getCurrentFinalizationRecord(lifecycleIdentity.sessionId)).toMatchObject({
          state: { status: 'succeeded', finalizationId: 'contract-reload' },
        });
        await expect(
          reloaded.recordVerificationObservation(lifecycleIdentity.sessionId, 'contract-reload', {
            fingerprint: 'b'.repeat(64),
            observedAt: 1_750_000_000_001,
          }),
        ).resolves.toEqual({ status: 'idempotent' });
      });
    }

    if (definition.capabilities?.lifecycleWriteFailure) {
      it('does not emit success or change durable state when a lifecycle write fails', async () => {
        const identity = await harness.store.createSession();
        await requireValue(harness.failNextLifecycleWrite, 'lifecycle failure capability')();
        const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        try {
          await expect(
            harness.store.markFinalizationQueued(identity.sessionId, {
              finalizationId: 'contract-write-failure',
              queuedAtMs: 10,
              scenarioContext,
            }),
          ).rejects.toThrow();
          expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(0);
        } finally {
          info.mockRestore();
        }

        const reloaded = await requireValue(harness.reload, 'reload capability')();
        expect(await reloaded.getCurrentFinalizationRecord(identity.sessionId)).toBeNull();
      });
    }
  });
}
