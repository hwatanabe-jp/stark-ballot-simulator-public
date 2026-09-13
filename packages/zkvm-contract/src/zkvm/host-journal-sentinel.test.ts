import hostJournalSentinel from '../../../../zkvm/contract-core/testdata/current-journal-host-json-sentinel.json';
import { describe, expect, it } from 'vitest';
import { parseHostZkVMOutput } from './host-io';
import { CURRENT_METHOD_VERSION } from './types';

describe('Rust-owned host journal JSON sentinel', () => {
  it('is admitted through the current TypeScript host boundary', () => {
    const admitted = parseHostZkVMOutput(hostJournalSentinel);

    expect(admitted.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(admitted.verifiedTally).toEqual([1, 1, 1, 1, 1]);
    expect(admitted.totalVotes).toBe(5);
    expect(admitted.excludedSlots).toBe(0);
    expect(admitted.imageId).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('rejects unknown top-level fields outside the exact Rust projection', () => {
    expect(() => parseHostZkVMOutput({ ...hostJournalSentinel, compatibilityMarker: 'retired' })).toThrow(
      /exact current fields/u,
    );
  });
});
