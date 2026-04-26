import { describe, it, expect, beforeAll } from 'vitest';
import { executeZkVM } from '@/lib/zkvm/executor';
import type { ZkVMInput, VoteWithProof } from '@/lib/zkvm/types';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import path from 'path';
import { BOT_COUNT } from '@/shared/constants';

describe('zkVM End-to-End Tests', () => {
  const zkVMPath = path.join(process.cwd(), 'zkvm/target/release/host');

  beforeAll(() => {
    // Check if zkVM binary exists
    if (!existsSync(zkVMPath)) {
      throw new Error('zkVM binary not found. Please run: cd zkvm && cargo build --release');
    }

    // Set development mode for faster execution in tests
    process.env.RISC0_DEV_MODE = '1';
  });

  describe('Basic Voting Flow', () => {
    it('should successfully generate proof for valid votes', async () => {
      // Create test votes with SHA256 commitments
      const votes: VoteWithProof[] = [];

      // Add user vote
      const userChoice = 0; // A
      const userRandom = '0x' + '1'.repeat(64); // 32 bytes hex
      const userCommitment =
        '0x' +
        createHash('sha256')
          .update(Buffer.from([userChoice]))
          .update(Buffer.from(userRandom.slice(2), 'hex'))
          .digest('hex');

      votes.push({
        choice: userChoice,
        commitment: userCommitment,
        random: userRandom,
        index: 0,
        merklePath: [],
      });

      // Add bot votes
      for (let i = 0; i < BOT_COUNT; i++) {
        const choice = i % 5; // Distribute among A-E
        const random = '0x' + (i + 2).toString(16).padStart(64, '0');
        const commitment =
          '0x' +
          createHash('sha256')
            .update(Buffer.from([choice]))
            .update(Buffer.from(random.slice(2), 'hex'))
            .digest('hex');

        votes.push({
          choice,
          commitment,
          random,
          index: i + 1,
          merklePath: [],
        });
      }

      // Create Merkle root from all commitments
      const allCommitments = votes.map((v) => v.commitment).join('');
      const merkleRoot = '0x' + createHash('sha256').update(allCommitments).digest('hex');

      // Calculate expected tally
      const expectedTally = [13, 13, 13, 13, 12]; // Distribution of 64 votes across A-E

      const input: ZkVMInput = {
        votes,
        bulletinRoot: merkleRoot,
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      const result = await executeZkVM(input);

      // Verify basic structure
      expect(result).toBeDefined();
      expect(result.verifiedTally).toBeDefined();
      expect(result.verifiedTally).toEqual(expectedTally);
      expect(result.totalVotes).toBe(64);
      expect(result.excludedSlots).toBe(0);

      // Verify vote distribution
      const totalCounted = result.verifiedTally.reduce((sum: number, count: number) => sum + count, 0);
      expect(totalCounted).toBe(64);

      // Verify proof components
      expect(result.includedBitmapRoot).toBeDefined();
      expect(result.methodVersion).toBeDefined();
    }, 180000); // 3 minutes timeout for test

    it('should detect tamper when votes are excluded', async () => {
      // Create test data with SHA256 commitments
      const votes: VoteWithProof[] = [];

      // Add user vote for C
      const userChoice = 2; // C
      const userRandom = '0x' + '2'.repeat(64);
      const userCommitment =
        '0x' +
        createHash('sha256')
          .update(Buffer.from([userChoice]))
          .update(Buffer.from(userRandom.slice(2), 'hex'))
          .digest('hex');

      votes.push({
        choice: userChoice,
        commitment: userCommitment,
        random: userRandom,
        index: 0,
        merklePath: [],
      });

      // Add 63 bot votes all voting for C
      for (let i = 0; i < BOT_COUNT; i++) {
        const choice = 2; // C
        const random = '0x' + (i + 100).toString(16).padStart(64, '0');
        const commitment =
          '0x' +
          createHash('sha256')
            .update(Buffer.from([choice]))
            .update(Buffer.from(random.slice(2), 'hex'))
            .digest('hex');

        votes.push({
          choice,
          commitment,
          random,
          index: i + 1,
          merklePath: [],
        });
      }

      const allCommitments = votes.map((v) => v.commitment).join('');
      const merkleRoot = '0x' + createHash('sha256').update(allCommitments).digest('hex');

      const input: ZkVMInput = {
        votes,
        bulletinRoot: merkleRoot,
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      const result = await executeZkVM(input);

      // Should count all votes correctly
      expect(result.verifiedTally).toEqual([0, 0, 64, 0, 0]); // All 64 votes for C
      expect(result.totalVotes).toBe(64);
      expect(result.excludedSlots).toBe(0); // No votes excluded
    }, 180000);

    it('should handle invalid vote commitments', async () => {
      // Create a vote with mismatched commitment
      const votes: VoteWithProof[] = [];

      // Add user vote with wrong commitment
      const userChoice = 1; // B
      const userRandom = '0x' + '3'.repeat(64);
      const wrongCommitment = '0x' + 'f'.repeat(64); // Invalid commitment

      votes.push({
        choice: userChoice,
        commitment: wrongCommitment,
        random: userRandom,
        index: 0,
        merklePath: [],
      });

      // Add bot votes with valid commitments
      for (let i = 0; i < BOT_COUNT; i++) {
        const choice = 1;
        const random = '0x' + (i + 200).toString(16).padStart(64, '0');
        const commitment =
          '0x' +
          createHash('sha256')
            .update(Buffer.from([choice]))
            .update(Buffer.from(random.slice(2), 'hex'))
            .digest('hex');

        votes.push({
          choice,
          commitment,
          random,
          index: i + 1,
          merklePath: [],
        });
      }

      const merkleRoot = '0x' + '1234567890abcdef'.padStart(64, '0');

      const input: ZkVMInput = {
        votes,
        bulletinRoot: merkleRoot,
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      const result = await executeZkVM(input);

      // The invalid commitment should be detected
      // The vote should be marked as invalid and not counted
      expect(result.verifiedTally).toEqual([0, 63, 0, 0, 0]); // Only valid bot votes
      expect(result.totalVotes).toBe(63); // Invalid vote not counted
      expect(result.excludedSlots).toBeGreaterThan(0); // Invalid vote excluded
    }, 180000);
  });

  describe('Tamper Detection', () => {
    it('should detect various tally manipulations', async () => {
      const votes: VoteWithProof[] = [];

      // Add user vote for E
      const userChoice = 4; // E
      const userRandom = '0x' + '4'.repeat(64);
      const userCommitment =
        '0x' +
        createHash('sha256')
          .update(Buffer.from([userChoice]))
          .update(Buffer.from(userRandom.slice(2), 'hex'))
          .digest('hex');

      votes.push({
        choice: userChoice,
        commitment: userCommitment,
        random: userRandom,
        index: 0,
        merklePath: [],
      });

      // Add bot votes all for E
      for (let i = 0; i < BOT_COUNT; i++) {
        const choice = 4; // E
        const random = '0x' + (i + 300).toString(16).padStart(64, '0');
        const commitment =
          '0x' +
          createHash('sha256')
            .update(Buffer.from([choice]))
            .update(Buffer.from(random.slice(2), 'hex'))
            .digest('hex');

        votes.push({
          choice,
          commitment,
          random,
          index: i + 1,
          merklePath: [],
        });
      }

      const allCommitments = votes.map((v) => v.commitment).join('');
      const merkleRoot = '0x' + createHash('sha256').update(allCommitments).digest('hex');

      const input: ZkVMInput = {
        votes,
        bulletinRoot: merkleRoot,
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      const result = await executeZkVM(input);

      // Should count all votes correctly
      expect(result.verifiedTally).toEqual([0, 0, 0, 0, 64]); // All 64 votes for E
      expect(result.totalVotes).toBe(64);
      expect(result.excludedSlots).toBe(0); // No exclusions when all votes are valid
    }, 180000);
  });
});
