/**
 * Focused hashing invariants for the current zkVM contract.
 * Exact TypeScript/Rust field ownership lives in ts-rust-compatibility.test.ts.
 */

import {
  type ZkVMInput,
  createElectionId,
  computeCommitment,
  computeInputCommitment,
  computeInputCommitmentFromPublicInput,
  asUnixTimestampMillis,
  computeSTHDigest,
} from '../types';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const withBufferUnavailable = <T>(fn: () => T): T => {
  const globals = globalThis as Record<string, unknown>;
  const originalBuffer = globals['Buffer'];
  try {
    globals['Buffer'] = undefined;
    return fn();
  } finally {
    globals['Buffer'] = originalBuffer;
  }
};

describe('ZkVMInput', () => {
  describe('commitment domain separation', () => {
    it('should reject odd-length random hex', () => {
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const choice = 2;
      const random = '0x' + 'a'.repeat(63);

      expect(() => computeCommitment(electionId, choice, random)).toThrow(/odd length/i);
    });

    it('should compute hashes without Node Buffer', () => {
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const commitmentInput: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 1,
        logId: '0x' + '2'.repeat(64),
        timestamp: 1_700_000_000_000,
        totalExpected: 1,
        electionConfigHash: '0x' + '3'.repeat(64),
        votes: [
          {
            commitment: '0x' + '4'.repeat(64),
            choice: 0,
            random: '0x' + '5'.repeat(64),
            index: 0,
            merklePath: [],
          },
        ],
      };

      const result = withBufferUnavailable(() => {
        return {
          commitment: computeCommitment(electionId, 2, '0x' + 'a'.repeat(64)),
          inputCommitment: computeInputCommitment(commitmentInput),
          sthDigest: computeSTHDigest(
            commitmentInput.logId,
            commitmentInput.treeSize,
            asUnixTimestampMillis(commitmentInput.timestamp),
            commitmentInput.bulletinRoot,
          ),
        };
      });

      expect(result.commitment).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(result.inputCommitment).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(result.sthDigest).toMatch(/^0x[0-9a-f]{64}$/i);
    });
  });
});

describe('inputCommitment calculation', () => {
  it('should apply canonical vote ordering before hashing (MUST requirement)', () => {
    const input: ZkVMInput = {
      electionId: createElectionId(),
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 3,
      logId: '0x' + '2'.repeat(64),
      timestamp: 1_234_567_890_000,
      totalExpected: 3,
      electionConfigHash: '0x' + '3'.repeat(64),
      votes: [
        {
          commitment: '0x' + 'a'.repeat(64),
          choice: 0,
          random: '0x' + 'b'.repeat(64),
          index: 2, // Out of order
          merklePath: [],
        },
        {
          commitment: '0x' + 'c'.repeat(64),
          choice: 1,
          random: '0x' + 'd'.repeat(64),
          index: 0, // First
          merklePath: [],
        },
        {
          commitment: '0x' + 'e'.repeat(64),
          choice: 2,
          random: '0x' + 'f'.repeat(64),
          index: 1, // Middle
          merklePath: [],
        },
      ],
    };

    const commitment1 = computeInputCommitment(input);

    // Reorder votes
    input.votes = [strictDefined(input.votes[1]), strictDefined(input.votes[2]), strictDefined(input.votes[0])]; // Now in order: 0, 1, 2
    const commitment2 = computeInputCommitment(input);

    // Both should produce the same commitment due to canonical ordering.
    expect(commitment1).toBe(commitment2);
  });

  it('should deterministically order duplicate indices using commitment and merklePath tie-breaks', () => {
    const input = {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 8,
      totalExpected: 3,
    };

    const voteA = {
      index: 3,
      commitment: '0x' + '2'.repeat(64),
      merklePath: ['0x' + '4'.repeat(64)],
    };
    const voteB = {
      index: 3,
      commitment: '0x' + '1'.repeat(64),
      merklePath: ['0x' + '5'.repeat(64)],
    };
    const voteC = {
      index: 3,
      commitment: '0x' + '1'.repeat(64),
      merklePath: ['0x' + '3'.repeat(64)],
    };

    const commitment1 = computeInputCommitmentFromPublicInput({
      ...input,
      votes: [voteA, voteB, voteC],
    });
    const commitment2 = computeInputCommitmentFromPublicInput({
      ...input,
      votes: [voteC, voteA, voteB],
    });

    expect(commitment1).toBe('0xd097e151b6e9e86146be5af1a0d0df53512898f675a33bc28e88e90612181f60');
    expect(commitment2).toBe('0xd097e151b6e9e86146be5af1a0d0df53512898f675a33bc28e88e90612181f60');
  });
});
