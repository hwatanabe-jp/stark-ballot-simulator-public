import { describe, it, expect, beforeAll } from 'vitest';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { generateVoteId } from '@/lib/vote/voteId';
import type { ZkVMInput, VoteWithProof } from '@/lib/zkvm/types';
import { computeCommitment, computeInputCommitment } from '@/lib/zkvm/types';
import { choiceToNumber } from '@/lib/crypto/sha256Commitment';
import { BOT_COUNT } from '@/shared/constants';

const ZERO_HASH = '0x' + '00'.repeat(32);

function padRandom(value: number): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

describe('Data Format Consistency Tests', () => {
  const electionId = '550e8400-e29b-41d4-a716-446655440000';
  const baseTimestamp = 1_700_000_000_000;

  beforeAll(() => {
    process.env.RISC0_DEV_MODE = '1';
  });

  describe('Commitment Format Consistency', () => {
    it('should produce valid commitments and CT proofs for zkVM input', () => {
      const bulletin = new SimpleBulletinBoard();
      const rawVotes: Array<{
        index: number;
        choice: number;
        random: string;
        commitment: string;
        voteId: string;
      }> = [];

      const userChoice = choiceToNumber('A');
      const userRandom = padRandom(0x1234);
      const userCommitment = computeCommitment(electionId, userChoice, userRandom);

      rawVotes.push({
        index: 0,
        choice: userChoice,
        random: userRandom,
        commitment: userCommitment,
        voteId: generateVoteId(),
      });
      bulletin.appendVote(rawVotes[0].voteId, userCommitment);

      for (let i = 0; i < BOT_COUNT; i++) {
        const choice = i % 5;
        const random = padRandom(i + 1000);
        const commitment = computeCommitment(electionId, choice, random);

        const voteId = generateVoteId();
        rawVotes.push({ index: i + 1, choice, random, commitment, voteId });
        bulletin.appendVote(voteId, commitment);
      }

      const votes: VoteWithProof[] = rawVotes.map(({ index, choice, random, commitment, voteId }) => {
        const proof = bulletin.getInclusionProof(voteId);
        if (!proof) {
          throw new Error(`Missing proof for vote ${voteId}`);
        }

        return {
          choice,
          random,
          commitment,
          index,
          merklePath: proof.proofNodes.map((sibling) => `0x${sibling}`),
        };
      });

      const input: ZkVMInput = {
        votes,
        bulletinRoot: `0x${bulletin.getCurrentRoot()}`,
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId,
        electionConfigHash: ZERO_HASH,
        logId: ZERO_HASH,
        timestamp: baseTimestamp,
      };

      expect(votes.length).toBe(1 + BOT_COUNT);
      votes.forEach((vote) => {
        expect(vote.commitment).toMatch(/^0x[0-9a-f]{64}$/);
        expect(vote.random).toMatch(/^0x[0-9a-f]{64}$/);
        expect(vote.index).toBeGreaterThanOrEqual(0);
        expect(vote.index).toBeLessThan(votes.length);
      });

      const inputCommitment = computeInputCommitment(input);
      expect(inputCommitment).toMatch(/^0x[0-9a-f]{64}$/);

      const proofForFirst = bulletin.getInclusionProof(rawVotes[0].voteId);
      if (!proofForFirst) {
        throw new Error('Missing proof for first vote');
      }
      const isValid = bulletin.verifyInclusionProof(
        userCommitment.slice(2),
        proofForFirst.leafIndex,
        proofForFirst.proofNodes,
        bulletin.getCurrentRoot(),
        proofForFirst.treeSize,
      );
      expect(isValid).toBe(true);
    });
  });

  describe('Merkle Root Format Conversion', () => {
    it('should correctly convert BigInt merkle root to hex and back', () => {
      const testCases = [
        BigInt('0'),
        BigInt('1'),
        BigInt('255'),
        BigInt('12345678901234567890'),
        BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
      ];

      testCases.forEach((original) => {
        const hex = '0x' + original.toString(16);
        const restored = BigInt(hex);
        expect(restored).toBe(original);
      });
    });

    it('should handle merkle root byte conversion correctly', () => {
      const merkleRootDecimal = '12345678901234567890123456789012345678901234567890';
      const merkleRootBigInt = BigInt(merkleRootDecimal);
      const merkleRootHex = '0x' + merkleRootBigInt.toString(16);

      const cleanHex = merkleRootHex.slice(2);
      const paddedHex = cleanHex.padStart(64, '0');
      const bytes: number[] = [];
      for (let i = 0; i < paddedHex.length; i += 2) {
        bytes.push(parseInt(paddedHex.substr(i, 2), 16));
      }

      let reconstructed = BigInt(0);
      for (const byte of bytes) {
        reconstructed = (reconstructed << BigInt(8)) | BigInt(byte);
      }

      expect(reconstructed).toBe(merkleRootBigInt);
    });
  });

  describe('Vote Choice Encoding', () => {
    it('should correctly encode vote choices', () => {
      const choices = ['A', 'B', 'C', 'D', 'E'];
      const expectedValues = [0, 1, 2, 3, 4];

      choices.forEach((choice, index) => {
        const encoded = choice.charCodeAt(0) - 'A'.charCodeAt(0);
        expect(encoded).toBe(expectedValues[index]);
      });
    });
  });
});
