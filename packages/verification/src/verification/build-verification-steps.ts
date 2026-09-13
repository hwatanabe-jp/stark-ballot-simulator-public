import type { VerificationStepId, VerificationStepStatus } from './step-types';
import { evaluateVerificationCheckResults } from '@stark-ballot/verification/check-results';
import { deriveStepStatusFromChecks } from '@stark-ballot/verification/stage-status';
import type { CheckResult, VerificationEvaluationInput } from '@stark-ballot/verification/engine-types';
import {
  getVerificationRequiredCheckIdsForStep,
  getVerificationStepInputs,
  type VerificationCheckId,
  type VerificationCheckRequirementContext,
} from '@stark-ballot/verification/checks';

type CastSource = 'server' | 'client';

export interface VerificationStep {
  id: VerificationStepId;
  status: VerificationStepStatus;
  inputs: string[];
  error?: string;
}

export const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const satisfies readonly VerificationStepId[];

export function hasCanonicalVerificationSteps(
  steps: readonly {
    readonly id: VerificationStepId;
    readonly status: VerificationStepStatus;
    readonly inputs: readonly string[];
    readonly error?: string | undefined;
  }[],
): boolean {
  if (steps.length !== VERIFICATION_STEP_IDS.length) {
    return false;
  }
  return VERIFICATION_STEP_IDS.every((id, index) => {
    const step = steps[index];
    const expectedInputs = getVerificationStepInputs(id);
    return (
      step !== undefined &&
      step.id === id &&
      step.inputs.length === expectedInputs.length &&
      step.inputs.every((input, inputIndex) => input === expectedInputs[inputIndex]) &&
      (step.error === undefined || (step.status === 'failed' && step.error.trim().length > 0))
    );
  });
}

export type BuildVerificationStepsInput = VerificationEvaluationInput &
  Readonly<{
    castSource?: CastSource;
    checkResults?: Map<VerificationCheckId, CheckResult>;
  }>;

/**
 * Build the four-step summary for a verification resource.
 */
export async function buildVerificationSteps(input: BuildVerificationStepsInput): Promise<VerificationStep[]> {
  const castSource = input.castSource ?? 'client';
  const requirementContext = resolveRequirementContext(input);
  const checks =
    input.checkResults ??
    (await evaluateVerificationCheckResults({
      ...input,
      castSource,
    }));

  const castStep =
    castSource === 'client'
      ? createStep('cast_as_intended', 'not_run', undefined)
      : buildStepFromChecks('cast_as_intended', checks, input, requirementContext);
  const recordedStep = buildStepFromChecks('recorded_as_cast', checks, input, requirementContext);
  const countedStep = buildStepFromChecks('counted_as_recorded', checks, input, requirementContext);
  const starkStep = buildStepFromChecks('stark_verification', checks, input, requirementContext);

  return [castStep, recordedStep, countedStep, starkStep];
}

function buildStepFromChecks(
  stepId: VerificationStepId,
  checks: Map<VerificationCheckId, CheckResult>,
  ctx: BuildVerificationStepsInput,
  requirementContext: VerificationCheckRequirementContext,
): VerificationStep {
  const checkIds = getVerificationRequiredCheckIdsForStep(stepId, requirementContext);
  const { status, error } = deriveStepStatusFromChecks(stepId, checkIds, checks, ctx);
  return createStep(stepId, status, error);
}

function resolveRequirementContext(input: BuildVerificationStepsInput): VerificationCheckRequirementContext {
  return {
    sthSourcesConfigured: input.sthSourcesConfigured === true,
  };
}

function createStep(
  id: VerificationStepId,
  status: VerificationStepStatus,
  error: string | undefined,
): VerificationStep {
  return {
    id,
    status,
    inputs: getVerificationStepInputs(id),
    ...(error ? { error } : {}),
  };
}
