import type { VerificationStep, VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';
import { evaluateVerificationCheckResults } from '@/lib/verification/build-verification-checks';
import { deriveStepStatusFromChecks } from '@/lib/verification/engine/derive-stages';
import type { VerificationContext, VerificationStatus, CheckResult } from '@/lib/verification/engine/types';
import { resolveConfiguredSthSources } from '@/lib/verification/sth-verifier';
import {
  getVerificationRequiredCheckIdsForStep,
  getVerificationStepInputs,
  type VerificationCheckId,
  type VerificationCheckRequirementContext,
} from '@/lib/verification/verification-checks';

type CastSource = 'server' | 'client';

export interface BuildVerificationStepsInput extends VerificationContext {
  verificationStatus?: VerificationStatus;
  verificationReportStatus?: VerificationStatus;
  allowDevModeVerification?: boolean;
  castSource?: CastSource;
  checkResults?: Map<VerificationCheckId, CheckResult>;
}

/**
 * Build the four-step verification summary for /api/verify responses.
 */
export async function buildVerificationSteps(input: BuildVerificationStepsInput): Promise<VerificationStep[]> {
  const castSource = input.castSource ?? 'client';
  const requirementContext = resolveRequirementContext();
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

function resolveRequirementContext(): VerificationCheckRequirementContext {
  return {
    sthSourcesConfigured: resolveConfiguredSthSources().length > 0,
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
