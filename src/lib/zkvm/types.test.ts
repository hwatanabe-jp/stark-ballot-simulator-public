import { describe, it, expect } from 'vitest';
import type { ZkVMInput, VoteWithProof } from './types';
import { getArrayProperty, getNumberProperty, getStringProperty, isRecord } from '@/lib/utils/guards';

describe('zkVM Types', () => {
  describe('ZkVMInput', () => {
    it('should include bulletinRoot field', () => {
      const input: ZkVMInput = {
        votes: [],
        bulletinRoot: '0x' + 'b'.repeat(64),
        treeSize: 64,
        totalExpected: 64,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'c'.repeat(64),
        logId: '0x' + 'd'.repeat(64),
        timestamp: Date.now(),
      };

      expect(input.bulletinRoot).toBeDefined();
      expect(input.bulletinRoot).toBe('0x' + 'b'.repeat(64));
    });

    it('should include totalExpected field', () => {
      const input: ZkVMInput = {
        votes: [],
        bulletinRoot: '0x' + 'b'.repeat(64),
        treeSize: 64,
        totalExpected: 64,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'c'.repeat(64),
        logId: '0x' + 'd'.repeat(64),
        timestamp: Date.now(),
      };

      expect(input.totalExpected).toBeDefined();
      expect(input.totalExpected).toBe(64);
    });

    it('should serialize to JSON correctly', () => {
      const vote: VoteWithProof = {
        commitment: '0x' + 'c'.repeat(64),
        choice: 0,
        random: '0x' + 'd'.repeat(64),
        index: 0,
        merklePath: [],
      };

      const input: ZkVMInput = {
        votes: [vote],
        bulletinRoot: '0x' + 'b'.repeat(64),
        treeSize: 1,
        totalExpected: 1,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'c'.repeat(64),
        logId: '0x' + 'd'.repeat(64),
        timestamp: Date.now(),
      };

      const json = JSON.stringify(input);
      const parsed: unknown = JSON.parse(json);
      const record = isRecord(parsed) ? parsed : null;
      expect(getStringProperty(record, 'bulletinRoot')).toBe(input.bulletinRoot);
      expect(getNumberProperty(record, 'totalExpected')).toBe(input.totalExpected);
      const votes = getArrayProperty(record, 'votes') ?? [];
      expect(votes).toHaveLength(1);
    });

    it('should handle full vote set with bulletin root', () => {
      const votes: VoteWithProof[] = [];
      for (let i = 0; i < 64; i++) {
        votes.push({
          commitment: '0x' + i.toString(16).padStart(64, '0'),
          choice: i % 5,
          random: '0x' + (i + 100).toString(16).padStart(64, '0'),
          index: i,
          merklePath: [],
        });
      }

      const input: ZkVMInput = {
        votes: votes,
        bulletinRoot: '0x' + 'bulletin'.padEnd(64, '0'),
        treeSize: 64,
        totalExpected: 64,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'config'.padEnd(64, '0'),
        logId: '0x' + 'log'.padEnd(64, '0'),
        timestamp: Date.now(),
      };

      expect(input.votes).toHaveLength(64);
      expect(input.totalExpected).toBe(64);
      expect(input.bulletinRoot).toContain('bulletin');
    });
  });

  describe('ZkVMInput validation', () => {
    it('should validate bulletinRoot format', () => {
      const validateBulletinRoot = (root: string): boolean => {
        // Must be hex string with 0x prefix and 64 hex chars
        const hexRegex = /^0x[0-9a-f]{64}$/i;
        return hexRegex.test(root);
      };

      expect(validateBulletinRoot('0x' + 'a'.repeat(64))).toBe(true);
      expect(validateBulletinRoot('invalid')).toBe(false);
      expect(validateBulletinRoot('0x' + 'g'.repeat(64))).toBe(false);
      expect(validateBulletinRoot('0x' + 'a'.repeat(63))).toBe(false);
    });

    it('should validate totalExpected range', () => {
      const validateTotalExpected = (total: number): boolean => {
        return total > 0 && total <= 100; // Max 100 votes
      };

      expect(validateTotalExpected(64)).toBe(true);
      expect(validateTotalExpected(1)).toBe(true);
      expect(validateTotalExpected(100)).toBe(true);
      expect(validateTotalExpected(0)).toBe(false);
      expect(validateTotalExpected(101)).toBe(false);
      expect(validateTotalExpected(-1)).toBe(false);
    });
  });

  describe('Backward compatibility', () => {
    it('should require bulletinRoot in the current input contract', () => {
      // bulletinRoot is a required field
      // Legacy systems without bulletinRoot are no longer supported
      const input = {
        votes: [],
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        totalExpected: 64,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'c'.repeat(64),
        logId: '0x' + 'd'.repeat(64),
        timestamp: Date.now(),
      };

      // bulletinRoot must be defined
      const zkInput: ZkVMInput = input;
      expect(zkInput.bulletinRoot).toBeDefined();
      expect(zkInput.bulletinRoot).toBe('0x' + 'a'.repeat(64));
    });
  });
});
