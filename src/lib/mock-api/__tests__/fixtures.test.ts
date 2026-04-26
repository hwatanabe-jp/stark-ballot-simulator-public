import {
  buildBulletinProofResponse,
  buildBulletinResponse,
  buildConsistencyProofResponse,
  buildFinalizeCancelResponse,
  buildFinalizationResult,
  buildFinalizationStatusResponse,
  buildSessionResponse,
  buildVerifyResponse,
} from '../fixtures';
import { VERIFICATION_CHECK_DEFINITIONS } from '@/lib/verification/verification-checks';
import {
  FinalizeSyncResponseSchema,
  SessionStatusResponseSchema,
  VerifyResponseSchema,
} from '@/lib/validation/apiSchemas';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import verifyS0Fixture from '../fixtures/json/verify.get.S0.json';
import type { MockState } from '../state';

const baseState: MockState = {
  sessionId: '11111111-2222-3333-4444-555555555555',
  capabilityToken: 'mock-capability-token-for-test',
  contractGeneration: resolveCurrentContractGeneration(),
  electionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  electionConfigHash: '0x' + 'a'.repeat(64),
  logId: '0x' + 'b'.repeat(64),
  animationSeed: '0xcccccccccccccccc',
  scenarioId: 'S3',
};

const cloneValue = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const withPatchedVerifyFixtureData = <T>(
  fixture: { data: Record<string, unknown> },
  mutate: (data: Record<string, unknown>) => void,
  run: () => T,
): T => {
  const originalData = cloneValue(fixture.data);
  mutate(fixture.data);
  try {
    return run();
  } finally {
    fixture.data = originalData;
  }
};

describe('mock api fixtures', () => {
  it('buildSessionResponse overrides session identifiers', () => {
    const payload = buildSessionResponse(baseState) as { data?: Record<string, unknown> };
    const data = payload.data as Record<string, unknown>;
    expect(data.sessionId).toBe(baseState.sessionId);
    expect(data.capabilityToken).toBe(baseState.capabilityToken);
    expect(data.electionId).toBe(baseState.electionId);
    expect(data.electionConfigHash).toBe(baseState.electionConfigHash);
    expect(data.logId).toBe(baseState.logId);
  });

  it('buildVerifyResponse preserves scenario fixture fields', () => {
    const payload = buildVerifyResponse(baseState, 1730000000000) as { data?: Record<string, unknown> };
    const data = payload.data as Record<string, unknown>;
    expect(data.scenarioId).toBe('S3');
    expect(data.logId).toBe(baseState.logId);
    expect(data.missingSlots).toBe(1);
    expect(data.invalidPresentedSlots).toBe(0);
    expect(data.rejectedRecords).toBe(0);
    expect(data.excludedSlots).toBe(1);
    const summary = data.botVotesSummary as { affectedBotIds?: number[] };
    expect(summary.affectedBotIds).toEqual([1]);
  });

  it('buildVerifyResponse maps stark step status from state', () => {
    const payload = buildVerifyResponse(
      {
        ...baseState,
        scenarioId: 'S0',
        verificationStatus: 'success',
      },
      1730000000000,
    ) as { data?: Record<string, unknown> };
    const data = payload.data as Record<string, unknown>;
    const steps = data.verificationSteps as Array<{ id: string; status: string }>;
    const starkStep = steps.find((step) => step.id === 'stark_verification');
    expect(starkStep?.status).toBe('success');
  });

  it('buildVerifyResponse derives verificationChecks from step status', () => {
    const payload = buildVerifyResponse(
      {
        ...baseState,
        scenarioId: 'S2',
      },
      1730000000000,
    ) as { data?: Record<string, unknown> };
    const data = payload.data as Record<string, unknown>;
    const checks = data.verificationChecks as Array<{ id?: string; status?: string }>;
    const countedCheck = checks.find((check) => check.id === 'counted_tally_consistent');
    expect(checks).toHaveLength(VERIFICATION_CHECK_DEFINITIONS.length);
    expect(countedCheck?.status).toBe('failed');
  });

  it('buildVerifyResponse returns a canonical v12 journal when includeJournal is enabled', () => {
    const payload = buildVerifyResponse(baseState, 1730000000000, { includeJournal: true });
    const parsed = VerifyResponseSchema.parse(payload);
    const data = parsed.data;

    expect(data.journalStatus).toBe('available');
    if (data.journalStatus !== 'available') {
      throw new Error('Expected canonical journal to be included');
    }
    expect(data.journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(data.journal.bulletinRoot).toBe(data.bulletinRoot);
    expect(data.journal.missingSlots).toBe(data.missingSlots);
    expect(data.journal.missingSlots).toBe(data.missingSlots);
    expect(data.journal.invalidPresentedSlots).toBe(data.invalidPresentedSlots);
    expect(data.journal.invalidPresentedSlots).toBe(data.invalidPresentedSlots);
    expect(data.journal.validVotes).toBe(data.verifiedTally.reduce((sum, count) => sum + count, 0));
    expect(data.journal.excludedSlots).toBe(data.excludedSlots);
    expect(data.journal.excludedSlots).toBe(data.excludedSlots);
  });

  it('fails closed when a current-contract fixture is missing verifiedTally', () => {
    expect(() =>
      withPatchedVerifyFixtureData(
        verifyS0Fixture as { data: Record<string, unknown> },
        (data) => {
          delete data.verifiedTally;
        },
        () => buildVerifyResponse({ ...baseState, scenarioId: 'S0' }, 1730000000000, { includeJournal: true }),
      ),
    ).toThrow('[mock-api] Missing current-contract verifiedTally in verify fixture S0');
  });

  it('derives journal totalVotes from counted and rejected records', () => {
    const payload = withPatchedVerifyFixtureData(
      verifyS0Fixture as { data: Record<string, unknown> },
      (data) => {
        data.verifiedTally = [10, 10, 10, 10, 10];
        data.missingSlots = 14;
        data.invalidPresentedSlots = 0;
        data.rejectedRecords = 3;
        data.validVotes = 50;
        data.excludedSlots = 14;
        data.seenIndicesCount = 50;
      },
      () => buildVerifyResponse({ ...baseState, scenarioId: 'S0' }, 1730000000000, { includeJournal: true }),
    );
    const parsed = VerifyResponseSchema.parse(payload);

    if (parsed.data.journalStatus !== 'available') {
      throw new Error('Expected canonical journal to be included');
    }

    expect(parsed.data.rejectedRecords).toBe(3);
    expect(parsed.data.journal.validVotes).toBe(50);
    expect(parsed.data.journal.invalidVotes).toBe(3);
    expect(parsed.data.journal.totalVotes).toBe(53);
    expect(parsed.data.journal.totalVotes).toBe(parsed.data.journal.validVotes + parsed.data.journal.invalidVotes);
  });

  it('buildFinalizationStatusResponse returns a canonical succeeded finalization result', () => {
    const now = 1730000245000;
    const payload = buildFinalizationStatusResponse(
      {
        ...baseState,
        finalizationQueuedAt: now - 22000,
        finalizationStartedAt: now - 20000,
        finalizationCompletedAt: now - 1000,
      },
      now,
    );
    const parsed = SessionStatusResponseSchema.parse(payload);

    expect(parsed.finalizationState?.status).toBe('succeeded');
    expect(parsed.finalizationResult?.journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(parsed.finalizationResult?.journal.missingSlots).toBe(parsed.finalizationResult?.missingSlots);
    expect(parsed.finalizationResult?.journal.invalidPresentedSlots).toBe(
      parsed.finalizationResult?.invalidPresentedSlots,
    );
    expect(parsed.finalizationResult?.journal.validVotes).toBe(
      parsed.finalizationResult?.verifiedTally.reduce((sum, count) => sum + count, 0),
    );
    expect(parsed.finalizationResult?.journal.excludedSlots).toBe(parsed.finalizationResult?.excludedSlots);
  });

  it('buildFinalizationResult returns a canonical sync result with top-level mirrors derived from journal', () => {
    const parsed = FinalizeSyncResponseSchema.parse({
      data: buildFinalizationResult({
        ...baseState,
        scenarioId: 'S0',
      }),
    });
    const data = parsed.data;

    expect(data.journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(data.journal.bulletinRoot).toBe(data.bulletinRoot);
    expect(data.journal.missingSlots).toBe(data.missingSlots);
    expect(data.journal.invalidPresentedSlots).toBe(data.invalidPresentedSlots);
    expect(data.journal.validVotes).toBe(data.verifiedTally.reduce((sum, count) => sum + count, 0));
    expect(data.journal.excludedSlots).toBe(data.excludedSlots);
    expect(data.journal.seenIndicesCount).toBe(data.seenIndicesCount);
  });

  it('supports current-contract S5 exclusion metrics across mock builders', () => {
    const now = 1730000245000;
    const state: MockState = {
      ...baseState,
      scenarioId: 'S5',
      finalizationQueuedAt: now - 22000,
      finalizationStartedAt: now - 20000,
      finalizationCompletedAt: now - 1000,
    };

    const finalizeResult = FinalizeSyncResponseSchema.parse({ data: buildFinalizationResult(state) }).data;
    expect(finalizeResult.missingSlots).toBe(4);
    expect(finalizeResult.invalidPresentedSlots).toBe(0);
    expect(finalizeResult.journal.validVotes).toBe(60);
    expect(finalizeResult.excludedSlots).toBe(4);
    expect(finalizeResult.excludedSlots).toBe(4);
    expect(finalizeResult.journal.missingSlots).toBe(4);
    expect(finalizeResult.journal.validVotes).toBe(60);
    expect(finalizeResult.journal.excludedSlots).toBe(4);

    const verifyPayload = VerifyResponseSchema.parse(buildVerifyResponse(state, now));
    expect(verifyPayload.data.missingSlots).toBe(4);
    expect(verifyPayload.data.verifiedTally.reduce((sum, count) => sum + count, 0)).toBe(60);
    expect(verifyPayload.data.excludedSlots).toBe(4);
    expect(verifyPayload.data.excludedSlots).toBe(4);

    const statusPayload = SessionStatusResponseSchema.parse(buildFinalizationStatusResponse(state, now));
    expect(statusPayload.finalizationState?.status).toBe('succeeded');
    expect(statusPayload.finalizationResult?.missingSlots).toBe(4);
    expect(statusPayload.finalizationResult?.journal.validVotes).toBe(60);
    expect(statusPayload.finalizationResult?.excludedSlots).toBe(4);
    expect(statusPayload.finalizationResult?.excludedSlots).toBe(4);
  });

  it('buildBulletinResponse returns paged commitments and metadata', () => {
    const state: MockState = {
      ...baseState,
      commitment: '0x' + 'e'.repeat(64),
      bulletinIndex: 3,
    };
    const payload = buildBulletinResponse(state, { offset: 0, limit: 10, now: 1730000000000 }) as {
      commitments?: string[];
      nextOffset?: number;
      hasMore?: boolean;
    };
    expect(payload.commitments).toHaveLength(10);
    expect(payload.commitments?.[3]).toBe(state.commitment);
    expect(payload.nextOffset).toBe(10);
    expect(payload.hasMore).toBe(true);
  });

  it('buildBulletinProofResponse returns inclusion proof for user vote', () => {
    const state: MockState = {
      ...baseState,
      commitment: '0x' + 'e'.repeat(64),
      bulletinIndex: 2,
      voteId: '00000000-0000-4000-8000-000000000001',
    };
    const payload = buildBulletinProofResponse(state, state.voteId ?? 'missing') as {
      voteId?: string;
      proof?: { leafIndex?: number; merklePath?: string[] };
    };
    expect(payload.voteId).toBe(state.voteId);
    expect(payload.proof?.leafIndex).toBe(state.bulletinIndex);
    expect((payload.proof?.merklePath ?? []).length).toBeGreaterThan(0);
  });

  it('buildConsistencyProofResponse returns proof metadata', () => {
    const state: MockState = {
      ...baseState,
      commitment: '0x' + 'e'.repeat(64),
      bulletinIndex: 0,
    };
    const payload = buildConsistencyProofResponse(state, { oldSize: 1, newSize: 64, now: 1730000000000 }) as {
      oldSize?: number;
      newSize?: number;
      rootAtOldSize?: string;
      rootAtNewSize?: string;
      proofNodes?: string[];
    };
    expect(payload.oldSize).toBe(1);
    expect(payload.newSize).toBe(64);
    expect(payload.rootAtOldSize?.startsWith('0x')).toBe(true);
    expect(payload.rootAtNewSize?.startsWith('0x')).toBe(true);
    expect((payload.proofNodes ?? []).length).toBeGreaterThan(0);
  });

  it('buildFinalizeCancelResponse returns failed state', () => {
    const payload = buildFinalizeCancelResponse(baseState, {
      executionId: 'mock-execution-001',
      reason: 'Cancelled from test',
      now: 1730000000000,
    }) as {
      state?: { status?: string; error?: { code?: string; message?: string } };
    };
    expect(payload.state?.status).toBe('failed');
    expect(payload.state?.error?.code).toBe('USER_CANCELLED');
    expect(payload.state?.error?.message).toContain('Cancelled');
  });
});
