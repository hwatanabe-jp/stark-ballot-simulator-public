/**
 * Tests for the current slot/record split semantics in ZkVMJournal.
 * Following t-wada's approach: RED Phase - Write failing tests first.
 *
 * The canonical count vocabulary is slot/record based:
 * - `missingSlots` counts unpresented bulletin slots
 * - `invalidPresentedSlots` counts presented slots that failed counting
 * - `validVotes` counts proof-bound accepted votes
 * - `excludedSlots` mirrors slot-based exclusions
 *
 * Rejected duplicate or out-of-range records are tracked separately via
 * `rejectedRecords`.
 */

import { describe, it, expect } from 'vitest';
import type { ZkVMInput } from '../types';
import { createElectionId } from '../types';
import { executeMockZkVM } from '../mock-executor';
import { createTestVoteWithProof, generateElectionConfigHash, generateDefaultLogId } from '@/lib/testing/test-helpers';

describe('Three-way Split Semantics', () => {
  describe('Current contract: excludedSlots mirrors slot-based exclusions', () => {
    it('counts duplicate indices as rejected records while preserving slot-based exclusions', async () => {
      const electionId = createElectionId();
      const treeSize = 20;

      // Create votes with duplicate indices
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 5, pathLength: 0 }), // Valid
        createTestVoteWithProof({ electionId, choice: 1, index: 10, pathLength: 0 }), // Valid
        createTestVoteWithProof({ electionId, choice: 5, index: 15, pathLength: 0 }), // Invalid: choice out of range
        createTestVoteWithProof({ electionId, choice: 2, index: 5, pathLength: 0 }), // Invalid: duplicate index
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize,
        logId: generateDefaultLogId(),
        timestamp: Date.now(),
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      expect(result.seenIndicesCount).toBe(3); // Should be 3 unique indices: 5, 10, 15
      expect(result.missingSlots).toBe(treeSize - 3); // 20 - 3 = 17
      expect(result.validVotes).toBe(2); // Only first two votes are valid
      expect(result.invalidPresentedSlots).toBe(1); // Only slot 15 was presented but not counted
      expect(result.rejectedRecords).toBe(2); // Invalid choice and duplicate index are both rejected
      expect(result.excludedSlots).toBe(18);
      expect(result.excludedSlots).toBe(result.missingSlots + result.invalidPresentedSlots);
    });

    it('still reports zero invalid records when all votes are valid', async () => {
      const electionId = createElectionId();
      const treeSize = 10;

      // All valid, unique votes
      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 0, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 1, index: 1, pathLength: 0 }),
        createTestVoteWithProof({ electionId, choice: 2, index: 2, pathLength: 0 }),
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '2'.repeat(64),
        treeSize,
        logId: generateDefaultLogId(),
        timestamp: Date.now(),
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      expect(result.seenIndicesCount).toBe(3);
      expect(result.missingSlots).toBe(7); // 10 - 3 = 7
      expect(result.validVotes).toBe(3);
      expect(result.invalidPresentedSlots).toBe(0);
      expect(result.excludedSlots).toBe(result.missingSlots);
    });

    it('counts out-of-range indices as rejected records without inflating slot exclusions', async () => {
      const electionId = createElectionId();
      const treeSize = 5;

      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 2, pathLength: 0 }), // Valid
        createTestVoteWithProof({ electionId, choice: 1, index: 10, pathLength: 0 }), // Invalid: index >= treeSize
        createTestVoteWithProof({ electionId, choice: 2, index: 100, pathLength: 0 }), // Invalid: index >= treeSize
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '3'.repeat(64),
        treeSize,
        logId: generateDefaultLogId(),
        timestamp: Date.now(),
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      expect(result.seenIndicesCount).toBe(1);
      expect(result.missingSlots).toBe(4); // 5 - 1 = 4
      expect(result.validVotes).toBe(1);
      expect(result.invalidPresentedSlots).toBe(0); // No in-range presented slot failed counting
      expect(result.rejectedRecords).toBe(2); // Both out-of-range records are rejected
      expect(result.excludedSlots).toBe(4);
      expect(result.excludedSlots).toBe(result.missingSlots + result.invalidPresentedSlots);
    });

    it('counts duplicate commitments as rejected records and slot-level failures', async () => {
      const electionId = createElectionId();
      const treeSize = 10;

      // Create two votes with same commitment (same choice and random)
      const vote1 = createTestVoteWithProof({ electionId, choice: 1, index: 3, pathLength: 0 });
      const vote2 = { ...vote1, index: 4 }; // Same commitment, different index

      const votes = [
        createTestVoteWithProof({ electionId, choice: 0, index: 1, pathLength: 0 }),
        vote1,
        vote2, // Should be invalid due to duplicate commitment
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '4'.repeat(64),
        treeSize,
        logId: generateDefaultLogId(),
        timestamp: Date.now(),
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      expect(result.seenIndicesCount).toBe(3); // All three indices are unique
      expect(result.missingSlots).toBe(7); // 10 - 3 = 7
      expect(result.validVotes).toBe(2); // First two votes are valid
      expect(result.invalidPresentedSlots).toBe(1); // Slot 4 was presented but not counted
      expect(result.rejectedRecords).toBe(1); // Last vote has duplicate commitment
      expect(result.excludedSlots).toBe(8);
      expect(result.excludedSlots).toBe(result.missingSlots + result.invalidPresentedSlots);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty votes correctly', async () => {
      const electionId = createElectionId();
      const treeSize = 100;

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '5'.repeat(64),
        treeSize,
        logId: generateDefaultLogId(),
        timestamp: Date.now(),
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes: [], // No votes
      };

      const result = await executeMockZkVM(input);

      expect(result.seenIndicesCount).toBe(0);
      expect(result.missingSlots).toBe(100);
      expect(result.validVotes).toBe(0);
      expect(result.invalidPresentedSlots).toBe(0);
      expect(result.excludedSlots).toBe(100);
    });

    it('should handle single vote at max index', async () => {
      const electionId = createElectionId();
      const treeSize = 1000;

      const votes = [
        createTestVoteWithProof({ electionId, choice: 4, index: 999, pathLength: 0 }), // Max valid index
      ];

      const input: ZkVMInput = {
        electionId,
        bulletinRoot: '0x' + '6'.repeat(64),
        treeSize,
        logId: generateDefaultLogId(),
        timestamp: Date.now(),
        totalExpected: treeSize,
        electionConfigHash: generateElectionConfigHash({
          totalExpected: treeSize,
          choices: ['A', 'B', 'C', 'D', 'E'],
        }),
        votes,
      };

      const result = await executeMockZkVM(input);

      expect(result.seenIndicesCount).toBe(1);
      expect(result.missingSlots).toBe(999);
      expect(result.validVotes).toBe(1);
      expect(result.invalidPresentedSlots).toBe(0);
      expect(result.excludedSlots).toBe(999);
    });
  });
});
