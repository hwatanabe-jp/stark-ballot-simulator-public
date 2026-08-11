import {
  getVerificationStepInputs,
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
} from '@stark-ballot/verification/checks';
import {
  deriveVerificationPresentationPolicy,
  type VerificationPresentationPolicyResult,
} from '@stark-ballot/verification/presentation-policy';
import type { VerificationStep } from '@stark-ballot/verification/steps';

type CliVerificationStepId = 'counted_as_recorded' | 'stark_verification';
type CliVerificationCheckId =
  | 'counted_expected_vs_tree_size'
  | 'counted_election_manifest_consistent'
  | 'counted_close_statement_consistent'
  | 'stark_receipt_verify';

export interface CliVerificationStepFixture {
  readonly id: CliVerificationStepId;
  readonly status: VerificationStep['status'];
}

export interface CliVerificationCheckFixture {
  readonly id: CliVerificationCheckId;
  readonly status: VerificationCheck['status'];
}

export interface CliVerificationPresentationFixtureInput {
  readonly steps: readonly CliVerificationStepFixture[];
  readonly checks: readonly CliVerificationCheckFixture[];
}

export interface CliVerificationPresentationFixture {
  readonly verificationSteps: VerificationStep[];
  readonly verificationChecks: VerificationCheck[];
  readonly presentationPolicy: VerificationPresentationPolicyResult;
}

export function buildCliVerificationPresentationFixture(
  input: CliVerificationPresentationFixtureInput,
): CliVerificationPresentationFixture {
  const statusByStepId = new Map<VerificationStep['id'], VerificationStep['status']>(
    input.steps.map(({ id, status }) => [id, status]),
  );
  const statusByCheckId = new Map<VerificationCheck['id'], VerificationCheck['status']>(
    input.checks.map(({ id, status }) => [id, status]),
  );
  const verificationChecks = VERIFICATION_CHECK_DEFINITIONS.map((definition): VerificationCheck => ({
    id: definition.id,
    status: statusByCheckId.get(definition.id) ?? statusByStepId.get(definition.category) ?? 'not_run',
    evidence: definition.evidence,
    inputs: [...definition.inputs],
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));

  return {
    verificationSteps: input.steps.map(({ id, status }) => ({
      id,
      status,
      inputs: getVerificationStepInputs(id),
    })),
    verificationChecks,
    presentationPolicy: deriveVerificationPresentationPolicy({
      availability: 'available',
      checks: verificationChecks,
      context: {
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        excludedSlots: 0,
        sthSourcesConfigured: false,
      },
    }),
  };
}
