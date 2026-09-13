import { describe, expect, it } from 'vitest';
import { hasCoherentZkVMVoteSlotPartition, isSupportedZkVMJournal } from './journal-guards';
import { CURRENT_ZKVM_SEMANTIC_CONTRACT } from './semantic-contract';
import { CURRENT_METHOD_VERSION, UINT32_MAX } from './types';

const hex32 = `0x${'11'.repeat(32)}`;
const currentJournalRequiredKeys = CURRENT_ZKVM_SEMANTIC_CONTRACT.hostJsonProjection.fields
  .map((field) => field.name)
  .filter((field) => field !== 'imageId');

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

  it('rejects UUID-shaped strings outside the current RFC variant/version admission', () => {
    expect(
      isSupportedZkVMJournal({
        ...validJournal(),
        electionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    ).toBe(false);
  });

  it('accepts the exact current journal shape without optional ImageID metadata', () => {
    const journal = validJournal();
    delete journal['imageId'];

    expect(isSupportedZkVMJournal(journal)).toBe(true);
  });

  it('rejects unknown fields alongside the exact current journal shape', () => {
    expect(isSupportedZkVMJournal({ ...validJournal(), unexpected: true })).toBe(false);
  });

  it.each(currentJournalRequiredKeys)('rejects a current journal missing required field %s', (field) => {
    const journal = validJournal();
    delete journal[field];

    expect(isSupportedZkVMJournal(journal)).toBe(false);
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

  it.each([
    ['totalVotes', 0],
    ['validVotes', 0],
    ['invalidVotes', 1],
    ['seenIndicesCount', 0],
    ['missingSlots', 1],
    ['invalidPresentedSlots', 1],
    ['rejectedRecords', 1],
    ['excludedSlots', 1],
    ['verifiedTally', [0, 0, 0, 0, 0]],
  ] as const)('rejects a journal whose %s contradicts current count algebra', (field, value) => {
    expect(isSupportedZkVMJournal({ ...validJournal(), [field]: value })).toBe(false);
  });

  it('allows totalExpected/treeSize mismatch as coherent failure evidence', () => {
    expect(isSupportedZkVMJournal({ ...validJournal(), totalExpected: 2 })).toBe(true);
  });

  it('rejects different bitmap roots when there are no invalid presented slots', () => {
    expect(isSupportedZkVMJournal({ ...validJournal(), includedBitmapRoot: `0x${'22'.repeat(32)}` })).toBe(false);
  });

  it('rejects fewer rejected records than invalid presented slots', () => {
    expect(
      isSupportedZkVMJournal({
        ...validJournal(),
        verifiedTally: [0, 0, 0, 0, 0],
        totalVotes: 0,
        validVotes: 0,
        invalidVotes: 0,
        seenIndicesCount: 1,
        invalidPresentedSlots: 1,
        rejectedRecords: 0,
        excludedSlots: 1,
      }),
    ).toBe(false);
  });
});

describe('hasCoherentZkVMVoteSlotPartition', () => {
  const partition = {
    verifiedTally: [1, 0, 0, 0, 0],
    treeSize: 1,
    seenIndicesCount: 1,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    excludedSlots: 0,
    seenBitmapRoot: hex32,
    includedBitmapRoot: hex32,
  } as const;

  it('admits the exact projection shared by journal and proof authority', () => {
    expect(hasCoherentZkVMVoteSlotPartition(partition)).toBe(true);
  });

  it.each([
    ['verifiedTally', [0, 0, 0, 0, 0]],
    ['seenIndicesCount', 0],
    ['missingSlots', 1],
    ['invalidPresentedSlots', 1],
    ['rejectedRecords', -1],
    ['excludedSlots', 1],
    ['includedBitmapRoot', `0x${'22'.repeat(32)}`],
  ] as const)('rejects contradictory shared slot-partition field %s', (field, value) => {
    expect(hasCoherentZkVMVoteSlotPartition({ ...partition, [field]: value })).toBe(false);
  });
});
