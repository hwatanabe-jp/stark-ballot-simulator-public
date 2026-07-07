import { DEFAULT_CONTRACT_GENERATION, normalizeContractGeneration } from './contractGenerationConstants';

/**
 * Resolve the single current contract-generation boundary for this deploy.
 */
export function resolveCurrentContractGeneration(configuredGeneration?: string | null): string {
  return normalizeContractGeneration(configuredGeneration ?? undefined) ?? DEFAULT_CONTRACT_GENERATION;
}

export function isCurrentContractGeneration(
  value: string | null | undefined,
  configuredGeneration?: string | null,
): boolean {
  return value === resolveCurrentContractGeneration(configuredGeneration);
}
