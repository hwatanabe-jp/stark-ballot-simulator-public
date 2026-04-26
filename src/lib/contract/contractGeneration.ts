const DEFAULT_CONTRACT_GENERATION = '2026-04-zkvm-current-v3';

function normalizeContractGeneration(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Resolve the single current contract-generation boundary for this deploy.
 */
export function resolveCurrentContractGeneration(): string {
  return normalizeContractGeneration(process.env.CONTRACT_GENERATION) ?? DEFAULT_CONTRACT_GENERATION;
}

export function isCurrentContractGeneration(value: string | null | undefined): boolean {
  return value === resolveCurrentContractGeneration();
}
