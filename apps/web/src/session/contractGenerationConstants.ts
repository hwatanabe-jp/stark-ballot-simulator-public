export const DEFAULT_CONTRACT_GENERATION = '2026-04-zkvm-current-v3';

export function normalizeContractGeneration(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
