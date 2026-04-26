/**
 * Tests for MockZkVM executor
 * Following final_design.md v1.0 specifications
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ZkVMInput, VoteWithProof } from '../types';
import { createElectionId, computeCommitment, computeInputCommitment, computeSTHDigest } from '../types';
import { executeMockZkVM } from '../mock-executor';
import { createTestVoteWithProof, generateElectionConfigHash, generateDefaultLogId } from '@/lib/testing/test-helpers';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { computeIncludedBitmapRoot } from '@/lib/zkvm/bitmap';

describe('MockZkVM Executor', () => {
  let electionId: string;
  let basicInput: ZkVMInput;
  let originalExpectedImageId: string | undefined;

  beforeEach(() => {
    originalExpectedImageId = process.env.EXPECTED_IMAGE_ID;
    electionId = createElectionId();

    // Create basic input with one vote
    const vote = createTestVoteWithProof({
      electionId,
      choice: 0, // Option A
      index: 0,
      pathLength: 0, // Single vote, no path needed
    });

    basicInput = {
      electionId,
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 1,
      logId: generateDefaultLogId(),
      timestamp: Date.now(),
      totalExpected: 1,
      electionConfigHash: generateElectionConfigHash({
        totalExpected: 1,
        choices: ['A', 'B', 'C', 'D', 'E'],
      }),
      votes: [vote],
    };
  });

  afterEach(() => {
    if (originalExpectedImageId === undefined) {
      delete process.env.EXPECTED_IMAGE_ID;
    } else {
      process.env.EXPECTED_IMAGE_ID = originalExpectedImageId;
    }
  });

  describe('Basic Functionality', () => {
    it('should process ZkVMInput and return ZkVMJournal', async () => {
      const result = await executeMockZkVM(basicInput);

      // Check structure
      expect(result).toBeDefined();
      expect(result.electionId).toBe(basicInput.electionId);
      expect(result.electionConfigHash).toBe(basicInput.electionConfigHash);
      expect(result.bulletinRoot).toBe(basicInput.bulletinRoot);
      expect(result.treeSize).toBe(basicInput.treeSize);
      expect(result.totalExpected).toBe(basicInput.totalExpected);
    });

    it('should NOT include tamperDetected field (removed in v1.0)', async () => {
      const result = await executeMockZkVM(basicInput);

      // @ts-expect-error - tamperDetected should not exist
      expect(result.tamperDetected).toBeUndefined();
    });

    it('should include the current methodVersion for the active journal layout', async () => {
      const result = await executeMockZkVM(basicInput);

      expect(result.methodVersion).toBe(CURRENT_METHOD_VERSION);
    });
  });

  describe('ImageID Resolution', () => {
    it('should use EXPECTED_IMAGE_ID when provided', async () => {
      process.env.EXPECTED_IMAGE_ID = '0x' + 'a'.repeat(64);

      const result = await executeMockZkVM(basicInput);

      expect(result.imageId).toBe(process.env.EXPECTED_IMAGE_ID);
    });

    it('should use the configured ImageID variant when no explicit ImageID override is set', async () => {
      delete process.env.EXPECTED_IMAGE_ID;
      const originalVariant = process.env.EXPECTED_IMAGE_ID_VARIANT;
      process.env.EXPECTED_IMAGE_ID_VARIANT = 'x86_64';

      const { getExpectedImageId, resetImageIdVerifierState } = await import('@/lib/verification/image-id-verifier');
      resetImageIdVerifierState();

      try {
        const result = await executeMockZkVM(basicInput);
        const expectedImageId = await getExpectedImageId(CURRENT_METHOD_VERSION, 'x86_64');

        expect(result.imageId).toBe(expectedImageId);
      } finally {
        resetImageIdVerifierState();
        if (originalVariant === undefined) {
          delete process.env.EXPECTED_IMAGE_ID_VARIANT;
        } else {
          process.env.EXPECTED_IMAGE_ID_VARIANT = originalVariant;
        }
      }
    });
  });

  describe('Domain-Separated Commitment Verification', () => {
    it('should verify commitments with domain separation (v1.0)', async () => {
      // Create vote with correct domain-separated commitment
      const choice = 2; // Option C
      const random = '0x' + 'a'.repeat(64);
      const commitment = computeCommitment(electionId, choice, random);

      const vote = {
        commitment,
        choice,
        random,
        index: 0,
        merklePath: [],
      };

      basicInput.votes = [vote];
      const result = await executeMockZkVM(basicInput);

      expect(result.validVotes).toBe(1);
      expect(result.invalidVotes).toBe(0);
      expect(result.verifiedTally[choice]).toBe(1);
    });

    it('should reject commitments without proper domain separation', async () => {
      // Create vote with incorrect commitment (without domain separation)
      const choice = 1;
      const random = '0x' + 'b'.repeat(64);

      // Wrong: simple SHA256(choice || random) instead of domain-separated
      const crypto = await import('crypto');
      const incorrectCommitment =
        '0x' +
        crypto
          .createHash('sha256')
          .update(Buffer.from([choice]))
          .update(Buffer.from(random.slice(2), 'hex'))
          .digest('hex');

      const vote = {
        commitment: incorrectCommitment,
        choice,
        random,
        index: 0,
        merklePath: [],
      };

      basicInput.votes = [vote];
      const result = await executeMockZkVM(basicInput);

      expect(result.validVotes).toBe(0);
      expect(result.invalidVotes).toBe(1);
      expect(result.verifiedTally[choice]).toBe(0);
    });
  });

  describe('Three-Way Split Statistics', () => {
    it('should calculate missingSlots correctly', async () => {
      // Set treeSize to 5 but only provide 3 votes
      basicInput.treeSize = 5;
      basicInput.totalExpected = 5;

      const votes = [0, 2, 4].map((index) =>
        createTestVoteWithProof({
          electionId,
          choice: 0,
          index,
          pathLength: 3,
        }),
      );

      basicInput.votes = votes;
      const result = await executeMockZkVM(basicInput);

      expect(result.seenIndicesCount).toBe(3);
      expect(result.missingSlots).toBe(2); // 5 - 3 = 2
      expect(result.invalidPresentedSlots).toBe(0);
      expect(result.validVotes).toBe(3);
    });

    it('should calculate invalidPresentedSlots for failed verification', async () => {
      // Create votes with invalid commitments
      const votes: VoteWithProof[] = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0 }),
        {
          commitment: '0xinvalid',
          choice: 1,
          random: '0x' + 'c'.repeat(64),
          index: 1,
          merklePath: [],
        },
        createTestVoteWithProof({ electionId, choice: 2, index: 2 }),
      ];

      basicInput.treeSize = 3;
      basicInput.totalExpected = 3;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      expect(result.seenIndicesCount).toBe(3);
      expect(result.missingSlots).toBe(0);
      expect(result.invalidPresentedSlots).toBe(1);
      expect(result.validVotes).toBe(2);
      expect(result.validVotes).toBe(2);
    });

    it('should handle duplicate indices as invalid', async () => {
      // Create votes with duplicate index
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 0 }), // Duplicate!
        createTestVoteWithProof({ electionId, choice: 2, index: 1 }),
      ];

      basicInput.treeSize = 2;
      basicInput.totalExpected = 2;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      expect(result.seenIndicesCount).toBe(2); // Only unique indices
      expect(result.invalidPresentedSlots).toBe(0); // Legacy alias now tracks slot-level failures only
      expect(result.rejectedRecords).toBe(1); // Duplicate record is rejected
      expect(result.excludedSlots).toBe(0); // No slot was excluded from counting
      expect(result.invalidVotes).toBe(1);
    });

    it('should count out-of-range indices as invalid presented records', async () => {
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 5 }), // Out of range
      ];

      basicInput.treeSize = 2;
      basicInput.totalExpected = 2;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      expect(result.seenIndicesCount).toBe(1);
      expect(result.missingSlots).toBe(1);
      expect(result.invalidPresentedSlots).toBe(0);
      expect(result.rejectedRecords).toBe(1);
      expect(result.excludedSlots).toBe(1);
      expect(result.invalidVotes).toBe(1);
      expect(result.validVotes).toBe(1);
    });

    it('should reject duplicate and out-of-range records without inflating slot-level failures', async () => {
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 0 }), // Duplicate index
        createTestVoteWithProof({ electionId, choice: 2, index: 1 }),
        createTestVoteWithProof({ electionId, choice: 3, index: 99 }), // Out of range
      ];

      basicInput.treeSize = 2;
      basicInput.totalExpected = 2;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      expect(result.seenIndicesCount).toBe(2);
      expect(result.missingSlots).toBe(0);
      expect(result.invalidPresentedSlots).toBe(0);
      expect(result.rejectedRecords).toBe(2);
      expect(result.excludedSlots).toBe(0);
      expect(result.validVotes).toBe(2);
      expect(result.invalidVotes).toBe(2);
    });
  });

  describe('STH Digest Computation', () => {
    it('should compute STH digest correctly', async () => {
      const result = await executeMockZkVM(basicInput);

      // Compute expected STH digest
      const expectedDigest = computeSTHDigest(
        basicInput.logId,
        basicInput.treeSize,
        basicInput.timestamp,
        basicInput.bulletinRoot,
      );

      expect(result.sthDigest).toBe(expectedDigest);
    });
  });

  describe('Input Commitment with Sorting', () => {
    it('should compute inputCommitment with votes sorted by index', async () => {
      // Create votes in non-sorted order
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 2 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 0 }),
        createTestVoteWithProof({ electionId, choice: 2, index: 1 }),
      ];

      basicInput.treeSize = 3;
      basicInput.totalExpected = 3;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      // The inputCommitment should be computed with sorted votes
      const expectedCommitment = computeInputCommitment(basicInput);
      expect(result.inputCommitment).toBe(expectedCommitment);
    });
  });

  describe('Included Bitmap Root', () => {
    it('should generate includedBitmapRoot for processed votes', async () => {
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 2 }),
        createTestVoteWithProof({ electionId, choice: 2, index: 4 }),
      ];

      basicInput.treeSize = 5;
      basicInput.totalExpected = 5;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      // Should have a valid hex string for bitmap root
      expect(result.includedBitmapRoot).toMatch(/^0x[0-9a-f]{64}$/i);

      // The bitmap should reflect which indices were counted
      // Indices 0, 2, 4 should be marked as included
      // This will be verified more thoroughly in integration tests
    });

    it('should match the canonical bitmap root implementation for included and seen bitmaps', async () => {
      const votes = [0, 2, 256].map((index) => createTestVoteWithProof({ electionId, choice: index % 5, index }));

      basicInput.treeSize = 257;
      basicInput.totalExpected = 257;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      expect(result.includedBitmap).toBeDefined();
      expect(result.seenBitmap).toBeDefined();
      expect(result.includedBitmapRoot).toBe(computeIncludedBitmapRoot(result.includedBitmap ?? []));
      expect(result.seenBitmapRoot).toBe(computeIncludedBitmapRoot(result.seenBitmap ?? []));
    });
  });

  describe('Choice Boundary Validation', () => {
    it('should reject votes with choice >= 5', async () => {
      const vote = {
        commitment: '0x' + '1'.repeat(64),
        choice: 5, // Invalid: should be 0-4
        random: '0x' + 'd'.repeat(64),
        index: 0,
        merklePath: [],
      };

      basicInput.votes = [vote];
      const result = await executeMockZkVM(basicInput);

      expect(result.validVotes).toBe(0);
      expect(result.invalidVotes).toBe(1);
    });

    it('should accept all valid choices (0-4)', async () => {
      const votes = [0, 1, 2, 3, 4].map((choice, index) => createTestVoteWithProof({ electionId, choice, index }));

      basicInput.treeSize = 5;
      basicInput.totalExpected = 5;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      expect(result.validVotes).toBe(5);
      expect(result.invalidVotes).toBe(0);
      result.verifiedTally.forEach((count) => {
        expect(count).toBe(1);
      });
    });
  });

  describe('Current count contract', () => {
    it('should maintain excludedSlots as the slot-based fail-closed total', async () => {
      basicInput.treeSize = 10;
      basicInput.totalExpected = 10;

      const votes = [0, 1, 2].map((index) => createTestVoteWithProof({ electionId, choice: 0, index }));

      basicInput.votes = votes;
      const result = await executeMockZkVM(basicInput);

      const expectedExcluded = result.missingSlots + result.invalidPresentedSlots;
      expect(result.excludedSlots).toBe(expectedExcluded);
    });
  });

  describe('Duplicate Commitment Detection', () => {
    it('should reject duplicate commitments (same opening)', async () => {
      const choice = 1;
      const random = '0x' + 'e'.repeat(64);
      const commitment = computeCommitment(electionId, choice, random);

      // Two votes with same commitment (same choice and random)
      const votes = [
        { commitment, choice, random, index: 0, merklePath: [] },
        { commitment, choice, random, index: 1, merklePath: [] }, // Duplicate!
      ];

      basicInput.treeSize = 2;
      basicInput.totalExpected = 2;
      basicInput.votes = votes;

      const result = await executeMockZkVM(basicInput);

      expect(result.validVotes).toBe(1); // Only first should be valid
      expect(result.invalidVotes).toBe(1); // Second is invalid (duplicate)
      expect(result.verifiedTally[choice]).toBe(1); // Only counted once
    });
  });

  describe('Performance', () => {
    it('should complete mock execution in ~100ms', async () => {
      const startTime = Date.now();
      await executeMockZkVM(basicInput);
      const duration = Date.now() - startTime;

      // Mock should be fast (100ms ± 50ms tolerance)
      expect(duration).toBeLessThan(150);
    });
  });
});
