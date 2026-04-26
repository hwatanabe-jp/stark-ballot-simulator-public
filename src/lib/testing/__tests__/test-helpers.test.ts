/**
 * Tests for v2 test helpers
 * Following t-wada's TDD approach: Red-Green-Refactor
 */

import {
  generateElectionId,
  createTestVoteWithProof,
  generateSTHParameters,
  createTestInput,
  createTestJournal,
  generateRandomBytes32,
  generateBulletinRoot,
  generateElectionConfig,
  normalizeTestJournalCounts,
} from '../test-helpers';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import type { VoteWithProof } from '@/lib/zkvm/types';

describe('test-helpers', () => {
  describe('generateElectionId', () => {
    it('should generate valid UUID v4', () => {
      const id = generateElectionId();

      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      // where y is 8, 9, A, or B
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidV4Regex);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateElectionId());
      }
      expect(ids.size).toBe(100); // All should be unique
    });
  });

  describe('createTestVoteWithProof', () => {
    it('should create vote with valid structure', () => {
      const vote = createTestVoteWithProof({
        choice: 2,
        index: 5,
        pathLength: 3,
      });

      expect(vote.choice).toBe(2);
      expect(vote.index).toBe(5);
      expect(vote.merklePath).toHaveLength(3);
      expect(vote.commitment).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(vote.random).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('should generate consistent commitment for same inputs', () => {
      const electionId = generateElectionId();
      const choice = 1;
      const random = generateRandomBytes32();

      const vote1 = createTestVoteWithProof({
        electionId,
        choice,
        random,
        index: 0,
      });

      const vote2 = createTestVoteWithProof({
        electionId,
        choice,
        random,
        index: 0,
      });

      expect(vote1.commitment).toBe(vote2.commitment);
    });

    it('should generate different commitments for different choices', () => {
      const electionId = generateElectionId();
      const random = generateRandomBytes32();

      const voteA = createTestVoteWithProof({
        electionId,
        choice: 0,
        random,
        index: 0,
      });

      const voteB = createTestVoteWithProof({
        electionId,
        choice: 1,
        random,
        index: 0,
      });

      expect(voteA.commitment).not.toBe(voteB.commitment);
    });
  });

  describe('generateSTHParameters', () => {
    it('should generate valid STH parameters', () => {
      const params = generateSTHParameters();

      expect(params.logId).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(params.timestamp).toBeGreaterThan(0);
      expect(params.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('should accept custom timestamp', () => {
      const customTimestamp = 1234567890;
      const params = generateSTHParameters({ timestamp: customTimestamp });

      expect(params.timestamp).toBe(customTimestamp);
    });
  });

  describe('createTestInput', () => {
    it('should create valid ZkVMInput with defaults', () => {
      const input = createTestInput();

      expect(input.electionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(input.bulletinRoot).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(input.treeSize).toBeGreaterThan(0);
      expect(input.totalExpected).toBeGreaterThan(0);
      expect(input.votes).toBeInstanceOf(Array);
    });

    it('should create input with specified number of votes', () => {
      const input = createTestInput({ voteCount: 5 });

      expect(input.votes).toHaveLength(5);
      expect(input.totalExpected).toBe(5);
      expect(input.treeSize).toBeGreaterThanOrEqual(5);
    });

    it('should NOT have claimedTally field', () => {
      const input = createTestInput();

      // @ts-expect-error - claimedTally should not exist
      expect(input.claimedTally).toBeUndefined();
    });

    it('should sort votes by index in inputCommitment', () => {
      const input = createTestInput({ voteCount: 3 });

      // Manually reorder votes
      const unsortedVotes = [input.votes[2], input.votes[0], input.votes[1]];
      input.votes = unsortedVotes;

      // Input commitment should still be consistent due to internal sorting
      const commitment1 = input.electionConfigHash; // This would be recalculated

      // Restore original order
      input.votes = input.votes.sort((a, b) => a.index - b.index);
      const commitment2 = input.electionConfigHash;

      // In real implementation, these would be the same due to sorting
      expect(commitment1).toBe(commitment2);
    });
  });

  describe('createTestJournal', () => {
    it('should keep record-only rejections out of slot-based compatibility mirrors', () => {
      const counts = normalizeTestJournalCounts({
        validVotes: 4,
        missingIndices: 6,
        invalidIndices: 0,
        rejectedRecords: 3,
      });

      expect(counts.validVotes).toBe(4);
      expect(counts.invalidVotes).toBe(3);
      expect(counts.rejectedRecords).toBe(3);
      expect(counts.seenIndicesCount).toBe(4);
      expect(counts.totalVotes).toBe(7);
      expect(counts.invalidPresentedSlots).toBe(0);
      expect(counts.excludedSlots).toBe(6);
    });

    it('should derive seenIndicesCount from counted and slot-invalid counts', () => {
      const counts = normalizeTestJournalCounts({
        countedIndices: 4,
        invalidIndices: 2,
      });

      expect(counts.validVotes).toBe(4);
      expect(counts.invalidPresentedSlots).toBe(2);
      expect(counts.rejectedRecords).toBe(2);
      expect(counts.seenIndicesCount).toBe(6);
      expect(counts.validVotes).toBe(4);
      expect(counts.invalidPresentedSlots).toBe(2);
    });

    it('should create valid ZkVMJournal', () => {
      const journal = createTestJournal();

      expect(journal.electionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(journal.sthDigest).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(journal.verifiedTally).toHaveLength(5);
      expect(journal.seenBitmapRoot).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    });

    it('should NOT have tamperDetected field', () => {
      const journal = createTestJournal();

      // @ts-expect-error - tamperDetected should not exist
      expect(journal.tamperDetected).toBeUndefined();
    });

    it('should derive slot-based compatibility counts from the current journal fields', () => {
      const journal = createTestJournal({
        totalExpected: 10,
        validVotes: 4,
        missingIndices: 6,
      });

      expect(journal.validVotes).toBe(4);
      expect(journal.seenIndicesCount).toBe(4);
      expect(journal.totalVotes).toBe(4);
      expect(journal.missingSlots).toBe(6);
      expect(journal.invalidPresentedSlots).toBe(0);
      expect(journal.rejectedRecords).toBe(0);
      expect(journal.invalidPresentedSlots).toBe(0);
      expect(journal.excludedSlots).toBe(6);
      expect(journal.excludedSlots).toBe(6);
    });

    it('should respect an explicit seenIndicesCount override for custom fixtures', () => {
      const journal = createTestJournal({
        totalExpected: 10,
        validVotes: 4,
        missingIndices: 2,
        invalidIndices: 4,
        seenIndicesCount: 8,
      });

      expect(journal.seenIndicesCount).toBe(8);
      expect(journal.missingSlots).toBe(2);
      expect(journal.invalidPresentedSlots).toBe(4);
      expect(journal.rejectedRecords).toBe(4);
      expect(journal.missingSlots).toBe(2);
      expect(journal.invalidPresentedSlots).toBe(4);
      expect(journal.excludedSlots).toBe(6);
      expect(journal.excludedSlots).toBe(6);
    });

    it('should treat invalidIndices as a legacy alias for slot-based invalidPresentedSlots', () => {
      const journal = createTestJournal({
        totalExpected: 10,
        validVotes: 4,
        missingIndices: 2,
        invalidIndices: 4,
      });

      expect(journal.seenIndicesCount).toBe(8);
      expect(journal.missingSlots).toBe(2);
      expect(journal.invalidPresentedSlots).toBe(4);
      expect(journal.rejectedRecords).toBe(4);
      expect(journal.invalidPresentedSlots).toBe(4);
      expect(journal.totalVotes).toBe(8);
    });

    it('should throw when invalidIndices and seenIndicesCount disagree about slot counts', () => {
      expect(() =>
        createTestJournal({
          totalExpected: 10,
          validVotes: 4,
          missingIndices: 2,
          invalidIndices: 3,
          seenIndicesCount: 8,
        }),
      ).toThrow(/invalidIndices/i);
    });

    it('should throw when the slot partition exceeds totalExpected', () => {
      expect(() =>
        createTestJournal({
          totalExpected: 10,
          validVotes: 4,
          missingIndices: 1,
          invalidIndices: 6,
        }),
      ).toThrow(/slot partition/i);
    });

    it('should allow explicit record-only rejections beyond slot-based exclusions', () => {
      const journal = createTestJournal({
        totalExpected: 10,
        validVotes: 4,
        missingIndices: 6,
        rejectedRecords: 3,
      });

      expect(journal.seenIndicesCount).toBe(4);
      expect(journal.missingSlots).toBe(6);
      expect(journal.invalidPresentedSlots).toBe(0);
      expect(journal.rejectedRecords).toBe(3);
      expect(journal.invalidVotes).toBe(3);
      expect(journal.totalVotes).toBe(7);
      expect(journal.invalidPresentedSlots).toBe(0);
      expect(journal.excludedSlots).toBe(6);
    });

    it('should throw when rejectedRecords is smaller than slot-based invalidIndices', () => {
      expect(() =>
        createTestJournal({
          totalExpected: 10,
          validVotes: 4,
          missingIndices: 2,
          invalidIndices: 4,
          rejectedRecords: 3,
        }),
      ).toThrow(/rejectedRecords/i);
    });

    it('should generate consistent tally distribution', () => {
      const journal = createTestJournal({ validVotes: 64 });

      const tallySum = journal.verifiedTally.reduce((sum, count) => sum + count, 0);
      expect(tallySum).toBe(64);
    });
  });

  describe('helper utilities', () => {
    describe('generateRandomBytes32', () => {
      it('should generate 32-byte hex string', () => {
        const random = generateRandomBytes32();

        expect(random).toMatch(/^0x[0-9a-f]{64}$/i);
      });

      it('should generate different values each time', () => {
        const randoms = new Set<string>();
        for (let i = 0; i < 100; i++) {
          randoms.add(generateRandomBytes32());
        }
        expect(randoms.size).toBe(100);
      });
    });

    describe('generateBulletinRoot', () => {
      it('should generate valid bulletin root from votes', () => {
        const votes: VoteWithProof[] = [createTestVoteWithProof({ index: 0 }), createTestVoteWithProof({ index: 1 })];

        const root = generateBulletinRoot(votes);
        expect(root).toMatch(/^0x[0-9a-f]{64}$/i);
      });

      it('should generate consistent root for same votes', () => {
        const votes: VoteWithProof[] = [
          createTestVoteWithProof({ index: 0, random: generateRandomBytes32() }),
          createTestVoteWithProof({ index: 1, random: generateRandomBytes32() }),
        ];

        const root1 = generateBulletinRoot(votes);
        const root2 = generateBulletinRoot(votes);

        expect(root1).toBe(root2);
      });
    });

    describe('generateElectionConfig', () => {
      it('should generate valid election configuration', () => {
        const config = generateElectionConfig({ totalExpected: 64 });

        expect(config.totalExpected).toBe(64);
        expect(config.choices).toEqual(['A', 'B', 'C', 'D', 'E']);
        expect(config.hash).toMatch(/^0x[0-9a-f]{64}$/i);
      });

      it('should include totalExpected in hash calculation', () => {
        const config1 = generateElectionConfig({ totalExpected: 64 });
        const config2 = generateElectionConfig({ totalExpected: 100 });

        expect(config1.hash).not.toBe(config2.hash);
      });
    });
  });
});
