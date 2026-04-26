/**
 * Enhanced input validation tests for zkVM v2
 * t-wada's approach: RED Phase - Writing failing tests first
 * Requirements from final_design.md §1.2 and §2.4
 */

import { type ZkVMInput, type VoteWithProof, createElectionId, computeCommitment } from '../types';
import { createTestInput, generateElectionConfigHash, generateRandomBytes32 } from '@/lib/testing/test-helpers';

// Import the validator that we'll implement
import { validateZkVMInputEnhanced } from '../input-validator';

describe('Enhanced ZkVMInput Validation', () => {
  describe('Election ID validation', () => {
    it('should accept valid UUID v4', () => {
      const input = createTestInput();
      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(true);
      expect(result.errors).not.toContain(expect.stringMatching(/electionId/));
    });

    it('should reject UUID v1 (not v4)', () => {
      const input = createTestInput();
      input.electionId = 'e9f6d32e-c585-11eb-b8bc-0242ac130003'; // UUID v1

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid electionId: must be UUID v4');
    });

    it('should reject malformed UUID', () => {
      const input = createTestInput();
      input.electionId = '550e8400-e29b-XXXX-a716-446655440000'; // Invalid hex

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid electionId: must be UUID v4');
    });
  });

  describe('STH parameters validation', () => {
    it('should validate logId format (32 bytes hex)', () => {
      const input = createTestInput();
      input.logId = '0x' + 'g'.repeat(64); // Invalid hex character

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid logId: must be 32 bytes hex');
    });

    it('should validate timestamp is reasonable', () => {
      const input = createTestInput();
      input.timestamp = -1; // Invalid timestamp

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid timestamp: must be positive Unix timestamp');
    });

    it('should reject future timestamps (>1 hour ahead)', () => {
      const input = createTestInput();
      input.timestamp = Date.now() + 2 * 60 * 60 * 1000; // 2 hours in future

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid timestamp: too far in the future');
    });
  });

  describe('Tree size and vote count constraints', () => {
    it('should not fail solely because votes.length exceeds treeSize', () => {
      const input = createTestInput({ voteCount: 10, treeSize: 5 });

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).not.toContain('Constraint violation: votes.length (10) > treeSize (5)');
      expect(result.errors).toContain('Invalid index at vote 5: must be < treeSize');
    });

    it('should validate treeSize is positive', () => {
      const input = createTestInput();
      input.treeSize = 0;

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid treeSize: must be positive');
    });

    it('should validate totalExpected matches electionConfigHash', () => {
      const input = createTestInput({ totalExpected: 64 });
      // Tamper with totalExpected after config hash generation
      input.totalExpected = 100;

      const result = validateZkVMInputEnhanced(input, {
        computeElectionConfigHash: (candidate) =>
          generateElectionConfigHash({ totalExpected: candidate.totalExpected }),
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('totalExpected does not match electionConfigHash');
    });
  });

  describe('Vote validation', () => {
    it('should validate choice boundaries (0-4)', () => {
      const input = createTestInput({ voteCount: 1 });
      input.votes[0].choice = 5; // Out of bounds

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid choice at vote 0: must be 0-4');
    });

    it('should validate vote index is within treeSize', () => {
      const input = createTestInput({ voteCount: 1, treeSize: 10 });
      input.votes[0].index = 10; // Equal to treeSize (should be <)

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid index at vote 0: must be < treeSize');
    });

    it('should detect duplicate vote indices', () => {
      const input = createTestInput({ voteCount: 2 });
      input.votes[0].index = 5;
      input.votes[1].index = 5; // Duplicate

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate vote index: 5');
    });

    it('should validate commitment matches recomputed value', () => {
      const input = createTestInput({ voteCount: 1 });
      const vote = input.votes[0];

      // Tamper with commitment
      vote.commitment = generateRandomBytes32();

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid commitment at vote 0: does not match computed value');
    });

    it('should validate merkle path depth for tree size', () => {
      const input = createTestInput({ voteCount: 1, treeSize: 64 });
      // For 64 leaves, we need ceil(log2(64)) = 6 path nodes
      input.votes[0].merklePath = [generateRandomBytes32(), generateRandomBytes32(), generateRandomBytes32()]; // Only 3 nodes instead of 6

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid merkle path at vote 0: expected depth 6, got 3');
    });

    it('should validate merkle path node format', () => {
      const input = createTestInput({ voteCount: 1 });
      input.votes[0].merklePath = [
        '0x' + 'z'.repeat(64), // Invalid hex
        generateRandomBytes32(),
      ];

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid merkle path node at vote 0, node 0');
    });
  });

  describe('Commitment domain separation validation', () => {
    it('should validate commitment includes electionId (v1.0 requirement)', () => {
      const electionId = createElectionId();
      const choice = 2;
      const random = generateRandomBytes32();

      // const correctCommitment = computeCommitment(electionId, choice, random)

      // Create vote with wrong electionId in commitment
      const differentElectionId = createElectionId();
      const wrongCommitment = computeCommitment(differentElectionId, choice, random);

      const vote: VoteWithProof = {
        commitment: wrongCommitment,
        choice,
        random,
        index: 0,
        merklePath: [],
      };

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: generateRandomBytes32(),
        treeSize: 1,
        logId: generateRandomBytes32(),
        timestamp: Date.now(),
        totalExpected: 1,
        electionConfigHash: generateRandomBytes32(),
        votes: [vote],
      };

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid commitment at vote 0: does not match computed value');
    });
  });

  describe('Complete input validation', () => {
    it('should accept a fully valid input', () => {
      const input = createTestInput({ voteCount: 64, treeSize: 64, totalExpected: 64 });

      // Ensure all votes have proper commitments
      input.votes.forEach((vote, i) => {
        vote.commitment = computeCommitment(input.electionId, vote.choice, vote.random);
        vote.index = i;
        vote.merklePath = Array(6)
          .fill(null)
          .map(() => generateRandomBytes32()); // Depth 6 for 64 leaves
      });

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should collect multiple validation errors', () => {
      const input = createTestInput({ voteCount: 2 });

      // Create multiple issues
      input.electionId = 'invalid-uuid';
      input.treeSize = -1;
      input.votes[0].choice = 10;
      input.votes[1].index = 1000;

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(3);
      expect(result.errors).toContain('Invalid electionId: must be UUID v4');
      expect(result.errors).toContain('Invalid treeSize: must be positive');
      expect(result.errors).toContain('Invalid choice at vote 0: must be 0-4');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty votes array', () => {
      const input = createTestInput({ voteCount: 0 });

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should handle single vote (treeSize = 1)', () => {
      const input = createTestInput({ voteCount: 1, treeSize: 1 });
      input.votes[0].merklePath = []; // No path needed for single leaf
      input.votes[0].commitment = computeCommitment(input.electionId, input.votes[0].choice, input.votes[0].random);

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should validate maximum tree size (practical limit)', () => {
      const input = createTestInput();
      input.treeSize = 1_000_001; // Over 1 million

      const result = validateZkVMInputEnhanced(input);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid treeSize: exceeds maximum (1000000)');
    });
  });
});
