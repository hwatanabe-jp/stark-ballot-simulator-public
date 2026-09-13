import { describe, expect, it } from 'vitest';
import {
  MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD,
  MAX_GUEST_SERIALIZED_INPUT_BYTES,
  MAX_GUEST_TOTAL_EXPECTED,
  MAX_GUEST_TOTAL_PATH_NODES,
  MAX_GUEST_TREE_SIZE,
  MAX_GUEST_VOTE_COUNT,
  calculateStructuralInputBytes,
  calculateTotalPathNodes,
  validateGuestWorkBudget,
} from './work-budget';
import type { VoteWithProof, ZkVMInput } from './types';
import { serializeZkvmAggregatorInput } from './host-io';

const EMPTY_INPUT: Pick<ZkVMInput, 'treeSize' | 'totalExpected' | 'votes'> = {
  treeSize: 1,
  totalExpected: 1,
  votes: [],
};

function voteWithPathLength(pathLength: number): VoteWithProof {
  return {
    commitment: '0x' + '11'.repeat(32),
    choice: 0,
    random: '0x' + '22'.repeat(32),
    index: 0,
    merklePath: Array.from({ length: pathLength }, () => '0x' + '33'.repeat(32)),
  };
}

function repeatVote(vote: VoteWithProof, count: number): VoteWithProof[] {
  return Array.from({ length: count }, () => vote);
}

describe('guest work budget', () => {
  it('counts aggregate Merkle path nodes across all records', () => {
    expect(calculateTotalPathNodes({ votes: [voteWithPathLength(2), voteWithPathLength(3)] })).toBe(5);
  });

  it('accepts the maximum aggregate Merkle path-node budget', () => {
    const voteCount = 50_000;
    const pathLength = MAX_GUEST_TOTAL_PATH_NODES / voteCount;
    expect(() =>
      validateGuestWorkBudget({ ...EMPTY_INPUT, votes: repeatVote(voteWithPathLength(pathLength), voteCount) }),
    ).not.toThrow();
  });

  it('rejects inputs over the aggregate Merkle path-node budget', () => {
    const voteCount = 50_000;
    const pathLength = Math.floor(MAX_GUEST_TOTAL_PATH_NODES / voteCount) + 1;
    expect(() =>
      validateGuestWorkBudget({ ...EMPTY_INPUT, votes: repeatVote(voteWithPathLength(pathLength), voteCount) }),
    ).toThrow(
      `zkVM input exceeds total Merkle path node budget: ${voteCount * pathLength} > ${MAX_GUEST_TOTAL_PATH_NODES}`,
    );
  });

  it('rejects inputs outside guest semantic tree-size bounds', () => {
    expect(() => validateGuestWorkBudget({ ...EMPTY_INPUT, treeSize: 0 })).toThrow(
      `zkVM input treeSize exceeds guest contract bounds: 0 not in 1..${MAX_GUEST_TREE_SIZE}`,
    );
    expect(() => validateGuestWorkBudget({ ...EMPTY_INPUT, treeSize: MAX_GUEST_TREE_SIZE + 1 })).toThrow(
      `zkVM input treeSize exceeds guest contract bounds: ${MAX_GUEST_TREE_SIZE + 1} not in 1..${MAX_GUEST_TREE_SIZE}`,
    );
  });

  it('rejects inputs over the guest semantic totalExpected bound', () => {
    expect(() => validateGuestWorkBudget({ ...EMPTY_INPUT, totalExpected: MAX_GUEST_TOTAL_EXPECTED + 1 })).toThrow(
      `zkVM input totalExpected exceeds guest contract bound: ${MAX_GUEST_TOTAL_EXPECTED + 1} > ${MAX_GUEST_TOTAL_EXPECTED}`,
    );
  });

  it('rejects inputs over the guest semantic vote-count bound before scanning records', () => {
    const vote = voteWithPathLength(0);
    expect(() =>
      validateGuestWorkBudget({ ...EMPTY_INPUT, votes: repeatVote(vote, MAX_GUEST_VOTE_COUNT + 1) }),
    ).toThrow(
      `zkVM input vote count exceeds guest contract bound: ${MAX_GUEST_VOTE_COUNT + 1} > ${MAX_GUEST_VOTE_COUNT}`,
    );
  });

  it('rejects per-record Merkle paths that exceed the u16 input-commitment encoding bound', () => {
    expect(() =>
      validateGuestWorkBudget({
        ...EMPTY_INPUT,
        votes: [voteWithPathLength(MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD + 1)],
      }),
    ).toThrow(
      `zkVM input votes[0] Merkle path length exceeds per-record budget: ${MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD + 1} > ${MAX_GUEST_MERKLE_PATH_NODES_PER_RECORD}`,
    );
  });

  it('accepts the maximum serialized input byte budget', () => {
    expect(() =>
      validateGuestWorkBudget(EMPTY_INPUT, { serializedInputBytes: MAX_GUEST_SERIALIZED_INPUT_BYTES }),
    ).not.toThrow();
  });

  it('rejects inputs over the serialized byte budget', () => {
    expect(() =>
      validateGuestWorkBudget(EMPTY_INPUT, { serializedInputBytes: MAX_GUEST_SERIALIZED_INPUT_BYTES + 1 }),
    ).toThrow(
      `zkVM input exceeds serialized byte budget: ${MAX_GUEST_SERIALIZED_INPUT_BYTES + 1} > ${MAX_GUEST_SERIALIZED_INPUT_BYTES}`,
    );
  });

  it('matches the Rust structural byte estimate for the current input shape', () => {
    expect(calculateStructuralInputBytes({ votes: [voteWithPathLength(2), voteWithPathLength(3)] })).toBe(
      136 + 2 * 77 + 5 * 32,
    );
  });

  it('fails closed if serialized JSON bytes do not dominate the structural estimate', () => {
    expect(() =>
      validateGuestWorkBudget({ ...EMPTY_INPUT, votes: [voteWithPathLength(1)] }, { serializedInputBytes: 0 }),
    ).toThrow('zkVM serialized JSON byte count must dominate structural byte estimate');
  });

  it('proves the current host JSON wire dominates the structural byte estimate for minimal values', () => {
    const input: ZkVMInput = {
      electionId: '00000000-0000-4000-8000-000000000000',
      bulletinRoot: '0x' + '01'.repeat(32),
      treeSize: 1,
      logId: '0x' + '00'.repeat(32),
      timestamp: 1,
      totalExpected: 1,
      electionConfigHash: '0x' + '00'.repeat(32),
      votes: [
        {
          commitment: '0x' + '00'.repeat(32),
          choice: 0,
          random: '0x' + '00'.repeat(32),
          index: 0,
          merklePath: ['0x' + '00'.repeat(32)],
        },
      ],
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(serializeZkvmAggregatorInput(input), null, 2), 'utf8');

    expect(serializedBytes).toBeGreaterThan(calculateStructuralInputBytes(input));
    expect(() => validateGuestWorkBudget(input, { serializedInputBytes: serializedBytes })).not.toThrow();
  });
});
