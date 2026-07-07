import { describe, expect, it } from 'vitest';
import { isSupportedZkVMJournal } from '../journal-guards';
import { CURRENT_METHOD_VERSION, UINT32_MAX } from '../types';

const hex32 = `0x${'11'.repeat(32)}`;

function validJournal(): Record<string, unknown> {
  return {
    electionId: '123e4567-e89b-12d3-a456-426614174000',
    electionConfigHash: hex32,
    bulletinRoot: hex32,
    treeSize: 1,
    totalExpected: 1,
    sthDigest: hex32,
    verifiedTally: [1, 0, 0, 0, 0],
    totalVotes: 1,
    validVotes: 1,
    invalidVotes: 0,
    seenIndicesCount: 1,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    seenBitmapRoot: hex32,
    includedBitmapRoot: hex32,
    excludedSlots: 0,
    inputCommitment: hex32,
    methodVersion: CURRENT_METHOD_VERSION,
    imageId: hex32,
  };
}

describe('isSupportedZkVMJournal', () => {
  it('accepts current journals with u32-compatible Rust output numbers', () => {
    expect(isSupportedZkVMJournal(validJournal())).toBe(true);
  });

  it.each([
    ['treeSize', 0],
    ['totalExpected', -1],
    ['totalVotes', 1.5],
    ['validVotes', Number.POSITIVE_INFINITY],
    ['invalidVotes', Number.NaN],
    ['seenIndicesCount', Number.MAX_SAFE_INTEGER + 1],
    ['missingSlots', UINT32_MAX + 1],
    ['invalidPresentedSlots', UINT32_MAX + 1],
    ['rejectedRecords', UINT32_MAX + 1],
    ['excludedSlots', UINT32_MAX + 1],
  ])('rejects impossible current journal count %s=%s', (field, value) => {
    expect(isSupportedZkVMJournal({ ...validJournal(), [field]: value })).toBe(false);
  });

  it('rejects tally entries outside the Rust u32 journal contract', () => {
    expect(isSupportedZkVMJournal({ ...validJournal(), verifiedTally: [UINT32_MAX + 1, 0, 0, 0, 0] })).toBe(false);
  });
});
