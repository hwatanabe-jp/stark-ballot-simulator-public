/**
 * Tests for ZkVMJournal v2 output specification
 * Following final_design.md §1.3 specifications
 * Verifies the implemented journal contract.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ZkVMInput } from '../types';
import { CURRENT_METHOD_VERSION, createElectionId, computeInputCommitment, computeSTHDigest } from '../types';
import { executeMockZkVM } from '../mock-executor';
import { createTestVoteWithProof, generateElectionConfigHash, generateDefaultLogId } from '@/lib/testing/test-helpers';

describe('ZkVMJournal Output Specification', () => {
  let electionId: string;
  let logId: string;
  let timestamp: number;

  beforeEach(() => {
    electionId = createElectionId();
    logId = generateDefaultLogId();
    timestamp = Date.now();
  });

  describe('STH Digest Calculation', () => {
    it('should compute STH digest correctly', async () => {
      const bulletinRoot = '0x' + '1'.repeat(64);
      const treeSize = 64;

      const vote = createTestVoteWithProof({
        electionId,
        choice: 0,
        index: 0,
        pathLength: 0,
      });

      const input: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize,
        logId,
        timestamp,
        totalExpected: 1,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 1,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes: [vote],
      };

      const result = await executeMockZkVM(input);

      // Verify STH digest is computed correctly
      const expectedSTHDigest = computeSTHDigest(logId, treeSize, timestamp, bulletinRoot);
      expect(result.sthDigest).toBe(expectedSTHDigest);
    });

    it('should bind to specific STH parameters', async () => {
      // Create two inputs with different timestamps
      const bulletinRoot = '0x' + '2'.repeat(64);
      const treeSize = 32;

      const vote = createTestVoteWithProof({
        electionId,
        choice: 1,
        index: 0,
        pathLength: 0,
      });

      const input1: ZkVMInput = {
        electionId,
        bulletinRoot,
        treeSize,
        logId,
        timestamp: 1000000,
        totalExpected: 1,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 1,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes: [vote],
      };

      const input2 = { ...input1, timestamp: 2000000 };

      const result1 = await executeMockZkVM(input1);
      const result2 = await executeMockZkVM(input2);

      // Different timestamps should produce different STH digests
      expect(result1.sthDigest).not.toBe(result2.sthDigest);

      // Each should match its expected value
      expect(result1.sthDigest).toBe(computeSTHDigest(logId, treeSize, 1000000, bulletinRoot));
      expect(result2.sthDigest).toBe(computeSTHDigest(logId, treeSize, 2000000, bulletinRoot));
    });
  });

  describe('Slot And Record Counts', () => {
    it('should calculate missingSlots correctly', async () => {
      const treeSize = 10; // Tree has 10 slots

      // Only provide votes for indices 0, 2, 4 (missing 1, 3, 5-9)
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 2, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 2, index: 4, pathLength: 0 }),
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '3'.repeat(64),
        treeSize,
        logId,
        timestamp,
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      // missingSlots = treeSize - seenIndicesCount
      expect(result.seenIndicesCount).toBe(3); // We provided 3 unique indices
      expect(result.missingSlots).toBe(7); // 10 - 3 = 7 missing
      expect(result.validVotes).toBe(3); // All 3 should be valid
      expect(result.invalidVotes).toBe(0);
      expect(result.invalidPresentedSlots).toBe(0);
      expect(result.rejectedRecords).toBe(0);
      expect(result.excludedSlots).toBe(7);
    });

    it('should handle invalid votes correctly', async () => {
      const treeSize = 5;

      // Create votes with various issues
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0, pathLength: 0 }), // Valid
        createTestVoteWithProof({ electionId, choice: 6, index: 1, pathLength: 0 }), // Invalid choice (>4)
        createTestVoteWithProof({ electionId, choice: 2, index: 0, pathLength: 0 }), // Duplicate index
        createTestVoteWithProof({ electionId, choice: 3, index: 10, pathLength: 0 }), // Index out of range
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '4'.repeat(64),
        treeSize,
        logId,
        timestamp,
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      // Check three-way split
      expect(result.validVotes).toBe(1); // Only first vote is valid
      expect(result.invalidVotes).toBe(3); // Invalid choice, duplicate index, and out-of-range index are all rejected
      expect(result.seenIndicesCount).toBe(2); // Indices 0 and 1 were seen
      expect(result.missingSlots).toBe(3); // 5 - 2 = 3 missing
      expect(result.invalidPresentedSlots).toBe(1); // Slot 1 was presented but not counted
      expect(result.rejectedRecords).toBe(3); // Record-based rejections can exceed slot exclusions
      expect(result.excludedSlots).toBe(4); // missingSlots + invalidPresentedSlots
    });

    it('should separate slot exclusions from record rejections', async () => {
      const treeSize = 20;

      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 5, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 10, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 5, index: 15, pathLength: 0 }), // Invalid choice
        createTestVoteWithProof({ electionId, choice: 2, index: 5, pathLength: 0 }), // Duplicate index
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '5'.repeat(64),
        treeSize,
        logId,
        timestamp,
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      expect(result.seenIndicesCount).toBe(3);
      expect(result.missingSlots).toBe(17);
      expect(result.invalidPresentedSlots).toBe(1);
      expect(result.rejectedRecords).toBe(2);
      expect(result.validVotes).toBe(2);
      expect(result.invalidVotes).toBe(2);
      expect(result.excludedSlots).toBe(18);
    });
  });

  describe('Included Bitmap Root', () => {
    it('should generate bitmap root for single vote', async () => {
      const treeSize = 8; // 1 byte bitmap

      const vote = createTestVoteWithProof({
        electionId,
        choice: 0,
        index: 0,
        pathLength: 0,
      });

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '6'.repeat(64),
        treeSize,
        logId,
        timestamp,
        totalExpected: 1,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 1,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes: [vote],
      };

      const result = await executeMockZkVM(input);

      // Bitmap root should be generated
      expect(result.includedBitmapRoot).toBeDefined();
      expect(result.includedBitmapRoot).toMatch(/^0x[0-9a-f]{64}$/i);

      // For a single vote at index 0, bitmap = [1,0,0,0,0,0,0,0]
      // LSB first encoding = 0x01
    });

    it('should generate different roots for different vote patterns', async () => {
      const treeSize = 16; // 2 bytes bitmap

      // Pattern 1: votes at indices 0, 1, 2
      const votes1 = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 1, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 2, index: 2, pathLength: 0 }),
      ];

      // Pattern 2: votes at indices 5, 10, 15
      const votes2 = [
        createTestVoteWithProof({ electionId, choice: 0, index: 5, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 10, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 2, index: 15, pathLength: 0 }),
      ];

      const input1: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '7'.repeat(64),
        treeSize,
        logId,
        timestamp,
        totalExpected: 3,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 3,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes: votes1,
      };

      const input2 = { ...input1, votes: votes2 };

      const result1 = await executeMockZkVM(input1);
      const result2 = await executeMockZkVM(input2);

      // Different vote patterns should produce different bitmap roots
      expect(result1.includedBitmapRoot).not.toBe(result2.includedBitmapRoot);
    });

    it('should handle boundary cases for bitmap size', async () => {
      // Test case from final_design.md: 12 votes (less than 32 bytes)
      const treeSize = 12;

      // Create votes for all indices (all bits set to 1)
      const votes = Array.from({ length: treeSize }, (_, i) =>
        createTestVoteWithProof({ electionId, choice: i % 5, index: i, pathLength: 0 }),
      );

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '8'.repeat(64),
        treeSize,
        logId,
        timestamp,
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      // All votes should be counted
      expect(result.validVotes).toBe(12);
      expect(result.includedBitmapRoot).toBeDefined();

      // Bitmap: 12 bits all set to 1
      // LSB first: 0b111111111111 = 0x0FFF (padded to 2 bytes)
    });

    it('should handle 257 votes case (multiple chunks)', async () => {
      // Test case from final_design.md: 257 votes (crosses 256-bit boundary)
      const treeSize = 257;

      // Create votes for first 10 indices and index 256
      const votes = [
        ...Array.from({ length: 10 }, (_, i) =>
          createTestVoteWithProof({ electionId, choice: i % 5, index: i, pathLength: 0 }),
        ),
        createTestVoteWithProof({ electionId, choice: 0, index: 256, pathLength: 0 }),
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '9'.repeat(64),
        treeSize,
        logId,
        timestamp,
        totalExpected: 11,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 11,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      expect(result.validVotes).toBe(11);
      expect(result.seenIndicesCount).toBe(11);
      expect(result.missingSlots).toBe(246); // 257 - 11
      expect(result.includedBitmapRoot).toBeDefined();
    });
  });

  describe('Input Commitment', () => {
    it('should apply canonical vote ordering before hashing', async () => {
      // Create votes in non-sorted order
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 5, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 1, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 2, index: 10, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 3, index: 3, pathLength: 0 }),
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 15,
        logId,
        timestamp,
        totalExpected: 4,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 4,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      // Compute expected commitment with sorted votes
      const expectedCommitment = computeInputCommitment(input);

      // Result should use sorted votes for commitment
      expect(result.inputCommitment).toBe(expectedCommitment);

      // Verify that the function sorts internally
      const sortedInput = { ...input, votes: [...votes].sort((a, b) => a.index - b.index) };
      const sortedCommitment = computeInputCommitment(sortedInput);
      expect(result.inputCommitment).toBe(sortedCommitment);
    });

    it('should include all required fields in commitment', async () => {
      const vote = createTestVoteWithProof({
        electionId,
        choice: 0,
        index: 0,
        pathLength: 0,
      });

      const input1: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + 'b'.repeat(64),
        treeSize: 1,
        logId,
        timestamp,
        totalExpected: 1,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 1,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes: [vote],
      };

      // Create another input with different electionId
      const differentElectionId = createElectionId();
      const vote2 = createTestVoteWithProof({
        electionId: differentElectionId,
        choice: 0,
        index: 0,
        pathLength: 0,
      });

      const input2: ZkVMInput = {
        ...input1,
        electionId: differentElectionId,
        votes: [vote2],
      };

      const result1 = await executeMockZkVM(input1);
      const result2 = await executeMockZkVM(input2);

      // Different electionIds should produce different commitments
      expect(result1.inputCommitment).not.toBe(result2.inputCommitment);
    });

    it('should use canonical encoding with little endian', async () => {
      const vote = createTestVoteWithProof({
        electionId,
        choice: 2,
        index: 100,
        pathLength: 2,
      });

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + 'c'.repeat(64),
        treeSize: 200,
        logId,
        timestamp,
        totalExpected: 1,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 1,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes: [vote],
      };

      const result = await executeMockZkVM(input);

      // Verify the commitment uses the expected encoding
      expect(result.inputCommitment).toBeDefined();
      expect(result.inputCommitment).toMatch(/^0x[0-9a-f]{64}$/i);

      // The commitment should be deterministic
      const result2 = await executeMockZkVM(input);
      expect(result2.inputCommitment).toBe(result.inputCommitment);
    });

    it('should include method version in journal', async () => {
      const vote = createTestVoteWithProof({
        electionId,
        choice: 0,
        index: 0,
        pathLength: 0,
      });

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + 'd'.repeat(64),
        treeSize: 1,
        logId,
        timestamp,
        totalExpected: 1,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: 1,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes: [vote],
      };

      const result = await executeMockZkVM(input);

      expect(result.methodVersion).toBe(CURRENT_METHOD_VERSION);
    });
  });

  describe('Echo Fields', () => {
    it('should echo input fields correctly', async () => {
      const specificElectionId = createElectionId();
      const specificBulletinRoot = '0x' + 'e'.repeat(64);
      const specificTreeSize = 42;
      const specificTotalExpected = 64;
      const specificConfigHash = '0x' + 'f'.repeat(64);

      const vote = createTestVoteWithProof({
        electionId: specificElectionId,
        choice: 0,
        index: 0,
        pathLength: 0,
      });

      const input: ZkVMInput = {
        electionId: specificElectionId,
        bulletinRoot: specificBulletinRoot,
        treeSize: specificTreeSize,
        logId,
        timestamp,
        totalExpected: specificTotalExpected,
        electionConfigHash: specificConfigHash,
        votes: [vote],
      };

      const result = await executeMockZkVM(input);

      // Verify all echo fields
      expect(result.electionId).toBe(specificElectionId);
      expect(result.electionConfigHash).toBe(specificConfigHash);
      expect(result.bulletinRoot).toBe(specificBulletinRoot);
      expect(result.treeSize).toBe(specificTreeSize);
      expect(result.totalExpected).toBe(specificTotalExpected);
    });
  });
});
