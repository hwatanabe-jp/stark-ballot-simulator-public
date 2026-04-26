import { describe, it, expect, beforeEach } from 'vitest';
import { MockSessionStore } from './mockSessionStore';
import type { VoteData } from '@/types/server';
import { generateVoteId } from '@/lib/vote/voteId';
import { computeCommitment } from '@/lib/zkvm/types';
import { createTestCommitment } from '@/lib/testing/commitment-test-helpers';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { addHexPrefix } from '@/lib/utils/hex';
import {
  CorruptOrUnreadableFinalizedStateBoundaryError,
  resolveCurrentContractGeneration,
  resolveSessionFinalizationArtifactState,
} from '@/lib/contract';
import { buildFinalizationResultFromJournal } from '@/lib/finalize/finalization-result';

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
        verificationExecutionId: 'exec-bitmap-test',
      },
      resolveCurrentContractGeneration(),
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

  describe('finalization state transitions', () => {
    it('seeds the finalization contract generation when scenario context is persisted before queueing', async () => {
      const executionId = 'ulid-queue-after-context';
      const queuedAt = 1730000000000;

      await store.updateSession(sessionId, {
        finalizationScenarioContext: {
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

      await store.markFinalizationQueued(sessionId, {
        executionId,
        queuedAt,
        contractGeneration: resolveCurrentContractGeneration(),
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

      await store.markFinalizationRunning(sessionId, {
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

      await store.markFinalizationSucceeded(sessionId, {
        executionId,
        queuedAt,
        startedAt,
        completedAt,
        contractGeneration: resolveCurrentContractGeneration(),
        bundleMetadata: {
          s3BundleKey: 'sessions/abc/execution-1/bundle.zip',
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
          s3BundleKey: 'sessions/abc/execution-1/bundle.zip',
          s3UploadedAt: '2025-10-26T12:34:56.000Z',
        },
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
      });
      expect(session?.finalized).toBe(true);
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
          },
          resolveCurrentContractGeneration(),
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

      session.finalizationState = {
        status: 'pending',
        executionId: 'exec-corrupt-branch',
        queuedAt: 1730000000000,
      };
      session.finalizationContractGeneration = undefined;

      const journal = createTestJournal();
      await expect(
        store.updateSession(sessionId, {
          finalizationResult: {
            tally: {
              counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
              totalVotes: 1,
              tamperedCount: 0,
            },
            imageId: '0x' + '1'.repeat(64),
            journal,
          },
        }),
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

      await store.updateSession(sessionId, {
        finalizationContractGeneration: resolveCurrentContractGeneration(),
      });

      const repaired = await store.getSession(sessionId);
      expect(repaired?.finalizationContractGeneration).toBe(resolveCurrentContractGeneration());
      expect(repaired?.finalizationArtifactState).toBeUndefined();
      expect(resolveSessionFinalizationArtifactState(repaired ?? { finalized: false })).toBe('supported');
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
    session.bulletin = undefined;

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
      const secondVote = votes[1];
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
