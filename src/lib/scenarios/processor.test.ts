import { describe, it, expect, beforeEach } from 'vitest';
import { ScenarioProcessor } from './processor';
import type { VoteData } from '@/types/server';

describe('ScenarioProcessor', () => {
  let processor: ScenarioProcessor;
  let votes: Map<number, VoteData>;

  beforeEach(() => {
    processor = new ScenarioProcessor();

    // Setup sample votes
    votes = new Map([
      [0, { vote: 'A', rand: 'userRand', commit: 'userCommit', path: [] }], // User vote
      [1, { vote: 'B', rand: 'bot1Rand', commit: 'bot1Commit', path: [] }],
      [2, { vote: 'C', rand: 'bot2Rand', commit: 'bot2Commit', path: [] }],
      [3, { vote: 'D', rand: 'bot3Rand', commit: 'bot3Commit', path: [] }],
      [4, { vote: 'E', rand: 'bot4Rand', commit: 'bot4Commit', path: [] }],
    ]);
  });

  describe('applyScenarios', () => {
    it('should not modify votes when no scenarios applied', () => {
      // Act
      const result = processor.applyScenarios(votes, [], 0);

      // Assert
      expect(result.modifiedVotes).toEqual(votes);
      expect(result.changes).toHaveLength(0);
    });

    it('should apply S1 - ignore user vote', () => {
      // Act
      const result = processor.applyScenarios(votes, ['S1'], 0);

      // Assert
      expect(result.modifiedVotes.has(0)).toBe(false); // User vote removed
      expect(result.modifiedVotes.size).toBe(4); // Only bot votes remain
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toEqual({
        scenario: 'S1',
        voteIndex: 0,
        action: 'IGNORED',
        originalVote: 'A',
      });
    });

    it('should apply S2 - recount user vote', () => {
      // Act
      const result = processor.applyScenarios(votes, ['S2'], 0, { targetChoice: 'E' });

      // Assert
      const userVote = result.modifiedVotes.get(0);
      expect(userVote?.vote).toBe('E'); // Vote changed to E
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toEqual({
        scenario: 'S2',
        voteIndex: 0,
        action: 'RECOUNTED',
        originalVote: 'A',
        newVote: 'E',
      });
    });

    it('should apply S3 - ignore specific bot vote', () => {
      // Act
      const result = processor.applyScenarios(votes, ['S3'], 0, { targetBotId: 2 });

      // Assert
      expect(result.modifiedVotes.has(2)).toBe(false); // Bot 2 vote removed
      expect(result.modifiedVotes.size).toBe(4);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toEqual({
        scenario: 'S3',
        voteIndex: 2,
        action: 'IGNORED',
        originalVote: 'C',
      });
    });

    it('should apply S4 - recount bot vote', () => {
      // Act
      const result = processor.applyScenarios(votes, ['S4'], 0, {
        targetBotId: 3,
        targetChoice: 'A',
      });

      // Assert
      const botVote = result.modifiedVotes.get(3);
      expect(botVote?.vote).toBe('A'); // Bot vote changed to A
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toEqual({
        scenario: 'S4',
        voteIndex: 3,
        action: 'RECOUNTED',
        originalVote: 'D',
        newVote: 'A',
      });
    });

    it('should apply S5 - random error injection', () => {
      // Act
      const result = processor.applyScenarios(votes, ['S5'], 0);

      // Assert
      // S5 should randomly modify some votes
      expect(result.changes.length).toBeGreaterThan(0);
      expect(result.changes[0].scenario).toBe('S5');
      expect(result.changes[0].action).toMatch(/IGNORED|RECOUNTED|DUPLICATED/);
    });

    it('should apply multiple non-conflicting scenarios', () => {
      // Act
      const result = processor.applyScenarios(votes, ['S1', 'S3'], 0, { targetBotId: 2 });

      // Assert
      expect(result.modifiedVotes.has(0)).toBe(false); // User vote removed (S1)
      expect(result.modifiedVotes.has(2)).toBe(false); // Bot 2 removed (S3)
      expect(result.modifiedVotes.size).toBe(3);
      expect(result.changes).toHaveLength(2);
    });
  });

  describe('getTallyCounts', () => {
    it('should calculate correct tally counts', () => {
      // Act
      const counts = processor.getTallyCounts(votes);

      // Assert
      expect(counts).toEqual({
        A: 1,
        B: 1,
        C: 1,
        D: 1,
        E: 1,
      });
    });

    it('should handle missing votes', () => {
      // Arrange
      const sparseVotes: Map<number, VoteData> = new Map([
        [0, { vote: 'A', rand: 'r1', commit: 'c1', path: [] }],
        [1, { vote: 'A', rand: 'r2', commit: 'c2', path: [] }],
        [2, { vote: 'B', rand: 'r3', commit: 'c3', path: [] }],
      ]);

      // Act
      const counts = processor.getTallyCounts(sparseVotes);

      // Assert
      expect(counts).toEqual({
        A: 2,
        B: 1,
        C: 0,
        D: 0,
        E: 0,
      });
    });
  });
});
