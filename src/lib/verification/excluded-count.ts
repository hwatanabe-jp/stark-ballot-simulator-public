export interface ExcludedCountInput {
  journal?: {
    missingSlots?: number;
    invalidPresentedSlots?: number;
    rejectedRecords?: number;
    excludedSlots?: number;
    validVotes?: number;
  };
  missingSlots?: number;
  invalidPresentedSlots?: number;
  excludedSlots?: number;
  missingIndices?: number;
  invalidIndices?: number;
  excludedCount?: number;
  fallbackToZero?: boolean;
}

/**
 * Resolve the current fail-closed exclusion count.
 *
 * Current verification paths use slot-based exclusions (`excludedSlots`).
 * Legacy aliases are accepted only as a one-way fail-closed quarantine for
 * stale or polluted payloads; callers must not use them as current public
 * fallback fields.
 */
export function resolveExcludedCount(input: ExcludedCountInput): number | undefined {
  const {
    journal,
    missingSlots,
    invalidPresentedSlots,
    excludedSlots,
    missingIndices,
    invalidIndices,
    excludedCount,
    fallbackToZero,
  } = input;

  if (journal) {
    return journal.excludedSlots;
  }

  if (typeof excludedSlots === 'number') {
    return excludedSlots;
  }

  if (typeof excludedCount === 'number') {
    return excludedCount;
  }

  if (typeof missingSlots === 'number' && typeof invalidPresentedSlots === 'number') {
    return missingSlots + invalidPresentedSlots;
  }

  if (typeof missingIndices === 'number' && typeof invalidIndices === 'number') {
    return missingIndices + invalidIndices;
  }

  if (fallbackToZero) {
    return (missingSlots ?? missingIndices ?? 0) + (invalidPresentedSlots ?? invalidIndices ?? 0);
  }

  return undefined;
}
