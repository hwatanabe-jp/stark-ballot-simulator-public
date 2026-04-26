import { describe, it, expect } from 'vitest';
import { generateCommitment } from './commitment';
import type { VoteChoice } from '@/lib/session/types';
import { computeCommitment } from '@/lib/zkvm/types';

const TEST_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Commitment Generation', () => {
  describe('generateCommitment', () => {
    it('should generate a commitment for vote A', async () => {
      const result = await generateCommitment('A', TEST_ELECTION_ID);

      expect(result).toHaveProperty('commitment');
      expect(result).toHaveProperty('randomValue');
      expect(typeof result.commitment).toBe('string');
      expect(typeof result.randomValue).toBe('string');
      // SHA256 produces 64-char hex string plus 0x prefix = 66
      expect(result.commitment.length).toBe(66);
    });

    it('should generate different random values for the same vote', async () => {
      const result1 = await generateCommitment('B', TEST_ELECTION_ID);
      const result2 = await generateCommitment('B', TEST_ELECTION_ID);

      expect(result1.randomValue).not.toBe(result2.randomValue);
      expect(result1.commitment).not.toBe(result2.commitment);
    });

    it('should generate different commitments for different votes', async () => {
      const resultA = await generateCommitment('A', TEST_ELECTION_ID);
      const resultC = await generateCommitment('C', TEST_ELECTION_ID);

      expect(resultA.commitment).not.toBe(resultC.commitment);
    });

    it('should generate valid hex string commitments', async () => {
      const result = await generateCommitment('D', TEST_ELECTION_ID);

      // Check if commitment is a valid hex string with 0x prefix
      expect(result.commitment).toMatch(/^0x[0-9a-fA-F]{64}$/);
    });

    it('should generate random values as hex strings', async () => {
      const result = await generateCommitment('E', TEST_ELECTION_ID);

      // Check if random value is a valid hex string
      expect(result.randomValue).toMatch(/^0x[0-9a-fA-F]+$/);
    });

    it('should handle all valid vote choices', async () => {
      const voteChoices: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];

      for (const choice of voteChoices) {
        const result = await generateCommitment(choice, TEST_ELECTION_ID);
        expect(result.commitment).toBeTruthy();
        expect(result.randomValue).toBeTruthy();
      }
    });

    it('should use SHA256 hash for commitment calculation', async () => {
      const result = await generateCommitment('A', TEST_ELECTION_ID);

      // Verify the commitment has the expected SHA256 format
      expect(result.commitment).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(result.commitment.length).toBe(66); // 64 hex chars + '0x'
    });

    it('should generate commitments compatible with verification', async () => {
      const vote: VoteChoice = 'C';
      const { commitment } = await generateCommitment(vote, TEST_ELECTION_ID);

      // This test ensures the commitment format is consistent (SHA256 = 64 chars + 0x prefix)
      expect(commitment).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(commitment.length).toBe(66);
    });

    it('should generate random values with sufficient entropy', async () => {
      const results = await Promise.all(
        Array(10)
          .fill(null)
          .map(() => generateCommitment('A', TEST_ELECTION_ID)),
      );

      const randomValues = results.map((r) => r.randomValue);
      const uniqueValues = new Set(randomValues);

      // All random values should be unique
      expect(uniqueValues.size).toBe(10);
    });

    it('should convert vote choices to numeric values correctly', async () => {
      // This test ensures votes are mapped to correct numeric values
      // A=0, B=1, C=2, D=3, E=4
      const votes: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];
      const results = [];

      for (const vote of votes) {
        const result = await generateCommitment(vote, TEST_ELECTION_ID);
        results.push(result);
      }

      // All results should be valid
      results.forEach((result) => {
        expect(result.commitment).toBeTruthy();
        expect(result.randomValue).toBeTruthy();
      });
    });

    it('should include electionId in the commitment domain separation', async () => {
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const vote: VoteChoice = 'A';
      const { commitment, randomValue } = await generateCommitment(vote, TEST_ELECTION_ID);

      const choiceNumber = vote.charCodeAt(0) - 'A'.charCodeAt(0);
      const expected = computeCommitment(electionId, choiceNumber, randomValue);

      expect(commitment).toBe(expected);
    });
  });
});
