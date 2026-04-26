import { Buffer } from 'buffer';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeMockZkVM } from '../mock-executor';
import { computeCommitment, type VoteWithProof, type ZkVMInput } from '../types';

const FIXED_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

const hex32Arbitrary = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => `0x${Buffer.from(bytes).toString('hex')}`);

const merklePathArbitrary = fc.array(hex32Arbitrary, { maxLength: 4 });

function voteArbitrary(electionId: string, treeSize: number) {
  return fc
    .record({
      choice: fc.integer({ min: 0, max: 6 }),
      random: hex32Arbitrary,
      index: fc.integer({ min: 0, max: Math.max(treeSize + 3, 3) }),
      merklePath: merklePathArbitrary,
    })
    .map(
      ({ choice, random, index, merklePath }): VoteWithProof => ({
        choice,
        random,
        index,
        merklePath,
        commitment: computeCommitment(electionId, choice, random),
      }),
    );
}

const zkvmInputArbitrary = fc.integer({ min: 0, max: 16 }).chain((treeSize) =>
  fc.record({
    treeSize: fc.constant(treeSize),
    bulletinRoot: hex32Arbitrary,
    logId: hex32Arbitrary,
    timestamp: fc.integer({ min: 0, max: 2_000_000_000 }),
    electionConfigHash: hex32Arbitrary,
    votes: fc.array(voteArbitrary(FIXED_ELECTION_ID, treeSize), { maxLength: 20 }),
  }),
);

describe('journal invariant property tests', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the current slot/record count invariants for arbitrary mock zkVM inputs', async () => {
    await fc.assert(
      fc.asyncProperty(zkvmInputArbitrary, async (generated) => {
        const input: ZkVMInput = {
          electionId: FIXED_ELECTION_ID,
          bulletinRoot: generated.bulletinRoot,
          treeSize: generated.treeSize,
          logId: generated.logId,
          timestamp: generated.timestamp,
          totalExpected: generated.treeSize,
          electionConfigHash: generated.electionConfigHash,
          votes: generated.votes,
        };

        const result = await executeMockZkVM(input);

        expect(result.totalVotes).toBe(input.votes.length);
        expect(result.totalVotes).toBe(result.validVotes + result.rejectedRecords);
        expect(result.invalidVotes).toBe(result.rejectedRecords);
        expect(result.seenIndicesCount).toBe(result.validVotes + result.invalidPresentedSlots);
        expect(result.validVotes + result.invalidPresentedSlots + result.missingSlots).toBe(result.treeSize);
        expect(result.excludedSlots).toBe(result.missingSlots + result.invalidPresentedSlots);
        expect(result.rejectedRecords).toBeGreaterThanOrEqual(result.invalidPresentedSlots);
        expect(
          result.includedBitmap?.every((included, index) => !included || result.seenBitmap?.[index] === true),
        ).toBe(true);
      }),
      { numRuns: 48 },
    );
  }, 15_000);
});
