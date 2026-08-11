import { describe, expect, it } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationScenarioContext } from '@stark-ballot/application/finalize/finalization-types';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { MockSessionStore } from './mockSessionStore';

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

describe('MockSessionStore lifecycle records', () => {
  it('creates separate complete identity and voting records without legacy aggregate fields', async () => {
    const store = new MockSessionStore();
    const identity = await store.createSession();
    const voting = await store.getVotingRecord(identity.sessionId);

    expect(await store.getSessionIdentity(identity.sessionId)).toEqual(identity);
    expect(voting).toMatchObject({
      sessionId: identity.sessionId,
      botCount: 0,
      userParticipation: { status: 'not_cast' },
    });
    expect(voting?.votes).toBeInstanceOf(Map);
    expect(voting?.bulletin.getLogId()).toBe(identity.logId);
    expect(await store.getCurrentFinalizationRecord(identity.sessionId)).toBeNull();
    expect('getSession' in store).toBe(false);
    expect('updateSession' in store).toBe(false);
    expect(Object.hasOwn(identity, 'contractGeneration')).toBe(false);
    expect(Object.hasOwn(identity, 'finalized')).toBe(false);
  });

  it('uses an explicit current-finalization index and exact scoped lookup', async () => {
    const store = new MockSessionStore();
    const identity = await store.createSession();
    const queued = await store.markFinalizationQueued(identity.sessionId, {
      finalizationId: 'finalization-current',
      queuedAtMs: 10,
      scenarioContext,
    });

    expect(await store.getCurrentFinalizationRecord(identity.sessionId)).toEqual(queued);
    expect(await store.getFinalizationRecord(identity.sessionId, 'finalization-current')).toEqual(queued);
    expect(await store.getFinalizationRecord(identity.sessionId, 'finalization-stale')).toBeNull();
  });

  it('keeps finalization, verification, observation, bitmap, and adapter metadata separate', async () => {
    const store = new MockSessionStore();
    const identity = await store.createSession();
    const finalizationId = 'finalization-separated';
    const includedBitmap = [true];
    const journal = {
      ...createTestJournal({ totalExpected: includedBitmap.length }),
      includedBitmapRoot: computeIncludedBitmapRoot(includedBitmap),
    };
    const result = buildFinalizationResultFromJournal({
      journal,
      imageId: journal.imageId ?? `0x${'1'.repeat(64)}`,
    });
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    const committed = await store.commitSuccessfulFinalization({
      record: {
        sessionId: identity.sessionId,
        finalizationId,
        scenarioContext,
        state: { status: 'succeeded', finalizationId, queuedAtMs: 10, startedAtMs: 20, completedAtMs: 30 },
        finalizationResult: { finalizationId, ...result },
      },
      verificationResult: { status: 'success' },
      bitmap: {
        availability: 'available',
        data: {
          includedBitmap,
          includedBitmapRoot: journal.includedBitmapRoot,
          treeSize: journal.treeSize,
          finalizedAtMs: 30,
        },
      },
    });
    const succeeded = committed.record;
    const verification = await store.getVerificationResultRecord(identity.sessionId, finalizationId);
    await expect(
      store.recordVerificationObservation(identity.sessionId, finalizationId, {
        fingerprint: 'a'.repeat(64),
        observedAt: 40,
      }),
    ).resolves.toEqual({ status: 'recorded' });
    await store.recordAwsProofBundlePublication(identity.sessionId, finalizationId, {
      s3BundleKey: `sessions/${identity.sessionId}/${finalizationId}/bundle.zip`,
      s3UploadedAtMs: 35,
    });

    expect(succeeded.finalizationResult).not.toHaveProperty('verificationResult');
    expect(succeeded.finalizationResult).not.toHaveProperty('s3BundleKey');
    expect(verification).toMatchObject({
      sessionId: identity.sessionId,
      finalizationId,
      verificationResult: { status: 'success' },
    });
    expect(await store.getBitmapData(identity.sessionId, finalizationId)).toMatchObject({
      sessionId: identity.sessionId,
      finalizationId,
      includedBitmap: [true],
    });
    expect(await store.getAwsVerificationDeliveryMetadata(identity.sessionId, finalizationId)).toMatchObject({
      s3UploadedAtMs: 35,
    });
  });

  it('rejects a duplicated observation finalization identifier instead of reconciling it', async () => {
    const store = new MockSessionStore();
    const identity = await store.createSession();
    const finalizationId = 'finalization-observation';
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });

    await expect(
      store.recordVerificationObservation(identity.sessionId, finalizationId, {
        finalizationId: 'duplicated-identity',
        fingerprint: 'a'.repeat(64),
        observedAt: 20,
      } as never),
    ).rejects.toThrow('Invalid verification observation');
  });
});
