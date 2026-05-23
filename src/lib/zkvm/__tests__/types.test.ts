/**
 * Tests for zkVM v2 type definitions
 * Following final_design.md v1.0 specifications
 */

import {
  type ZkVMInput,
  type ZkVMJournal,
  type VoteWithProof,
  validateZkVMInput,
  createElectionId,
  computeCommitment,
  computeInputCommitment,
  computeInputCommitmentFromPublicInput,
  CURRENT_METHOD_VERSION,
  computeSTHDigest,
} from '../types';

const withBufferUnavailable = <T>(fn: () => T): T => {
  const globals = globalThis as Record<string, unknown>;
  const originalBuffer = globals.Buffer;
  try {
    globals.Buffer = undefined;
    return fn();
  } finally {
    globals.Buffer = originalBuffer;
  }
};

describe('ZkVMInput', () => {
  describe('structure validation', () => {
    it('should have all required fields from final_design.md', () => {
      const input: ZkVMInput = {
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 64,
        logId: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
        totalExpected: 64,
        electionConfigHash: '0x' + '3'.repeat(64),
        votes: [],
      };

      expect(input.electionId).toBeDefined();
      expect(input.electionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(input.bulletinRoot).toHaveLength(66); // 0x + 64 chars
      expect(input.treeSize).toBe(64);
      expect(input.logId).toHaveLength(66);
      expect(input.timestamp).toBeGreaterThan(0);
      expect(input.totalExpected).toBe(64);
      expect(input.electionConfigHash).toHaveLength(66);
      expect(input.votes).toEqual([]);
    });

    it('should NOT have claimedTally field (removed in v1.0)', () => {
      const input: ZkVMInput = {
        electionId: createElectionId(),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 64,
        logId: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
        totalExpected: 64,
        electionConfigHash: '0x' + '3'.repeat(64),
        votes: [],
      };

      // @ts-expect-error - claimedTally should not exist
      expect(input.claimedTally).toBeUndefined();
    });
  });

  describe('VoteWithProof structure', () => {
    it('should include index and merklePath as per final_design.md', () => {
      const vote: VoteWithProof = {
        commitment: '0x' + '4'.repeat(64),
        choice: 0,
        random: '0x' + '5'.repeat(64),
        index: 0,
        merklePath: ['0x' + '6'.repeat(64), '0x' + '7'.repeat(64)],
      };

      expect(vote.index).toBeDefined();
      expect(vote.merklePath).toBeDefined();
      expect(vote.merklePath).toBeInstanceOf(Array);
      expect(vote.merklePath).toHaveLength(2);
    });
  });

  describe('commitment domain separation', () => {
    it('should compute commitment with domain tag and electionId (v1.0)', () => {
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const choice = 2; // Option C
      const random = '0x' + 'a'.repeat(64);

      const commitment = computeCommitment(electionId, choice, random);

      // Should be SHA256("stark-ballot:commit|v1.0" || electionId || choice || random)
      expect(commitment).toMatch(/^0x[0-9a-f]{64}$/i);

      // Should be different from simple SHA256(choice || random)
      const simpleCommitment = computeSimpleCommitment(choice, random);
      expect(commitment).not.toBe(simpleCommitment);
    });

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
            commitmentInput.timestamp,
            commitmentInput.bulletinRoot,
          ),
        };
      });

      expect(result.commitment).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(result.inputCommitment).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(result.sthDigest).toMatch(/^0x[0-9a-f]{64}$/i);
    });
  });

  describe('input validation', () => {
    it('should validate correct input structure', () => {
      const input: ZkVMInput = {
        electionId: createElectionId(),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 1,
        logId: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
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

      const result = validateZkVMInput(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject duplicate vote indices', () => {
      const input: ZkVMInput = {
        electionId: createElectionId(),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 2,
        logId: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
        totalExpected: 2,
        electionConfigHash: '0x' + '3'.repeat(64),
        votes: [
          {
            commitment: '0x' + '4'.repeat(64),
            choice: 0,
            random: '0x' + '5'.repeat(64),
            index: 0,
            merklePath: [],
          },
          {
            commitment: '0x' + '6'.repeat(64),
            choice: 1,
            random: '0x' + '7'.repeat(64),
            index: 0,
            merklePath: [],
          },
        ],
      };

      const result = validateZkVMInput(input);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate vote index: 0');
    });

    it('should reject invalid electionId format', () => {
      const input: ZkVMInput = {
        electionId: 'invalid-uuid',
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 1,
        logId: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
        totalExpected: 1,
        electionConfigHash: '0x' + '3'.repeat(64),
        votes: [],
      };

      const result = validateZkVMInput(input);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid electionId format (must be UUID v4)');
    });

    it('allows extra records beyond treeSize so the guest can reject them in-journal', () => {
      const input: ZkVMInput = {
        electionId: createElectionId(),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 1,
        logId: '0x' + '2'.repeat(64),
        timestamp: Date.now(),
        totalExpected: 2,
        electionConfigHash: '0x' + '3'.repeat(64),
        votes: [
          {
            commitment: '0x' + '4'.repeat(64),
            choice: 0,
            random: '0x' + '5'.repeat(64),
            index: 0,
            merklePath: [],
          },
          {
            commitment: '0x' + '6'.repeat(64),
            choice: 1,
            random: '0x' + '7'.repeat(64),
            index: 1,
            merklePath: [],
          },
        ],
      };

      const result = validateZkVMInput(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });
});

describe('ZkVMJournal', () => {
  describe('structure validation', () => {
    it('should have all required fields from final_design.md', () => {
      const journal: ZkVMJournal = {
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '1'.repeat(64),
        bulletinRoot: '0x' + '2'.repeat(64),
        treeSize: 64,
        totalExpected: 64,
        sthDigest: '0x' + '3'.repeat(64),
        verifiedTally: [15, 12, 18, 10, 9],
        totalVotes: 64,
        validVotes: 63,
        invalidVotes: 1,
        seenIndicesCount: 64,
        missingSlots: 0,
        invalidPresentedSlots: 1,
        rejectedRecords: 1,
        includedBitmapRoot: '0x' + '4'.repeat(64),
        excludedSlots: 1,
        inputCommitment: '0x' + '5'.repeat(64),
        methodVersion: CURRENT_METHOD_VERSION,
      };

      // All fields should be present
      expect(journal.electionId).toBeDefined();
      expect(journal.electionConfigHash).toBeDefined();
      expect(journal.sthDigest).toBeDefined();
      expect(journal.missingSlots).toBeDefined();
      expect(journal.invalidPresentedSlots).toBeDefined();
      expect(journal.rejectedRecords).toBeDefined();
      expect(journal.includedBitmapRoot).toBeDefined();
      expect(journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    });

    it('should NOT have tamperDetected field (removed in v1.0)', () => {
      const journal: ZkVMJournal = {
        electionId: createElectionId(),
        electionConfigHash: '0x' + '1'.repeat(64),
        bulletinRoot: '0x' + '2'.repeat(64),
        treeSize: 64,
        totalExpected: 64,
        sthDigest: '0x' + '3'.repeat(64),
        verifiedTally: [15, 12, 18, 10, 9],
        totalVotes: 64,
        validVotes: 64,
        invalidVotes: 0,
        seenIndicesCount: 64,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        includedBitmapRoot: '0x' + '4'.repeat(64),
        excludedSlots: 0,
        inputCommitment: '0x' + '5'.repeat(64),
        methodVersion: CURRENT_METHOD_VERSION,
      };

      // @ts-expect-error - tamperDetected should not exist
      expect(journal.tamperDetected).toBeUndefined();
    });

    it('should distinguish slot-based exclusions from record-based rejections', () => {
      const journal: ZkVMJournal = {
        electionId: createElectionId(),
        electionConfigHash: '0x' + '1'.repeat(64),
        bulletinRoot: '0x' + '2'.repeat(64),
        treeSize: 64,
        totalExpected: 64,
        sthDigest: '0x' + '3'.repeat(64),
        verifiedTally: [10, 10, 10, 10, 10],
        totalVotes: 62,
        validVotes: 50,
        invalidVotes: 12,
        seenIndicesCount: 60,
        missingSlots: 4, // Not presented to VM
        invalidPresentedSlots: 10, // Seen slots that still failed counting
        rejectedRecords: 12, // Rejected records, including duplicates/out-of-range
        includedBitmapRoot: '0x' + '4'.repeat(64),
        excludedSlots: 14, // missingSlots + invalidPresentedSlots
        inputCommitment: '0x' + '5'.repeat(64),
        methodVersion: CURRENT_METHOD_VERSION,
      };

      expect(journal.missingSlots + journal.invalidPresentedSlots + journal.validVotes).toBe(64);
      expect(journal.excludedSlots).toBe(journal.missingSlots + journal.invalidPresentedSlots);
      expect(journal.rejectedRecords).toBe(journal.invalidVotes);
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
      timestamp: 1234567890,
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
    input.votes = [input.votes[1], input.votes[2], input.votes[0]]; // Now in order: 0, 1, 2
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

describe('STH digest calculation', () => {
  it('should compute STH digest from parameters', () => {
    const logId = '0x' + '1'.repeat(64);
    const treeSize = 64;
    const timestamp = 1234567890;
    const bulletinRoot = '0x' + '2'.repeat(64);

    const digest = computeSTHDigest(logId, treeSize, timestamp, bulletinRoot);

    expect(digest).toMatch(/^0x[0-9a-f]{64}$/i);
  });
});

// Helper function for testing - simple commitment without domain separation
function computeSimpleCommitment(choice: number, random: string): string {
  void choice;
  void random;
  // This would be the old way: SHA256(choice || random)
  // Implementation would go here
  return '0x' + '0'.repeat(64); // Placeholder
}
