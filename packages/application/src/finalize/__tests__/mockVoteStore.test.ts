import { describe, expect, it, vi } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationScenarioContext } from '@stark-ballot/application/finalize/finalization-types';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createMockVoteStore } from './support/mockVoteStore';

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

    await expect(store.getSessionIdentity('session-1')).resolves.toBeNull();
    expect(getSessionIdentity).toHaveBeenCalledWith('session-1');
  });

  it('keeps finalization, verification, and observation records separately keyed', async () => {
    const store = createMockVoteStore();
    const finalizationId = 'finalization-1';
    const journal = createTestJournal();
    await store.markFinalizationQueued('session-1', {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    await store.markFinalizationSucceeded('session-1', {
      finalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
      finalizationResult: buildFinalizationResultFromJournal({
        journal,
        imageId: journal.imageId ?? `0x${'1'.repeat(64)}`,
      }),
    });

    await store.completeVerificationResult('session-1', finalizationId, { status: 'success' });
    await store.recordVerificationObservation('session-1', finalizationId, {
      fingerprint: 'a'.repeat(64),
      observedAt: 40,
    });

    expect(await store.getCurrentFinalizationRecord('session-1')).not.toHaveProperty('verificationResult');
    expect(await store.getVerificationResultRecord('session-1', finalizationId)).toMatchObject({
      finalizationId,
      verificationResult: { status: 'success' },
    });
  });
});
