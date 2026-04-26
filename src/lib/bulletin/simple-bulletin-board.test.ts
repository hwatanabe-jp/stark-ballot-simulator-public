import { describe, it, expect, beforeEach } from 'vitest';
import { SimpleBulletinBoard } from './simple-bulletin-board';
import { createHash } from 'crypto';

// Helper to create test commitments
function createTestCommitment(index: number): string {
  return createHash('sha256').update(`commitment${index}`).digest('hex');
}

// Helper to create test vote ID
function createTestVoteId(index: number): string {
  return `550e8400-e29b-41d4-a716-${index.toString().padStart(12, '0')}`;
}

describe('SimpleBulletinBoard', () => {
  let board: SimpleBulletinBoard;

  beforeEach(() => {
    board = new SimpleBulletinBoard();
  });

  describe('append operation', () => {
    it('should append votes with monotonically increasing indices', () => {
      const voteId1 = createTestVoteId(1);
      const commitment1 = createTestCommitment(1);

      const result1 = board.appendVote(voteId1, commitment1);

      expect(result1.index).toBe(0);
      expect(result1.rootAtAppend).toBeDefined();
      expect(result1.timestamp).toBeLessThanOrEqual(Date.now());

      const voteId2 = createTestVoteId(2);
      const commitment2 = createTestCommitment(2);

      const result2 = board.appendVote(voteId2, commitment2);

      expect(result2.index).toBe(1);
      expect(result2.rootAtAppend).not.toBe(result1.rootAtAppend);
    });

    it('should maintain append-only property', () => {
      const commitment1 = createTestCommitment(1);
      const commitment2 = createTestCommitment(2);
      const commitment3 = createTestCommitment(3);

      board.appendVote(createTestVoteId(1), commitment1);
      const root1 = board.getCurrentRoot();

      board.appendVote(createTestVoteId(2), commitment2);
      const root2 = board.getCurrentRoot();

      board.appendVote(createTestVoteId(3), commitment3);
      const root3 = board.getCurrentRoot();

      // Roots should be different
      expect(root1).not.toBe(root2);
      expect(root2).not.toBe(root3);
      expect(root1).not.toBe(root3);

      // Size should increase
      expect(board.getSize()).toBe(3);
    });

    it('should track commitments in order', () => {
      const commitments = [createTestCommitment(1), createTestCommitment(2), createTestCommitment(3)];

      commitments.forEach((commitment, i) => {
        board.appendVote(createTestVoteId(i), commitment);
      });

      const allCommitments = board.getCommitments();
      expect(allCommitments).toEqual(commitments);
    });
  });

  describe('vote retrieval', () => {
    it('should retrieve vote by ID', () => {
      const voteId = createTestVoteId(1);
      const commitment = createTestCommitment(1);

      const appendResult = board.appendVote(voteId, commitment);
      const voteInfo = board.getVoteById(voteId);

      expect(voteInfo).toBeDefined();
      expect(voteInfo?.voteId).toBe(voteId);
      expect(voteInfo?.commitment).toBe(commitment);
      expect(voteInfo?.index).toBe(appendResult.index);
      expect(voteInfo?.timestamp).toBe(appendResult.timestamp);
    });

    it('should return undefined for non-existent vote ID', () => {
      board.appendVote(createTestVoteId(1), createTestCommitment(1));

      const voteInfo = board.getVoteById('non-existent-id');
      expect(voteInfo).toBeUndefined();
    });

    it('should retrieve vote by index', () => {
      const commitment = createTestCommitment(1);
      board.appendVote(createTestVoteId(1), commitment);

      const voteByIndex = board.getVoteByIndex(0);
      expect(voteByIndex).toBeDefined();
      expect(voteByIndex?.commitment).toBe(commitment);
    });
  });

  describe('root history', () => {
    it('should track root history with timestamps', () => {
      const beforeTime = Date.now();

      board.appendVote(createTestVoteId(1), createTestCommitment(1));
      board.appendVote(createTestVoteId(2), createTestCommitment(2));

      const afterTime = Date.now();
      const history = board.getRootHistory();

      expect(history.length).toBe(2);

      // Check first snapshot
      expect(history[0].treeSize).toBe(1);
      expect(history[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(history[0].timestamp).toBeLessThanOrEqual(afterTime);

      // Check second snapshot
      expect(history[1].treeSize).toBe(2);
      expect(history[1].timestamp).toBeGreaterThanOrEqual(history[0].timestamp);
      expect(history[1].timestamp).toBeLessThanOrEqual(afterTime);

      // Roots should be different
      expect(history[0].root).not.toBe(history[1].root);
    });

    it('should get root at specific size', () => {
      board.appendVote(createTestVoteId(1), createTestCommitment(1));
      const root1 = board.getCurrentRoot();

      board.appendVote(createTestVoteId(2), createTestCommitment(2));
      const root2 = board.getCurrentRoot();

      board.appendVote(createTestVoteId(3), createTestCommitment(3));

      // Should be able to get historical roots
      expect(board.getRootAtSize(1)).toBe(root1);
      expect(board.getRootAtSize(2)).toBe(root2);
      expect(board.getRootAtSize(3)).toBe(board.getCurrentRoot());
    });
  });

  describe('consistency proofs', () => {
    it('should generate consistency proof between sizes', () => {
      // Add 4 votes to test consistency
      for (let i = 0; i < 4; i++) {
        board.appendVote(createTestVoteId(i), createTestCommitment(i));
      }

      const proof = board.getConsistencyProof(2, 4);

      expect(proof).toBeDefined();
      expect(proof.oldSize).toBe(2);
      expect(proof.newSize).toBe(4);
      expect(proof.proofNodes).toBeDefined();
      expect(Array.isArray(proof.proofNodes)).toBe(true);
    });

    it('should verify consistency between tree states', () => {
      // Add votes incrementally
      board.appendVote(createTestVoteId(1), createTestCommitment(1));
      board.appendVote(createTestVoteId(2), createTestCommitment(2));
      const root2 = board.getCurrentRoot();

      board.appendVote(createTestVoteId(3), createTestCommitment(3));
      board.appendVote(createTestVoteId(4), createTestCommitment(4));
      const root4 = board.getCurrentRoot();

      const proof = board.getConsistencyProof(2, 4);
      const isConsistent = board.verifyConsistency(root2, root4, proof);

      expect(isConsistent).toBe(true);
    });
  });

  describe('inclusion proofs', () => {
    it('should generate inclusion proof for a vote', () => {
      const voteId = createTestVoteId(1);
      const commitment = createTestCommitment(1);

      board.appendVote(voteId, commitment);
      board.appendVote(createTestVoteId(2), createTestCommitment(2));
      board.appendVote(createTestVoteId(3), createTestCommitment(3));

      const proof = board.getInclusionProof(voteId);

      expect(proof).toBeDefined();
      expect(proof?.leafIndex).toBe(0);
      expect(proof?.proofNodes).toBeDefined();
      expect(proof?.proofNodes.length).toBeGreaterThan(0);
      expect(proof?.treeSize).toBe(3);
      expect(proof?.rootHash).toBe(board.getCurrentRoot());
    });

    it('should verify inclusion proof', () => {
      const commitment = createTestCommitment(1);
      const voteId = createTestVoteId(1);

      board.appendVote(voteId, commitment);
      board.appendVote(createTestVoteId(2), createTestCommitment(2));
      board.appendVote(createTestVoteId(3), createTestCommitment(3));

      const proof = board.getInclusionProof(voteId);
      expect(proof).toBeDefined();

      if (proof) {
        const isIncluded = board.verifyInclusionProof(
          commitment,
          proof.leafIndex,
          proof.proofNodes,
          proof.rootHash,
          proof.treeSize,
        );

        expect(isIncluded).toBe(true);
      }
    });

    it('should reject tampered inclusion proof', () => {
      const voteId = createTestVoteId(1);
      const commitment = createTestCommitment(1);

      board.appendVote(voteId, commitment);
      board.appendVote(createTestVoteId(2), createTestCommitment(2));
      board.appendVote(createTestVoteId(3), createTestCommitment(3));

      const proof = board.getInclusionProof(voteId);
      expect(proof).toBeDefined();

      if (proof) {
        const tamperedNodes = [...proof.proofNodes];
        if (tamperedNodes.length > 0) {
          tamperedNodes[0] = `${tamperedNodes[0].slice(0, 63)}${tamperedNodes[0].endsWith('0') ? '1' : '0'}`;
        }

        const isIncluded = board.verifyInclusionProof(
          commitment,
          proof.leafIndex,
          tamperedNodes,
          proof.rootHash,
          proof.treeSize,
        );

        expect(isIncluded).toBe(false);
      }
    });
  });

  describe('duplicate prevention', () => {
    it('should reject duplicate vote IDs', () => {
      const voteId = createTestVoteId(1);

      board.appendVote(voteId, createTestCommitment(1));

      expect(() => {
        board.appendVote(voteId, createTestCommitment(2));
      }).toThrow('Vote ID already exists');
    });

    it('should reject duplicate commitments', () => {
      const commitment = createTestCommitment(1);

      board.appendVote(createTestVoteId(1), commitment);

      expect(() => {
        board.appendVote(createTestVoteId(2), commitment);
      }).toThrow('Commitment already exists');
    });

    it('should reject duplicate commitments after normalization', () => {
      const commitment = 'a'.repeat(64);

      board.appendVote(createTestVoteId(1), commitment.toUpperCase());

      expect(() => {
        board.appendVote(createTestVoteId(2), commitment);
      }).toThrow('Commitment already exists');
    });
  });

  describe('security and validation', () => {
    it('should reject invalid vote IDs', () => {
      expect(() => {
        board.appendVote('invalid-id', createTestCommitment(1));
      }).toThrow('Invalid vote ID format');
    });

    it('should reject empty commitments', () => {
      expect(() => {
        board.appendVote(createTestVoteId(1), '');
      }).toThrow('Commitment cannot be empty');
    });

    it('should reject invalid hex commitments', () => {
      expect(() => {
        board.appendVote(createTestVoteId(1), 'not-hex-string');
      }).toThrow('Invalid commitment format');
    });

    it('should reject commitments with invalid length', () => {
      expect(() => {
        board.appendVote(createTestVoteId(1), 'a'.repeat(62));
      }).toThrow('Invalid commitment format');

      expect(() => {
        board.appendVote(createTestVoteId(2), 'b'.repeat(66));
      }).toThrow('Invalid commitment format');
    });
  });

  describe('performance', () => {
    it('should handle large number of votes efficiently', () => {
      const startTime = performance.now();
      const numVotes = 1000;

      for (let i = 0; i < numVotes; i++) {
        board.appendVote(createTestVoteId(i), createTestCommitment(i));
      }

      const endTime = performance.now();
      const duration = endTime - startTime;

      expect(board.getSize()).toBe(numVotes);
      expect(duration).toBeLessThan(1000); // Should complete in less than 1 second

      // Verify consistency of the tree
      const proof = board.getConsistencyProof(500, 1000);
      expect(proof).toBeDefined();
    });
  });
});
