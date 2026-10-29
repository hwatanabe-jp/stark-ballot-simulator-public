import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationResultAuthority,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import { logger } from '@stark-ballot/diagnostics/logger';
import type { BotVoteCommand, SessionIdentityRecord, UserVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { FileMockSessionStore } from './fileMockSessionStore';

const STORAGE_DIR = process.env['FILE_MOCK_STORE_DIR']
  ? path.resolve(process.env['FILE_MOCK_STORE_DIR'])
  : path.join(process.cwd(), '.tmp', 'mock-sessions');
const SNAPSHOT_FILE = path.join(STORAGE_DIR, 'sessions.json');
const TEMPORARY_SNAPSHOT_FILE = `${SNAPSHOT_FILE}.tmp`;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} array`);
  }
  return value;
}

async function readSnapshot(): Promise<Record<string, unknown>> {
  const value: unknown = await fs.readJson(SNAPSHOT_FILE);
  if (!isRecord(value)) {
    throw new Error('Expected file-store snapshot object');
  }
  return value;
}

async function mutateSnapshot(mutator: (snapshot: Record<string, unknown>) => void): Promise<void> {
  const snapshot = await readSnapshot();
  mutator(snapshot);
  await fs.writeJson(SNAPSHOT_FILE, snapshot, { spaces: 2 });
}

function findRecord(records: unknown, key: string, value: string): Record<string, unknown> {
  const record = requireArray(records, 'records').find((candidate) => isRecord(candidate) && candidate[key] === value);
  if (!isRecord(record)) {
    throw new Error(`Expected record with ${key}=${value}`);
  }
  return record;
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

describe('FileMockSessionStore exact records', () => {
  let store: FileMockSessionStore;
  let identity: SessionIdentityRecord;
  let sessionId: SessionId;
  let warnLog: MockInstance<typeof logger.warn>;

  function consumeSnapshotWarnings(count: number): void {
    expect(warnLog).toHaveBeenCalledTimes(count);
    for (let index = 1; index <= count; index += 1) {
      expect(warnLog).toHaveBeenNthCalledWith(index, '[FileMockStore] File snapshot failed closed', {
        error: 'File store snapshot does not match the exact record layout',
      });
    }
    warnLog.mockClear();
  }

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
    if (record.state.status !== 'succeeded' || record.finalizationResult === undefined) {
      throw new Error('Expected succeeded finalization');
    }
    return {
      sessionId: record.sessionId,
      finalizationId: record.finalizationId,
      scenarioContext: record.scenarioContext,
      state: record.state,
      finalizationResult: record.finalizationResult,
    };
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await fs.remove(STORAGE_DIR);
    store = new FileMockSessionStore();
    identity = await store.createSession();
    sessionId = identity.sessionId;
  });

  afterEach(async () => {
    try {
      expect(warnLog).not.toHaveBeenCalled();
    } finally {
      try {
        vi.restoreAllMocks();
      } finally {
        await fs.remove(STORAGE_DIR);
      }
    }
  });

  it('does not expose standalone receipt-board publication', () => {
    expect('saveReceiptToBoard' in store).toBe(false);
  });

  it('persists complete identity and voting records across reloads', async () => {
    const reloaded = new FileMockSessionStore();
    const persistedIdentity = await reloaded.getSessionIdentity(sessionId);
    const voting = await reloaded.getVotingRecord(sessionId);

    expect(persistedIdentity).toEqual(identity);
    expect(voting).toMatchObject({
      sessionId,
      botCount: 0,
      userParticipation: { status: 'not_cast' },
    });
    expect(voting?.bulletin.getLogId()).toBe(identity.logId);
    const snapshot = await readSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'bitmaps',
        'currentFinalizationIds',
        'deliveryMetadata',
        'finalizations',
        'identities',
        'receiptCounter',
        'receipts',
        'runtimeMetadata',
        'verificationObservations',
        'verificationResults',
        'voteIdIndex',
        'voting',
      ].sort(),
    );
    expect('contractGeneration' in findRecord(snapshot['identities'], 'sessionId', sessionId)).toBe(false);
  });

  it('rejects duplicate vote IDs without changing persisted vote or bulletin indexes', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));
    const before = await readSnapshot();

    await expect(store.addVote(sessionId, buildVote('B', 'b', voteId))).resolves.toEqual({
      ok: false,
      error: { code: 'DUPLICATE_VOTE', details: { duplicateKind: 'voteId' } },
    });
    expect(await readSnapshot()).toEqual(before);
  });

  it('persists verification observation CAS state across store instances', async () => {
    const finalizationId = asFinalizationId('observation-cas');
    await succeed(finalizationId);
    await store.recordVerificationObservation(sessionId, finalizationId, {
      fingerprint: 'a'.repeat(64),
      observedAt: 40,
    });
    const reloaded = new FileMockSessionStore();

    await expect(
      reloaded.recordVerificationObservation(sessionId, finalizationId, {
        fingerprint: 'a'.repeat(64),
        observedAt: 41,
      }),
    ).resolves.toEqual({ status: 'idempotent' });
    await expect(reloaded.getVerificationObservation(sessionId, finalizationId)).resolves.toMatchObject({
      fingerprint: 'a'.repeat(64),
    });
  });

  it('rejects stale observations without persisting them', async () => {
    await succeed('observation-current');
    const before = await readSnapshot();

    await expect(
      store.recordVerificationObservation(sessionId, 'observation-stale', {
        fingerprint: 'b'.repeat(64),
        observedAt: 40,
      }),
    ).resolves.toEqual({ status: 'conflict', reason: 'finalization_mismatch' });
    expect(await readSnapshot()).toEqual(before);
  });

  it('serializes lifecycle and observation writes from concurrent store instances', async () => {
    const other = new FileMockSessionStore();
    const finalizationId = asFinalizationId('serialized-writes');
    await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    await other.markFinalizationRunning(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
    });
    await store.recordVerificationObservation(sessionId, finalizationId, {
      fingerprint: 'c'.repeat(64),
      observedAt: 30,
    });

    const reloaded = new FileMockSessionStore();
    await expect(reloaded.getCurrentFinalizationRecord(sessionId)).resolves.toMatchObject({
      state: { status: 'running' },
    });
    await expect(reloaded.getVerificationObservation(sessionId, finalizationId)).resolves.toMatchObject({
      fingerprint: 'c'.repeat(64),
    });
  });

  it('does not emit success or change durable state when lifecycle persistence fails', async () => {
    await fs.ensureDir(TEMPORARY_SNAPSHOT_FILE);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await expect(
      store.markFinalizationQueued(sessionId, {
        finalizationId: asFinalizationId('write-failure'),
        queuedAtMs: 10,
        scenarioContext,
      }),
    ).rejects.toThrow();
    expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(0);
    await fs.remove(TEMPORARY_SNAPSHOT_FILE);
    await expect(new FileMockSessionStore().getCurrentFinalizationRecord(sessionId)).resolves.toBeNull();
  });

  it('retains staged delivery metadata when a finalization success write fails', async () => {
    const finalizationId = asFinalizationId('metadata-before-failure');
    await store.recordAwsVerificationDeliveryMetadata(sessionId, finalizationId, {
      s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
      verificationWorkQueuedAtMs: 15,
    });
    await fs.ensureDir(TEMPORARY_SNAPSHOT_FILE);

    await expect(
      store.markFinalizationSucceeded(sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: buildResult(),
      }),
    ).rejects.toThrow();
    await fs.remove(TEMPORARY_SNAPSHOT_FILE);
    await expect(
      new FileMockSessionStore().getAwsVerificationDeliveryMetadata(sessionId, finalizationId),
    ).resolves.toEqual({
      s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
      verificationWorkQueuedAtMs: 15,
    });
  });

  it('restores in-memory authority when synchronous finalization persistence fails', async () => {
    const finalizationId = asFinalizationId('sync-write-failure');
    await store.recordAwsVerificationDeliveryMetadata(sessionId, finalizationId, {
      verificationWorkQueuedAtMs: 15,
    });
    await fs.ensureDir(TEMPORARY_SNAPSHOT_FILE);

    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(sessionId, finalizationId),
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow();
    await fs.remove(TEMPORARY_SNAPSHOT_FILE);
    await expect(store.getCurrentFinalizationRecord(sessionId)).resolves.toBeNull();
    await expect(store.getAwsVerificationDeliveryMetadata(sessionId, finalizationId)).resolves.toEqual({
      verificationWorkQueuedAtMs: 15,
    });
  });

  it('returns the exact cast-time bulletin root from addVote', async () => {
    const cast = await store.addVote(sessionId, buildVote('A', 'a'));
    if (!cast.ok) {
      throw new Error(`Expected vote persistence, received ${cast.error.code}`);
    }
    const voting = requireValue(await store.getVotingRecord(sessionId), 'voting');

    expect(cast.value.bulletinRootAtCast).toBe(voting.votes.get(0)?.rootAtCast);
    expect(normalizeHex(cast.value.bulletinRootAtCast, { allowEmpty: true })).toBe(
      normalizeHex(voting.bulletin.getRootAtSize(1), { allowEmpty: true }),
    );
  });

  it('does not refresh activity on read-only record calls', async () => {
    const before = requireValue(await store.getVotingRecord(sessionId), 'voting');
    await store.getSessionIdentity(sessionId);
    await store.getVotingRecord(sessionId);
    await store.getCurrentFinalizationRecord(sessionId);
    const after = requireValue(await store.getVotingRecord(sessionId), 'voting');

    expect(after.lastActivityMs).toBe(before.lastActivityMs);
  });

  it('excludes a nonconforming live snapshot from active session count', async () => {
    await mutateSnapshot((snapshot) => {
      findRecord(snapshot['identities'], 'sessionId', sessionId)['legacyGeneration'] = 'retired';
    });

    await expect(new FileMockSessionStore().getActiveSessionCount()).resolves.toBe(0);
    consumeSnapshotWarnings(2);
  });

  it('summarizes a batch of bot votes in one info log entry', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    await store.addVote(sessionId, buildVote('A', 'a'));
    info.mockClear();
    await store.addBotVotes(sessionId, [buildBotVote('B', 'b'), buildBotVote('C', 'c')]);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      '[FileMockStore] Bot votes added',
      expect.objectContaining({ addedCount: 2, totalBotCount: 2, bulletinSize: 3 }),
    );
  });

  it('fails closed when addBotVotes targets a finalized session', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('bot-finalized'),
      queuedAtMs: 10,
      scenarioContext,
    });

    await expect(store.addBotVotes(sessionId, [buildBotVote('B', 'b')])).resolves.toEqual({
      ok: false,
      error: { code: 'SESSION_FINALIZED' },
    });
  });

  it('fails closed on stale persisted botCount instead of reconciling it', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    await mutateSnapshot((snapshot) => {
      findRecord(snapshot['voting'], 'sessionId', sessionId)['botCount'] = 1;
    });
    const before = await fs.readFile(SNAPSHOT_FILE, 'utf8');

    await expect(new FileMockSessionStore().addBotVotes(sessionId, [buildBotVote('B', 'b')])).rejects.toThrow(
      'Session identity is missing or invalid',
    );
    await expect(fs.readFile(SNAPSHOT_FILE, 'utf8')).resolves.toBe(before);
    consumeSnapshotWarnings(3);
  });

  it('fails closed on missing persisted user participation without repairing index zero', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    await mutateSnapshot((snapshot) => {
      delete findRecord(snapshot['voting'], 'sessionId', sessionId)['userParticipation'];
    });

    await expect(new FileMockSessionStore().getVotingRecord(sessionId)).resolves.toBeNull();
    consumeSnapshotWarnings(1);
  });

  it('fails closed when persisted participation points at a non-canonical user index', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    await mutateSnapshot((snapshot) => {
      findRecord(snapshot['voting'], 'sessionId', sessionId)['userParticipation'] = {
        status: 'cast',
        voteIndex: 1,
      };
    });

    await expect(new FileMockSessionStore().getVotingRecord(sessionId)).resolves.toBeNull();
    consumeSnapshotWarnings(1);
  });

  it('fails closed when persisted vote indices are sparse', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    await store.addBotVotes(sessionId, [buildBotVote('B', 'b')]);
    await mutateSnapshot((snapshot) => {
      const voting = findRecord(snapshot['voting'], 'sessionId', sessionId);
      const votes = requireArray(voting['votes'], 'votes');
      const second = requireValue(votes[1], 'second vote');
      if (!Array.isArray(second)) {
        throw new Error('Expected indexed vote');
      }
      second[0] = 2;
    });

    await expect(new FileMockSessionStore().getVotingRecord(sessionId)).resolves.toBeNull();
    consumeSnapshotWarnings(1);
  });

  it('does not persist a ghost vote when the CT write cannot be staged', async () => {
    const invalid = buildVote('A', 'a');
    invalid.rand = 'not-hex';

    await expect(store.addVote(sessionId, invalid)).rejects.toThrow();
    expect(requireValue(await store.getVotingRecord(sessionId), 'voting').votes.size).toBe(0);
    expect(
      requireArray(findRecord((await readSnapshot())['voting'], 'sessionId', sessionId)['votes'], 'votes'),
    ).toEqual([]);
  });

  it('rolls back the vote-ID index when session persistence fails after staging a vote', async () => {
    const voteId = generateVoteId();
    await fs.ensureDir(TEMPORARY_SNAPSHOT_FILE);

    await expect(store.addVote(sessionId, buildVote('A', 'a', voteId))).rejects.toThrow();
    await fs.remove(TEMPORARY_SNAPSHOT_FILE);
    const reloaded = new FileMockSessionStore();
    await expect(reloaded.getVoteById(sessionId, voteId)).resolves.toBeNull();
    expect(requireValue(await reloaded.getVotingRecord(sessionId), 'voting').votes.size).toBe(0);
  });

  it('fails closed when persisted vote-ID index points at a different vote', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));
    await mutateSnapshot((snapshot) => {
      const index = requireArray(snapshot['voteIdIndex'], 'voteIdIndex');
      const entry = requireValue(index[0], 'index entry');
      if (!Array.isArray(entry)) {
        throw new Error('Expected index entry');
      }
      entry[0] = generateVoteId();
    });

    await expect(new FileMockSessionStore().getVoteById(sessionId, voteId)).resolves.toBeNull();
    consumeSnapshotWarnings(1);
  });

  it('refreshes a long-lived reader when another instance appends a vote', async () => {
    const reader = new FileMockSessionStore();
    const voteId = generateVoteId();
    await expect(reader.getVoteById(sessionId, voteId)).resolves.toBeNull();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));

    await expect(reader.getVoteById(sessionId, voteId)).resolves.toMatchObject({
      index: 0,
      voteData: { voteId },
    });
  });

  it('applies bot vote batches atomically when a later staged append fails', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    const before = await readSnapshot();

    await expect(store.addBotVotes(sessionId, [buildBotVote('B', 'b'), buildBotVote('B', 'b')])).rejects.toThrow(
      'Commitment already exists',
    );
    expect(await readSnapshot()).toEqual(before);
  });

  it('fails closed on stale persisted bulletin root history instead of rebuilding it', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    await mutateSnapshot((snapshot) => {
      const voting = findRecord(snapshot['voting'], 'sessionId', sessionId);
      const history = requireArray(voting['bulletinRootHistory'], 'history');
      const first = requireValue(history[0], 'root snapshot');
      if (!isRecord(first)) {
        throw new Error('Expected root snapshot');
      }
      first['root'] = '0'.repeat(64);
    });
    const before = await fs.readFile(SNAPSHOT_FILE, 'utf8');

    await expect(new FileMockSessionStore().getVotingRecord(sessionId)).resolves.toBeNull();
    await expect(fs.readFile(SNAPSHOT_FILE, 'utf8')).resolves.toBe(before);
    consumeSnapshotWarnings(1);
  });

  it('retains matching persisted bulletin timestamps and signatures after reload', async () => {
    await store.addVote(sessionId, buildVote('A', 'a'));
    await mutateSnapshot((snapshot) => {
      const voting = findRecord(snapshot['voting'], 'sessionId', sessionId);
      const history = requireArray(voting['bulletinRootHistory'], 'history');
      const first = requireValue(history[0], 'root snapshot');
      if (!isRecord(first)) {
        throw new Error('Expected root snapshot');
      }
      first['signature'] = 'test-signature';
    });

    const voting = requireValue(await new FileMockSessionStore().getVotingRecord(sessionId), 'voting');
    expect(voting.bulletinRootHistory[0]?.signature).toBe('test-signature');
  });

  it('derives exact Merkle paths after finalization and reload', async () => {
    const voteId = generateVoteId();
    await store.addVote(sessionId, buildVote('A', 'a', voteId));
    await succeed('proof-after-finalization');

    await expect(new FileMockSessionStore().getVoteByIdWithProof(sessionId, voteId)).resolves.toMatchObject({
      leafIndex: 0,
      treeSize: 1,
      merklePath: [],
    });
  });

  it('fails closed on finalization results without a journal', async () => {
    const finalizationId = asFinalizationId('missing-journal');
    await succeed(finalizationId);
    await mutateSnapshot((snapshot) => {
      const record = findRecord(snapshot['finalizations'], 'finalizationId', finalizationId);
      const result = record['finalizationResult'];
      if (!isRecord(result)) {
        throw new Error('Expected finalization result');
      }
      delete result['journal'];
    });

    await expect(new FileMockSessionStore().getSessionIdentity(sessionId)).resolves.toBeNull();
    consumeSnapshotWarnings(1);
  });

  it('keeps receipt bodies outside semantic identity, voting, and finalization records', async () => {
    const finalizationId = asFinalizationId('receipt-separate');
    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(sessionId, finalizationId),
      receipt: { receipt: 'sensitive-receipt-body', timestamp: 40 },
      bitmap: { availability: 'unavailable' },
    });
    const snapshot = await readSnapshot();

    expect(JSON.stringify(snapshot['identities'])).not.toContain('sensitive-receipt-body');
    expect(JSON.stringify(snapshot['voting'])).not.toContain('sensitive-receipt-body');
    expect(JSON.stringify(snapshot['finalizations'])).not.toContain('sensitive-receipt-body');
    expect(JSON.stringify(snapshot['receipts'])).toContain('sensitive-receipt-body');
  });

  it('fails closed on malformed finalization results that only carry a journal', async () => {
    const finalizationId = asFinalizationId('journal-only');
    await succeed(finalizationId);
    await mutateSnapshot((snapshot) => {
      const record = findRecord(snapshot['finalizations'], 'finalizationId', finalizationId);
      const result = record['finalizationResult'];
      if (!isRecord(result)) {
        throw new Error('Expected finalization result');
      }
      record['finalizationResult'] = {
        finalizationId,
        journal: result['journal'],
      };
    });

    await expect(new FileMockSessionStore().getCurrentFinalizationRecord(sessionId)).rejects.toThrow(
      'Session identity is missing or invalid',
    );
    consumeSnapshotWarnings(1);
  });

  it('stores bitmap data by session and finalization identity', async () => {
    const finalizationId = asFinalizationId('bitmap-scoped');
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const journal = {
      ...createTestJournal({ totalExpected: 1 }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    };
    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(sessionId, finalizationId, buildResult(journal)),
      bitmap: {
        availability: 'available',
        data: {
          includedBitmap,
          includedBitmapRoot,
          treeSize: 1,
          finalizedAtMs: 30,
        },
      },
    });
    const other = await store.createSession();

    await expect(new FileMockSessionStore().getBitmapData(sessionId, finalizationId)).resolves.toMatchObject({
      sessionId,
      finalizationId,
      includedBitmap: [true],
    });
    await expect(store.getBitmapData(other.sessionId, finalizationId)).resolves.toBeNull();
  });

  it.each(['seenBitmap', 'seenBitmapRoot'] as const)(
    'fails closed when persisted %s appears without its paired evidence',
    async (fieldToDelete) => {
      const finalizationId = asFinalizationId(`bitmap-one-sided-${fieldToDelete}`);
      const includedBitmap = [true];
      const seenBitmap = [true];
      const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
      const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
      const journal = { ...createTestJournal({ totalExpected: 1 }), includedBitmapRoot, seenBitmapRoot };
      await store.commitSuccessfulFinalization({
        record: buildSucceededRecord(sessionId, finalizationId, buildResult(journal)),
        bitmap: {
          availability: 'available',
          data: {
            includedBitmap,
            includedBitmapRoot,
            seenBitmap,
            seenBitmapRoot,
            treeSize: 1,
            finalizedAtMs: 30,
          },
        },
      });
      await mutateSnapshot((snapshot) => {
        delete findRecord(snapshot['bitmaps'], 'finalizationId', finalizationId)[fieldToDelete];
      });

      await expect(new FileMockSessionStore().getBitmapData(sessionId, finalizationId)).rejects.toThrow(
        'Session identity is missing or invalid',
      );
      consumeSnapshotWarnings(1);
    },
  );

  it('does not rewrite a nonconforming snapshot during reads', async () => {
    await mutateSnapshot((snapshot) => {
      snapshot['retiredWrapper'] = true;
    });
    const before = await fs.readFile(SNAPSHOT_FILE, 'utf8');

    await expect(new FileMockSessionStore().getSessionIdentity(sessionId)).resolves.toBeNull();
    await expect(fs.readFile(SNAPSHOT_FILE, 'utf8')).resolves.toBe(before);
    consumeSnapshotWarnings(1);
  });

  it('does not reinterpret corrupt finalized records during unrelated reads', async () => {
    const finalizationId = asFinalizationId('corrupt-result');
    await succeed(finalizationId);
    await mutateSnapshot((snapshot) => {
      findRecord(snapshot['finalizations'], 'finalizationId', finalizationId)['legacyMarker'] = true;
    });
    const before = await fs.readFile(SNAPSHOT_FILE, 'utf8');

    await expect(new FileMockSessionStore().getSessionIdentity(sessionId)).resolves.toBeNull();
    await expect(fs.readFile(SNAPSHOT_FILE, 'utf8')).resolves.toBe(before);
    consumeSnapshotWarnings(1);
  });

  it('persists async finalization success as the current exact record', async () => {
    const finalizationId = asFinalizationId('async-success');
    await store.markAwsFinalizationSucceeded(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
      scenarioContext,
      finalizationResult: buildResult(),
      stepFunctionsArn: 'arn:async-success',
    });

    await expect(new FileMockSessionStore().getCurrentFinalizationRecord(sessionId)).resolves.toMatchObject({
      finalizationId,
      state: { status: 'succeeded' },
    });
  });

  it('keeps current AWS runtime state when competing stale finalizations arrive', async () => {
    await store.markFinalizationRunning(sessionId, {
      finalizationId: asFinalizationId('runtime-current'),
      queuedAtMs: 10,
      startedAtMs: 20,
      scenarioContext,
    });

    await expect(
      store.markAwsFinalizationRunning(sessionId, {
        finalizationId: asFinalizationId('runtime-stale'),
        queuedAtMs: 11,
        startedAtMs: 21,
        scenarioContext,
        stepFunctionsArn: 'arn:stale',
      }),
    ).resolves.toMatchObject({ status: 'running', finalizationId: 'runtime-current' });
    await expect(
      store.getAwsFinalizationRuntimeMetadata(sessionId, asFinalizationId('runtime-stale')),
    ).resolves.toBeUndefined();
    consumeRejectedTransitionLogs({
      finalizationId: 'runtime-stale',
      reason: 'EXECUTION_MISMATCH',
      to: 'running',
    });
  });

  it('keeps USER_CANCELLED state sticky against later running transitions', async () => {
    const finalizationId = asFinalizationId('cancel-sticky');
    await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    const cancelled = await store.markFinalizationFailed(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      failedAtMs: 20,
      error: { code: 'USER_CANCELLED', message: 'cancelled' },
    });

    await expect(
      store.markFinalizationRunning(sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 21,
      }),
    ).resolves.toEqual(cancelled);
    consumeRejectedTransitionLogs({
      finalizationId,
      reason: 'USER_CANCELLED',
      to: 'running',
    });
  });

  it('keeps every terminal finalization state sticky', async () => {
    for (const status of ['succeeded', 'failed', 'timeout'] as const) {
      const localIdentity = await store.createSession();
      const finalizationId = asFinalizationId(`terminal-${status}`);
      if (status === 'succeeded') {
        await succeed(finalizationId, localIdentity.sessionId);
      } else if (status === 'failed') {
        await store.markFinalizationFailed(localIdentity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          failedAtMs: 20,
          scenarioContext,
          error: { code: 'FAILED', message: 'failure' },
        });
      } else {
        await store.markFinalizationTimedOut(localIdentity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          timeoutAtMs: 20,
          scenarioContext,
        });
      }

      await expect(
        store.markFinalizationRunning(localIdentity.sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 30,
        }),
      ).resolves.toMatchObject({ state: { status } });
    }
    consumeRejectedTransitionLogs(
      { finalizationId: 'terminal-succeeded', reason: 'TERMINAL_STATE_STICKY', to: 'running' },
      { finalizationId: 'terminal-failed', reason: 'TERMINAL_STATE_STICKY', to: 'running' },
      { finalizationId: 'terminal-timeout', reason: 'TERMINAL_STATE_STICKY', to: 'running' },
    );
  });

  it('does not persist success side effects when success arrives after failure', async () => {
    const finalizationId = asFinalizationId('failure-before-success');
    await store.markFinalizationFailed(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      failedAtMs: 20,
      scenarioContext,
      error: { code: 'FAILED', message: 'failure' },
    });
    await store.markAwsFinalizationSucceeded(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
      finalizationResult: buildResult(),
      bundleMetadata: { s3BundleKey: 'late/bundle.zip', s3UploadedAtMs: 31 },
    });

    await expect(store.getAwsFinalizationRuntimeMetadata(sessionId, finalizationId)).resolves.toBeUndefined();
    await expect(store.getAwsVerificationDeliveryMetadata(sessionId, finalizationId)).resolves.toBeUndefined();
  });

  it('rejects widened pure lifecycle payloads before persistence', async () => {
    const before = await fs.readFile(SNAPSHOT_FILE, 'utf8');
    await expect(
      store.markFinalizationQueued(sessionId, {
        finalizationId: 'widened',
        queuedAtMs: 10,
        scenarioContext,
        contractGeneration: 'retired',
      } as never),
    ).rejects.toThrow('Invalid queued finalization payload');
    await expect(
      store.markFinalizationRunning(sessionId, {
        finalizationId: 'widened',
        queuedAtMs: 10,
        startedAtMs: 20,
        scenarioContext,
        stepFunctionsArn: 'arn:not-pure',
      } as never),
    ).rejects.toThrow('Invalid running finalization payload');
    await expect(fs.readFile(SNAPSHOT_FILE, 'utf8')).resolves.toBe(before);
  });

  it('persists scenario context on queue without a contract generation', async () => {
    const record = await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('scenario-context'),
      queuedAtMs: 10,
      scenarioContext: {
        ...scenarioContext,
        scenarios: ['S2'],
        tamperMode: 'claim',
      },
    });

    expect(record.scenarioContext).toMatchObject({ scenarios: ['S2'], tamperMode: 'claim' });
    expect(JSON.stringify(await readSnapshot())).not.toContain('contractGeneration');
  });

  it('keeps semantic finalization authority separate from persisted adapter metadata', async () => {
    const finalizationId = asFinalizationId('metadata-separate');
    await store.markAwsFinalizationSucceeded(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
      scenarioContext,
      finalizationResult: buildResult(),
      stepFunctionsArn: 'arn:metadata',
      bundleMetadata: { s3BundleKey: 'metadata/bundle.zip', s3UploadedAtMs: 31 },
    });
    const record = requireValue(await store.getCurrentFinalizationRecord(sessionId), 'finalization');

    expect(record).not.toHaveProperty('stepFunctionsArn');
    expect(record.finalizationResult).not.toHaveProperty('s3BundleKey');
    await expect(store.getAwsFinalizationRuntimeMetadata(sessionId, finalizationId)).resolves.toEqual({
      stepFunctionsArn: 'arn:metadata',
      bundleMetadata: { s3BundleKey: 'metadata/bundle.zip', s3UploadedAtMs: 31 },
    });
  });

  it('does not reconcile historical records into the explicit current index', async () => {
    const current = await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('current-record'),
      queuedAtMs: 10,
      scenarioContext,
    });
    await mutateSnapshot((snapshot) => {
      requireArray(snapshot['finalizations'], 'finalizations').push({
        sessionId,
        finalizationId: 'historical-record',
        scenarioContext,
        state: {
          status: 'pending',
          finalizationId: 'historical-record',
          queuedAtMs: 11,
        },
      });
    });
    const reloaded = new FileMockSessionStore();

    await expect(reloaded.getCurrentFinalizationRecord(sessionId)).resolves.toEqual(current);
    await expect(
      reloaded.getFinalizationRecord(sessionId, asFinalizationId('historical-record')),
    ).resolves.toMatchObject({ finalizationId: 'historical-record' });
  });

  it('rejects writes against a corrupt finalization record', async () => {
    const finalizationId = asFinalizationId('corrupt-write');
    await store.markFinalizationQueued(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    await mutateSnapshot((snapshot) => {
      findRecord(snapshot['finalizations'], 'finalizationId', finalizationId)['legacyMarker'] = true;
    });

    await expect(
      new FileMockSessionStore().markFinalizationRunning(sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
      }),
    ).rejects.toThrow('Session identity is missing or invalid');
    consumeSnapshotWarnings(3);
  });

  it('does not expose repair APIs or repair a corrupt snapshot', async () => {
    await mutateSnapshot((snapshot) => {
      snapshot['repairMarker'] = true;
    });
    const before = await fs.readFile(SNAPSHOT_FILE, 'utf8');
    const reloaded = new FileMockSessionStore();

    expect('repairSession' in reloaded).toBe(false);
    await expect(reloaded.getSessionIdentity(sessionId)).resolves.toBeNull();
    await expect(fs.readFile(SNAPSHOT_FILE, 'utf8')).resolves.toBe(before);
    consumeSnapshotWarnings(1);
  });

  it('returns the exact receipt publication when the same successful commit is repeated', async () => {
    const record = buildSucceededRecord(sessionId, 'receipt-idempotent');
    const input = {
      record,
      receipt: { receipt: 'receipt-one', timestamp: 40 },
      bitmap: { availability: 'unavailable' as const },
    };
    const first = await store.commitSuccessfulFinalization(input);
    const reloaded = new FileMockSessionStore();
    const repeated = await reloaded.commitSuccessfulFinalization(input);

    expect(repeated).toEqual(first);
    await expect(
      reloaded.commitSuccessfulFinalization({
        ...input,
        receipt: { receipt: 'receipt-two', timestamp: 41 },
      }),
    ).rejects.toThrow('conflicts with existing authority');
    expect(requireArray((await readSnapshot())['receipts'], 'receipts')).toHaveLength(1);
  });

  it('observes receipt publication from the exact pre-publication lifecycle state', async () => {
    const finalizationId = asFinalizationId('receipt-observability');
    await store.markFinalizationRunning(sessionId, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      scenarioContext,
    });
    const record = buildSucceededRecord(sessionId, finalizationId);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await store.commitSuccessfulFinalization({
      record,
      receipt: { receipt: 'observed-receipt', timestamp: 40 },
      bitmap: { availability: 'unavailable' },
    });

    expect(info).toHaveBeenCalledWith(
      'finalize_state_transition',
      expect.objectContaining({
        changed: true,
        finalization_id: finalizationId,
        from: 'running',
        to: 'succeeded',
      }),
    );
  });

  it('does not persist a receipt sidecar when atomic publication fails', async () => {
    const record = buildSucceededRecord(sessionId, 'receipt-write-failure');
    await fs.ensureDir(TEMPORARY_SNAPSHOT_FILE);
    await expect(
      store.commitSuccessfulFinalization({
        record,
        receipt: { receipt: 'failed-receipt', timestamp: 40 },
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow();
    await fs.remove(TEMPORARY_SNAPSHOT_FILE);

    const snapshot = await readSnapshot();
    expect(snapshot['receiptCounter']).toBe(100);
    expect(requireArray(snapshot['receipts'], 'receipts')).toEqual([]);
    await expect(
      new FileMockSessionStore().commitSuccessfulFinalization({
        record,
        receipt: { receipt: 'retry-receipt', timestamp: 41 },
        bitmap: { availability: 'unavailable' },
      }),
    ).resolves.toMatchObject({ receiptPublication: { boardIndex: 100 } });
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

  it('does not publish receipts or consume board indexes for corrupt snapshots', async () => {
    await store.markFinalizationQueued(sessionId, {
      finalizationId: asFinalizationId('receipt-corrupt'),
      queuedAtMs: 10,
      scenarioContext,
    });
    await mutateSnapshot((snapshot) => {
      findRecord(snapshot['finalizations'], 'finalizationId', 'receipt-corrupt')['corrupt'] = true;
    });
    const before = await readSnapshot();

    await expect(
      new FileMockSessionStore().commitSuccessfulFinalization({
        record: buildSucceededRecord(sessionId, 'receipt-corrupt'),
        receipt: { receipt: 'corrupt', timestamp: 40 },
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow('Session identity is missing or invalid');
    expect(await readSnapshot()).toEqual(before);
    expect(before['receiptCounter']).toBe(100);
    consumeSnapshotWarnings(3);
  });

  it.each(['bitmap', 'verification'] as const)(
    'fails closed on a preterminal %s orphan without rewriting the snapshot',
    async (kind) => {
      const finalizationId = asFinalizationId(`file-preterminal-${kind}-orphan`);
      const includedBitmap = [true];
      const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
      const result = buildResult({
        ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
        includedBitmapRoot,
        seenBitmapRoot: includedBitmapRoot,
      });
      await store.markFinalizationQueued(sessionId, {
        finalizationId,
        queuedAtMs: 10,
        scenarioContext,
      });
      await mutateSnapshot((snapshot) => {
        if (kind === 'bitmap') {
          requireArray(snapshot['bitmaps'], 'bitmaps').push({
            sessionId,
            finalizationId,
            includedBitmap,
            includedBitmapRoot,
            treeSize: 1,
            finalizedAtMs: 30,
          });
        } else {
          requireArray(snapshot['verificationResults'], 'verificationResults').push({
            sessionId,
            finalizationId,
            verificationResult: { status: 'running' },
          });
        }
      });
      const before = await readSnapshot();
      const reloaded = new FileMockSessionStore();

      await expect(
        reloaded.commitSuccessfulFinalization({
          record: buildSucceededRecord(sessionId, finalizationId, result),
          bitmap: { availability: 'unavailable' },
        }),
      ).rejects.toThrow('Session identity is missing or invalid');
      await expect(
        reloaded.markFinalizationSucceeded(sessionId, {
          finalizationId,
          queuedAtMs: 10,
          startedAtMs: 20,
          completedAtMs: 30,
          scenarioContext,
          finalizationResult: result,
        }),
      ).rejects.toThrow('Session identity is missing or invalid');
      expect(await readSnapshot()).toEqual(before);
      consumeSnapshotWarnings(3);
    },
  );

  it.each(['missing', 'not-advanced'] as const)(
    'fails closed on a receipt replay when the persisted counter is %s',
    async (counterState) => {
      const finalizationId = asFinalizationId(`file-receipt-counter-${counterState}`);
      const input = {
        record: buildSucceededRecord(sessionId, finalizationId),
        receipt: { receipt: '{"counter":true}', timestamp: 30 },
        bitmap: { availability: 'unavailable' as const },
      };
      const committed = await store.commitSuccessfulFinalization(input);
      await mutateSnapshot((snapshot) => {
        if (counterState === 'missing') {
          delete snapshot['receiptCounter'];
        } else {
          snapshot['receiptCounter'] = committed.receiptPublication?.boardIndex ?? 100;
        }
      });
      const before = await readSnapshot();
      const reloaded = new FileMockSessionStore();

      await expect(reloaded.commitSuccessfulFinalization(input)).rejects.toThrow(
        'Session identity is missing or invalid',
      );
      expect(await readSnapshot()).toEqual(before);
      consumeSnapshotWarnings(3);
    },
  );

  it('fails closed when receipt data and publication share a non-derived hash', async () => {
    const finalizationId = asFinalizationId('file-corrupt-receipt-hash');
    const input = {
      record: buildSucceededRecord(sessionId, finalizationId),
      receipt: { receipt: '{"exact":true}', timestamp: 30 },
      bitmap: { availability: 'unavailable' as const },
    };
    await store.commitSuccessfulFinalization(input);
    const corruptHash = `0x${'f'.repeat(64)}`;
    await mutateSnapshot((snapshot) => {
      findRecord(snapshot['receipts'], 'finalizationId', finalizationId)['receiptHash'] = corruptHash;
      const finalization = findRecord(snapshot['finalizations'], 'finalizationId', finalizationId);
      const finalizationResult = finalization['finalizationResult'];
      if (!isRecord(finalizationResult) || !isRecord(finalizationResult['receiptPublication'])) {
        throw new Error('Expected receipt publication');
      }
      finalizationResult['receiptPublication']['receiptHash'] = corruptHash;
    });
    const before = await readSnapshot();
    const reloaded = new FileMockSessionStore();

    await expect(reloaded.commitSuccessfulFinalization(input)).rejects.toThrow(
      'Session identity is missing or invalid',
    );
    expect(await readSnapshot()).toEqual(before);
    consumeSnapshotWarnings(3);
  });

  it('does not expose generic session updates', () => {
    expect('updateSession' in store).toBe(false);
    expect('getSession' in store).toBe(false);
  });

  it('ignores retired bitmap.json sidecars instead of reusing them', async () => {
    const finalizationId = asFinalizationId('bitmap-legacy-sidecar');
    await succeed(finalizationId);
    await fs.writeJson(path.join(STORAGE_DIR, 'bitmap.json'), {
      sessionId,
      includedBitmap: [true],
      includedBitmapRoot: `0x${'1'.repeat(64)}`,
      treeSize: 1,
      finalizedAtMs: 30,
    });

    await expect(new FileMockSessionStore().getBitmapData(sessionId, finalizationId)).resolves.toBeNull();
  });
});
