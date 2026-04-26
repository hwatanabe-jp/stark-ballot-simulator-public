import { describe, it, expect, beforeEach } from 'vitest';
import { DuplicateDetector } from './duplicate-detector';

describe('DuplicateDetector', () => {
  let detector: DuplicateDetector;

  beforeEach(() => {
    detector = new DuplicateDetector();
  });

  describe('checkDuplicate', () => {
    it('should detect no duplicate for first vote', () => {
      const result = detector.checkDuplicate('550e8400-e29b-41d4-a716-446655440000', '0xabc123');

      expect(result.isDuplicate).toBe(false);
      expect(result.duplicateType).toBeUndefined();
    });

    it('should detect duplicate voteId', () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440000';
      const commitment1 = '0xabc123';
      const commitment2 = '0xdef456';

      // First vote
      detector.checkDuplicate(voteId, commitment1);

      // Duplicate voteId
      const result = detector.checkDuplicate(voteId, commitment2);

      expect(result.isDuplicate).toBe(true);
      expect(result.duplicateType).toBe('voteId');
    });

    it('should detect duplicate commitment', () => {
      const voteId1 = '550e8400-e29b-41d4-a716-446655440001';
      const voteId2 = '550e8400-e29b-41d4-a716-446655440002';
      const commitment = '0xabc123';

      // First vote
      detector.checkDuplicate(voteId1, commitment);

      // Duplicate commitment
      const result = detector.checkDuplicate(voteId2, commitment);

      expect(result.isDuplicate).toBe(true);
      expect(result.duplicateType).toBe('commitment');
    });

    it('should allow different voteId and commitment', () => {
      const voteId1 = '550e8400-e29b-41d4-a716-446655440001';
      const voteId2 = '550e8400-e29b-41d4-a716-446655440002';
      const commitment1 = '0xabc123';
      const commitment2 = '0xdef456';

      detector.checkDuplicate(voteId1, commitment1);
      const result = detector.checkDuplicate(voteId2, commitment2);

      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('checkBatch', () => {
    it('should process batch of votes with no duplicates', () => {
      const votes = [
        { voteId: '550e8400-e29b-41d4-a716-446655440001', commitment: '0xabc123' },
        { voteId: '550e8400-e29b-41d4-a716-446655440002', commitment: '0xdef456' },
        { voteId: '550e8400-e29b-41d4-a716-446655440003', commitment: '0x789abc' },
      ];

      const result = detector.checkBatch(votes);

      expect(result.uniqueCount).toBe(3);
      expect(result.duplicates).toHaveLength(0);
      expect(result.duplicateCount).toBe(0);
    });

    it('should detect duplicates in batch', () => {
      const votes = [
        { voteId: '550e8400-e29b-41d4-a716-446655440001', commitment: '0xabc123' },
        { voteId: '550e8400-e29b-41d4-a716-446655440001', commitment: '0xdef456' }, // Duplicate voteId
        { voteId: '550e8400-e29b-41d4-a716-446655440003', commitment: '0xabc123' }, // Duplicate commitment
      ];

      const result = detector.checkBatch(votes);

      expect(result.uniqueCount).toBe(1);
      expect(result.duplicateCount).toBe(2);
      expect(result.duplicates).toHaveLength(2);
      expect(result.duplicates[0].type).toBe('voteId');
      expect(result.duplicates[1].type).toBe('commitment');
    });
  });

  describe('getStatistics', () => {
    it('should return correct statistics', () => {
      detector.checkDuplicate('id1', 'commit1');
      detector.checkDuplicate('id2', 'commit2');
      detector.checkDuplicate('id1', 'commit3'); // Duplicate voteId
      detector.checkDuplicate('id3', 'commit2'); // Duplicate commitment

      const stats = detector.getStatistics();

      expect(stats.totalChecks).toBe(4);
      expect(stats.uniqueVoteIds).toBe(3);
      expect(stats.uniqueCommitments).toBe(3);
      expect(stats.duplicateVoteIds).toBe(1);
      expect(stats.duplicateCommitments).toBe(1);
    });

    it('should calculate duplicate rates', () => {
      // Add 10 votes
      for (let i = 0; i < 10; i++) {
        detector.checkDuplicate(`id${i}`, `commit${i}`);
      }

      // Add 2 duplicates
      detector.checkDuplicate('id0', 'commitNew'); // Duplicate voteId
      detector.checkDuplicate('idNew', 'commit0'); // Duplicate commitment

      const stats = detector.getStatistics();

      expect(stats.totalChecks).toBe(12);
      expect(stats.duplicateRate).toBeCloseTo(16.67, 1); // 2/12 * 100
    });
  });

  describe('clear', () => {
    it('should clear all stored data', () => {
      detector.checkDuplicate('id1', 'commit1');
      detector.checkDuplicate('id2', 'commit2');

      detector.clear();

      const result = detector.checkDuplicate('id1', 'commit1');
      expect(result.isDuplicate).toBe(false);

      const stats = detector.getStatistics();
      expect(stats.totalChecks).toBe(1);
      expect(stats.uniqueVoteIds).toBe(1);
    });
  });

  describe('export and import', () => {
    it('should export current state', () => {
      detector.checkDuplicate('id1', 'commit1');
      detector.checkDuplicate('id2', 'commit2');

      const state = detector.exportState();

      expect(state.voteIds).toContain('id1');
      expect(state.voteIds).toContain('id2');
      expect(state.commitments).toContain('commit1');
      expect(state.commitments).toContain('commit2');
    });

    it('should import state', () => {
      const state = {
        voteIds: ['id1', 'id2'],
        commitments: ['commit1', 'commit2'],
      };

      detector.importState(state);

      const result1 = detector.checkDuplicate('id1', 'commit3');
      expect(result1.isDuplicate).toBe(true);
      expect(result1.duplicateType).toBe('voteId');

      const result2 = detector.checkDuplicate('id3', 'commit1');
      expect(result2.isDuplicate).toBe(true);
      expect(result2.duplicateType).toBe('commitment');
    });
  });
});
