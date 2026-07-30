import {
  emitCanonicalEvent,
  type CanonicalScenarioId,
  type VerificationFailureCategory,
} from '@stark-ballot/diagnostics/canonicalEvents';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  isVerificationCheckRequired,
  type VerificationCheck,
  type VerificationCheckRequirementContext,
} from '@stark-ballot/verification/checks';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import { deriveVerificationSummary, type VerificationSummaryContext } from '@stark-ballot/verification/summary';

const SCENARIO_ID_SET = new Set<CanonicalScenarioId>(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);

export interface VerificationRunSummaryObservationInput {
  checks: readonly VerificationCheck[];
  summaryContext: VerificationSummaryContext;
  persistedScenarios: readonly string[] | undefined;
  verificationResult: VerificationResult | undefined;
  devModeReceipt?: boolean;
  sessionId: string;
  executionId?: string;
}

export function countFailedRequiredChecksForObservation(
  checks: readonly VerificationCheck[],
  context: VerificationCheckRequirementContext,
): number {
  return VERIFICATION_CHECK_DEFINITIONS.filter((definition) => {
    if (!isVerificationCheckRequired(definition, context)) {
      return false;
    }
    const matchingChecks = checks.filter((check) => check.id === definition.id);
    return matchingChecks.length !== 1 || matchingChecks[0]?.status !== 'success';
  }).length;
}

function resolvePersistedScenarioId(
  persistedScenarios: readonly string[] | undefined,
): CanonicalScenarioId | undefined {
  if (!persistedScenarios) {
    return undefined;
  }
  if (persistedScenarios.length === 0) {
    return 'S0';
  }
  if (persistedScenarios.length !== 1) {
    return undefined;
  }
  const scenarioId = persistedScenarios[0];
  return scenarioId && SCENARIO_ID_SET.has(scenarioId as CanonicalScenarioId)
    ? (scenarioId as CanonicalScenarioId)
    : undefined;
}

function resolveVerificationFailureCategory(
  verificationResult: VerificationResult | undefined,
): VerificationFailureCategory {
  if (verificationResult?.failureCategory) {
    return verificationResult.failureCategory;
  }
  return verificationResult?.status === 'failed' && !verificationResult.report ? 'unknown' : 'none';
}

export function emitVerificationRunSummaryObservation(input: VerificationRunSummaryObservationInput): void {
  try {
    const scenarioId = resolvePersistedScenarioId(input.persistedScenarios);
    if (!scenarioId) {
      return;
    }
    const summary = deriveVerificationSummary([...input.checks], input.summaryContext);
    if (!summary) {
      return;
    }
    const failedRequiredCount = countFailedRequiredChecksForObservation(
      input.checks,
      input.summaryContext.sthSourcesConfigured === undefined
        ? {}
        : { sthSourcesConfigured: input.summaryContext.sthSourcesConfigured },
    );

    emitCanonicalEvent({
      event: 'verification_run_summary',
      outcome: summary.status,
      failure_category: resolveVerificationFailureCategory(input.verificationResult),
      scenario_id: scenarioId,
      failed_required_count: failedRequiredCount,
      dev_mode_receipt: input.devModeReceipt ?? input.verificationResult?.report?.dev_mode_receipt === true,
      session_id_hash: hashSessionIdForLogging(input.sessionId),
      ...(input.executionId ? { execution_id: input.executionId } : {}),
    });
  } catch {
    // Verification telemetry is strictly observational and must never alter the completed response.
  }
}
