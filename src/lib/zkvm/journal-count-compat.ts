import type { ZkVMJournal } from '@/lib/zkvm/types';

type JournalCountLike = Partial<
  Pick<ZkVMJournal, 'validVotes' | 'missingSlots' | 'invalidPresentedSlots' | 'rejectedRecords' | 'excludedSlots'>
> & {
  missingIndices?: number;
  invalidIndices?: number;
  countedIndices?: number;
  excludedCount?: number;
};

export interface LegacyJournalCountCompatibility {
  missingIndices: number;
  invalidIndices: number;
  countedIndices: number;
  excludedCount: number;
}

export function resolveMissingSlots(value: JournalCountLike | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  return typeof value.missingSlots === 'number' ? value.missingSlots : value.missingIndices;
}

export function resolveInvalidPresentedSlots(value: JournalCountLike | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value.invalidPresentedSlots === 'number') {
    return value.invalidPresentedSlots;
  }
  return typeof value.invalidIndices === 'number' ? value.invalidIndices : undefined;
}

export function resolveRejectedRecords(value: JournalCountLike | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  // `rejectedRecords` has no legacy alias. `invalidIndices` mirrors the
  // slot-based `invalidPresentedSlots` count and must not be reinterpreted as a
  // record-space rejection count.
  return typeof value.rejectedRecords === 'number' ? value.rejectedRecords : undefined;
}

export function resolveExcludedSlots(value: JournalCountLike | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value.excludedSlots === 'number') {
    return value.excludedSlots;
  }
  const missingSlots = resolveMissingSlots(value);
  const invalidPresentedSlots = resolveInvalidPresentedSlots(value);
  if (typeof missingSlots === 'number' && typeof invalidPresentedSlots === 'number') {
    return missingSlots + invalidPresentedSlots;
  }
  if (typeof value.excludedCount === 'number') {
    return value.excludedCount;
  }
  return undefined;
}

export function deriveLegacyJournalCountCompatibility(value: JournalCountLike): LegacyJournalCountCompatibility {
  const missingIndices = resolveMissingSlots(value) ?? 0;
  const invalidIndices = resolveInvalidPresentedSlots(value) ?? 0;
  const countedIndices =
    typeof value.validVotes === 'number'
      ? value.validVotes
      : typeof value.countedIndices === 'number'
        ? value.countedIndices
        : 0;
  const excludedCount = resolveExcludedSlots(value) ?? missingIndices + invalidIndices;

  return {
    missingIndices,
    invalidIndices,
    countedIndices,
    excludedCount,
  };
}
