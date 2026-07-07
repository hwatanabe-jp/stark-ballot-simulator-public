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
  fallbackToZero?: boolean;
}

/**
 * Resolve the current fail-closed exclusion count.
 *
 * Current verification paths use slot-based exclusions (`excludedSlots`).
 * Legacy aliases are rejected before current verification processing and are
 * intentionally not accepted by this active helper.
 */
export function resolveExcludedCount(input: ExcludedCountInput): number | undefined {
  const { journal, missingSlots, invalidPresentedSlots, excludedSlots, fallbackToZero } = input;

  if (journal) {
    return journal.excludedSlots;
  }

  if (typeof excludedSlots === 'number') {
    return excludedSlots;
  }

  if (typeof missingSlots === 'number' && typeof invalidPresentedSlots === 'number') {
    return missingSlots + invalidPresentedSlots;
  }

  if (fallbackToZero) {
    return (missingSlots ?? 0) + (invalidPresentedSlots ?? 0);
  }

  return undefined;
}
