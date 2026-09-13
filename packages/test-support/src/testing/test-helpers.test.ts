/**
 * Tests for shared zkVM test fixtures.
 */

import {
  createTestInput,
  createTestJournal,
  createTestVoteWithProof,
  generateBulletinRoot,
  generateElectionConfig,
  generateRandomBytes32,
  generateSTHParameters,
} from './test-helpers';
import { CURRENT_METHOD_VERSION, computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';

describe('test-helpers', () => {
  describe('createTestVoteWithProof', () => {
    it('binds the supplied vote fields into a structurally valid fixture', () => {
      const electionId = '00000000-0000-4000-8000-000000000001';
      const choice = 2;
      const random = `0x${'ab'.repeat(32)}`;

      const vote = createTestVoteWithProof({ electionId, choice, random, index: 5, pathLength: 3 });

      expect(vote).toMatchObject({
        choice,
        index: 5,
        random,
        commitment: computeCommitment(electionId, choice, random),
      });
      expect(vote.merklePath).toHaveLength(3);
    });
  });

  describe('generateSTHParameters', () => {
    it('generates valid default STH parameters', () => {
      const params = generateSTHParameters();

      expect(params.logId).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(params.timestamp).toBeGreaterThan(0);
      expect(params.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('createTestInput', () => {
    it('creates a valid ZkVMInput with defaults', () => {
      const input = createTestInput();

      expect(input.electionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(input.bulletinRoot).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(input.treeSize).toBeGreaterThan(0);
      expect(input.totalExpected).toBeGreaterThan(0);
      expect(input.votes).toBeInstanceOf(Array);
    });

    it('creates an input with the requested number of votes', () => {
      const input = createTestInput({ voteCount: 5 });

      expect(input.votes).toHaveLength(5);
      expect(input.totalExpected).toBe(5);
      expect(input.treeSize).toBeGreaterThanOrEqual(5);
    });
  });

  describe('createTestJournal', () => {
    it('creates a valid current ZkVMJournal', () => {
      const journal = createTestJournal();

      expect(journal.electionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(journal.sthDigest).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(journal.verifiedTally).toHaveLength(5);
      expect(journal.seenBitmapRoot).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    });

    it('uses the same seen and included bitmap root when no presented slot was rejected', () => {
      const journal = createTestJournal({ invalidPresentedSlots: 0 });

      expect(journal.seenBitmapRoot).toBe(journal.includedBitmapRoot);
    });

    it.each([
      {
        name: 'derives counts from missing slots',
        options: { totalExpected: 10, validVotes: 4, missingSlots: 6 },
        expected: {
          validVotes: 4,
          invalidVotes: 0,
          seenIndicesCount: 4,
          totalVotes: 4,
          missingSlots: 6,
          invalidPresentedSlots: 0,
          rejectedRecords: 0,
          excludedSlots: 6,
        },
      },
      {
        name: 'respects an explicit seen-indices override',
        options: {
          totalExpected: 10,
          validVotes: 4,
          missingSlots: 2,
          invalidPresentedSlots: 4,
          seenIndicesCount: 8,
        },
        expected: {
          validVotes: 4,
          invalidVotes: 4,
          seenIndicesCount: 8,
          totalVotes: 8,
          missingSlots: 2,
          invalidPresentedSlots: 4,
          rejectedRecords: 4,
          excludedSlots: 6,
        },
      },
      {
        name: 'derives seen indices from valid and invalid presented slots',
        options: { totalExpected: 10, validVotes: 4, missingSlots: 2, invalidPresentedSlots: 4 },
        expected: {
          validVotes: 4,
          invalidVotes: 4,
          seenIndicesCount: 8,
          totalVotes: 8,
          missingSlots: 2,
          invalidPresentedSlots: 4,
          rejectedRecords: 4,
          excludedSlots: 6,
        },
      },
    ])('$name', ({ options, expected }) => {
      expect(createTestJournal(options)).toMatchObject(expected);
    });

    it.each([
      {
        name: 'rejects disagreeing invalid-presented and seen-index counts',
        options: {
          totalExpected: 10,
          validVotes: 4,
          missingSlots: 2,
          invalidPresentedSlots: 3,
          seenIndicesCount: 8,
        },
        error: /invalidPresentedSlots/i,
      },
      {
        name: 'rejects a slot partition that exceeds the expected total',
        options: { totalExpected: 10, validVotes: 4, missingSlots: 1, invalidPresentedSlots: 6 },
        error: /slot partition/i,
      },
      {
        name: 'rejects fewer records than invalid presented slots',
        options: {
          totalExpected: 10,
          validVotes: 4,
          missingSlots: 2,
          invalidPresentedSlots: 4,
          rejectedRecords: 3,
        },
        error: /rejectedRecords/i,
      },
    ])('$name', ({ options, error }) => {
      expect(() => createTestJournal(options)).toThrow(error);
    });

    it('keeps record-only rejections out of slot-based counts', () => {
      const journal = createTestJournal({
        totalExpected: 10,
        validVotes: 4,
        missingSlots: 6,
        rejectedRecords: 3,
      });

      expect(journal).toMatchObject({
        seenIndicesCount: 4,
        missingSlots: 6,
        invalidPresentedSlots: 0,
        rejectedRecords: 3,
        invalidVotes: 3,
        totalVotes: 7,
        excludedSlots: 6,
      });
    });

    it('generates a tally whose sum matches valid votes', () => {
      const journal = createTestJournal({ validVotes: 64 });

      expect(journal.verifiedTally.reduce((sum, count) => sum + count, 0)).toBe(64);
    });
  });

  describe('helper utilities', () => {
    it('generates the same bulletin root regardless of vote order', () => {
      const votes = [
        createTestVoteWithProof({ index: 0, random: generateRandomBytes32() }),
        createTestVoteWithProof({ index: 1, random: generateRandomBytes32() }),
      ];

      expect(generateBulletinRoot(votes)).toBe(generateBulletinRoot([...votes].reverse()));
    });

    it('generates the default election configuration', () => {
      const config = generateElectionConfig({ totalExpected: 64 });

      expect(config.totalExpected).toBe(64);
      expect(config.choices).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(config.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('includes totalExpected in the election configuration hash', () => {
      const config1 = generateElectionConfig({ totalExpected: 64 });
      const config2 = generateElectionConfig({ totalExpected: 100 });

      expect(config1.hash).not.toBe(config2.hash);
    });
  });
});
