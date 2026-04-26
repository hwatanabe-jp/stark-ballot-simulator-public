import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { FileMockSessionStore } from '../fileMockSessionStore';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { createTestJournal } from '@/lib/testing/test-helpers';
import type { ZkVMJournal } from '@/lib/zkvm/types';

const STORAGE_DIR = process.env.FILE_MOCK_STORE_DIR
  ? path.resolve(process.env.FILE_MOCK_STORE_DIR)
  : path.join(process.cwd(), '.tmp', 'mock-sessions');

function createAuthoritativePublicInputArtifact(
  journal: Pick<
    ZkVMJournal,
    | 'electionId'
    | 'electionConfigHash'
    | 'methodVersion'
    | 'bulletinRoot'
    | 'treeSize'
    | 'totalExpected'
    | 'validVotes'
    | 'inputCommitment'
  >,
  overrides: Parameters<typeof createTestPublicInputArtifact>[0] = {},
) {
  return createTestPublicInputArtifact({
    ...overrides,
    typedAuthority: {
      electionId: journal.electionId,
      electionConfigHash: journal.electionConfigHash,
      methodVersion: journal.methodVersion,
      bulletinRoot: journal.bulletinRoot,
      treeSize: journal.treeSize,
      totalExpected: journal.totalExpected,
      votesCount: journal.validVotes,
      logId: '0x' + 'b'.repeat(64),
      timestamp: 123,
      recomputedInputCommitment: journal.inputCommitment,
      ...overrides.typedAuthority,
    },
  });
}

function createFinalizationPayload() {
  const journal = createTestJournal({
    totalExpected: 64,
    validVotes: 64,
    missingIndices: 0,
    invalidIndices: 0,
  });

  return {
    tally: {
      counts: { A: 16, B: 10, C: 14, D: 13, E: 11 },
      totalVotes: 64,
      tamperedCount: 0,
    },
    bulletinRoot: '0x' + '1'.repeat(64),
    imageId: '0x' + '2'.repeat(64),
    tamperDetected: false,
    publicInputArtifact: createAuthoritativePublicInputArtifact(journal),
    journal: {
      ...journal,
      verifiedTally: [16, 10, 14, 13, 11],
    },
  };
}

describe('FileMockSessionStore cache behaviour', () => {
  const originalLimit = process.env.FILE_STORE_CACHE_LIMIT;
  const originalDisable = process.env.DISABLE_FILE_STORE_CACHE;

  beforeEach(async () => {
    await fs.remove(STORAGE_DIR);
    FileMockSessionStore.__resetDiagnosticsForTests();
    if (originalLimit === undefined) {
      delete process.env.FILE_STORE_CACHE_LIMIT;
    } else {
      process.env.FILE_STORE_CACHE_LIMIT = originalLimit;
    }
    if (originalDisable === undefined) {
      delete process.env.DISABLE_FILE_STORE_CACHE;
    } else {
      process.env.DISABLE_FILE_STORE_CACHE = originalDisable;
    }
  });

  afterEach(async () => {
    await fs.remove(STORAGE_DIR);
    FileMockSessionStore.__resetDiagnosticsForTests();
    if (originalLimit === undefined) {
      delete process.env.FILE_STORE_CACHE_LIMIT;
    } else {
      process.env.FILE_STORE_CACHE_LIMIT = originalLimit;
    }
    if (originalDisable === undefined) {
      delete process.env.DISABLE_FILE_STORE_CACHE;
    } else {
      process.env.DISABLE_FILE_STORE_CACHE = originalDisable;
    }
  });

  it('reuses session cache when mtime is unchanged', async () => {
    const store = new FileMockSessionStore();
    const session = await store.createSession();

    const diagnosticsAfterCreate = FileMockSessionStore.__getDiagnosticsForTests();
    expect(diagnosticsAfterCreate.sessionDiskReads).toBe(1);

    const firstFetch = await store.getSession(session.sessionId);
    expect(firstFetch).not.toBeNull();

    const afterFirstFetch = FileMockSessionStore.__getDiagnosticsForTests();
    expect(afterFirstFetch.sessionDiskReads).toBe(1);

    const secondFetch = await store.getSession(session.sessionId);
    expect(secondFetch).not.toBeNull();

    const afterSecondFetch = FileMockSessionStore.__getDiagnosticsForTests();
    expect(afterSecondFetch.sessionDiskReads).toBe(1);
  });

  it('reloads sessions when underlying file mtime changes', async () => {
    const storeA = new FileMockSessionStore();
    const storeB = new FileMockSessionStore();

    const session = await storeA.createSession();

    const initialDiagnostics = FileMockSessionStore.__getDiagnosticsForTests();
    expect(initialDiagnostics.sessionDiskReads).toBe(2);

    const fetched = await storeB.getSession(session.sessionId);
    expect(fetched).not.toBeNull();

    const afterFirstRead = FileMockSessionStore.__getDiagnosticsForTests();
    expect(afterFirstRead.sessionDiskReads).toBe(3);

    await storeA.updateSession(session.sessionId, {
      finalizationResult: createFinalizationPayload(),
    });

    const refreshed = await storeB.getSession(session.sessionId);
    expect(refreshed?.finalizationResult?.journal.verifiedTally).toEqual([16, 10, 14, 13, 11]);

    const afterReload = FileMockSessionStore.__getDiagnosticsForTests();
    expect(afterReload.sessionDiskReads).toBeGreaterThan(afterFirstRead.sessionDiskReads);
  });

  it('evicts least recently used sessions when cache limit is exceeded', async () => {
    process.env.FILE_STORE_CACHE_LIMIT = '2';
    const store = new FileMockSessionStore();

    const sessions = [];
    for (let i = 0; i < 3; i++) {
      sessions.push(await store.createSession());
    }

    const diagnosticsAfterCreate = FileMockSessionStore.__getDiagnosticsForTests();
    expect(diagnosticsAfterCreate.cacheSize).toBe(2);
    expect(diagnosticsAfterCreate.cacheEvictions).toBe(1);

    const restored = await store.getSession(sessions[0].sessionId);
    expect(restored?.sessionId).toBe(sessions[0].sessionId);

    const afterRestore = FileMockSessionStore.__getDiagnosticsForTests();
    expect(afterRestore.cacheSize).toBe(2);
    expect(afterRestore.cacheEvictions).toBeGreaterThanOrEqual(1);

    const persistedSessions: unknown = await fs.readJson(path.join(STORAGE_DIR, 'sessions.json'));
    expect(Array.isArray(persistedSessions)).toBe(true);
    if (Array.isArray(persistedSessions)) {
      expect(persistedSessions).toHaveLength(3);
    }
  });
});
