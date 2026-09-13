import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationScenarioContext } from '@stark-ballot/application/finalize/finalization-types';
import { FileMockSessionStore } from './fileMockSessionStore';

const STORAGE_DIR = process.env['FILE_MOCK_STORE_DIR']
  ? path.resolve(process.env['FILE_MOCK_STORE_DIR'])
  : path.join(process.cwd(), '.tmp', 'mock-sessions');
const SNAPSHOT_FILE = path.join(STORAGE_DIR, 'sessions.json');

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

describe('FileMockSessionStore snapshot refresh', () => {
  beforeEach(async () => {
    await fs.remove(STORAGE_DIR);
  });

  afterEach(async () => {
    await fs.remove(STORAGE_DIR);
  });

  it('keeps repeated record reads side-effect free when the snapshot is unchanged', async () => {
    const store = new FileMockSessionStore();
    const identity = await store.createSession();
    const before = await fs.readFile(SNAPSHOT_FILE, 'utf8');

    await expect(store.getSessionIdentity(identity.sessionId)).resolves.toEqual(identity);
    await expect(store.getVotingRecord(identity.sessionId)).resolves.toMatchObject({
      sessionId: identity.sessionId,
    });
    await expect(store.getSessionIdentity(identity.sessionId)).resolves.toEqual(identity);

    await expect(fs.readFile(SNAPSHOT_FILE, 'utf8')).resolves.toBe(before);
  });

  it('refreshes a long-lived reader when another instance changes the snapshot', async () => {
    const writer = new FileMockSessionStore();
    const reader = new FileMockSessionStore();
    const identity = await writer.createSession();

    await expect(reader.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
    await writer.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('snapshot-refresh'),
      queuedAtMs: 10,
      scenarioContext,
    });

    await expect(reader.getCurrentFinalizationRecord(identity.sessionId)).resolves.toMatchObject({
      finalizationId: 'snapshot-refresh',
      state: { status: 'pending' },
    });
  });

  it('retains every exact identity and voting record across reload', async () => {
    const store = new FileMockSessionStore();
    const identities = await Promise.all([store.createSession(), store.createSession(), store.createSession()]);
    const reloaded = new FileMockSessionStore();

    for (const identity of identities) {
      await expect(reloaded.getSessionIdentity(identity.sessionId)).resolves.toEqual(identity);
      await expect(reloaded.getVotingRecord(identity.sessionId)).resolves.toMatchObject({
        sessionId: identity.sessionId,
      });
    }
    await expect(reloaded.getActiveSessionCount()).resolves.toBe(3);
  });
});
