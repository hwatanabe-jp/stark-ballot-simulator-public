import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { detectTampering } from './tamperDetection';
import type { Receipt, VoteData } from './types';

// Mock the merkle module
vi.mock('./merkle', () => ({
  verifyCTMerkleInclusion: vi.fn(),
}));

import { verifyCTMerkleInclusion } from './merkle';

describe('detectTampering', () => {
  let consoleWarnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyCTMerkleInclusion).mockReturnValue(true);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('Scenario S1: Ignore User Vote', () => {
    it('should detect when user vote is ignored (not included in Merkle tree)', async () => {
      // Mock Merkle verification to return false (vote not included)
      vi.mocked(verifyCTMerkleInclusion).mockReturnValue(false);
      // Arrange
      const receipt: Receipt = {
        tally: {
          A: 0,
          B: 63,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 63,
        tamperedCount: 1,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      // Act
      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: ['S1'],
      });

      // Assert
      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('ignoreUserVote');
      expect(result.details.ignoreUserVote).toBe(true);
    });

    it('should trust CT proof outcome even if incremental path would pass', async () => {
      vi.mocked(verifyCTMerkleInclusion).mockReturnValue(false);

      const receipt: Receipt = {
        tally: {
          A: 0,
          B: 63,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 63,
        tamperedCount: 1,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: ['S1'],
      });

      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('ignoreUserVote');
      expect(result.details.ignoreUserVote).toBe(true);
    });

    it('should not fall back to incremental proof when CT verification throws', async () => {
      vi.mocked(verifyCTMerkleInclusion).mockImplementation(() => {
        throw new Error('ct failure');
      });

      const receipt: Receipt = {
        tally: {
          A: 0,
          B: 63,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 63,
        tamperedCount: 1,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: ['S1'],
      });

      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('ignoreUserVote');
      expect(result.details.ignoreUserVote).toBe(true);
    });
  });

  describe('Scenario S2: Recount User Vote as Different Choice', () => {
    it('should detect when user vote is counted as different choice', async () => {
      // Mock Merkle verification to return true (vote is included)
      // Arrange
      const receipt: Receipt = {
        tally: {
          A: 0,
          B: 64, // User vote counted as B instead of A
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 1,
        verifiedTally: [1, 63, 0, 0, 0],
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A', // User voted for A
        random: '0xrand',
        treeSize: 64,
      };

      // Act
      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: ['S2'],
      });

      // Assert
      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('recountUserAsOther');
      expect(result.detectedScenarios).not.toContain('recountBotVotes');
      expect(result.details.recountUserAsOther).toBe(true);
      expect(result.details.recountedTo).toBe('B');
    });

    it('treats non-finite tally counts as 0 when inferring recount target', async () => {
      const receipt: Receipt = {
        tally: {
          A: Number.NaN,
          B: 64,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 1,
        verifiedTally: [1, 63, 0, 0, 0],
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        scenarios: ['S2'],
      });

      expect(result.isTampered).toBe(true);
      expect(result.details.recountUserAsOther).toBe(true);
      expect(result.details.recountedTo).toBe('B');
    });

    it('flags tampering when all votes become invalid even if tally is zero', async () => {
      const receipt: Receipt = {
        tally: {
          A: 0,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 64,
        invalidPresentedSlots: 64,
        validVotes: 0,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'C',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: [],
      });

      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('indexAnomaly');
      expect(result.details.indexAnomaly).toBe(true);
      expect(result.details.invalidPresentedSlotsCount).toBe(64);
    });

    it('detects recount via verified tally diff even without explicit context', async () => {
      const receipt: Receipt = {
        tally: {
          A: 0,
          B: 62,
          C: 2,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 2,
        verifiedTally: [2, 62, 0, 0, 0],
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote);

      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('recountUserAsOther');
      expect(result.details.recountedTo).toBe('C');
    });

    it('does not infer user recount from scenario context alone when verified tally is absent', async () => {
      const receipt: Receipt = {
        tally: {
          A: 0,
          B: 64,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 1,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        scenarios: ['S2'],
      });

      expect(result.detectedScenarios).not.toContain('recountUserAsOther');
    });
  });

  describe('Scenario S3: Ignore Bot Votes', () => {
    it('should detect when bot votes are ignored', async () => {
      // Mock Merkle verification to return true (vote is included)
      // Arrange
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 57, // Should be 63 but 6 bot votes ignored
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 58, // Should be 64
        tamperedCount: 6,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      // Act
      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: ['S3'],
      });

      // Assert
      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('ignoreBotVotes');
      expect(result.details.ignoreBotVotes).toBe(true);
      expect(result.details.ignoredBotCount).toBe(6); // 64 expected - 58 actual = 6 ignored
    });

    it('prefers proof-bound missingSlots even when claimed totalVotes still matches the expected total', async () => {
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 63,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 2,
        missingSlots: 2,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
      });

      expect(result.detectedScenarios).toContain('ignoreBotVotes');
      expect(result.details.ignoreBotVotes).toBe(true);
      expect(result.details.ignoredBotCount).toBe(2);
    });

    it('does not infer ignored bot votes from record-only rejections when no slots are missing', async () => {
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 63,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 3,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 3,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
      });

      expect(result.detectedScenarios).not.toContain('ignoreBotVotes');
      expect(result.details.ignoreBotVotes).toBe(false);
      expect(result.details.ignoredBotCount).toBeUndefined();
    });
  });

  describe('Scenario S4: Recount Bot Votes', () => {
    it('should detect when bot votes are recounted to different choice', async () => {
      // Mock Merkle verification to return true (vote is included)
      // Arrange
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 57, // Should be 63 but 6 recounted to E
          C: 0,
          D: 0,
          E: 6, // These are recounted bot votes
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 6,
        botTamperInfo: {
          originalChoice: 'B',
          recountedTo: 'E',
          count: 6,
        },
        verifiedTally: [1, 63, 0, 0, 0],
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      // Act
      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: ['S4'],
      });

      // Assert
      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('recountBotVotes');
      expect(result.details.recountBotVotes).toBe(true);
      expect(result.details.recountedBotInfo).toEqual({
        originalChoice: 'B',
        recountedTo: 'E',
        count: 6, // Matches botTamperInfo.count in test data
      });
    });

    it('detects recount via tally differential when botTamperInfo is absent', async () => {
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 60,
          C: 0,
          D: 0,
          E: 3,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 3,
        verifiedTally: [1, 63, 0, 0, 0],
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote);

      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('recountBotVotes');
      expect(result.details.recountBotVotes).toBe(true);
    });

    it('does not infer bot recount from slot failures alone even in S4 context', async () => {
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 64,
        invalidPresentedSlots: 64,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        scenarios: ['S4'],
      });

      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).not.toContain('recountBotVotes');
      expect(result.details.indexAnomaly).toBe(true);
    });

    it('does not treat record-only rejections as slot-failure evidence for S4 heuristics', async () => {
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 0,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 64,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      const result = await detectTampering(receipt, userVote, {
        scenarios: ['S4'],
      });

      expect(result.detectedScenarios).not.toContain('recountBotVotes');
      expect(result.detectedScenarios).toContain('indexAnomaly');
    });
  });

  describe('Scenario S5: Random Errors', () => {
    it('should detect random inconsistencies in vote data', async () => {
      // Mock Merkle verification to return true (vote is included)
      // Arrange
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 62, // One vote randomly changed
          C: 1, // Random error
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 64,
        tamperedCount: 1,
        randomError: true,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      // Act
      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: ['S5'],
      });

      // Assert
      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('randomErrors');
      expect(result.details.randomErrors).toBe(true);
    });
  });

  describe('No Tampering', () => {
    it('should return no tampering when vote is valid', async () => {
      // Mock Merkle verification to return true (vote is included)
      // Arrange
      const receipt: Receipt = {
        tally: {
          A: 1,
          B: 63,
          C: 0,
          D: 0,
          E: 0,
        },
        bulletinRoot: '0xvalidroot',
        totalVotes: 64,
        tamperedCount: 0,
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      // Act
      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
      });

      // Assert
      expect(result.isTampered).toBe(false);
      expect(result.detectedScenarios).toHaveLength(0);
      expect(result.details.ignoreUserVote).toBe(false);
      expect(result.details.recountUserAsOther).toBe(false);
      expect(result.details.ignoreBotVotes).toBe(false);
      expect(result.details.recountBotVotes).toBe(false);
      expect(result.details.randomErrors).toBe(false);
    });
  });

  describe('Multiple Scenarios', () => {
    it('should detect multiple tamper scenarios simultaneously', async () => {
      // Mock Merkle verification to return false (vote not included - S1)
      vi.mocked(verifyCTMerkleInclusion).mockReturnValue(false);
      // Arrange
      const receipt: Receipt = {
        tally: {
          A: 0, // User vote ignored
          B: 52, // Some bot votes ignored and some recounted
          C: 0,
          D: 0,
          E: 3, // Recounted bot votes
        },
        bulletinRoot: '0xfakeroot',
        totalVotes: 55, // Should be 64
        tamperedCount: 10, // 1 user + 6 ignored bots + 3 recounted bots
        botTamperInfo: {
          originalChoice: 'B',
          recountedTo: 'E',
          count: 3,
        },
      };

      const userVote: VoteData = {
        commitment: '0x1234',
        path: ['0x5678', '0x9abc'],
        leafIndex: 0,
        choice: 'A',
        random: '0xrand',
        treeSize: 64,
      };

      // Act
      const result = await detectTampering(receipt, userVote, {
        expectedTotalVotes: 64,
        scenarios: ['S1', 'S3', 'S4'],
      });

      // Assert
      expect(result.isTampered).toBe(true);
      expect(result.detectedScenarios).toContain('ignoreUserVote');
      expect(result.detectedScenarios).toContain('ignoreBotVotes');
      expect(result.detectedScenarios).toContain('recountBotVotes');
      expect(result.detectedScenarios).toHaveLength(3);
    });
  });
});
