import { describe, expect, it } from 'vitest';
import {
  VerificationObservationRequestSchema,
  VerificationResourceParamsSchema,
  VerificationResourceQuerySchema,
  VerificationResourceResponseSchema,
} from './verification';
import { API_ROUTES, buildApiRouteUrl, matchApiRoute } from '../routes';

const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;
const HEX_D = `0x${'d'.repeat(64)}`;
const HEX_E = `0x${'e'.repeat(64)}`;
const HEX_F = `0x${'f'.repeat(64)}`;

const availableResource = {
  data: {
    availability: 'available',
    finalizationId: 'finalization-1',
    proofAuthority: {
      electionId: 'election-1',
      electionConfigHash: HEX_A,
      logId: HEX_B,
      imageId: HEX_C,
      bulletinRoot: HEX_D,
      verifiedTally: [1, 2, 3, 4, 5],
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      totalExpected: 15,
      treeSize: 15,
      excludedSlots: 0,
      sthDigest: HEX_E,
      includedBitmapRoot: HEX_F,
      inputCommitment: HEX_A,
      seenIndicesCount: 15,
    },
    presentation: {
      tally: {
        counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
        totalVotes: 15,
        tamperedCount: 0,
      },
      scenarioId: 'S0',
      tamperDetected: false,
      policy: {
        summary: {
          status: 'fully_verified',
          tone: 'verified',
        },
        stageStatuses: {
          cast_as_intended: 'success',
          recorded_as_cast: 'success',
          counted_as_recorded: 'success',
          stark_verification: 'success',
        },
        evidenceFullyVerified: true,
        fullyVerifiedLabelEligible: true,
        display: {
          readiness: 'ready',
          source: 'summary',
          status: 'verified',
          renderedStatus: 'verified',
        },
        publishedTallyMismatch: false,
        devModeEvidence: false,
        missingEvidence: false,
      },
    },
    verifierResult: {
      status: 'success',
      report: {
        status: 'success',
        duration_ms: 12,
        errors: [],
      },
    },
    verification: {
      checks: [
        {
          id: 'stark_receipt_verify',
          status: 'success',
          evidence: 'zk',
          inputs: ['proofBundleStatus'],
        },
      ],
      steps: [
        {
          id: 'stark_verification',
          status: 'success',
          inputs: ['imageId', 'proofBundleStatus'],
        },
      ],
    },
    voterEvidence: {
      availability: 'unavailable',
      reason: 'exact_proof_unavailable',
      userVote: {
        commitment: HEX_B,
      },
    },
    journal: {
      representation: 'omitted',
    },
  },
  meta: { requestId: 'request-1' },
} as const;

describe('verification resource contract', () => {
  it('uses exact finalization-scoped paths with capability-only path identity', () => {
    expect(API_ROUTES.verification).toMatchObject({
      routeId: 'sessions.finalizations.verification.get',
      method: 'GET',
      path: '/sessions/:sessionId/finalizations/:finalizationId/verification',
      authScope: 'path-session-capability',
      capabilityScope: 'path',
    });
    expect(API_ROUTES.runVerification).toMatchObject({
      routeId: 'sessions.finalizations.verification.post',
      method: 'POST',
      path: '/sessions/:sessionId/finalizations/:finalizationId/verification',
    });
    expect(API_ROUTES.recordVerificationObservation).toMatchObject({
      routeId: 'sessions.finalizations.verification.observations.post',
      method: 'POST',
      path: '/sessions/:sessionId/finalizations/:finalizationId/verification/observations',
    });

    for (const route of [
      API_ROUTES.verification,
      API_ROUTES.runVerification,
      API_ROUTES.recordVerificationObservation,
    ]) {
      expect(Object.keys(route.request.params.shape)).toEqual(['sessionId', 'finalizationId']);
      expect(Object.keys(route.request.headers.shape)).toEqual(['X-Session-Capability']);
      expect(route.request.headers.safeParse({ 'X-Session-Capability': 'capability-1' }).success).toBe(true);
      expect(
        route.request.headers.safeParse({
          'X-Session-Capability': 'capability-1',
          'X-Session-ID': 'session-1',
        }).success,
      ).toBe(false);
    }

    expect(matchApiRoute('GET', '/api/verify')).toBeNull();
    expect(matchApiRoute('POST', '/api/verification/run')).toBeNull();
    expect(matchApiRoute('POST', '/api/verification/observation')).toBeNull();
  });

  it('parses exact path params and centrally serializes include=journal', () => {
    expect(
      VerificationResourceParamsSchema.parse({
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
      }),
    ).toEqual({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
    });
    expect(VerificationResourceQuerySchema.parse({ include: 'journal' })).toEqual({ include: 'journal' });
    expect(VerificationResourceQuerySchema.safeParse({ includeJournal: '1' }).success).toBe(false);
    expect(VerificationResourceQuerySchema.safeParse({ include: 'other' }).success).toBe(false);
    expect(
      buildApiRouteUrl(API_ROUTES.verification, {
        params: { sessionId: 'session/one', finalizationId: 'finalization/one' },
        query: { include: 'journal' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations/finalization%2Fone/verification?include=journal');
  });

  it('admits one strict grouped available resource and rejects old flat authority', () => {
    expect(VerificationResourceResponseSchema.safeParse(availableResource).success).toBe(true);
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          verificationStatus: 'success',
        },
      }).success,
    ).toBe(false);
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          verification: {
            steps: availableResource.data.verification.steps,
          },
        },
      }).success,
    ).toBe(false);
  });

  it('admits explicit unavailable and corrupt resources that carry no success-shaped fields', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        data: {
          availability: 'unavailable',
          finalizationId: 'finalization-1',
          reason: 'finalization_not_current',
          message: 'Finalization unavailable',
        },
        meta: { requestId: 'request-1' },
      }).success,
    ).toBe(true);
    expect(
      VerificationResourceResponseSchema.safeParse({
        data: {
          availability: 'corrupt',
          finalizationId: 'finalization-1',
          reason: 'invalid_artifact',
          message: 'Invalid verification artifact',
        },
        meta: { requestId: 'request-1' },
      }).success,
    ).toBe(true);
    expect(
      VerificationResourceResponseSchema.safeParse({
        data: {
          availability: 'unavailable',
          finalizationId: 'finalization-1',
          reason: 'finalization_not_current',
          message: 'Finalization unavailable',
          verification: availableResource.data.verification,
        },
        meta: { requestId: 'request-1' },
      }).success,
    ).toBe(false);
  });

  it('requires voter evidence to discriminate exact evidence availability', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          voterEvidence: {
            userVote: {
              commitment: HEX_B,
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          voterEvidence: {
            availability: 'available',
            voteReceipt: {
              voteId: 'vote-1',
              commitment: HEX_B,
              bulletinIndex: 0,
              bulletinRootAtCast: HEX_D,
              castAtMs: 1,
            },
            userVote: {
              commitment: HEX_B,
              voteId: 'vote-1',
              proof: {
                leafIndex: 0,
                treeSize: 15,
                merklePath: [],
                bulletinRootAtCast: HEX_D,
              },
            },
          },
        },
      }).success,
    ).toBe(true);
  });

  it('keeps the run body empty and scopes observation identity only through the path', () => {
    const castChecks = {
      cast_receipt_present: 'success',
      cast_choice_range: 'success',
      cast_random_format: 'not_run',
      cast_commitment_match: 'failed',
    } as const;
    expect(VerificationObservationRequestSchema.parse({ castChecks })).toEqual({ castChecks });
    expect(
      VerificationObservationRequestSchema.safeParse({
        finalizationId: 'finalization-1',
        castChecks,
      }).success,
    ).toBe(false);
  });
});
