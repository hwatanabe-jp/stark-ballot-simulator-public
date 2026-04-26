import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { FileMockSessionStore } from '../fileMockSessionStore';
import type { VoteChoice } from '@/shared/constants';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { resolveCurrentContractGeneration, resolveSessionFinalizationArtifactState } from '@/lib/contract';
import { buildFinalizationResultFromJournal } from '@/lib/finalize/finalization-result';
import { buildZkVMInputFromSession } from '@/lib/zkvm/input-builder';
import { normalizeHex } from '@/lib/utils/hex';

const STORAGE_DIR = process.env.FILE_MOCK_STORE_DIR
  ? path.resolve(process.env.FILE_MOCK_STORE_DIR)
  : path.join(process.cwd(), '.tmp', 'mock-sessions');

function randomHex(): string {
  return `0x${crypto.randomBytes(32).toString('hex')}`;
}

function choiceAt(index: number): VoteChoice {
  const choices: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];
  return choices[index % choices.length];
}

async function finalizeSessionForBitmap(store: FileMockSessionStore, sessionId: string): Promise<void> {
  const journal = createTestJournal({
    totalExpected: 1,
    validVotes: 1,
    missingIndices: 0,
    invalidIndices: 0,
  });

  await store.finalizeSession(
    sessionId,
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
}

function createStoredFinalizationResult(executionId: string, journal = createTestJournal()) {
  return {
    ...buildFinalizationResultFromJournal({
      journal,
      imageId: '0x' + '1'.repeat(64),
    }),
    verificationExecutionId: executionId,
  };
}

async function mutatePersistedSessionRecord(
  sessionId: string,
  mutator: (record: Record<string, unknown>) => void,
): Promise<void> {
  const sessionsFile = path.join(STORAGE_DIR, 'sessions.json');
  const persistedSessions = (await fs.readJson(sessionsFile)) as Array<Record<string, unknown>>;
  const persistedRecord = persistedSessions.find((entry) => entry.sessionId === sessionId);

  if (!persistedRecord) {
    throw new Error(`Expected persisted session ${sessionId}`);
  }

  mutator(persistedRecord);
  await fs.writeJson(sessionsFile, persistedSessions, { spaces: 2 });
}

async function readPersistedSessionRecord(sessionId: string): Promise<Record<string, unknown>> {
  const sessionsFile = path.join(STORAGE_DIR, 'sessions.json');
  const persistedSessions = (await fs.readJson(sessionsFile)) as Array<Record<string, unknown>>;
  const persistedRecord = persistedSessions.find((entry) => entry.sessionId === sessionId);

  if (!persistedRecord) {
    throw new Error(`Expected persisted session ${sessionId}`);
  }

  return persistedRecord;
}

describe('FileMockSessionStore', () => {
  beforeEach(async () => {
    await fs.remove(STORAGE_DIR);
  });

  afterEach(async () => {
    await fs.remove(STORAGE_DIR);
  });

  it('returns the exact cast-time bulletin root from addVote', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    const result = await store.addVote(session.sessionId, {
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
    });

    const reloaded = await store.getSession(session.sessionId);
    const storedVote = reloaded?.votes.get(0);

    expect(result.leafIndex).toBe(0);
    expect(result.merklePath).toEqual(expect.any(Array));
    expect(result.bulletinRootAtCast).toBe(storedVote?.rootAtCast);
  });

  it('does not refresh lastActivity on read-only getSession calls', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    session.lastActivity = 1234;

    const reloaded = await store.getSession(session.sessionId);

    expect(reloaded?.lastActivity).toBe(1234);
  });

  it('excludes fail-closed live sessions from the active session count', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    expect(await store.getActiveSessionCount()).toBe(1);

    await store.updateSession(session.sessionId, {
      finalizationArtifactState: 'corrupt_or_unreadable',
    });

    expect(await store.getActiveSessionCount()).toBe(0);
  });

  it('fails closed when addBotVotes targets a stale live session', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await store.updateSession(session.sessionId, {
      contractGeneration: 'stale-contract-generation',
    });

    await expect(
      store.addBotVotes(session.sessionId, [
        {
          vote: choiceAt(0),
          rand: randomHex(),
          commit: randomHex(),
          path: [],
        },
      ]),
    ).rejects.toThrow('Session not found');

    const reloaded = await store.getSession(session.sessionId);
    expect(reloaded?.botCount).toBe(0);
  });

  it('reconciles stale persisted botCount before assigning new bot vote indices after reload', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const firstBotVoteId = crypto.randomUUID();
    const secondBotVoteId = crypto.randomUUID();

    await store.addVote(session.sessionId, {
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
    });

    await store.addBotVotes(session.sessionId, [
      {
        voteId: firstBotVoteId,
        vote: 'B',
        rand: randomHex(),
        commit: randomHex(),
        path: [],
      },
    ]);

    await mutatePersistedSessionRecord(session.sessionId, (persistedRecord) => {
      persistedRecord.botCount = 0;
    });

    const reloadedStore = new FileMockSessionStore();
    await reloadedStore.addBotVotes(session.sessionId, [
      {
        voteId: secondBotVoteId,
        vote: 'C',
        rand: randomHex(),
        commit: randomHex(),
        path: [],
      },
    ]);

    const reloaded = await reloadedStore.getSession(session.sessionId);
    expect(Array.from(reloaded?.votes.keys() ?? [])).toEqual([0, 1, 2]);
    expect(reloaded?.votes.get(1)?.voteId).toBe(firstBotVoteId);
    expect(reloaded?.votes.get(2)?.voteId).toBe(secondBotVoteId);
    expect(reloaded?.bulletin?.getSize()).toBe(3);
    expect(reloaded?.botCount).toBe(2);
  });

  it('repairs a missing persisted userVoteIndex from the canonical vote at index zero', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const botVoteId = crypto.randomUUID();

    await store.addVote(session.sessionId, {
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
    });

    await mutatePersistedSessionRecord(session.sessionId, (persistedRecord) => {
      delete persistedRecord.userVoteIndex;
    });

    const reloadedStore = new FileMockSessionStore();
    const reloadedSession = await reloadedStore.getSession(session.sessionId);
    expect(reloadedSession?.userVoteIndex).toBe(0);

    await reloadedStore.addBotVotes(session.sessionId, [
      {
        voteId: botVoteId,
        vote: 'B',
        rand: randomHex(),
        commit: randomHex(),
        path: [],
      },
    ]);

    const updated = await reloadedStore.getSession(session.sessionId);
    expect(updated?.userVoteIndex).toBe(0);
    expect(Array.from(updated?.votes.keys() ?? [])).toEqual([0, 1]);
    expect(updated?.votes.get(1)?.voteId).toBe(botVoteId);
    expect(updated?.botCount).toBe(1);
  });

  it('fails closed when addBotVotes is called before the user vote exists', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await expect(
      store.addBotVotes(session.sessionId, [
        {
          voteId: crypto.randomUUID(),
          vote: 'B',
          rand: randomHex(),
          commit: randomHex(),
          path: [],
        },
      ]),
    ).rejects.toThrow('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');

    const reloaded = await store.getSession(session.sessionId);
    expect(reloaded?.votes.size).toBe(0);
    expect(reloaded?.botCount).toBe(0);
  });

  it('fails closed when persisted state points the user vote at a non-canonical index', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await store.addVote(session.sessionId, {
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
    });

    await mutatePersistedSessionRecord(session.sessionId, (persistedRecord) => {
      const votes = persistedRecord.votes;
      if (!Array.isArray(votes) || votes.length === 0) {
        throw new Error('Expected persisted votes');
      }
      const [, firstVote] = votes[0] as [number, Record<string, unknown>];
      votes.push([
        1,
        {
          ...firstVote,
          voteId: crypto.randomUUID(),
          commit: randomHex(),
          rand: randomHex(),
          rootAtCast: randomHex(),
        },
      ]);
      persistedRecord.userVoteIndex = 1;
    });

    const reloadedStore = new FileMockSessionStore();

    await expect(
      reloadedStore.addBotVotes(session.sessionId, [
        {
          voteId: crypto.randomUUID(),
          vote: 'B',
          rand: randomHex(),
          commit: randomHex(),
          path: [],
        },
      ]),
    ).rejects.toThrow('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');
  });

  it('fails closed when persisted vote indices are sparse before appending bot votes', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await store.addVote(session.sessionId, {
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
    });

    await store.addBotVotes(session.sessionId, [
      {
        voteId: crypto.randomUUID(),
        vote: 'B',
        rand: randomHex(),
        commit: randomHex(),
        path: [],
      },
    ]);

    await mutatePersistedSessionRecord(session.sessionId, (persistedRecord) => {
      const votes = persistedRecord.votes;
      if (!Array.isArray(votes) || votes.length < 2) {
        throw new Error('Expected persisted votes');
      }
      const secondVote = votes[1] as unknown;
      if (!Array.isArray(secondVote) || secondVote.length !== 2) {
        throw new Error('Expected persisted vote entry');
      }
      secondVote[0] = 2;
    });

    const reloadedStore = new FileMockSessionStore();

    await expect(
      reloadedStore.addBotVotes(session.sessionId, [
        {
          voteId: crypto.randomUUID(),
          vote: 'C',
          rand: randomHex(),
          commit: randomHex(),
          path: [],
        },
      ]),
    ).rejects.toThrow('NON_CANONICAL_CT_VOTE_INDICES');
  });

  it('does not persist a ghost vote after addVote fails before CT append completes', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await expect(
      store.addVote(session.sessionId, {
        voteId: 'not-a-uuid',
        vote: 'A',
        rand: randomHex(),
        commit: randomHex(),
        path: [],
      }),
    ).rejects.toThrow('Invalid vote ID format');

    const reloaded = await store.getSession(session.sessionId);
    expect(reloaded?.votes.size).toBe(0);
    expect(reloaded?.userVoteIndex).toBeUndefined();

    await store.updateSession(session.sessionId, {
      lastActivity: (reloaded?.lastActivity ?? 0) + 1,
    });

    const persistedRecord = await readPersistedSessionRecord(session.sessionId);
    expect(persistedRecord.votes).toEqual([]);
  });

  it('applies bot vote batches atomically when a later staged append fails', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await store.addVote(session.sessionId, {
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
    });

    const validBotVoteId = crypto.randomUUID();

    await expect(
      store.addBotVotes(session.sessionId, [
        {
          voteId: validBotVoteId,
          vote: 'B',
          rand: randomHex(),
          commit: randomHex(),
          path: [],
        },
        {
          voteId: 'not-a-uuid',
          vote: 'C',
          rand: randomHex(),
          commit: randomHex(),
          path: [],
        },
      ]),
    ).rejects.toThrow('Invalid vote ID format');

    const reloaded = await store.getSession(session.sessionId);
    expect(reloaded?.votes.size).toBe(1);
    expect(reloaded?.botCount).toBe(0);
    expect(reloaded?.bulletin?.getSize()).toBe(1);
    expect(await store.getVoteById(session.sessionId, validBotVoteId)).toBeNull();

    await store.updateSession(session.sessionId, {
      lastActivity: (reloaded?.lastActivity ?? 0) + 1,
    });

    const persistedRecord = await readPersistedSessionRecord(session.sessionId);
    expect(Array.isArray(persistedRecord.votes)).toBe(true);
    expect((persistedRecord.votes as unknown[]).length).toBe(1);
  });

  it('rebuilds stale persisted bulletin root history from votes after reload', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await store.addVote(session.sessionId, {
      voteId: crypto.randomUUID(),
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
      timestamp: 1_700_000_000_000,
    });

    await store.addBotVotes(session.sessionId, [
      {
        voteId: crypto.randomUUID(),
        vote: 'B',
        rand: randomHex(),
        commit: randomHex(),
        path: [],
        timestamp: 1_700_000_001_000,
      },
    ]);

    await mutatePersistedSessionRecord(session.sessionId, (persistedRecord) => {
      persistedRecord.bulletinRootHistory = [
        { timestamp: 111, root: '0x' + 'f'.repeat(64), treeSize: 1 },
        { timestamp: 222, root: '0x' + 'e'.repeat(64), treeSize: 2, signature: 'stale-sig' },
      ];
    });

    const reloadedStore = new FileMockSessionStore();
    const reloaded = await reloadedStore.getSession(session.sessionId);
    if (!reloaded?.bulletin) {
      throw new Error('Expected reloaded bulletin to exist');
    }

    const input = buildZkVMInputFromSession(reloaded);
    expect(input.bulletinRoot).toBe(normalizeHex(reloaded.bulletin.getCurrentRoot()));
    expect(input.treeSize).toBe(reloaded.bulletin.getSize());
    expect(reloaded.bulletinRootHistory?.[1]?.root).toBe(normalizeHex(reloaded.bulletin.getCurrentRoot()));
    expect(reloaded.bulletinRootHistory?.[1]?.signature).toBeUndefined();
  });

  it('retains matching persisted bulletin root history timestamps and signatures after reload', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await store.addVote(session.sessionId, {
      voteId: crypto.randomUUID(),
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
      timestamp: 1_700_000_000_000,
    });

    await store.addBotVotes(session.sessionId, [
      {
        voteId: crypto.randomUUID(),
        vote: 'B',
        rand: randomHex(),
        commit: randomHex(),
        path: [],
        timestamp: 1_700_000_001_000,
      },
    ]);

    const liveSession = await store.getSession(session.sessionId);
    const expectedHistory = liveSession?.bulletinRootHistory;
    if (!expectedHistory || expectedHistory.length !== 2) {
      throw new Error('Expected live bulletin history with two snapshots');
    }

    await mutatePersistedSessionRecord(session.sessionId, (persistedRecord) => {
      persistedRecord.bulletinRootHistory = expectedHistory.map((snapshot, index) => ({
        timestamp: 10_000 + index,
        root: snapshot.root,
        treeSize: snapshot.treeSize,
        signature: `sig-${index + 1}`,
      }));
    });

    const reloadedStore = new FileMockSessionStore();
    const reloaded = await reloadedStore.getSession(session.sessionId);

    expect(reloaded?.bulletinRootHistory).toEqual([
      {
        timestamp: 10_000,
        root: normalizeHex(expectedHistory[0]?.root ?? ''),
        treeSize: expectedHistory[0]?.treeSize,
        signature: 'sig-1',
      },
      {
        timestamp: 10_001,
        root: normalizeHex(expectedHistory[1]?.root ?? ''),
        treeSize: expectedHistory[1]?.treeSize,
        signature: 'sig-2',
      },
    ]);
  });

  it('persists merkle paths after finalization', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    // Add the user vote
    await store.addVote(session.sessionId, {
      vote: 'A',
      rand: randomHex(),
      commit: randomHex(),
      path: [],
    });

    // Add all bot votes (63 total)
    const botVotes = Array.from({ length: 63 }, (_, index) => ({
      vote: choiceAt(index),
      rand: randomHex(),
      commit: randomHex(),
      path: [],
    }));
    await store.addBotVotes(session.sessionId, botVotes);

    // Finalize with minimal required payload
    await store.finalizeSession(
      session.sessionId,
      createStoredFinalizationResult('exec-merkle-paths', journal),
      resolveCurrentContractGeneration(),
    );

    const reloaded = await store.getSession(session.sessionId);
    if (!reloaded) {
      throw new Error('Expected session to be reloaded');
    }

    const userVote = reloaded.votes.get(0);
    expect(userVote?.path.length).toBeGreaterThan(0);

    const botVote = reloaded.votes.get(1);
    expect(botVote?.path.length).toBeGreaterThan(0);
  });

  it('drops corrupt finalization results without a journal when reloading from disk', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const journal = createTestJournal();

    await store.finalizeSession(
      session.sessionId,
      createStoredFinalizationResult('exec-corrupt-no-journal', journal),
      resolveCurrentContractGeneration(),
    );

    await mutatePersistedSessionRecord(session.sessionId, (persistedRecord) => {
      const finalizationResult = persistedRecord.finalizationResult;
      if (!finalizationResult || typeof finalizationResult !== 'object') {
        throw new Error('Expected persisted finalizationResult');
      }
      delete (finalizationResult as Record<string, unknown>).journal;
    });

    const reloadedStore = new FileMockSessionStore();
    const reloaded = await reloadedStore.getSession(session.sessionId);

    expect(reloaded?.finalized).toBe(true);
    expect(reloaded?.finalizationResult).toBeUndefined();
    expect(reloaded?.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('drops malformed finalization results that only carry a journal when reloading from disk', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const journal = createTestJournal();

    await store.finalizeSession(
      session.sessionId,
      createStoredFinalizationResult('exec-journal-only', journal),
      resolveCurrentContractGeneration(),
    );

    await mutatePersistedSessionRecord(session.sessionId, (persistedRecord) => {
      persistedRecord.finalizationResult = {
        journal,
      };
    });

    const reloadedStore = new FileMockSessionStore();
    const reloaded = await reloadedStore.getSession(session.sessionId);

    expect(reloaded?.finalized).toBe(true);
    expect(reloaded?.finalizationResult).toBeUndefined();
    expect(reloaded?.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('stores bitmap data by sessionId instead of a single shared slot', async () => {
    const store = new FileMockSessionStore();
    const sessionA = await store.createSession();
    const sessionB = await store.createSession();

    await finalizeSessionForBitmap(store, sessionA.sessionId);
    await finalizeSessionForBitmap(store, sessionB.sessionId);

    await store.saveBitmapData(sessionA.sessionId, {
      includedBitmap: [true, false, true],
      includedBitmapRoot: '0x' + 'a'.repeat(64),
      treeSize: 3,
      finalizedAt: 111,
    });

    await store.saveBitmapData(sessionB.sessionId, {
      includedBitmap: [false, true, false],
      includedBitmapRoot: '0x' + 'b'.repeat(64),
      treeSize: 3,
      finalizedAt: 222,
    });

    const bitmapA = await store.getBitmapData(sessionA.sessionId);
    const bitmapB = await store.getBitmapData(sessionB.sessionId);

    expect(bitmapA).toEqual({
      sessionId: sessionA.sessionId,
      includedBitmap: [true, false, true],
      includedBitmapRoot: '0x' + 'a'.repeat(64),
      treeSize: 3,
      finalizedAt: 111,
    });
    expect(bitmapB).toEqual({
      sessionId: sessionB.sessionId,
      includedBitmap: [false, true, false],
      includedBitmapRoot: '0x' + 'b'.repeat(64),
      treeSize: 3,
      finalizedAt: 222,
    });
  });

  it('does not rewrite stale finalized wrappers during unrelated saves', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    await finalizeSessionForBitmap(store, session.sessionId);

    const sessionsFile = path.join(STORAGE_DIR, 'sessions.json');
    const rawSessions = (await fs.readJson(sessionsFile)) as Array<Record<string, unknown>>;
    const staleRecord = rawSessions.find((entry) => entry.sessionId === session.sessionId);
    if (!staleRecord) {
      throw new Error('Expected stale record to exist');
    }
    staleRecord.finalizationContractGeneration = 'stale-contract-generation';
    delete staleRecord.finalizationArtifactState;
    await fs.writeJson(sessionsFile, rawSessions, { spaces: 2 });

    const reloadedStore = new FileMockSessionStore();
    const reloaded = await reloadedStore.getSession(session.sessionId);
    expect(reloaded?.finalizationResult).toBeUndefined();
    expect(reloaded?.finalizationArtifactState).toBe('unsupported_current_artifact');

    await reloadedStore.createSession();

    const persistedSessions = (await fs.readJson(sessionsFile)) as Array<Record<string, unknown>>;
    const persistedRecord = persistedSessions.find((entry) => entry.sessionId === session.sessionId);
    expect(persistedRecord?.finalizationContractGeneration).toBe('stale-contract-generation');
    expect(persistedRecord?.finalizationArtifactState).toBeUndefined();
    expect(persistedRecord?.finalizationResult).toBeDefined();
    expect(typeof persistedRecord?.finalizationResult).toBe('object');
    expect(persistedRecord?.finalizationResult).not.toBeNull();
    if (
      !persistedRecord?.finalizationResult ||
      typeof persistedRecord.finalizationResult !== 'object' ||
      !('journal' in persistedRecord.finalizationResult)
    ) {
      throw new Error('Expected persisted finalization result with journal');
    }
    expect(persistedRecord.finalizationResult.journal).toBeDefined();
  });

  it('does not rewrite corrupt finalized wrappers during unrelated saves', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    await finalizeSessionForBitmap(store, session.sessionId);

    const sessionsFile = path.join(STORAGE_DIR, 'sessions.json');
    const rawSessions = (await fs.readJson(sessionsFile)) as Array<Record<string, unknown>>;
    const corruptRecord = rawSessions.find((entry) => entry.sessionId === session.sessionId);
    if (
      !corruptRecord ||
      typeof corruptRecord.finalizationResult !== 'object' ||
      corruptRecord.finalizationResult === null
    ) {
      throw new Error('Expected corrupt record to exist');
    }
    (corruptRecord.finalizationResult as Record<string, unknown>).legacyField = 'unexpected';
    delete corruptRecord.finalizationArtifactState;
    await fs.writeJson(sessionsFile, rawSessions, { spaces: 2 });

    const reloadedStore = new FileMockSessionStore();
    const reloaded = await reloadedStore.getSession(session.sessionId);
    expect(reloaded?.finalizationResult).toBeUndefined();
    expect(reloaded?.finalizationArtifactState).toBe('corrupt_or_unreadable');

    await reloadedStore.createSession();

    const persistedSessions = (await fs.readJson(sessionsFile)) as Array<Record<string, unknown>>;
    const persistedRecord = persistedSessions.find((entry) => entry.sessionId === session.sessionId);
    expect(persistedRecord?.finalizationArtifactState).toBeUndefined();
    expect(persistedRecord?.finalizationResult).toMatchObject({
      legacyField: 'unexpected',
    });
  });

  it('marks the session finalized when async finalization succeeds', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const journal = createTestJournal();

    await store.markFinalizationQueued(session.sessionId, {
      executionId: 'exec-123',
      queuedAt: 1_730_000_000_000,
      contractGeneration: resolveCurrentContractGeneration(),
    });

    await store.markFinalizationSucceeded(session.sessionId, {
      executionId: 'exec-123',
      queuedAt: 1_730_000_000_000,
      startedAt: 1_730_000_001_000,
      completedAt: 1_730_000_002_000,
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationResult: createStoredFinalizationResult('exec-123', journal),
    });

    const reloaded = await store.getSession(session.sessionId);
    expect(reloaded?.finalized).toBe(true);
    expect(reloaded?.finalizationState?.status).toBe('succeeded');
  });

  it('seeds the finalization contract generation when scenario context is persisted before queueing', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const executionId = 'exec-queue-after-context';
    const queuedAt = 1_730_000_000_000;

    await store.updateSession(session.sessionId, {
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

    await store.markFinalizationQueued(session.sessionId, {
      executionId,
      queuedAt,
      contractGeneration: resolveCurrentContractGeneration(),
    });

    const reloaded = await store.getSession(session.sessionId);
    expect(reloaded?.finalizationContractGeneration).toBe(resolveCurrentContractGeneration());
    expect(reloaded?.finalizationState).toEqual({
      status: 'pending',
      executionId,
      queuedAt,
    });
    expect(reloaded?.finalizationScenarioContext).toEqual({
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

  it('treats the persisted wrapper generation as authoritative after the branch exists', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const executionId = 'exec-wrapper-stale';
    const queuedAt = 1_730_000_000_000;

    await store.markFinalizationQueued(session.sessionId, {
      executionId,
      queuedAt,
      contractGeneration: resolveCurrentContractGeneration(),
    });
    await store.updateSession(session.sessionId, {
      finalizationContractGeneration: 'stale-contract-generation',
    });

    const nextState = await store.markFinalizationRunning(session.sessionId, {
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

    const reloaded = await store.getSession(session.sessionId);
    expect(reloaded?.finalizationArtifactState).toBe('unsupported_current_artifact');
    expect(reloaded?.finalizationState).toMatchObject({
      status: 'failed',
      executionId,
      queuedAt,
    });
    expect(resolveSessionFinalizationArtifactState(reloaded ?? { finalized: false })).toBe(
      'unsupported_current_artifact',
    );
  });

  it('converges stale branches before returning early on executionId mismatch', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const queuedAt = 1_730_000_000_000;

    await store.markFinalizationQueued(session.sessionId, {
      executionId: 'exec-original',
      queuedAt,
      contractGeneration: resolveCurrentContractGeneration(),
    });
    await store.updateSession(session.sessionId, {
      finalizationContractGeneration: 'stale-contract-generation',
    });

    const nextState = await store.markFinalizationRunning(session.sessionId, {
      executionId: 'exec-new',
      queuedAt: queuedAt + 5_000,
      startedAt: queuedAt + 6_000,
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

    const reloaded = await store.getSession(session.sessionId);
    expect(reloaded?.finalizationArtifactState).toBe('unsupported_current_artifact');
    expect(reloaded?.finalizationState).toMatchObject({
      status: 'failed',
      executionId: 'exec-original',
      queuedAt,
    });
  });

  it('rejects write-side updates against a corrupt finalization branch', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    await store.updateSession(session.sessionId, {
      finalizationState: {
        status: 'pending',
        executionId: 'exec-corrupt-branch',
        queuedAt: 1_730_000_000_000,
      },
    });
    const corrupted = await store.getSession(session.sessionId);
    if (!corrupted) {
      throw new Error('Expected session to exist');
    }
    corrupted.finalizationContractGeneration = undefined;

    const journal = createTestJournal();
    await expect(
      store.updateSession(session.sessionId, {
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
    const store = new FileMockSessionStore();
    const session = await store.createSession();
    const executionId = 'exec-repair-stale';
    const queuedAt = 1_730_000_000_000;

    await store.markFinalizationQueued(session.sessionId, {
      executionId,
      queuedAt,
      contractGeneration: resolveCurrentContractGeneration(),
    });
    await store.updateSession(session.sessionId, {
      finalizationContractGeneration: 'stale-contract-generation',
    });

    const sessionsFile = path.join(STORAGE_DIR, 'sessions.json');
    const rawSessions = (await fs.readJson(sessionsFile)) as Array<Record<string, unknown>>;
    const staleRecord = rawSessions.find((entry) => entry.sessionId === session.sessionId);
    if (!staleRecord) {
      throw new Error('Expected stale record to exist');
    }
    staleRecord.finalizationArtifactState = 'unsupported_current_artifact';
    await fs.writeJson(sessionsFile, rawSessions, { spaces: 2 });

    const repairedStore = new FileMockSessionStore();
    const stale = await repairedStore.getSession(session.sessionId);
    expect(stale?.finalizationArtifactState).toBe('unsupported_current_artifact');

    await repairedStore.updateSession(session.sessionId, {
      finalizationContractGeneration: resolveCurrentContractGeneration(),
    });

    const repaired = await repairedStore.getSession(session.sessionId);
    expect(repaired?.finalizationContractGeneration).toBe(resolveCurrentContractGeneration());
    expect(repaired?.finalizationArtifactState).toBeUndefined();
    expect(resolveSessionFinalizationArtifactState(repaired ?? { finalized: false })).toBe('supported');
  });

  it('resets legacy bitmap.json artifacts instead of reusing them', async () => {
    await fs.ensureDir(STORAGE_DIR);
    await fs.writeJson(path.join(STORAGE_DIR, 'bitmap.json'), {
      sessionId: 'legacy-session',
      includedBitmap: [true, false],
      includedBitmapRoot: '0x' + 'c'.repeat(64),
      treeSize: 2,
      finalizedAt: 333,
    });

    const store = new FileMockSessionStore();
    const bitmap = await store.getBitmapData('legacy-session');

    expect(bitmap).toBeNull();
    expect(await fs.pathExists(path.join(STORAGE_DIR, 'bitmap.json'))).toBe(false);
  });
});
