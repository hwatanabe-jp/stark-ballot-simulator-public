import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_JOURNAL_PROOF_AUTHORITY_SHARED_FIELDS,
  VerificationObservationRequestSchema,
  VerificationResourceParamsSchema,
  VerificationResourceQuerySchema,
  VerificationResourceResponseSchema,
  verificationVoterEvidenceSchema,
} from './verification';
import { API_ROUTES, buildApiRouteUrl, matchApiRoute } from '../routes';
import { VERIFICATION_CHECK_DEFINITIONS, getVerificationStepInputs } from '@stark-ballot/verification/checks';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;
const HEX_D = `0x${'d'.repeat(64)}`;
const HEX_E = `0x${'e'.repeat(64)}`;
const HEX_F = `0x${'f'.repeat(64)}`;
const HEX_B_CAST_ROOT = '0x000e336a908387d3532d981998a2aa81f31e7867ec97f763afe954364988b629';
const ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const;
const ZK_GATE_CHECK_IDS = new Set([
  'counted_tally_consistent',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'counted_my_vote_included',
  'counted_input_commitment_match',
]);

const coherentVoterEvidence = {
  availability: 'available',
  voteReceipt: {
    voteId: 'vote-1',
    commitment: HEX_B,
    bulletinIndex: 0,
    bulletinRootAtCast: HEX_B_CAST_ROOT,
    castAtMs: 1,
    inputCommitment: HEX_A,
  },
  userVote: {
    commitment: HEX_B,
    voteId: 'vote-1',
    proof: {
      leafIndex: 0,
      treeSize: 1,
      merklePath: [],
      bulletinRootAtCast: HEX_B_CAST_ROOT,
    },
  },
} as const;

const availableResource = {
  data: {
    availability: 'available',
    finalizationId: 'finalization-1',
    proofAuthority: {
      electionId: ELECTION_ID,
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
      seenBitmapRoot: HEX_F,
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
        verifier_version: 'verifier-service-test',
        verified_at: '2026-08-11T00:00:00Z',
        duration_ms: 12,
        expected_image_id: HEX_C,
        receipt_image_id: HEX_C,
        dev_mode_receipt: false,
      },
    },
    verification: {
      checks: VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
        id: definition.id,
        status: 'success' as const,
        evidence: definition.evidence,
        inputs: [...definition.inputs],
        ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
      })),
      steps: VERIFICATION_STEP_IDS.map((id) => ({
        id,
        status: 'success' as const,
        inputs: getVerificationStepInputs(id),
      })),
    },
    voterEvidence: coherentVoterEvidence,
    journal: {
      representation: 'omitted',
    },
  },
  meta: { requestId: 'request-1' },
} as const;

const statusOnlyChecks = VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
  id: definition.id,
  status:
    definition.category === 'cast_as_intended' ||
    ZK_GATE_CHECK_IDS.has(definition.id) ||
    definition.id === 'counted_missing_indices_zero' ||
    definition.id === 'stark_image_id_match' ||
    definition.id === 'stark_receipt_verify'
      ? ('not_run' as const)
      : ('success' as const),
  evidence: definition.evidence,
  inputs: [...definition.inputs],
  ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
}));
const statusOnlyDerivedPolicy = deriveVerificationPresentationPolicy({
  availability: 'available',
  checks: statusOnlyChecks,
  context: {
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    excludedSlots: 0,
    sthSourcesConfigured: true,
  },
  verificationStatus: 'not_run',
});
if (statusOnlyDerivedPolicy.fullyVerifiedLabelEligible) {
  throw new Error('Expected status-only verification evidence to remain ineligible');
}
const statusOnlyPolicy = {
  summary: statusOnlyDerivedPolicy.summary,
  stageStatuses: statusOnlyDerivedPolicy.stageStatuses,
  evidenceFullyVerified: statusOnlyDerivedPolicy.evidenceFullyVerified,
  fullyVerifiedLabelEligible: statusOnlyDerivedPolicy.fullyVerifiedLabelEligible,
  display: statusOnlyDerivedPolicy.display,
  publishedTallyMismatch: statusOnlyDerivedPolicy.publishedTallyMismatch,
  devModeEvidence: statusOnlyDerivedPolicy.devModeEvidence,
  missingEvidence: statusOnlyDerivedPolicy.missingEvidence,
  ...(statusOnlyDerivedPolicy.explanationKey ? { explanationKey: statusOnlyDerivedPolicy.explanationKey } : {}),
} as const;
const coherentIneligibleResource = {
  ...availableResource,
  data: {
    ...availableResource.data,
    presentation: { ...availableResource.data.presentation, policy: statusOnlyPolicy },
    verifierResult: { status: 'not_run' as const },
    verification: {
      checks: statusOnlyChecks,
      steps: VERIFICATION_STEP_IDS.map((id) => ({
        id,
        status: statusOnlyPolicy.stageStatuses[id],
        inputs: getVerificationStepInputs(id),
      })),
    },
  },
} as const;

const ineligiblePresentation = coherentIneligibleResource.data.presentation;

const failedChecks = VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
  id: definition.id,
  status:
    definition.category === 'cast_as_intended'
      ? ('not_run' as const)
      : ZK_GATE_CHECK_IDS.has(definition.id) ||
          definition.id === 'counted_missing_indices_zero' ||
          definition.id === 'stark_image_id_match' ||
          definition.id === 'stark_receipt_verify'
        ? ('failed' as const)
        : ('success' as const),
  evidence: definition.evidence,
  inputs: [...definition.inputs],
  ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
}));
const failedReport = {
  status: 'failed' as const,
  verifier_version: 'verifier-service-test',
  verified_at: '2026-08-11T00:00:00Z',
  duration_ms: 12,
  expected_image_id: HEX_C,
  receipt_image_id: null,
  dev_mode_receipt: false,
  errors: ['Verification failed' as const],
};
const failedDerivedPolicy = deriveVerificationPresentationPolicy({
  availability: 'available',
  checks: failedChecks,
  context: {
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    excludedSlots: 0,
    sthSourcesConfigured: true,
  },
  verificationStatus: 'failed',
  verificationReportStatus: 'failed',
});
if (failedDerivedPolicy.fullyVerifiedLabelEligible) {
  throw new Error('Expected failed verifier evidence to remain ineligible');
}
const failedPolicy = {
  summary: failedDerivedPolicy.summary,
  stageStatuses: failedDerivedPolicy.stageStatuses,
  evidenceFullyVerified: failedDerivedPolicy.evidenceFullyVerified,
  fullyVerifiedLabelEligible: failedDerivedPolicy.fullyVerifiedLabelEligible,
  display: failedDerivedPolicy.display,
  publishedTallyMismatch: failedDerivedPolicy.publishedTallyMismatch,
  devModeEvidence: failedDerivedPolicy.devModeEvidence,
  missingEvidence: failedDerivedPolicy.missingEvidence,
  ...(failedDerivedPolicy.explanationKey ? { explanationKey: failedDerivedPolicy.explanationKey } : {}),
} as const;
const coherentFailedResource = {
  ...availableResource,
  data: {
    ...availableResource.data,
    presentation: { ...availableResource.data.presentation, policy: failedPolicy },
    verifierResult: { status: 'failed' as const, report: failedReport },
    verification: {
      checks: failedChecks,
      steps: VERIFICATION_STEP_IDS.map((id) => ({
        id,
        status: failedPolicy.stageStatuses[id],
        inputs: getVerificationStepInputs(id),
      })),
    },
  },
} as const;

const scenarioOneProofAuthority = {
  ...coherentIneligibleResource.data.proofAuthority,
  verifiedTally: [0, 2, 3, 4, 5] as const,
  missingSlots: 1,
  excludedSlots: 1,
  seenIndicesCount: 14,
};
const scenarioOneChecks = VERIFICATION_CHECK_DEFINITIONS.map((definition) => {
  const evidence = {
    id: definition.id,
    evidence: definition.evidence,
    inputs: [...definition.inputs],
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  };
  if (definition.category === 'cast_as_intended') {
    return { ...evidence, status: 'not_run' as const };
  }
  if (definition.id === 'counted_missing_indices_zero') {
    return { ...evidence, status: 'failed' as const };
  }
  if (
    ZK_GATE_CHECK_IDS.has(definition.id) ||
    definition.id === 'stark_image_id_match' ||
    definition.id === 'stark_receipt_verify'
  ) {
    return { ...evidence, status: 'not_run' as const };
  }
  return { ...evidence, status: 'success' as const };
});
const scenarioOnePolicy = deriveVerificationPresentationPolicy({
  availability: 'available',
  checks: scenarioOneChecks,
  context: {
    missingSlots: 1,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    excludedSlots: 1,
    sthSourcesConfigured: true,
  },
  verificationStatus: 'not_run',
});
if (scenarioOnePolicy.fullyVerifiedLabelEligible) {
  throw new Error('Expected scenario-one verification evidence to remain ineligible');
}
const coherentScenarioOneResource = {
  ...coherentIneligibleResource,
  data: {
    ...coherentIneligibleResource.data,
    proofAuthority: scenarioOneProofAuthority,
    presentation: {
      tally: {
        counts: { A: 0, B: 2, C: 3, D: 4, E: 5 },
        totalVotes: 14,
        tamperedCount: 1,
      },
      scenarioId: 'S1',
      tamperDetected: true,
      tamperSummary: {
        ignoredVotes: 1,
        recountedVotes: 0,
        userRecountedTo: null,
        affectedBotIds: [],
      },
      policy: scenarioOnePolicy,
    },
    verification: {
      checks: scenarioOneChecks,
      steps: VERIFICATION_STEP_IDS.map((id) => ({
        id,
        status: scenarioOnePolicy.stageStatuses[id],
        inputs: getVerificationStepInputs(id),
      })),
    },
  },
} as const;

const unavailableVoterCheckIds = new Set([
  'recorded_commitment_in_bulletin',
  'recorded_index_in_range',
  'recorded_root_at_cast_consistent',
  'recorded_inclusion_proof',
  'recorded_consistency_proof',
]);
const unavailableVoterChecks = VERIFICATION_CHECK_DEFINITIONS.map((definition) => {
  const evidence = {
    id: definition.id,
    evidence: definition.evidence,
    inputs: [...definition.inputs],
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  };
  if (definition.id === 'counted_my_vote_included') {
    return { ...evidence, status: 'not_run' as const };
  }
  if (
    definition.category === 'cast_as_intended' ||
    ZK_GATE_CHECK_IDS.has(definition.id) ||
    definition.id === 'counted_missing_indices_zero' ||
    unavailableVoterCheckIds.has(definition.id) ||
    definition.id === 'stark_image_id_match' ||
    definition.id === 'stark_receipt_verify'
  ) {
    return { ...evidence, status: 'not_run' as const };
  }
  return { ...evidence, status: 'success' as const };
});
const unavailableVoterPolicy = deriveVerificationPresentationPolicy({
  availability: 'available',
  checks: unavailableVoterChecks,
  context: {
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    excludedSlots: 0,
    sthSourcesConfigured: true,
  },
  verificationStatus: 'not_run',
});
if (unavailableVoterPolicy.fullyVerifiedLabelEligible) {
  throw new Error('Expected unavailable voter evidence to remain ineligible');
}
const coherentUnavailableVoterResource = {
  ...coherentIneligibleResource,
  data: {
    ...coherentIneligibleResource.data,
    presentation: { ...coherentIneligibleResource.data.presentation, policy: unavailableVoterPolicy },
    verification: {
      checks: unavailableVoterChecks,
      steps: VERIFICATION_STEP_IDS.map((id) => ({
        id,
        status: unavailableVoterPolicy.stageStatuses[id],
        inputs: getVerificationStepInputs(id),
      })),
    },
    voterEvidence: {
      availability: 'unavailable',
      reason: 'exact_proof_unavailable',
      userVote: { commitment: HEX_B, voteId: 'vote-1' },
    },
  },
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
    const admitted = VerificationResourceResponseSchema.safeParse(coherentIneligibleResource);
    expect(admitted.success, admitted.success ? undefined : admitted.error.message).toBe(true);
    expect(VerificationResourceResponseSchema.safeParse(coherentIneligibleResource).success).toBe(true);
    expect(VerificationResourceResponseSchema.safeParse(coherentFailedResource).success).toBe(true);
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

  it('rejects a verifier result whose terminal report contradicts its status', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          verifierResult: {
            status: 'success',
            report: {
              status: 'failed',
              errors: ['Verification failed'],
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['non-UUID election ID', { electionId: 'not-an-election-id' }],
    ['non-hex log ID', { logId: 'not-a-log-id' }],
    ['missing seen bitmap root', { seenBitmapRoot: undefined }],
  ] as const)('rejects proof authority with %s', (_label, proofOverride) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          proofAuthority: { ...availableResource.data.proofAuthority, ...proofOverride },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['tally/seen partition mismatch', { verifiedTally: [2, 2, 3, 4, 5] }],
    ['seen/tree partition mismatch', { seenIndicesCount: 14 }],
    ['missing/tree partition mismatch', { missingSlots: 1 }],
    ['excluded partition mismatch', { excludedSlots: 1 }],
    ['different roots with no invalid presented slots', { seenBitmapRoot: HEX_B }],
    [
      'fewer rejected records than invalid presented slots',
      {
        verifiedTally: [0, 2, 3, 4, 5],
        invalidPresentedSlots: 1,
        rejectedRecords: 0,
        excludedSlots: 1,
      },
    ],
  ] as const)('rejects globally incoherent proof authority: %s', (_label, proofOverride) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          proofAuthority: { ...coherentIneligibleResource.data.proofAuthority, ...proofOverride },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a fully verified report whose admitted ImageID differs from proof authority', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          verifierResult: {
            status: 'success',
            report: {
              ...availableResource.data.verifierResult.report,
              expected_image_id: HEX_B,
              receipt_image_id: HEX_B,
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a present failed report whose expected ImageID differs from proof authority globally', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentFailedResource,
        data: {
          ...coherentFailedResource.data,
          verifierResult: {
            status: 'failed',
            report: {
              ...failedReport,
              expected_image_id: HEX_B,
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each(['S1', 'S2', 'S3', 'S4', 'S5'] as const)(
    'rejects a fully verified presentation under tamper scenario %s',
    (scenarioId) => {
      expect(
        VerificationResourceResponseSchema.safeParse({
          ...availableResource,
          data: {
            ...availableResource.data,
            presentation: { ...availableResource.data.presentation, scenarioId },
          },
        }).success,
      ).toBe(false);
    },
  );

  it('admits a coherent scenario-one projection', () => {
    expect(VerificationResourceResponseSchema.safeParse(coherentScenarioOneResource).success).toBe(true);
  });

  it('rejects a public-fact check forgery even when policy and steps are regenerated from it', () => {
    const forgedChecks = scenarioOneChecks.map((check) =>
      check.id === 'counted_missing_indices_zero' ? { ...check, status: 'success' as const } : check,
    );
    const forgedPolicy = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: forgedChecks,
      context: {
        missingSlots: 1,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        excludedSlots: 1,
        sthSourcesConfigured: true,
      },
      verificationStatus: 'not_run',
    });
    if (forgedPolicy.fullyVerifiedLabelEligible) {
      throw new Error('Expected forged scenario-one verification evidence to remain ineligible');
    }

    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentScenarioOneResource,
        data: {
          ...coherentScenarioOneResource.data,
          presentation: { ...coherentScenarioOneResource.data.presentation, policy: forgedPolicy },
          verification: {
            checks: forgedChecks,
            steps: VERIFICATION_STEP_IDS.map((id) => ({
              id,
              status: forgedPolicy.stageStatuses[id],
              inputs: getVerificationStepInputs(id),
            })),
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a forged server-side cast check even when policy and steps are regenerated', () => {
    const forgedChecks = statusOnlyChecks.map((check) =>
      check.id === 'cast_receipt_present' ? { ...check, status: 'success' as const } : check,
    );
    const forgedPolicy = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: forgedChecks,
      context: {
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        excludedSlots: 0,
        sthSourcesConfigured: true,
      },
      verificationStatus: 'not_run',
    });
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          presentation: { ...coherentIneligibleResource.data.presentation, policy: forgedPolicy },
          verification: {
            checks: forgedChecks,
            steps: VERIFICATION_STEP_IDS.map((id) => ({
              id,
              status: forgedPolicy.stageStatuses[id],
              inputs: getVerificationStepInputs(id),
            })),
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a status fork between a derived check and its source', () => {
    const forgedChecks = statusOnlyChecks.map((check) =>
      check.id === 'recorded_commitment_in_bulletin' ? { ...check, status: 'failed' as const } : check,
    );
    const forgedPolicy = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: forgedChecks,
      context: {
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        excludedSlots: 0,
        sthSourcesConfigured: true,
      },
      verificationStatus: 'not_run',
    });
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          presentation: { ...coherentIneligibleResource.data.presentation, policy: forgedPolicy },
          verification: {
            checks: forgedChecks,
            steps: VERIFICATION_STEP_IDS.map((id) => ({
              id,
              status: forgedPolicy.stageStatuses[id],
              inputs: getVerificationStepInputs(id),
            })),
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects an inclusion-success claim for cryptographically invalid public voter evidence', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          voterEvidence: {
            ...coherentVoterEvidence,
            voteReceipt: { ...coherentVoterEvidence.voteReceipt, bulletinRootAtCast: HEX_C },
            userVote: {
              ...coherentVoterEvidence.userVote,
              proof: { ...coherentVoterEvidence.userVote.proof, bulletinRootAtCast: HEX_C },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('admits one exact unavailable-voter projection', () => {
    expect(VerificationResourceResponseSchema.safeParse(coherentUnavailableVoterResource).success).toBe(true);
  });

  it.each([
    ['recorded index', ['recorded_index_in_range']],
    ['recorded inclusion', ['recorded_inclusion_proof', 'recorded_commitment_in_bulletin']],
    ['recorded consistency', ['recorded_consistency_proof', 'recorded_root_at_cast_consistent']],
  ] as const)('rejects unavailable voter evidence with forged successful %s checks', (_label, forgedIds) => {
    const forgedIdSet = new Set<string>(forgedIds);
    const forgedChecks = unavailableVoterChecks.map((check) =>
      forgedIdSet.has(check.id) ? { ...check, status: 'success' as const } : check,
    );
    const forgedPolicy = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: forgedChecks,
      context: {
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        excludedSlots: 0,
        sthSourcesConfigured: true,
      },
      verificationStatus: 'not_run',
    });
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentUnavailableVoterResource,
        data: {
          ...coherentUnavailableVoterResource.data,
          presentation: { ...coherentUnavailableVoterResource.data.presentation, policy: forgedPolicy },
          verification: {
            checks: forgedChecks,
            steps: VERIFICATION_STEP_IDS.map((id) => ({
              id,
              status: forgedPolicy.stageStatuses[id],
              inputs: getVerificationStepInputs(id),
            })),
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'a note on a check that cannot own voter diagnostics',
      scenarioOneChecks.map((check) =>
        check.id === 'counted_missing_indices_zero'
          ? {
              ...check,
              noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt' as const,
            }
          : check,
      ),
    ],
    [
      'a voter note that contradicts the admitted scenario-one evidence',
      scenarioOneChecks.map((check) =>
        check.id === 'counted_my_vote_included'
          ? {
              ...check,
              noteKey: 'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt' as const,
            }
          : check,
      ),
    ],
  ] as const)('rejects %s', (_label, forgedChecks) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentScenarioOneResource,
        data: {
          ...coherentScenarioOneResource.data,
          verification: { ...coherentScenarioOneResource.data.verification, checks: forgedChecks },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'tampered count',
      {
        tally: { ...coherentScenarioOneResource.data.presentation.tally, tamperedCount: 999 },
      },
    ],
    [
      'tamper summary',
      {
        tamperSummary: {
          ignoredVotes: 999,
          recountedVotes: 999,
          userRecountedTo: 'E',
          affectedBotIds: [99],
        },
      },
    ],
    [
      'bot-vote summary',
      {
        botVotesSummary: {
          total: 999,
          affectedBotIds: [99],
          source: 'forged',
        },
      },
    ],
  ] as const)('rejects a scenario-one projection with forged %s', (_label, presentationOverride) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentScenarioOneResource,
        data: {
          ...coherentScenarioOneResource.data,
          presentation: {
            ...coherentScenarioOneResource.data.presentation,
            ...presentationOverride,
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each(['S1', 'S2', 'S3', 'S4', 'S5'] as const)(
    'rejects tamperDetected=false globally for scenario %s',
    (scenarioId) => {
      expect(
        VerificationResourceResponseSchema.safeParse({
          ...coherentIneligibleResource,
          data: {
            ...coherentIneligibleResource.data,
            presentation: { ...ineligiblePresentation, scenarioId },
          },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects different seen and included bitmap roots for fully verified evidence', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          proofAuthority: { ...availableResource.data.proofAuthority, seenBitmapRoot: HEX_B },
        },
      }).success,
    ).toBe(false);
  });

  it('requires available voter evidence for a fully verified presentation', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          voterEvidence: {
            availability: 'unavailable',
            reason: 'exact_proof_unavailable',
            userVote: { commitment: HEX_B },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects contradictory available voter evidence even for an ineligible presentation', () => {
    const voterEvidenceContradictions = [
      {
        label: 'vote IDs',
        value: {
          ...coherentVoterEvidence,
          voteReceipt: { ...coherentVoterEvidence.voteReceipt, voteId: 'other-vote' },
        },
      },
      {
        label: 'commitments',
        value: {
          ...coherentVoterEvidence,
          userVote: { ...coherentVoterEvidence.userVote, commitment: HEX_C },
        },
      },
      {
        label: 'receipt and proof indices',
        value: {
          ...coherentVoterEvidence,
          voteReceipt: { ...coherentVoterEvidence.voteReceipt, bulletinIndex: 1 },
        },
      },
      {
        label: 'receipt and proof roots',
        value: {
          ...coherentVoterEvidence,
          voteReceipt: { ...coherentVoterEvidence.voteReceipt, bulletinRootAtCast: HEX_C },
        },
      },
      {
        label: 'receipt and proof-authority input commitments',
        value: {
          ...coherentVoterEvidence,
          voteReceipt: { ...coherentVoterEvidence.voteReceipt, inputCommitment: HEX_C },
        },
      },
      {
        label: 'leaf index outside the cast tree',
        value: {
          ...coherentVoterEvidence,
          voteReceipt: { ...coherentVoterEvidence.voteReceipt, bulletinIndex: 15 },
          userVote: {
            ...coherentVoterEvidence.userVote,
            proof: { ...coherentVoterEvidence.userVote.proof, leafIndex: 15 },
          },
        },
      },
      {
        label: 'cast tree larger than the finalized tree',
        value: {
          ...coherentVoterEvidence,
          userVote: {
            ...coherentVoterEvidence.userVote,
            proof: { ...coherentVoterEvidence.userVote.proof, treeSize: 16 },
          },
        },
      },
      {
        label: 'cast tree size that is not the receipt index snapshot',
        value: {
          ...coherentVoterEvidence,
          userVote: {
            ...coherentVoterEvidence.userVote,
            proof: { ...coherentVoterEvidence.userVote.proof, treeSize: 2 },
          },
        },
      },
      {
        label: 'final-tree root at equal tree size',
        value: {
          ...coherentVoterEvidence,
          voteReceipt: { ...coherentVoterEvidence.voteReceipt, bulletinRootAtCast: HEX_C },
          userVote: {
            ...coherentVoterEvidence.userVote,
            proof: { ...coherentVoterEvidence.userVote.proof, bulletinRootAtCast: HEX_C },
          },
        },
      },
    ] as const;

    for (const contradiction of voterEvidenceContradictions) {
      expect
        .soft(
          VerificationResourceResponseSchema.safeParse({
            ...coherentIneligibleResource,
            data: {
              ...coherentIneligibleResource.data,
              voterEvidence: contradiction.value,
            },
          }).success,
          contradiction.label,
        )
        .toBe(false);
    }
  });

  it('requires a complete canonical check inventory for every available resource', () => {
    const checks = coherentIneligibleResource.data.verification.checks;
    const derivedCheck = checks.find((check) => check.id === 'recorded_commitment_in_bulletin');
    if (!derivedCheck) {
      throw new Error('Expected derived check fixture');
    }
    const contradictions = [
      { label: 'partial inventory', value: checks.slice(1) },
      { label: 'duplicate ID', value: [checks[0], ...checks.slice(0, -1)] },
      { label: 'wrong evidence', value: [{ ...checks[0], evidence: 'public' }, ...checks.slice(1)] },
      { label: 'wrong inputs', value: [{ ...checks[0], inputs: ['wrong'] }, ...checks.slice(1)] },
      {
        label: 'wrong derivation',
        value: checks.map((check) =>
          check.id === derivedCheck.id ? { ...check, derivedFrom: 'stark_receipt_verify' } : check,
        ),
      },
    ];

    for (const contradiction of contradictions) {
      expect
        .soft(
          VerificationResourceResponseSchema.safeParse({
            ...coherentIneligibleResource,
            data: {
              ...coherentIneligibleResource.data,
              verification: { ...coherentIneligibleResource.data.verification, checks: contradiction.value },
            },
          }).success,
          contradiction.label,
        )
        .toBe(false);
    }
  });

  it('requires the exact canonical step inventory for every available resource', () => {
    const steps = coherentIneligibleResource.data.verification.steps;
    const contradictions = [
      { label: 'empty inventory', value: [] },
      { label: 'duplicate ID', value: [steps[0], steps[0], steps[2], steps[3]] },
      { label: 'wrong inputs', value: [{ ...steps[0], inputs: ['wrong'] }, ...steps.slice(1)] },
      { label: 'error on success', value: [{ ...steps[0], error: 'not failed' }, ...steps.slice(1)] },
      { label: 'reversed order', value: [...steps].reverse() },
    ];

    for (const contradiction of contradictions) {
      expect
        .soft(
          VerificationResourceResponseSchema.safeParse({
            ...coherentIneligibleResource,
            data: {
              ...coherentIneligibleResource.data,
              verification: { ...coherentIneligibleResource.data.verification, steps: contradiction.value },
            },
          }).success,
          contradiction.label,
        )
        .toBe(false);
    }
  });

  it.each([
    ['tamperDetected', { tamperDetected: undefined }],
    ['tally.tamperedCount', { tally: { ...availableResource.data.presentation.tally, tamperedCount: undefined } }],
  ] as const)('requires the public presentation field %s', (_label, presentationOverride) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          presentation: {
            ...ineligiblePresentation,
            ...presentationOverride,
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['a nonzero tampered count', { tally: { ...availableResource.data.presentation.tally, tamperedCount: 1 } }],
    [
      'nonzero tamper summary facts',
      {
        tamperSummary: {
          ignoredVotes: 0,
          recountedVotes: 1,
          userRecountedTo: null,
          affectedBotIds: [],
        },
      },
    ],
  ] as const)(
    'rejects tamperDetected=false with %s even for an ineligible presentation',
    (_label, presentationOverride) => {
      expect(
        VerificationResourceResponseSchema.safeParse({
          ...coherentIneligibleResource,
          data: {
            ...coherentIneligibleResource.data,
            presentation: { ...ineligiblePresentation, ...presentationOverride },
          },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects tamperDetected=false when proof authority records excluded slots', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          presentation: ineligiblePresentation,
          proofAuthority: {
            ...coherentIneligibleResource.data.proofAuthority,
            verifiedTally: [0, 2, 3, 4, 5],
            seenIndicesCount: 14,
            missingSlots: 1,
            excludedSlots: 1,
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a forged policy and steps that contradict canonical check-derived stages', () => {
    const stageStatuses = {
      cast_as_intended: 'failed',
      recorded_as_cast: 'failed',
      counted_as_recorded: 'failed',
      stark_verification: 'success',
    } as const;
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          presentation: {
            ...ineligiblePresentation,
            policy: {
              ...ineligiblePresentation.policy,
              summary: { status: 'cast_integrity_failed', tone: 'failed' },
              stageStatuses,
              display: {
                readiness: 'ready',
                source: 'summary',
                status: 'failed',
                renderedStatus: 'failed',
              },
            },
          },
          verification: {
            ...coherentIneligibleResource.data.verification,
            steps: coherentIneligibleResource.data.verification.steps.map((step) => ({
              ...step,
              status: stageStatuses[step.id],
            })),
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each(VERIFICATION_JOURNAL_PROOF_AUTHORITY_SHARED_FIELDS)(
    'rejects an included journal whose %s contradicts proof authority',
    (field) => {
      const proofAuthority = availableResource.data.proofAuthority;
      const journalValue = {
        electionId: proofAuthority.electionId,
        electionConfigHash: proofAuthority.electionConfigHash,
        bulletinRoot: proofAuthority.bulletinRoot,
        treeSize: proofAuthority.treeSize,
        totalExpected: proofAuthority.totalExpected,
        sthDigest: proofAuthority.sthDigest,
        verifiedTally: [...proofAuthority.verifiedTally],
        totalVotes: 15,
        validVotes: 15,
        invalidVotes: 0,
        seenIndicesCount: proofAuthority.seenIndicesCount,
        missingSlots: proofAuthority.missingSlots,
        invalidPresentedSlots: proofAuthority.invalidPresentedSlots,
        rejectedRecords: proofAuthority.rejectedRecords,
        seenBitmapRoot: proofAuthority.seenBitmapRoot,
        includedBitmapRoot: proofAuthority.includedBitmapRoot,
        excludedSlots: proofAuthority.excludedSlots,
        inputCommitment: proofAuthority.inputCommitment,
        methodVersion: CURRENT_METHOD_VERSION,
        imageId: proofAuthority.imageId,
      };
      const current = journalValue[field];
      const contradictory = {
        ...journalValue,
        [field]:
          typeof current === 'number'
            ? current + 1
            : Array.isArray(current)
              ? [5, 4, 3, 2, 1]
              : current.startsWith('0x')
                ? `0x${'9'.repeat(64)}`
                : 'different-election',
      };

      expect(
        VerificationResourceResponseSchema.safeParse({
          ...availableResource,
          data: {
            ...availableResource.data,
            proofAuthority,
            journal: { representation: 'included', value: contradictory },
          },
        }).success,
      ).toBe(false);
    },
  );

  it('admits an included journal whose duplicated authority is semantically equal', () => {
    const proofAuthority = coherentIneligibleResource.data.proofAuthority;
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          journal: {
            representation: 'included',
            value: {
              electionId: proofAuthority.electionId,
              electionConfigHash: proofAuthority.electionConfigHash.slice(2).toUpperCase(),
              bulletinRoot: proofAuthority.bulletinRoot.slice(2).toUpperCase(),
              treeSize: proofAuthority.treeSize,
              totalExpected: proofAuthority.totalExpected,
              sthDigest: proofAuthority.sthDigest.slice(2).toUpperCase(),
              verifiedTally: [...proofAuthority.verifiedTally],
              totalVotes: 15,
              validVotes: 15,
              invalidVotes: 0,
              seenIndicesCount: proofAuthority.seenIndicesCount,
              missingSlots: proofAuthority.missingSlots,
              invalidPresentedSlots: proofAuthority.invalidPresentedSlots,
              rejectedRecords: proofAuthority.rejectedRecords,
              seenBitmapRoot: proofAuthority.seenBitmapRoot.slice(2).toUpperCase(),
              includedBitmapRoot: proofAuthority.includedBitmapRoot.slice(2).toUpperCase(),
              excludedSlots: proofAuthority.excludedSlots,
              inputCommitment: proofAuthority.inputCommitment.slice(2).toUpperCase(),
              methodVersion: CURRENT_METHOD_VERSION,
              imageId: proofAuthority.imageId.slice(2).toUpperCase(),
            },
          },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['non-verified summary', { summary: { status: 'demo_only', tone: 'demo' } }],
    ['unverified evidence', { evidenceFullyVerified: false }],
    [
      'non-ready display',
      { display: { readiness: 'pending', source: 'summary', status: 'verified', renderedStatus: null } },
    ],
    ['development evidence', { devModeEvidence: true }],
    ['missing evidence', { missingEvidence: true }],
    ['published tally mismatch', { publishedTallyMismatch: true }],
  ] as const)('rejects a fully-verified label with %s', (_label, policyOverride) => {
    const contradictory = {
      ...availableResource,
      data: {
        ...availableResource.data,
        presentation: {
          ...availableResource.data.presentation,
          policy: {
            ...availableResource.data.presentation.policy,
            ...policyOverride,
          },
        },
      },
    };

    expect(VerificationResourceResponseSchema.safeParse(contradictory).success).toBe(false);
  });

  it('rejects an ineligible flag attached to otherwise fully verified facts', () => {
    const contradictory = {
      ...availableResource,
      data: {
        ...availableResource.data,
        presentation: {
          ...availableResource.data.presentation,
          policy: {
            ...availableResource.data.presentation.policy,
            fullyVerifiedLabelEligible: false,
          },
        },
      },
    };

    expect(VerificationResourceResponseSchema.safeParse(contradictory).success).toBe(false);
  });

  it('rejects a fully verified display even when the ineligible branch clears its evidence flag', () => {
    const contradictory = {
      ...availableResource,
      data: {
        ...availableResource.data,
        presentation: {
          ...availableResource.data.presentation,
          policy: {
            ...availableResource.data.presentation.policy,
            evidenceFullyVerified: false,
            fullyVerifiedLabelEligible: false,
          },
        },
      },
    };

    expect(VerificationResourceResponseSchema.safeParse(contradictory).success).toBe(false);
  });

  it('rejects a fully verified policy whose stage evidence is not successful', () => {
    const contradictory = {
      ...availableResource,
      data: {
        ...availableResource.data,
        presentation: {
          ...availableResource.data.presentation,
          policy: {
            ...availableResource.data.presentation.policy,
            stageStatuses: {
              ...availableResource.data.presentation.policy.stageStatuses,
              stark_verification: 'failed',
            },
          },
        },
      },
    };

    expect(VerificationResourceResponseSchema.safeParse(contradictory).success).toBe(false);
  });

  it.each([
    ['not_run', { status: 'not_run' }],
    ['failed', { status: 'failed', report: { status: 'failed', errors: ['Verification failed'] } }],
  ] as const)('rejects fully verified presentation with %s verifier authority', (_label, verifierResult) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: { ...availableResource.data, verifierResult },
      }).success,
    ).toBe(false);
  });

  it('rejects verification steps that contradict presentation stage status', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          verification: {
            ...availableResource.data.verification,
            steps: availableResource.data.verification.steps.map((step) => ({ ...step, status: 'failed' })),
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a fully verified policy with incomplete required check evidence', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          verification: {
            ...availableResource.data.verification,
            checks: availableResource.data.verification.checks.map((check) =>
              check.id === 'stark_receipt_verify' ? { ...check, status: 'not_run' } : check,
            ),
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'published counts that differ from verified tally',
      { counts: { A: 999, B: 2, C: 3, D: 4, E: 5 }, totalVotes: 15 },
    ],
    [
      'published total that differs from the verified tally sum',
      { counts: { A: 1, B: 2, C: 3, D: 4, E: 5 }, totalVotes: 999 },
    ],
  ] as const)('rejects %s', (_label, tallyOverride) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          presentation: {
            ...availableResource.data.presentation,
            tally: {
              ...availableResource.data.presentation.tally,
              ...tallyOverride,
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['missing slots', { missingSlots: 1 }],
    ['invalid presented slots', { invalidPresentedSlots: 1 }],
    ['rejected records', { rejectedRecords: 1 }],
    ['excluded slots', { excludedSlots: 1 }],
    ['tree size below the expected total', { treeSize: 14 }],
    ['seen count below the tree size', { seenIndicesCount: 14 }],
  ] as const)('rejects fully verified presentation with %s', (_label, proofOverride) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          proofAuthority: { ...availableResource.data.proofAuthority, ...proofOverride },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a fully verified presentation that declares tampering', () => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          presentation: { ...availableResource.data.presentation, tamperDetected: true },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'a nonzero tampered tally count',
      {
        tally: { ...availableResource.data.presentation.tally, tamperedCount: 1 },
      },
    ],
    [
      'nonzero tamper summary evidence',
      {
        tamperSummary: {
          ignoredVotes: 1,
          recountedVotes: 0,
          userRecountedTo: null,
          affectedBotIds: [],
        },
      },
    ],
  ] as const)('rejects fully verified presentation with %s', (_label, presentationOverride) => {
    expect(
      VerificationResourceResponseSchema.safeParse({
        ...availableResource,
        data: {
          ...availableResource.data,
          presentation: { ...availableResource.data.presentation, ...presentationOverride },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'a rendered status before readiness',
      { readiness: 'pending', source: 'summary', status: 'verified', renderedStatus: 'verified' },
    ],
    [
      'a rendered status that differs from the resolved status',
      { readiness: 'ready', source: 'summary', status: 'failed', renderedStatus: 'verified' },
    ],
    [
      'a status that contradicts its source',
      { readiness: 'ready', source: 'hard_failure', status: 'warning', renderedStatus: 'warning' },
    ],
  ] as const)('rejects display policy with %s', (_label, display) => {
    const contradictory = {
      ...availableResource,
      data: {
        ...availableResource.data,
        presentation: {
          ...availableResource.data.presentation,
          policy: {
            ...availableResource.data.presentation.policy,
            fullyVerifiedLabelEligible: false,
            display,
          },
        },
      },
    };

    expect(VerificationResourceResponseSchema.safeParse(contradictory).success).toBe(false);
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
        ...coherentIneligibleResource,
        data: {
          ...coherentIneligibleResource.data,
          voterEvidence: coherentVoterEvidence,
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'exact proof unavailable without the known vote ID',
      {
        availability: 'unavailable',
        reason: 'exact_proof_unavailable',
        userVote: { commitment: HEX_B },
      },
    ],
    [
      'vote ID unavailable while nevertheless disclosing a vote ID',
      {
        availability: 'unavailable',
        reason: 'vote_id_unavailable',
        userVote: { commitment: HEX_B, voteId: 'vote-1' },
      },
    ],
  ] as const)('rejects %s', (_label, candidate) => {
    expect(verificationVoterEvidenceSchema.safeParse(candidate).success).toBe(false);
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
