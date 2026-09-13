import { describe, expect, it, vi } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationScenarioContext } from '@stark-ballot/application/finalize/finalization-types';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createMockVoteStore } from './mockVoteStore';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const SESSION_ID = asSessionId('session-1');

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

describe('createMockVoteStore lifecycle defaults', () => {
  it('exposes exact record ports without retired aggregate mutation methods', () => {
    const store = createMockVoteStore();

    expect('getSession' in store).toBe(false);
    expect('updateSession' in store).toBe(false);
    expect(typeof store.getSessionIdentity).toBe('function');
    expect(typeof store.getVotingRecord).toBe('function');
    expect(typeof store.getCurrentFinalizationRecord).toBe('function');
    expect(typeof store.getVerificationResultRecord).toBe('function');
  });

  it('preserves exact overrides while providing lifecycle-aware defaults', async () => {
    const getSessionIdentity = vi.fn().mockResolvedValue(null);
    const store = createMockVoteStore({ getSessionIdentity });

    await expect(store.getSessionIdentity(SESSION_ID)).resolves.toBeNull();
    expect(getSessionIdentity).toHaveBeenCalledWith(SESSION_ID);
  });

  it('keeps finalization, verification, and observation records separately keyed', async () => {
    const store = createMockVoteStore();
    const finalizationId = asFinalizationId('finalization-1');
    const journal = createTestJournal();
    await store.markFinalizationQueued(SESSION_ID, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    await store.markFinalizationSucceeded(SESSION_ID, {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
      finalizationResult: buildFinalizationResultFromJournal({
        journal,
        imageId: journal.imageId ?? `0x${'1'.repeat(64)}`,
      }),
    });

    await store.completeVerificationResult(SESSION_ID, finalizationId, { status: 'success' });
    await store.recordVerificationObservation(SESSION_ID, finalizationId, {
      fingerprint: 'a'.repeat(64),
      observedAt: 40,
    });

    expect(await store.getCurrentFinalizationRecord(SESSION_ID)).not.toHaveProperty('verificationResult');
    expect(await store.getVerificationResultRecord(SESSION_ID, finalizationId)).toMatchObject({
      finalizationId,
      verificationResult: { status: 'success' },
    });
  });
});
