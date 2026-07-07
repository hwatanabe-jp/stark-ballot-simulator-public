import { describe, expect, it } from 'vitest';
import { computeCommitment, type ZkVMInput } from '../types';
import { serializeZkvmAggregatorInput } from '../host-io';
import { assertZkvmWireNumericPreflight } from '../wire-numeric-preflight';

function createInput(): ZkVMInput {
  const electionId = '550e8400-e29b-41d4-a716-446655440000';
  const random = '0x' + '11'.repeat(32);
  return {
    electionId,
    bulletinRoot: '0x' + '22'.repeat(32),
    treeSize: 1,
    logId: '0x' + '33'.repeat(32),
    timestamp: 1_725_000_000_000,
    totalExpected: 1,
    electionConfigHash: '0x' + '44'.repeat(32),
    votes: [
      {
        commitment: computeCommitment(electionId, 0, random),
        choice: 0,
        random,
        index: 0,
        merklePath: [],
      },
    ],
  };
}

describe('zkVM Rust wire numeric preflight', () => {
  it.each([
    ['treeSize', Number.NaN, 'treeSize must be finite'],
    ['treeSize', 1.5, 'treeSize must be an integer'],
    ['treeSize', Number.MAX_SAFE_INTEGER + 1, 'treeSize must be a JavaScript safe integer'],
    ['treeSize', -1, 'treeSize must be non-negative'],
    ['treeSize', 0x1_0000_0000, 'treeSize exceeds Rust wire maximum 4294967295'],
    ['totalExpected', 0x1_0000_0000, 'totalExpected exceeds Rust wire maximum 4294967295'],
    ['timestamp', Number.MAX_SAFE_INTEGER + 1, 'timestamp must be a JavaScript safe integer'],
    ['timestamp', 0, 'timestamp must be positive Unix timestamp milliseconds'],
  ] as const)('rejects malformed top-level numeric field %s', (field, value, message) => {
    const input = createInput();
    input[field] = value;

    expect(() => assertZkvmWireNumericPreflight(input)).toThrow(message);
  });

  it.each([
    ['choice', -1, 'votes[0].choice must be non-negative'],
    ['choice', 256, 'votes[0].choice exceeds Rust wire maximum 255'],
    ['choice', Number.NaN, 'votes[0].choice must be finite'],
    ['index', -1, 'votes[0].index must be non-negative'],
    ['index', 0x1_0000_0000, 'votes[0].index exceeds Rust wire maximum 4294967295'],
  ] as const)('rejects malformed vote numeric field %s', (field, value, message) => {
    const input = createInput();
    const vote = input.votes[0];
    if (!vote) {
      throw new Error('test input missing vote');
    }
    vote[field] = value;

    expect(() => assertZkvmWireNumericPreflight(input)).toThrow(message);
  });

  it('allows guest-level invalid record outcomes when they fit Rust wire types', () => {
    const input = createInput();
    const vote = input.votes[0];
    if (!vote) {
      throw new Error('test input missing vote');
    }
    vote.choice = 5;
    vote.index = 2;

    expect(() => assertZkvmWireNumericPreflight(input)).not.toThrow();
    expect(serializeZkvmAggregatorInput(input).votes[0]?.choice).toBe(5);
  });

  it('keeps duplicate indices wire-representable for guest accounting', () => {
    const input = createInput();
    const firstVote = input.votes[0];
    if (!firstVote) {
      throw new Error('test input missing vote');
    }

    input.votes.push({
      ...firstVote,
      commitment: computeCommitment(input.electionId, 1, firstVote.random),
      choice: 1,
      index: firstVote.index,
    });

    expect(() => assertZkvmWireNumericPreflight(input)).not.toThrow();

    const serialized = serializeZkvmAggregatorInput(input);
    expect(serialized.votes.map((vote) => vote.index)).toEqual([0, 0]);
  });
});
