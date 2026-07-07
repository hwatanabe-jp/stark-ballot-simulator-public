import type { FinalizationState } from '@stark-ballot/application/finalize/finalization-types';

export type FinalizationQueueInfo = {
  concurrencyLimit: number;
  estimatedDurationMs: number;
};

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_ESTIMATED_DURATION_MS = 360000;

function parsePositiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return null;
}

function resolveConcurrencyLimit(): number {
  const enforcedMaxSlots = parsePositiveInteger(process.env['PROVER_MAX_CONCURRENT_PROVERS']);
  if (enforcedMaxSlots !== null) {
    return enforcedMaxSlots;
  }
  const legacyConcurrency = parsePositiveInteger(process.env['PROVER_LAMBDA_CONCURRENCY']);
  if (legacyConcurrency !== null) {
    return legacyConcurrency;
  }
  return DEFAULT_CONCURRENCY;
}

function buildQueueEstimate(): FinalizationQueueInfo {
  return {
    concurrencyLimit: resolveConcurrencyLimit(),
    estimatedDurationMs: DEFAULT_ESTIMATED_DURATION_MS,
  };
}

export function buildFinalizationQueueInfo(params: {
  queueUrl?: string;
  state: FinalizationState;
}): Promise<FinalizationQueueInfo | null> {
  const { queueUrl } = params;
  if (!queueUrl) {
    return Promise.resolve(null);
  }

  return Promise.resolve(buildQueueEstimate());
}
