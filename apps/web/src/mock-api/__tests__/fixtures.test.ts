import {
  buildBulletinProofResponse,
  buildBulletinResponse,
  buildConsistencyProofResponse,
  buildCurrentFinalizationResponse,
  buildFinalizationCancelResponse,
  buildFinalizationResponse,
  buildMockBitmapEvidence,
  buildSessionResponse,
  buildVerificationResourceResponse,
  MOCK_FINALIZATION_ID,
} from '../fixtures';
import { VERIFICATION_CHECK_DEFINITIONS, type VerificationCheck } from '@stark-ballot/verification/checks';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import {
  CurrentFinalizationResponseSchema,
  FinalizationResponseSchema,
} from '@stark-ballot/api-contract/schemas/finalizations';
import { VerificationResourceResponseSchema } from '@stark-ballot/api-contract/schemas/verification';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import { computeIncludedBitmapRootHex } from '@stark-ballot/zkvm-contract/zkvm/bitmap-core';
import verifyS0Fixture from '../fixtures/json/verification.get.S0.json';
import verifyS1Fixture from '../fixtures/json/verification.get.S1.json';
import verifyS2Fixture from '../fixtures/json/verification.get.S2.json';
import verifyS3Fixture from '../fixtures/json/verification.get.S3.json';
import verifyS4Fixture from '../fixtures/json/verification.get.S4.json';
import verifyS5Fixture from '../fixtures/json/verification.get.S5.json';
import type { MockState } from '../state';

const baseState: MockState = {
  sessionId: '11111111-2222-3333-4444-555555555555',
  capabilityToken: 'mock-capability-token-for-test',
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

const withPatchedVerificationFixtureData = <T>(
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
  it.each([
    ['S0', verifyS0Fixture],
    ['S1', verifyS1Fixture],
    ['S2', verifyS2Fixture],
    ['S3', verifyS3Fixture],
    ['S4', verifyS4Fixture],
    ['S5', verifyS5Fixture],
  ] as const)('admits the %s verification fixture without retired flat fields', (_scenarioId, fixture) => {
    const parsed = VerificationResourceResponseSchema.parse(fixture);

    expect(parsed.data.availability).toBe('available');
    expect(Object.keys(fixture.data).sort()).toEqual(
      [
        'availability',
        'finalizationId',
        'journal',
        'presentation',
        'proofAuthority',
        'verification',
        'verifierResult',
        'voterEvidence',
      ].sort(),
    );
    expect(JSON.stringify(fixture)).not.toMatch(
      /"(?:journalStatus|verificationChecks|verificationReport|verificationStatus|verificationSteps)"/,
    );
  });

  it('buildSessionResponse overrides session identifiers', () => {
    const payload = buildSessionResponse(baseState) as { data?: Record<string, unknown> };
    const data = payload.data as Record<string, unknown>;
    expect(data['sessionId']).toBe(baseState.sessionId);
    expect(data['capabilityToken']).toBe(baseState.capabilityToken);
    expect(data).not.toHaveProperty('artifactContractId');
    expect(data['electionId']).toBe(baseState.electionId);
    expect(data['electionConfigHash']).toBe(baseState.electionConfigHash);
    expect(data['logId']).toBe(baseState.logId);
  });

  it('buildVerificationResourceResponse groups scenario authority and presentation fields', () => {
    const parsed = VerificationResourceResponseSchema.parse(
      buildVerificationResourceResponse(baseState, 1730000000000),
    );
    const data = parsed.data;
    expect(data.availability).toBe('available');
    if (data.availability !== 'available') {
      throw new Error('Expected available verification resource');
    }
    expect(data.presentation.scenarioId).toBe('S3');
    expect(data.proofAuthority.logId).toBe(baseState.logId);
    expect(data.proofAuthority.missingSlots).toBe(1);
    expect(data.proofAuthority.invalidPresentedSlots).toBe(0);
    expect(data.proofAuthority.rejectedRecords).toBe(0);
    expect(data.proofAuthority.excludedSlots).toBe(1);
    expect(data.presentation.botVotesSummary?.affectedBotIds).toEqual([1]);
  });

  it('buildVerificationResourceResponse maps stark step status from state', () => {
    const parsed = VerificationResourceResponseSchema.parse(
      buildVerificationResourceResponse(
        {
          ...baseState,
          scenarioId: 'S0',
          verificationStatus: 'success',
        },
        1730000000000,
      ),
    );
    if (parsed.data.availability !== 'available') {
      throw new Error('Expected available verification resource');
    }
    const starkStep = parsed.data.verification.steps.find((step) => step.id === 'stark_verification');
    expect(starkStep?.status).toBe('success');
  });

  it('buildVerificationResourceResponse derives verification checks from scenario evidence', () => {
    const parsed = VerificationResourceResponseSchema.parse(
      buildVerificationResourceResponse(
        {
          ...baseState,
          scenarioId: 'S2',
          verificationStatus: 'success',
        },
        1730000000000,
      ),
    );
    if (parsed.data.availability !== 'available') {
      throw new Error('Expected available verification resource');
    }
    const checks = parsed.data.verification.checks;
    const countedCheck = checks.find((check) => check.id === 'counted_tally_consistent');
    expect(checks).toHaveLength(VERIFICATION_CHECK_DEFINITIONS.length);
    expect(countedCheck?.status).toBe('failed');
    expect(parsed.data.presentation.policy.fullyVerifiedLabelEligible).toBe(false);
  });

  it.each([
    ['S0', 'fully_verified', true],
    ['S1', 'user_vote_excluded', false],
    ['S2', 'published_tally_mismatch', false],
    ['S3', 'votes_excluded', false],
    ['S4', 'published_tally_mismatch', false],
    ['S5', 'votes_excluded', false],
  ] as const)(
    'preserves %s presentation semantics after browser-local cast checks',
    (scenarioId, expectedSummary, expectedEligibility) => {
      const parsed = VerificationResourceResponseSchema.parse(
        buildVerificationResourceResponse(
          {
            ...baseState,
            scenarioId,
            verificationStatus: 'success',
          },
          1730000000000,
        ),
      );
      if (parsed.data.availability !== 'available') {
        throw new Error('Expected available verification resource');
      }
      const resource = parsed.data;
      const checks: VerificationCheck[] = resource.verification.checks.map((check) => ({
        id: check.id,
        status: check.id.startsWith('cast_') ? 'success' : check.status,
        evidence: check.evidence,
        inputs: [...check.inputs],
        ...(check.noteKey !== undefined ? { noteKey: check.noteKey } : {}),
        ...(check.derivedFrom !== undefined ? { derivedFrom: check.derivedFrom } : {}),
      }));
      const policy = deriveVerificationPresentationPolicy({
        availability: 'available',
        checks,
        context: {
          missingSlots: resource.proofAuthority.missingSlots,
          invalidPresentedSlots: resource.proofAuthority.invalidPresentedSlots,
          rejectedRecords: resource.proofAuthority.rejectedRecords,
          excludedSlots: resource.proofAuthority.excludedSlots,
        },
        verificationStatus: resource.verifierResult.status,
        ...(resource.verifierResult.report ? { verificationReportStatus: resource.verifierResult.report.status } : {}),
      });

      expect(policy.summary?.status).toBe(expectedSummary);
      expect(policy.fullyVerifiedLabelEligible).toBe(expectedEligibility);
    },
  );

  it('buildVerificationResourceResponse returns a canonical current journal when requested', () => {
    const parsed = VerificationResourceResponseSchema.parse(
      buildVerificationResourceResponse(baseState, 1730000000000, { includeJournal: true }),
    );
    const data = parsed.data;

    if (data.availability !== 'available') {
      throw new Error('Expected available verification resource');
    }
    expect(data.journal.representation).toBe('included');
    if (data.journal.representation !== 'included') {
      throw new Error('Expected canonical journal to be included');
    }
    expect(data.journal.value.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(data.journal.value.bulletinRoot).toBe(data.proofAuthority.bulletinRoot);
    expect(data.journal.value.missingSlots).toBe(data.proofAuthority.missingSlots);
    expect(data.journal.value.invalidPresentedSlots).toBe(data.proofAuthority.invalidPresentedSlots);
    expect(data.journal.value.validVotes).toBe(
      data.proofAuthority.verifiedTally.reduce((sum, count) => sum + count, 0),
    );
    expect(data.journal.value.excludedSlots).toBe(data.proofAuthority.excludedSlots);
  });

  it('fails closed when a current-contract fixture is missing verifiedTally', () => {
    expect(() =>
      withPatchedVerificationFixtureData(
        verifyS0Fixture as { data: Record<string, unknown> },
        (data) => {
          delete (data['proofAuthority'] as Record<string, unknown>)['verifiedTally'];
        },
        () =>
          buildVerificationResourceResponse({ ...baseState, scenarioId: 'S0' }, 1730000000000, {
            includeJournal: true,
          }),
      ),
    ).toThrow('data.proofAuthority.verifiedTally');
  });

  it('derives journal totalVotes from counted and rejected records', () => {
    const payload = withPatchedVerificationFixtureData(
      verifyS0Fixture as { data: Record<string, unknown> },
      (data) => {
        const authority = data['proofAuthority'] as Record<string, unknown>;
        authority['verifiedTally'] = [10, 10, 10, 10, 10];
        authority['missingSlots'] = 14;
        authority['invalidPresentedSlots'] = 0;
        authority['rejectedRecords'] = 3;
        authority['excludedSlots'] = 14;
        authority['seenIndicesCount'] = 50;
      },
      () =>
        buildVerificationResourceResponse({ ...baseState, scenarioId: 'S0' }, 1730000000000, { includeJournal: true }),
    );
    const parsed = VerificationResourceResponseSchema.parse(payload);

    if (parsed.data.availability !== 'available' || parsed.data.journal.representation !== 'included') {
      throw new Error('Expected canonical journal to be included');
    }

    expect(parsed.data.proofAuthority.rejectedRecords).toBe(3);
    expect(parsed.data.journal.value.validVotes).toBe(50);
    expect(parsed.data.journal.value.invalidVotes).toBe(3);
    expect(parsed.data.journal.value.totalVotes).toBe(53);
    expect(parsed.data.journal.value.totalVotes).toBe(
      parsed.data.journal.value.validVotes + parsed.data.journal.value.invalidVotes,
    );
  });

  it('buildCurrentFinalizationResponse returns a canonical succeeded finalization resource', () => {
    const now = 1730000245000;
    const parsed = CurrentFinalizationResponseSchema.parse(
      buildCurrentFinalizationResponse(
        {
          ...baseState,
          finalizationId: MOCK_FINALIZATION_ID,
          finalizationQueuedAtMs: now - 22000,
          finalizationStartedAtMs: now - 20000,
          finalizationCompletedAtMs: now - 1000,
        },
        now,
      ),
    );
    const resource = parsed.data;

    expect(resource?.status).toBe('succeeded');
    if (resource?.status !== 'succeeded') {
      throw new Error('Expected succeeded finalization resource');
    }
    expect(resource.result.authority.journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(resource.result.authority.journal.missingSlots).toBe(resource.result.presentation.missingSlots);
    expect(resource.result.authority.journal.invalidPresentedSlots).toBe(
      resource.result.presentation.invalidPresentedSlots,
    );
    expect(resource.result.authority.journal.validVotes).toBe(
      resource.result.presentation.verifiedTally.reduce((sum: number, count: number) => sum + count, 0),
    );
    expect(resource.result.authority.journal.excludedSlots).toBe(resource.result.presentation.excludedSlots);
  });

  it.each([
    { scenarioId: 'S0', expectedUserIncluded: true },
    { scenarioId: 'S1', expectedUserIncluded: false },
    { scenarioId: 'S2', expectedUserIncluded: true },
    { scenarioId: 'S3', expectedUserIncluded: true },
    { scenarioId: 'S4', expectedUserIncluded: true },
    { scenarioId: 'S5', expectedUserIncluded: true },
  ] as const)(
    'derives canonical bitmap evidence for $scenarioId from the same authority as verification resources',
    ({ scenarioId, expectedUserIncluded }) => {
      const state: MockState = { ...baseState, scenarioId, bulletinIndex: 0 };
      const evidence = buildMockBitmapEvidence(state, 64);
      const verification = VerificationResourceResponseSchema.parse(
        buildVerificationResourceResponse(state, 1730000000000),
      );
      if (verification.data.availability !== 'available') {
        throw new Error('Expected available verification resource');
      }

      expect(evidence.includedBitmap).toHaveLength(verification.data.proofAuthority.treeSize);
      expect(evidence.seenBitmap).toHaveLength(verification.data.proofAuthority.treeSize);
      expect(evidence.includedBitmap[0]).toBe(expectedUserIncluded);
      expect(evidence.seenBitmap[0]).toBe(expectedUserIncluded);
      expect(evidence.includedBitmap.filter(Boolean)).toHaveLength(
        verification.data.proofAuthority.verifiedTally.reduce((sum, count) => sum + count, 0),
      );
      expect(evidence.seenBitmap.filter(Boolean)).toHaveLength(verification.data.proofAuthority.seenIndicesCount);
      expect(evidence.includedBitmapRoot).toBe(computeIncludedBitmapRootHex(evidence.includedBitmap));
      expect(evidence.seenBitmapRoot).toBe(computeIncludedBitmapRootHex(evidence.seenBitmap));
      expect(evidence.includedBitmapRoot).toBe(verification.data.proofAuthority.includedBitmapRoot);
      expect(evidence.seenBitmapRoot).toBe(verification.data.proofAuthority.seenBitmapRoot);
    },
  );

  it('buildFinalizationResponse emits the honest static queue estimate only', () => {
    const parsed = FinalizationResponseSchema.parse(
      buildFinalizationResponse(
        {
          ...baseState,
          finalizationId: MOCK_FINALIZATION_ID,
          finalizationQueuedAtMs: 1730000000000,
          finalizationStartedAtMs: 1730000002000,
          finalizationCompletedAtMs: 1730000362000,
        },
        1730000000000,
      ),
    );
    const queue = parsed.data.runtimeDiagnostics.queue;

    expect(queue).toEqual({
      concurrencyLimit: 2,
      estimatedDurationMs: 360000,
    });
    expect(Object.keys(queue ?? {}).sort()).toEqual(['concurrencyLimit', 'estimatedDurationMs']);
  });

  it('buildFinalizationResponse returns resource identity without a retired status URL', () => {
    const payload = buildFinalizationResponse(
      {
        ...baseState,
        finalizationId: MOCK_FINALIZATION_ID,
        finalizationQueuedAtMs: 1730000000000,
        finalizationStartedAtMs: 1730000002000,
        finalizationCompletedAtMs: 1730000362000,
      },
      1730000000000,
    );
    const parsed = FinalizationResponseSchema.parse(payload);

    expect(parsed.data.finalizationId).toBe(MOCK_FINALIZATION_ID);
    expect(parsed.data).not.toHaveProperty('statusUrl');
  });

  it.each([
    ['pending', 1730000000000],
    ['running', 1730000002000],
  ])('buildCurrentFinalizationResponse emits the honest queue estimate for %s state', (_label, now) => {
    const parsed = CurrentFinalizationResponseSchema.parse(
      buildCurrentFinalizationResponse(
        {
          ...baseState,
          finalizationId: MOCK_FINALIZATION_ID,
          finalizationQueuedAtMs: 1730000000000,
          finalizationStartedAtMs: 1730000001000,
          finalizationCompletedAtMs: 1730000361000,
        },
        now,
      ),
    );
    const queue = parsed.data?.runtimeDiagnostics.queue;

    if (!queue) {
      throw new Error('Expected mock resource to include queue info.');
    }
    expect(queue.concurrencyLimit).toBe(2);
    expect(queue.estimatedDurationMs).toBeGreaterThan(0);
    expect(Object.keys(queue).sort()).toEqual(['concurrencyLimit', 'estimatedDurationMs']);
  });

  it('buildCurrentFinalizationResponse uses the canonical running progress curve', () => {
    const startedAtMs = 1730000001000;
    const parsed = CurrentFinalizationResponseSchema.parse(
      buildCurrentFinalizationResponse(
        {
          ...baseState,
          finalizationId: MOCK_FINALIZATION_ID,
          finalizationQueuedAtMs: startedAtMs - 1000,
          finalizationStartedAtMs: startedAtMs,
          finalizationCompletedAtMs: startedAtMs + 360000,
        },
        startedAtMs + 180000,
      ),
    );

    expect(parsed.data?.status).toBe('running');
    expect(parsed.data?.runtimeDiagnostics.progress).toEqual({
      phase: 'running',
      source: 'derived',
      percent: 74,
      updatedAtMs: startedAtMs + 180000,
    });
  });

  it('buildCurrentFinalizationResponse reports null queue info for succeeded state', () => {
    const parsed = CurrentFinalizationResponseSchema.parse(
      buildCurrentFinalizationResponse(
        {
          ...baseState,
          finalizationId: MOCK_FINALIZATION_ID,
          finalizationQueuedAtMs: 1730000000000,
          finalizationStartedAtMs: 1730000001000,
          finalizationCompletedAtMs: 1730000001500,
        },
        1730000002000,
      ),
    );

    expect(parsed.data?.status).toBe('succeeded');
    expect(parsed.data?.runtimeDiagnostics.queue).toBeNull();
  });

  it('buildFinalizationResponse derives presentation mirrors from the journal', () => {
    const parsed = FinalizationResponseSchema.parse(
      buildFinalizationResponse(
        {
          ...baseState,
          scenarioId: 'S0',
          finalizationId: MOCK_FINALIZATION_ID,
          finalizationQueuedAtMs: 1,
          finalizationStartedAtMs: 2,
          finalizationCompletedAtMs: 3,
        },
        4,
      ),
    );
    if (parsed.data.status !== 'succeeded') {
      throw new Error('Expected succeeded finalization resource');
    }
    const { authority, presentation } = parsed.data.result;

    expect(authority.journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(authority.journal.bulletinRoot).toBe(presentation.bulletinRoot);
    expect(authority.journal.missingSlots).toBe(presentation.missingSlots);
    expect(authority.journal.invalidPresentedSlots).toBe(presentation.invalidPresentedSlots);
    expect(authority.journal.validVotes).toBe(
      presentation.verifiedTally.reduce((sum: number, count: number) => sum + count, 0),
    );
    expect(authority.journal.excludedSlots).toBe(presentation.excludedSlots);
    expect(authority.journal.seenIndicesCount).toBe(presentation.seenIndicesCount);
  });

  it('supports current-contract S5 exclusion metrics across mock builders', () => {
    const now = 1730000245000;
    const state: MockState = {
      ...baseState,
      scenarioId: 'S5',
      finalizationId: MOCK_FINALIZATION_ID,
      finalizationQueuedAtMs: now - 22000,
      finalizationStartedAtMs: now - 20000,
      finalizationCompletedAtMs: now - 1000,
    };

    const finalization = CurrentFinalizationResponseSchema.parse(buildCurrentFinalizationResponse(state, now)).data;
    if (finalization?.status !== 'succeeded') {
      throw new Error('Expected succeeded finalization resource');
    }
    expect(finalization.result.presentation.missingSlots).toBe(4);
    expect(finalization.result.presentation.invalidPresentedSlots).toBe(0);
    expect(finalization.result.authority.journal.validVotes).toBe(60);
    expect(finalization.result.presentation.excludedSlots).toBe(4);

    const verificationPayload = VerificationResourceResponseSchema.parse(buildVerificationResourceResponse(state, now));
    if (verificationPayload.data.availability !== 'available') {
      throw new Error('Expected available verification resource');
    }
    expect(verificationPayload.data.proofAuthority.missingSlots).toBe(4);
    expect(
      verificationPayload.data.proofAuthority.verifiedTally.reduce((sum: number, count: number) => sum + count, 0),
    ).toBe(60);
    expect(verificationPayload.data.proofAuthority.excludedSlots).toBe(4);
    expect(verificationPayload.data.presentation.policy.fullyVerifiedLabelEligible).toBe(false);
  });

  it('buildBulletinResponse returns paged commitments and metadata', () => {
    const state: MockState = {
      ...baseState,
      commitment: '0x' + 'e'.repeat(64),
      bulletinIndex: 3,
    };
    const response = buildBulletinResponse(state, { offset: 0, limit: 10, now: 1730000000000 }) as {
      data?: {
        commitments?: string[];
      };
      meta?: {
        page?: {
          nextOffset?: number | null;
          hasMore?: boolean;
        };
      };
    };
    const payload = response.data as { commitments?: string[] };
    expect(payload.commitments).toHaveLength(10);
    expect(payload.commitments?.[3]).toBe(state.commitment);
    expect(payload).not.toHaveProperty('nextOffset');
    expect(payload).not.toHaveProperty('hasMore');
    expect(response.meta?.page).toEqual({
      nextOffset: 10,
      hasMore: true,
    });
  });

  it('buildBulletinProofResponse returns inclusion proof for user vote', () => {
    const state: MockState = {
      ...baseState,
      commitment: '0x' + 'e'.repeat(64),
      bulletinIndex: 2,
      voteId: '00000000-0000-4000-8000-000000000001',
    };
    const response = buildBulletinProofResponse(state, state.voteId ?? 'missing') as {
      data?: {
        voteId?: string;
        proof?: { leafIndex?: number; merklePath?: string[] };
      };
    };
    const payload = response.data as {
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
    const response = buildConsistencyProofResponse(state, {
      fromTreeSize: 1,
      toTreeSize: 64,
      now: 1730000000000,
    }) as {
      data?: {
        fromTreeSize?: number;
        toTreeSize?: number;
        rootAtFromTreeSize?: string;
        rootAtToTreeSize?: string;
        proofNodes?: string[];
        generatedAtMs?: number;
      };
    };
    const payload = response.data as {
      fromTreeSize?: number;
      toTreeSize?: number;
      rootAtFromTreeSize?: string;
      rootAtToTreeSize?: string;
      proofNodes?: string[];
      generatedAtMs?: number;
    };
    expect(payload.fromTreeSize).toBe(1);
    expect(payload.toTreeSize).toBe(64);
    expect(payload.rootAtFromTreeSize?.startsWith('0x')).toBe(true);
    expect(payload.rootAtToTreeSize?.startsWith('0x')).toBe(true);
    expect((payload.proofNodes ?? []).length).toBeGreaterThan(0);
    expect(payload.generatedAtMs).toBe(1730000000000);
  });

  it('buildFinalizationCancelResponse returns failed resource', () => {
    const response = buildFinalizationCancelResponse(
      {
        ...baseState,
        finalizationId: MOCK_FINALIZATION_ID,
        finalizationQueuedAtMs: 1729999999000,
        finalizationFailedAtMs: 1730000000000,
        finalizationError: {
          code: 'USER_CANCELLED',
          message: 'Cancelled from test',
        },
      },
      {
        finalizationId: MOCK_FINALIZATION_ID,
        reason: 'Cancelled from test',
        now: 1730000000000,
      },
    );
    const payload = FinalizationResponseSchema.parse(response).data;
    expect(payload.status).toBe('failed');
    if (payload.status !== 'failed') {
      throw new Error('Expected failed finalization resource');
    }
    expect(payload.error.code).toBe('USER_CANCELLED');
    expect(payload.error.message).toContain('Cancelled');
  });
});
