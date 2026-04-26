import { describe, it, expect } from 'vitest';
import {
  createSHA256Commitment,
  verifySHA256Commitment,
  sha256MerkleNode,
  choiceToNumber,
  numberToChoice,
} from './sha256Commitment';

const TEST_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

const withBufferUnavailable = <T>(fn: () => T): T => {
  const globals = globalThis as Record<string, unknown>;
  const originalBuffer = globals.Buffer;
  try {
    globals.Buffer = undefined;
    return fn();
  } finally {
    globals.Buffer = originalBuffer;
  }
};

describe('SHA256 Commitment', () => {
  describe('createSHA256Commitment', () => {
    it('should create a valid SHA256 commitment', () => {
      const choice = 0; // 'A'
      const random = new Uint8Array(32).fill(1);

      const commitment = createSHA256Commitment(TEST_ELECTION_ID, choice, random);

      expect(commitment).toHaveLength(66); // 0x prefix + 64 hex chars
      expect(commitment).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('should create different commitments for different choices', () => {
      const random = new Uint8Array(32).fill(1);

      const commitmentA = createSHA256Commitment(TEST_ELECTION_ID, 0, random);
      const commitmentB = createSHA256Commitment(TEST_ELECTION_ID, 1, random);

      expect(commitmentA).not.toBe(commitmentB);
    });

    it('should create different commitments for different randoms', () => {
      const random1 = new Uint8Array(32).fill(1);
      const random2 = new Uint8Array(32).fill(2);

      const commitment1 = createSHA256Commitment(TEST_ELECTION_ID, 0, random1);
      const commitment2 = createSHA256Commitment(TEST_ELECTION_ID, 0, random2);

      expect(commitment1).not.toBe(commitment2);
    });

    it('should throw error for invalid choice', () => {
      const random = new Uint8Array(32);

      expect(() => createSHA256Commitment(TEST_ELECTION_ID, -1, random)).toThrow('Invalid choice');
      expect(() => createSHA256Commitment(TEST_ELECTION_ID, 5, random)).toThrow('Invalid choice');
    });

    it('should throw error for invalid random length', () => {
      const wrongRandom = new Uint8Array(31);

      expect(() => createSHA256Commitment(TEST_ELECTION_ID, 0, wrongRandom)).toThrow('Random must be 32 bytes');
    });

    it('should produce deterministic results', () => {
      const choice = 2;
      const random = new Uint8Array(32).fill(42);

      const commitment1 = createSHA256Commitment(TEST_ELECTION_ID, choice, random);
      const commitment2 = createSHA256Commitment(TEST_ELECTION_ID, choice, random);

      expect(commitment1).toBe(commitment2);
    });
  });

  describe('verifySHA256Commitment', () => {
    it('should verify a valid commitment', () => {
      const choice = 0;
      const random = new Uint8Array(32).fill(1);
      const commitment = createSHA256Commitment(TEST_ELECTION_ID, choice, random);

      const isValid = verifySHA256Commitment(TEST_ELECTION_ID, commitment, choice, random);

      expect(isValid).toBe(true);
    });

    it('should reject invalid commitment', () => {
      const choice = 0;
      const random = new Uint8Array(32).fill(1);
      const fakeCommitment = 'a'.repeat(64);

      const isValid = verifySHA256Commitment(TEST_ELECTION_ID, fakeCommitment, choice, random);

      expect(isValid).toBe(false);
    });

    it('should reject wrong choice', () => {
      const choice = 0;
      const random = new Uint8Array(32).fill(1);
      const commitment = createSHA256Commitment(TEST_ELECTION_ID, choice, random);

      const isValid = verifySHA256Commitment(TEST_ELECTION_ID, commitment, 1, random);

      expect(isValid).toBe(false);
    });

    it('should reject wrong random', () => {
      const choice = 0;
      const random = new Uint8Array(32).fill(1);
      const commitment = createSHA256Commitment(TEST_ELECTION_ID, choice, random);

      const wrongRandom = new Uint8Array(32).fill(2);
      const isValid = verifySHA256Commitment(TEST_ELECTION_ID, commitment, choice, wrongRandom);

      expect(isValid).toBe(false);
    });

    it('should handle uppercase commitment', () => {
      const choice = 0;
      const random = new Uint8Array(32).fill(1);
      const commitment = createSHA256Commitment(TEST_ELECTION_ID, choice, random);

      const isValid = verifySHA256Commitment(TEST_ELECTION_ID, commitment.toUpperCase(), choice, random);

      expect(isValid).toBe(true);
    });
  });

  describe('sha256MerkleNode', () => {
    it('should create a valid Merkle node', () => {
      const left = 'a'.repeat(64);
      const right = 'b'.repeat(64);

      const node = sha256MerkleNode(left, right);

      expect(node).toHaveLength(64);
      expect(node).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce different nodes for different inputs', () => {
      const node1 = sha256MerkleNode('a'.repeat(64), 'b'.repeat(64));
      const node2 = sha256MerkleNode('c'.repeat(64), 'd'.repeat(64));

      expect(node1).not.toBe(node2);
    });

    it('should be order-sensitive', () => {
      const left = 'a'.repeat(64);
      const right = 'b'.repeat(64);

      const node1 = sha256MerkleNode(left, right);
      const node2 = sha256MerkleNode(right, left);

      expect(node1).not.toBe(node2);
    });

    it('should reject odd-length hex inputs', () => {
      expect(() => sha256MerkleNode('a', 'b'.repeat(64))).toThrow(/odd length/i);
    });

    it('should work without Node Buffer', () => {
      const node = withBufferUnavailable(() => sha256MerkleNode('a'.repeat(64), 'b'.repeat(64)));
      expect(node).toHaveLength(64);
      expect(node).toMatch(/^[0-9a-f]{64}$/);
    });
  });

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

  describe('numberToChoice', () => {
    it('should convert valid numbers to choices', () => {
      expect(numberToChoice(0)).toBe('A');
      expect(numberToChoice(1)).toBe('B');
      expect(numberToChoice(2)).toBe('C');
      expect(numberToChoice(3)).toBe('D');
      expect(numberToChoice(4)).toBe('E');
    });

    it('should throw error for invalid numbers', () => {
      expect(() => numberToChoice(-1)).toThrow('Invalid number');
      expect(() => numberToChoice(5)).toThrow('Invalid number');
    });
  });

  describe('choiceToNumber and numberToChoice round-trip', () => {
    it('should round-trip correctly', () => {
      const choices = ['A', 'B', 'C', 'D', 'E'];

      for (const choice of choices) {
        const num = choiceToNumber(choice);
        const backToChoice = numberToChoice(num);
        expect(backToChoice).toBe(choice);
      }
    });
  });
});
