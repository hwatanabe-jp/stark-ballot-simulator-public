import { Buffer } from 'buffer';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeInputCommitmentFromPublicInput } from '../types';

const FIXED_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const ALTERNATE_ELECTION_ID = '123e4567-e89b-12d3-a456-426614174000';

type InputCommitmentPublicInput = Parameters<typeof computeInputCommitmentFromPublicInput>[0];
type InputCommitmentVote = InputCommitmentPublicInput['votes'][number];

const hex32Arbitrary = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => `0x${Buffer.from(bytes).toString('hex')}`);

const merklePathArbitrary = fc.array(hex32Arbitrary, { maxLength: 4 });

const voteArbitrary = fc.record({
  index: fc.integer({ min: 0, max: 8 }),
  commitment: hex32Arbitrary,
  merklePath: merklePathArbitrary,
});

const duplicateIndexVotesArbitrary = fc
  .tuple(fc.integer({ min: 0, max: 8 }), hex32Arbitrary, hex32Arbitrary, merklePathArbitrary)
  .filter(([, leftCommitment, rightCommitment]) => leftCommitment !== rightCommitment)
  .map(([index, leftCommitment, rightCommitment, merklePath]) => {
    const alternateMerklePath = mutateMerklePath(merklePath);

    return [
      {
        index,
        commitment: rightCommitment,
        merklePath: alternateMerklePath,
      },
      {
        index,
        commitment: leftCommitment,
        merklePath,
      },
      {
        index,
        commitment: rightCommitment,
        merklePath,
      },
    ] satisfies InputCommitmentVote[];
  });

const publicInputArbitrary = fc.record({
  bulletinRoot: hex32Arbitrary,
  treeSize: fc.integer({ min: 0, max: 64 }),
  totalExpected: fc.integer({ min: 0, max: 64 }),
  votes: fc.array(voteArbitrary, { minLength: 2, maxLength: 5 }),
});

const publicInputWithVotesArbitrary = fc.record({
  bulletinRoot: hex32Arbitrary,
  treeSize: fc.integer({ min: 0, max: 64 }),
  totalExpected: fc.integer({ min: 0, max: 64 }),
  votes: fc.array(voteArbitrary, { minLength: 1, maxLength: 5 }),
});

function withElectionId(input: Omit<InputCommitmentPublicInput, 'electionId'>): InputCommitmentPublicInput {
  return {
    electionId: FIXED_ELECTION_ID,
    ...input,
  };
}

function mutateHex32(value: string): string {
  const bytes = Buffer.from(value.slice(2), 'hex');
  bytes[0] ^= 0xff;
  return `0x${bytes.toString('hex')}`;
}

function mutateMerklePath(merklePath: readonly string[]): string[] {
  if (merklePath.length === 0) {
    return ['0x' + '00'.repeat(31) + '01'];
  }

  return [mutateHex32(merklePath[0]), ...merklePath.slice(1)];
}

function replaceFirstVote(
  votes: readonly InputCommitmentVote[],
  overrides: Partial<InputCommitmentVote>,
): InputCommitmentVote[] {
  return [{ ...votes[0], ...overrides }, ...votes.slice(1)];
}

// The properties enumerate all permutations, so keep vote arrays intentionally small.
function getPermutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) {
    return [Array.from(values)];
  }

  const permutations: T[][] = [];

  values.forEach((value, index) => {
    const remaining = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const permutation of getPermutations(remaining)) {
      permutations.push([value, ...permutation]);
    }
  });

  return permutations;
}

describe('input commitment property tests', () => {
  it('is invariant under permutations of the same vote multiset', () => {
    fc.assert(
      fc.property(publicInputArbitrary, (generatedInput) => {
        const baseInput = withElectionId(generatedInput);
        const expectedCommitment = computeInputCommitmentFromPublicInput(baseInput);

        for (const permutation of getPermutations(baseInput.votes)) {
          expect(
            computeInputCommitmentFromPublicInput({
              ...baseInput,
              votes: permutation,
            }),
          ).toBe(expectedCommitment);
        }
      }),
      { numRuns: 64 },
    );
  });

  it('is invariant under permutations when duplicate indices require canonical tie-break ordering', () => {
    fc.assert(
      fc.property(
        fc.record({
          bulletinRoot: hex32Arbitrary,
          treeSize: fc.integer({ min: 0, max: 64 }),
          totalExpected: fc.integer({ min: 0, max: 64 }),
        }),
        duplicateIndexVotesArbitrary,
        (context, votes) => {
          const baseInput = withElectionId({
            bulletinRoot: context.bulletinRoot,
            treeSize: context.treeSize,
            totalExpected: context.totalExpected,
            votes,
          });

          const expectedCommitment = computeInputCommitmentFromPublicInput(baseInput);

          for (const permutation of getPermutations(votes)) {
            expect(
              computeInputCommitmentFromPublicInput({
                ...baseInput,
                votes: permutation,
              }),
            ).toBe(expectedCommitment);
          }
        },
      ),
      { numRuns: 64 },
    );
  });

  it('changes when a top-level authoritative encoded field changes', () => {
    fc.assert(
      fc.property(publicInputArbitrary, (generatedInput) => {
        const baseInput = withElectionId(generatedInput);
        const expectedCommitment = computeInputCommitmentFromPublicInput(baseInput);

        expect(
          computeInputCommitmentFromPublicInput({
            ...baseInput,
            electionId: ALTERNATE_ELECTION_ID,
          }),
        ).not.toBe(expectedCommitment);

        expect(
          computeInputCommitmentFromPublicInput({
            ...baseInput,
            bulletinRoot: mutateHex32(baseInput.bulletinRoot),
          }),
        ).not.toBe(expectedCommitment);

        expect(
          computeInputCommitmentFromPublicInput({
            ...baseInput,
            treeSize: baseInput.treeSize + 1,
          }),
        ).not.toBe(expectedCommitment);

        expect(
          computeInputCommitmentFromPublicInput({
            ...baseInput,
            totalExpected: baseInput.totalExpected + 1,
          }),
        ).not.toBe(expectedCommitment);
      }),
      { numRuns: 64 },
    );
  });

  it('changes when a vote-level authoritative encoded field changes', () => {
    fc.assert(
      fc.property(publicInputWithVotesArbitrary, (generatedInput) => {
        const baseInput = withElectionId(generatedInput);
        const expectedCommitment = computeInputCommitmentFromPublicInput(baseInput);

        expect(
          computeInputCommitmentFromPublicInput({
            ...baseInput,
            votes: replaceFirstVote(baseInput.votes, {
              index: baseInput.votes[0].index + 1,
            }),
          }),
        ).not.toBe(expectedCommitment);

        expect(
          computeInputCommitmentFromPublicInput({
            ...baseInput,
            votes: replaceFirstVote(baseInput.votes, {
              commitment: mutateHex32(baseInput.votes[0].commitment),
            }),
          }),
        ).not.toBe(expectedCommitment);

        expect(
          computeInputCommitmentFromPublicInput({
            ...baseInput,
            votes: replaceFirstVote(baseInput.votes, {
              merklePath: mutateMerklePath(baseInput.votes[0].merklePath),
            }),
          }),
        ).not.toBe(expectedCommitment);
      }),
      { numRuns: 64 },
    );
  });
});
