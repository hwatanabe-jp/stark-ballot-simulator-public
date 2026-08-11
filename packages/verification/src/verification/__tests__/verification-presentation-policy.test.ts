import { describe, expect, it } from 'vitest';
import {
  deriveVerificationPresentationPolicy,
  resolveVerificationDisplayDecision,
  type VerificationDisplayStatus,
  type VerificationDisplaySource,
  type VerificationExplicitServerFailureStatus,
} from '@stark-ballot/verification/presentation-policy';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import type { VerificationSummaryTone } from '@stark-ballot/verification/summary';
import displayCasesJson from '../../../../../docs/formal/generated-vectors/verification-display-cases.json';

interface FormalDisplayCase {
  name: string;
  verificationStarted: boolean;
  sequenceComplete: boolean;
  hasCheckPending: boolean;
  explicitServerFailureStatus: VerificationExplicitServerFailureStatus | null;
  summaryTone: VerificationSummaryTone | null;
  hasVerificationChecks: boolean;
  hardFailureDetected: boolean;
  expectedOverrideSource: VerificationDisplaySource | null;
  expectedOverrideStatus: VerificationDisplayStatus | null;
  expectedRenderedStatus: VerificationDisplayStatus | null;
}

const displayCases = displayCasesJson as FormalDisplayCase[];

function buildChecks(
  overrides: Partial<Record<VerificationCheckId, VerificationCheck['status']>> = {},
): VerificationCheck[] {
  return VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    status: overrides[definition.id] ?? 'success',
    evidence: definition.evidence,
    inputs: [...definition.inputs],
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));
}

const FROZEN_BLOCKING_CHECK_IDS = [
  'recorded_consistency_proof',
  'counted_missing_indices_zero',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'counted_my_vote_included',
  'counted_input_commitment_match',
  'stark_image_id_match',
  'stark_receipt_verify',
] as const satisfies readonly VerificationCheckId[];

describe('resolveVerificationDisplayDecision formal vectors', () => {
  it.each(displayCases)('$name', (testCase) => {
    const decision = resolveVerificationDisplayDecision({
      verificationStarted: testCase.verificationStarted,
      sequenceComplete: testCase.sequenceComplete,
      hasCheckPending: testCase.hasCheckPending,
      explicitServerFailureStatus: testCase.explicitServerFailureStatus,
      summaryTone: testCase.summaryTone,
      hasVerificationChecks: testCase.hasVerificationChecks,
      hardFailureDetected: testCase.hardFailureDetected,
    });

    expect(decision.source).toBe(testCase.expectedOverrideSource);
    expect(decision.status).toBe(testCase.expectedOverrideStatus);
    expect(decision.renderedStatus).toBe(testCase.expectedRenderedStatus);
    if (testCase.expectedRenderedStatus !== 'verified') {
      expect(decision.renderedStatus).not.toBe('verified');
    }
  });
});

describe('deriveVerificationPresentationPolicy', () => {
  it('derives a fully verified label only from complete admitted evidence', () => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks(),
    });

    expect(result.summary).toEqual({ status: 'fully_verified', tone: 'verified' });
    expect(result.stageStatuses).toEqual({
      cast_as_intended: 'success',
      recorded_as_cast: 'success',
      counted_as_recorded: 'success',
      stark_verification: 'success',
    });
    expect(result.evidenceFullyVerified).toBe(true);
    expect(result.fullyVerifiedLabelEligible).toBe(true);
    expect(result.display).toEqual({
      readiness: 'ready',
      source: 'summary',
      status: 'verified',
      renderedStatus: 'verified',
    });
    expect(result.publishedTallyMismatch).toBe(false);
    expect(result.devModeEvidence).toBe(false);
    expect(result.missingEvidence).toBe(false);
    expect(result.explanationKey).toBeUndefined();
  });

  it.each(['pending', 'running'] as const)(
    'keeps optional STH %s fully verified in the summary but suppresses the label',
    (status) => {
      const result = deriveVerificationPresentationPolicy({
        availability: 'available',
        checks: buildChecks({ recorded_sth_third_party: status }),
      });

      expect(result.summary).toEqual({ status: 'fully_verified', tone: 'verified' });
      expect(result.stageStatuses.recorded_as_cast).toBe('success');
      expect(result.evidenceFullyVerified).toBe(true);
      expect(result.fullyVerifiedLabelEligible).toBe(false);
      expect(result.display).toEqual({
        readiness: 'pending',
        source: 'summary',
        status: 'verified',
        renderedStatus: null,
      });
    },
  );

  it('promotes configured STH evidence into the required recorded stage', () => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks({ recorded_sth_third_party: 'not_run' }),
      context: { sthSourcesConfigured: true },
    });

    expect(result.summary?.status).toBe('missing_evidence');
    expect(result.stageStatuses.recorded_as_cast).toBe('not_run');
    expect(result.evidenceFullyVerified).toBe(false);
    expect(result.fullyVerifiedLabelEligible).toBe(false);
    expect(result.missingEvidence).toBe(true);
  });

  it('keeps dev-mode evidence visibly separate from a verified label', () => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks(),
      context: { devModeEvidence: true },
    });

    expect(result.summary).toEqual({ status: 'demo_only', tone: 'demo' });
    expect(result.devModeEvidence).toBe(true);
    expect(result.evidenceFullyVerified).toBe(false);
    expect(result.fullyVerifiedLabelEligible).toBe(false);
    expect(result.display.renderedStatus).toBe('demo_only');
  });

  it('fails closed on excluded slots even if contradictory check input claims success', () => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks(),
      context: { excludedSlots: 1 },
    });

    expect(result.summary?.status).toBe('fully_verified');
    expect(result.evidenceFullyVerified).toBe(false);
    expect(result.fullyVerifiedLabelEligible).toBe(false);
    expect(result.display).toMatchObject({
      readiness: 'ready',
      source: 'hard_failure',
      status: 'failed',
      renderedStatus: 'failed',
    });
  });

  it.each([
    ['missing slots without an exclusion total', { missingSlots: 1, invalidPresentedSlots: 0 }],
    [
      'invalid presented slots with a zero exclusion total',
      { missingSlots: 0, invalidPresentedSlots: 1, excludedSlots: 0 },
    ],
    ['inconsistent exclusion accounting', { missingSlots: 1, invalidPresentedSlots: 1, excludedSlots: 3 }],
    ['fractional exclusion evidence', { missingSlots: 0.5, invalidPresentedSlots: 0, excludedSlots: 0.5 }],
  ] as const)('fails closed on %s', (_label, context) => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks(),
      context,
    });

    expect(result.evidenceFullyVerified).toBe(false);
    expect(result.fullyVerifiedLabelEligible).toBe(false);
    expect(result.display).toMatchObject({
      source: 'hard_failure',
      status: 'failed',
      renderedStatus: 'failed',
    });
  });

  it.each(FROZEN_BLOCKING_CHECK_IDS)('%s blocks a fully verified label when it fails', (checkId) => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks({ [checkId]: 'failed' }),
    });

    expect(result.fullyVerifiedLabelEligible).toBe(false);
    expect(result.display.renderedStatus).not.toBe('verified');
  });

  it('blocks a fully verified label when configured STH evidence fails', () => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks({ recorded_sth_third_party: 'failed' }),
      context: { sthSourcesConfigured: true },
    });

    expect(result.stageStatuses.recorded_as_cast).toBe('failed');
    expect(result.fullyVerifiedLabelEligible).toBe(false);
    expect(result.display.renderedStatus).not.toBe('verified');
  });

  it('exposes published tally mismatch without reclassifying proof verification', () => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks({ counted_tally_consistent: 'failed' }),
      verificationStatus: 'success',
      verificationReportStatus: 'success',
    });

    expect(result.summary?.status).toBe('published_tally_mismatch');
    expect(result.publishedTallyMismatch).toBe(true);
    expect(result.stageStatuses.stark_verification).toBe('success');
    expect(result.display.source).toBe('summary');
    expect(result.display.renderedStatus).toBe('failed');
  });

  it.each([
    ['unavailable', 'warning'],
    ['corrupt', 'failed'],
  ] as const)('makes %s resources explicitly ineligible', (availability, expectedStatus) => {
    const result = deriveVerificationPresentationPolicy({
      availability,
      checks: buildChecks(),
    });

    expect(result.summary).toBeNull();
    expect(Object.values(result.stageStatuses)).toEqual(['not_run', 'not_run', 'not_run', 'not_run']);
    expect(result.evidenceFullyVerified).toBe(false);
    expect(result.fullyVerifiedLabelEligible).toBe(false);
    expect(result.missingEvidence).toBe(true);
    expect(result.display).toEqual({
      readiness: 'ready',
      source: availability,
      status: expectedStatus,
      renderedStatus: expectedStatus,
    });
  });

  it('fails closed on missing, unknown, and duplicate-worst check identities', () => {
    const canonical = buildChecks();
    const missing = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: canonical.slice(1),
    });
    expect(missing.summary?.status).toBe('missing_evidence');
    expect(missing.stageStatuses.cast_as_intended).toBe('not_run');
    expect(missing.fullyVerifiedLabelEligible).toBe(false);

    const first = canonical[0];
    if (!first) {
      throw new Error('Expected a canonical check');
    }
    const unknown = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: [
        ...canonical,
        {
          ...first,
          id: 'future_check' as VerificationCheckId,
        },
      ],
    });
    expect(unknown.summary?.status).toBe('missing_evidence');
    expect(unknown.fullyVerifiedLabelEligible).toBe(false);

    const duplicateWorst = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: [
        ...canonical,
        {
          ...canonical.find((check) => check.id === 'stark_receipt_verify'),
          id: 'stark_receipt_verify',
          status: 'failed',
          evidence: 'zk',
          inputs: ['proofBundleStatus'],
        },
      ],
    });
    expect(duplicateWorst.summary?.status).toBe('proof_verification_failed');
    expect(duplicateWorst.stageStatuses.stark_verification).toBe('failed');
    expect(duplicateWorst.fullyVerifiedLabelEligible).toBe(false);
  });

  it('preserves the summary explanation key for exclusion-specific presentation', () => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks({
        counted_missing_indices_zero: 'failed',
        counted_my_vote_included: 'failed',
      }),
      context: {
        missingSlots: 1,
        invalidPresentedSlots: 0,
        excludedSlots: 1,
      },
    });

    expect(result.summary?.status).toBe('user_vote_excluded');
    expect(result.explanationKey).toBe('pages.verify.resultSummary.userVoteMissingSub');
    expect(result.display.renderedStatus).toBe('failed');
  });

  it('uses successful receipt and ImageID checks instead of a stale top-level failure status', () => {
    const result = deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: buildChecks(),
      verificationStatus: 'failed',
    });

    expect(result.summary?.status).toBe('fully_verified');
    expect(result.evidenceFullyVerified).toBe(true);
    expect(result.display.source).toBe('summary');
    expect(result.display.renderedStatus).toBe('verified');
    expect(result.fullyVerifiedLabelEligible).toBe(true);
  });
});
