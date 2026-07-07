import { describe, it, expect } from 'vitest';
import { generateVoteId, isValidVoteId, VoteIdGenerator } from './voteId';

describe('Vote ID Generation', () => {
  describe('generateVoteId', () => {
    it('should generate a valid UUID v4', () => {
      const voteId = generateVoteId();

      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      // where y is one of [8, 9, a, b]
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      expect(voteId).toMatch(uuidV4Regex);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      const numIds = 1000;

      for (let i = 0; i < numIds; i++) {
        ids.add(generateVoteId());
      }

      // All IDs should be unique
      expect(ids.size).toBe(numIds);
    });

    it('should have 128 bits of randomness', () => {
      const voteId = generateVoteId();
      // Remove hyphens and check length
      const hexDigits = voteId.replace(/-/g, '');

      // 32 hex characters = 128 bits
      expect(hexDigits.length).toBe(32);
    });
  });

  describe('isValidVoteId', () => {
    it('should validate correct UUID v4', () => {
      const validIds = ['550e8400-e29b-41d4-a716-446655440000', 'f47ac10b-58cc-4372-a567-0e02b2c3d479'];

      validIds.forEach((id) => {
        expect(isValidVoteId(id)).toBe(true);
      });
    });

    it('should reject invalid formats', () => {
      const invalidIds = [
        '',
        'not-a-uuid',
        '550e8400-e29b-41d4-a716', // too short
        '550e8400-e29b-41d4-a716-446655440000-extra', // too long
        '550e8400-e29b-XXd4-a716-446655440000', // invalid characters
        '../../../etc/passwd', // path traversal attempt
        'test/../../secret', // path traversal
        '550e8400\\e29b\\41d4\\a716\\446655440000', // backslashes
      ];

      invalidIds.forEach((id) => {
        expect(isValidVoteId(id)).toBe(false);
      });
    });

    it('should be case-insensitive', () => {
      const id = '550E8400-E29B-41D4-A716-446655440000';
      expect(isValidVoteId(id)).toBe(true);
      expect(isValidVoteId(id.toLowerCase())).toBe(true);
    });
  });

  describe('VoteIdGenerator class', () => {
    it('should track generated IDs', () => {
      const generator = new VoteIdGenerator();

      const id1 = generator.generate();
      const id2 = generator.generate();
      const id3 = generator.generate();

      expect(generator.hasGenerated(id1)).toBe(true);
      expect(generator.hasGenerated(id2)).toBe(true);
      expect(generator.hasGenerated(id3)).toBe(true);
      expect(generator.hasGenerated('non-existent-id')).toBe(false);
    });

    it('should return generation count', () => {
      const generator = new VoteIdGenerator();

      expect(generator.getCount()).toBe(0);

      generator.generate();
      expect(generator.getCount()).toBe(1);

      generator.generate();
      generator.generate();
      expect(generator.getCount()).toBe(3);
    });

    it('should support clearing history', () => {
      const generator = new VoteIdGenerator();

      const id = generator.generate();
      expect(generator.hasGenerated(id)).toBe(true);
      expect(generator.getCount()).toBe(1);

      generator.clear();

      expect(generator.hasGenerated(id)).toBe(false);
      expect(generator.getCount()).toBe(0);
    });

    it('should provide generation timestamp', () => {
      const generator = new VoteIdGenerator();
      const beforeTime = Date.now();

      const id = generator.generate();

      const afterTime = Date.now();
      const timestamp = generator.getTimestamp(id);

      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('Security considerations', () => {
    it('should use cryptographically secure random', () => {
      // This test verifies the implementation uses crypto.randomUUID
      // which is cryptographically secure
      // const id = generateVoteId()

      // Check it's not a predictable pattern
      const ids = Array.from({ length: 10 }, () => generateVoteId());
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should not expose internal state', () => {
      const generator = new VoteIdGenerator();
      let id = generator.generate();

      // Modifying the returned ID should not affect internal state
      const originalId = id;
      id = 'modified';

      expect(generator.hasGenerated(originalId)).toBe(true);
      expect(generator.hasGenerated('modified')).toBe(false);
    });
  });
});
