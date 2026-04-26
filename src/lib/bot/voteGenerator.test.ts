import { describe, it, expect, vi } from 'vitest';
import { generateBotVote, generateBotId } from './voteGenerator';
import { VOTE_CHOICES } from '@/shared/constants';
import { createSHA256Commitment } from '@/lib/crypto/sha256Commitment';

const TEST_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

// Mock SHA256 commitment
vi.mock('@/lib/crypto/sha256Commitment', () => ({
  createSHA256Commitment: vi.fn(),
  choiceToNumber: vi.fn((choice: string) => choice.charCodeAt(0) - 'A'.charCodeAt(0)),
}));

describe('voteGenerator', () => {
  describe('generateBotId', () => {
    it('should generate bot ID in valid range (1-63)', () => {
      // Test for all valid indices (0-62)
      for (let i = 0; i < 63; i++) {
        const botId = generateBotId(i);
        expect(botId).toBeGreaterThanOrEqual(1);
        expect(botId).toBeLessThanOrEqual(63);
      }
    });

    it('should generate unique IDs for different indices', () => {
      const ids = new Set<number>();
      for (let i = 0; i < 63; i++) {
        ids.add(generateBotId(i));
      }
      // Should have 63 unique IDs
      expect(ids.size).toBe(63);
    });
  });

  describe('generateBotVote', () => {
    it('should generate valid bot vote data', async () => {
      // Arrange
      const mockCommitment = '0x' + 'a'.repeat(64); // Hex with prefix
      vi.mocked(createSHA256Commitment).mockReturnValue(mockCommitment);
      const botId = 10;

      // Act
      const voteData = await generateBotVote(botId, TEST_ELECTION_ID);

      // Assert
      expect(voteData).toHaveProperty('vote');
      expect(voteData).toHaveProperty('rand');
      expect(voteData).toHaveProperty('commit');
      expect(voteData).toHaveProperty('path');

      expect(VOTE_CHOICES).toContain(voteData.vote);
      expect(voteData.commit).toBe(mockCommitment);
      expect(voteData.path).toEqual([]); // Empty path initially

      // Verify createSHA256Commitment was called
      expect(createSHA256Commitment).toHaveBeenCalledWith(TEST_ELECTION_ID, expect.any(Number), expect.any(Uint8Array));
    });

    it('should generate different random values for different bots', async () => {
      // Arrange
      let callCount = 0;
      vi.mocked(createSHA256Commitment).mockImplementation(() => {
        callCount++;
        return `0x${'0'.repeat(62)}${callCount.toString(16).padStart(2, '0')}`; // Different hex for each call
      });

      // Act
      const vote1 = await generateBotVote(1, TEST_ELECTION_ID);
      const vote2 = await generateBotVote(2, TEST_ELECTION_ID);

      // Assert
      expect(vote1.rand).not.toBe(vote2.rand);
      expect(vote1.commit).not.toBe(vote2.commit);
    });

    it('should generate random votes with valid structure', async () => {
      // Arrange
      vi.mocked(createSHA256Commitment).mockImplementation((_electionId, choice, random) => {
        // Create hash based on inputs
        const randomHex = Array.from(random)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return `0x${choice.toString(16).padStart(2, '0')}${randomHex.slice(0, 62)}`;
      });

      // Act
      const vote1 = await generateBotVote(10, TEST_ELECTION_ID);
      const vote2 = await generateBotVote(10, TEST_ELECTION_ID);

      // Assert
      // Each call generates a valid vote (structure is correct)
      expect(VOTE_CHOICES).toContain(vote1.vote);
      expect(VOTE_CHOICES).toContain(vote2.vote);
      expect(vote1.rand).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(vote2.rand).toMatch(/^0x[0-9a-f]{64}$/i);
      // Votes are random (may be same or different)
      expect(vote1.commit).toBeDefined();
      expect(vote2.commit).toBeDefined();
    });

    it('should distribute votes across all choices', async () => {
      // Arrange
      vi.mocked(createSHA256Commitment).mockImplementation((_electionId, choice) => {
        return `0x${choice.toString().padStart(64, '0')}`;
      });

      // Act
      const voteCounts = new Map<string, number>();
      for (let i = 1; i <= 63; i++) {
        const vote = await generateBotVote(i, TEST_ELECTION_ID);
        voteCounts.set(vote.vote, (voteCounts.get(vote.vote) || 0) + 1);
      }

      // Assert
      // All vote choices should be used
      expect(voteCounts.size).toBe(VOTE_CHOICES.length);
      VOTE_CHOICES.forEach((choice) => {
        expect(voteCounts.has(choice)).toBe(true);
      });
    });
  });
});
