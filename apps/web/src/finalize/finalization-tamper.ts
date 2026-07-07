export interface FinalizationTamperSummaryLike {
  ignoredVotes?: number;
  recountedVotes?: number;
}

function normalizeNonNegativeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function resolveScenarioTamperCount(summary?: FinalizationTamperSummaryLike | null): number {
  return normalizeNonNegativeCount(summary?.ignoredVotes) + normalizeNonNegativeCount(summary?.recountedVotes);
}

export function resolveFinalizationTamperDetected(input: {
  excludedSlots?: number;
  rejectedRecords?: number;
  scenarioTamperCount?: number;
}): boolean {
  const excludedSignal = normalizeNonNegativeCount(input.excludedSlots);
  const rejectedSignal = normalizeNonNegativeCount(input.rejectedRecords);
  const scenarioSignal = normalizeNonNegativeCount(input.scenarioTamperCount);

  return excludedSignal > 0 || rejectedSignal > 0 || scenarioSignal > 0;
}
