import type { VerificationStepStatus, VerificationStepId } from '@/lib/knowledge';
import type { VerificationCheckId } from '@/lib/verification/verification-checks';
import type { CheckResult, VerificationContext } from './types';

export function deriveStageStatusFromChecks(
  checks: Map<VerificationCheckId, CheckResult>,
  checkIds: VerificationCheckId[],
): VerificationStepStatus {
  const statuses = checkIds.map((id) => checks.get(id)?.status ?? 'not_run');

  if (statuses.includes('failed')) {
    return 'failed';
  }
  if (statuses.includes('running')) {
    return 'running';
  }
  if (statuses.includes('pending')) {
    return 'pending';
  }
  if (statuses.every((status) => status === 'success')) {
    return 'success';
  }
  return 'not_run';
}

export function pickStageError(
  checks: Map<VerificationCheckId, CheckResult>,
  checkIds: VerificationCheckId[],
): string | undefined {
  for (const id of checkIds) {
    const result = checks.get(id);
    if (result?.status === 'failed' && result.error) {
      return result.error;
    }
  }
  return undefined;
}

export function deriveStepStatusFromChecks(
  stepId: VerificationStepId,
  checkIds: VerificationCheckId[],
  checks: Map<VerificationCheckId, CheckResult>,
  ctx?: VerificationContext,
): { status: VerificationStepStatus; error?: string } {
  const status = deriveStageStatusFromChecks(checks, checkIds);
  const error = status === 'failed' ? pickStageError(checks, checkIds) : undefined;
  const guardedStatus = applyStepGuards(stepId, status, ctx);
  if (guardedStatus !== status) {
    return { status: guardedStatus };
  }
  return { status, error };
}

function applyStepGuards(
  stepId: VerificationStepId,
  status: VerificationStepStatus,
  ctx?: VerificationContext,
): VerificationStepStatus {
  if (!ctx) {
    return status;
  }

  if (stepId === 'counted_as_recorded' && !ctx.journal && status !== 'failed') {
    return 'not_run';
  }

  if (stepId === 'recorded_as_cast') {
    const hasTreeSize = typeof ctx.userVote?.proof?.treeSize === 'number';
    if (!hasTreeSize) {
      return 'not_run';
    }
  }

  if (status === 'failed') {
    return status;
  }

  return status;
}
