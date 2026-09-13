import { describe, expect, it } from 'vitest';
import { choiceToNumber } from './sha256Commitment';

describe('vote choice encoding', () => {
  describe('choiceToNumber', () => {
    it('should convert valid choices to numbers', () => {
      expect(choiceToNumber('A')).toBe(0);
      expect(choiceToNumber('B')).toBe(1);
      expect(choiceToNumber('C')).toBe(2);
      expect(choiceToNumber('D')).toBe(3);
      expect(choiceToNumber('E')).toBe(4);
    });

    it('should throw error for invalid choices', () => {
      expect(() => choiceToNumber('F')).toThrow('Invalid choice');
      expect(() => choiceToNumber('a')).toThrow('Invalid choice');
      expect(() => choiceToNumber('AB')).toThrow('Invalid choice');
      expect(() => choiceToNumber('')).toThrow('Invalid choice');
    });
  });
});
