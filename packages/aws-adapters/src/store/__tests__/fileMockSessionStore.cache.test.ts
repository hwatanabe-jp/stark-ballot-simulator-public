import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { FileMockSessionStore } from '../fileMockSessionStore';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const STORAGE_DIR = process.env['FILE_MOCK_STORE_DIR']
  ? path.resolve(process.env['FILE_MOCK_STORE_DIR'])
  : path.join(process.cwd(), '.tmp', 'mock-sessions');

describe('FileMockSessionStore cache behaviour', () => {
  const originalLimit = process.env['FILE_STORE_CACHE_LIMIT'];
  const originalDisable = process.env['DISABLE_FILE_STORE_CACHE'];

  beforeEach(async () => {
    await fs.remove(STORAGE_DIR);
    FileMockSessionStore.__resetDiagnosticsForTests();
    if (originalLimit === undefined) {
      delete process.env['FILE_STORE_CACHE_LIMIT'];
    } else {
      process.env['FILE_STORE_CACHE_LIMIT'] = originalLimit;
    }
    if (originalDisable === undefined) {
      delete process.env['DISABLE_FILE_STORE_CACHE'];
    } else {
      process.env['DISABLE_FILE_STORE_CACHE'] = originalDisable;
    }
  });

  afterEach(async () => {
    await fs.remove(STORAGE_DIR);
    FileMockSessionStore.__resetDiagnosticsForTests();
    if (originalLimit === undefined) {
      delete process.env['FILE_STORE_CACHE_LIMIT'];
    } else {
      process.env['FILE_STORE_CACHE_LIMIT'] = originalLimit;
    }
    if (originalDisable === undefined) {
      delete process.env['DISABLE_FILE_STORE_CACHE'];
    } else {
      process.env['DISABLE_FILE_STORE_CACHE'] = originalDisable;
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

    await storeA.markFinalizationQueued(session.sessionId, {
      executionId: 'exec-cache-reload',
      queuedAt: 1_730_000_000_000,
      contractGeneration: session.contractGeneration ?? resolveCurrentContractGeneration(),
      scenarioContext: {
        scenarios: ['S2'],
        tamperMode: 'claim',
        claimedCounts: { A: 16, B: 10, C: 14, D: 13, E: 11 },
        claimedTotalVotes: 64,
        summary: {
          ignoredCount: 0,
          recountedCount: 1,
          userRecountChoice: 'A',
        },
      },
    });

    const refreshed = await storeB.getSession(session.sessionId);
    expect(refreshed?.finalizationScenarioContext?.scenarios).toEqual(['S2']);

    const afterReload = FileMockSessionStore.__getDiagnosticsForTests();
    expect(afterReload.sessionDiskReads).toBeGreaterThan(afterFirstRead.sessionDiskReads);
  });

  it('evicts least recently used sessions when cache limit is exceeded', async () => {
    process.env['FILE_STORE_CACHE_LIMIT'] = '2';
    const store = new FileMockSessionStore();

    const sessions = [];
    for (let i = 0; i < 3; i++) {
      sessions.push(await store.createSession());
    }

    const diagnosticsAfterCreate = FileMockSessionStore.__getDiagnosticsForTests();
    expect(diagnosticsAfterCreate.cacheSize).toBe(2);
    expect(diagnosticsAfterCreate.cacheEvictions).toBe(1);

    const restored = await store.getSession(strictDefined(sessions[0]).sessionId);
    expect(restored?.sessionId).toBe(strictDefined(sessions[0]).sessionId);

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
