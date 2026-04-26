import { describe, it, expect } from 'vitest';
import { validateCommitment, validateSessionId, validateVoteChoice, validateBotId } from './requests';
import { VOTE_CHOICES } from '@/shared/constants';

describe('Request Validation', () => {
  describe('validateCommitment', () => {
    it('should accept valid hex commitment', () => {
      const valid = validateCommitment('0x1234567890abcdef');
      expect(valid).toBe(true);
    });

    it('should accept numeric string commitment', () => {
      const valid = validateCommitment('123456789012345678901234567890');
      expect(valid).toBe(true);
    });

    it('should reject empty commitment', () => {
      const valid = validateCommitment('');
      expect(valid).toBe(false);
    });

    it('should reject null/undefined', () => {
      expect(validateCommitment(null)).toBe(false);
      expect(validateCommitment(undefined)).toBe(false);
    });

    it('should reject non-string types', () => {
      expect(validateCommitment(123)).toBe(false);
      expect(validateCommitment({})).toBe(false);
    });
  });

  describe('validateSessionId', () => {
    it('should accept valid hex session ID', () => {
      const valid = validateSessionId('a1b2c3d4e5f6789012345678901234567890');
      expect(valid).toBe(true);
    });

    it('should accept UUID format', () => {
      const valid = validateSessionId('550e8400-e29b-41d4-a716-446655440000');
      expect(valid).toBe(true);
    });

    it('should reject too short IDs', () => {
      const valid = validateSessionId('abc123');
      expect(valid).toBe(false);
    });

    it('should reject empty string', () => {
      const valid = validateSessionId('');
      expect(valid).toBe(false);
    });

    it('should reject special characters', () => {
      const valid = validateSessionId('abc@123#def');
      expect(valid).toBe(false);
    });
  });

  describe('validateVoteChoice', () => {
    it('should accept all valid vote choices', () => {
      VOTE_CHOICES.forEach((choice) => {
        expect(validateVoteChoice(choice)).toBe(true);
      });
    });

    it('should reject invalid choices', () => {
      expect(validateVoteChoice('F')).toBe(false);
      expect(validateVoteChoice('X')).toBe(false);
      expect(validateVoteChoice('1')).toBe(false);
    });

    it('should reject lowercase', () => {
      expect(validateVoteChoice('a')).toBe(false);
    });

    it('should reject non-string types', () => {
      expect(validateVoteChoice(1)).toBe(false);
      expect(validateVoteChoice(null)).toBe(false);
    });
  });

  describe('validateBotId', () => {
    it('should accept valid bot IDs (1-63)', () => {
      expect(validateBotId(1)).toBe(true);
      expect(validateBotId(50)).toBe(true);
      expect(validateBotId(63)).toBe(true);
    });

    it('should accept numeric strings', () => {
      expect(validateBotId('1')).toBe(true);
      expect(validateBotId('63')).toBe(true);
    });

    it('should reject 0', () => {
      expect(validateBotId(0)).toBe(false);
      expect(validateBotId('0')).toBe(false);
    });

    it('should reject values > 63', () => {
      expect(validateBotId(64)).toBe(false);
      expect(validateBotId(1000)).toBe(false);
    });

    it('should reject negative values', () => {
      expect(validateBotId(-1)).toBe(false);
    });

    it('should reject non-numeric values', () => {
      expect(validateBotId('abc')).toBe(false);
      expect(validateBotId(null)).toBe(false);
    });
  });
});
