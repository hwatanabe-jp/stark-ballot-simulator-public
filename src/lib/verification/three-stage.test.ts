import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  verifyCastAsIntended,
  verifyRecordedAsCast,
  verifyCountedAsRecorded,
  performFullVerification,
} from './three-stage';
import type { VoteReceipt } from '@/types/receipt';
import type { BulletinBoard } from '@/types/bulletin';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import { computeCommitment, CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import type { VoteChoice } from '@/shared/constants';
import { RFC6962MerkleTree } from '@/lib/merkle/rfc6962-merkle-tree';
import { createTestJournal } from '@/lib/testing/test-helpers';

const verifyConsistencyProofMock = vi
  .spyOn(RFC6962MerkleTree.prototype, 'verifyConsistencyProof')
  .mockReturnValue(true);
const fetchMock = vi.fn();

// Extended types for testing
interface TestVoteReceipt extends VoteReceipt {
  choice?: number;
  random?: string;
}

interface TestZkVMResult extends ZkVMJournal {
  inputBulletinRoot?: string;
}

describe('E2E Three-Stage Verification', () => {
  let receipt: TestVoteReceipt;
  let bulletin: BulletinBoard;
  let zkResult: TestZkVMResult;
  let electionId: string;
  let userChoice: VoteChoice;
  let randomValue: string;
  let castContext: { electionId: string; choice: VoteChoice; random: string };

  beforeEach(() => {
    verifyConsistencyProofMock.mockReset();
    verifyConsistencyProofMock.mockReturnValue(true);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    // Setup test data
    electionId = '550e8400-e29b-41d4-a716-446655440001';
    userChoice = 'A';
    randomValue = '0x' + 'd'.repeat(64);
    const choiceIndex = 0;
    const correctCommitment = computeCommitment(electionId, choiceIndex, randomValue);

    castContext = {
      electionId,
      choice: userChoice,
      random: randomValue,
    };

    receipt = {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commitment: correctCommitment, // Use the correct commitment
      bulletinIndex: 0,
      bulletinRootAtCast: '0x' + 'b'.repeat(64),
      inputCommitment: '0x' + 'c'.repeat(64),
      timestamp: Date.now(),
      choice: choiceIndex, // test helper metadata
      random: randomValue,
    };

    bulletin = {
      commitments: [correctCommitment, '0x' + 'e'.repeat(64)], // Include the correct commitment
      bulletinRoot: '0x' + 'b'.repeat(64),
      treeSize: 2,
      timestamp: Date.now(),
      rootHistory: [],
    };

    zkResult = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        seenIndicesCount: 1,
      }),
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'c'.repeat(64),
      bulletinRoot: '0x' + 'b'.repeat(64),
      treeSize: 1,
      totalExpected: 1,
      sthDigest: '0x' + 'd'.repeat(64),
      verifiedTally: [1, 0, 0, 0, 0],
      totalVotes: 1,
      validVotes: 1,
      invalidVotes: 0,
      seenIndicesCount: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      includedBitmapRoot: '0x' + 'e'.repeat(64),
      excludedSlots: 0,
      inputCommitment: '0x' + 'f'.repeat(64),
      methodVersion: CURRENT_METHOD_VERSION,
      inputBulletinRoot: '0x' + 'b'.repeat(64),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Cast-as-Intended', () => {
    it('should verify valid commitment', async () => {
      const result = await verifyCastAsIntended(receipt, castContext);
      if (!result.passed) {
        console.log('Test failed with error:', result.error);
      }
      expect(result.passed).toBe(true);
      expect(result.stage).toBe('Cast-as-Intended');
    });

    it('should fail with invalid commitment', async () => {
      receipt.commitment = '0x' + 'f'.repeat(64); // Wrong commitment
      const result = await verifyCastAsIntended(receipt, castContext);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Commitment mismatch');
    });

    it('should fail when random value does not match commitment', async () => {
      const result = await verifyCastAsIntended(receipt, {
        ...castContext,
        random: '0x' + 'e'.repeat(64),
      });
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Commitment mismatch');
    });

    it('should fail when electionId differs', async () => {
      const result = await verifyCastAsIntended(receipt, {
        ...castContext,
        electionId: '550e8400-e29b-41d4-a716-446655440099',
      });
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Commitment mismatch');
    });
  });

  describe('Recorded-as-Cast', () => {
    it('should verify bulletin board inclusion', async () => {
      const result = await verifyRecordedAsCast(receipt, bulletin);
      expect(result.passed).toBe(true);
      expect(result.stage).toBe('Recorded-as-Cast');
    });

    it('should fail if commitment not in bulletin', async () => {
      bulletin.commitments = ['0x' + 'x'.repeat(64)]; // Different commitment
      const result = await verifyRecordedAsCast(receipt, bulletin);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('not found in bulletin');
    });

    it('should detect bulletin root mismatch', async () => {
      bulletin.bulletinRoot = '0x' + 'z'.repeat(64); // Different root
      const result = await verifyRecordedAsCast(receipt, bulletin);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Root mismatch');
    });

    it('should handle 0x prefix inconsistencies: receipt with 0x, bulletin without', async () => {
      // receipt.bulletinRootAtCast has 0x prefix
      receipt.bulletinRootAtCast = '0x' + 'b'.repeat(64);
      // bulletin.bulletinRoot without 0x prefix
      bulletin.bulletinRoot = 'b'.repeat(64);

      const result = await verifyRecordedAsCast(receipt, bulletin);
      expect(result.passed).toBe(true); // Should normalize and match
      expect(result.stage).toBe('Recorded-as-Cast');
    });

    it('should handle 0x prefix inconsistencies: receipt without 0x, bulletin with', async () => {
      // receipt.bulletinRootAtCast without 0x prefix
      receipt.bulletinRootAtCast = 'b'.repeat(64);
      // bulletin.bulletinRoot with 0x prefix
      bulletin.bulletinRoot = '0x' + 'b'.repeat(64);

      const result = await verifyRecordedAsCast(receipt, bulletin);
      expect(result.passed).toBe(true); // Should normalize and match
      expect(result.stage).toBe('Recorded-as-Cast');
    });

    it('should handle 0x prefix inconsistencies in rootHistory', async () => {
      // Set up mismatched current roots to trigger history check
      receipt.bulletinRootAtCast = '0x' + 'a'.repeat(64);
      bulletin.bulletinRoot = '0x' + 'b'.repeat(64);

      // Add matching root in history without 0x prefix
      bulletin.rootHistory = [{ bulletinRoot: 'a'.repeat(64), timestamp: Date.now() - 1000, treeSize: 1 }];

      const result = await verifyRecordedAsCast(receipt, bulletin);
      expect(result.passed).toBe(true); // Should find in history after normalization
      expect(result.stage).toBe('Recorded-as-Cast');
    });
  });

  describe('Counted-as-Recorded', () => {
    it('should verify zkVM processing', async () => {
      const result = await verifyCountedAsRecorded(zkResult);
      expect(result.passed).toBe(true);
      expect(result.stage).toBe('Counted-as-Recorded');
    });

    it('should detect bulletin root mismatch in zkVM', async () => {
      zkResult.inputBulletinRoot = '0x' + 'y'.repeat(64); // Different input root
      const result = await verifyCountedAsRecorded(zkResult);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Bulletin root mismatch');
    });

    it('should handle 0x prefix inconsistencies: bulletinRoot with 0x, inputBulletinRoot without', async () => {
      // zkResult.bulletinRoot with 0x prefix
      zkResult.bulletinRoot = '0x' + 'b'.repeat(64);
      // zkResult.inputBulletinRoot without 0x prefix
      zkResult.inputBulletinRoot = 'b'.repeat(64);

      const result = await verifyCountedAsRecorded(zkResult);
      expect(result.passed).toBe(true); // Should normalize and match
      expect(result.stage).toBe('Counted-as-Recorded');
    });

    it('should handle 0x prefix inconsistencies: bulletinRoot without 0x, inputBulletinRoot with', async () => {
      // zkResult.bulletinRoot without 0x prefix
      zkResult.bulletinRoot = 'b'.repeat(64);
      // zkResult.inputBulletinRoot with 0x prefix
      zkResult.inputBulletinRoot = '0x' + 'b'.repeat(64);

      const result = await verifyCountedAsRecorded(zkResult);
      expect(result.passed).toBe(true); // Should normalize and match
      expect(result.stage).toBe('Counted-as-Recorded');
    });

    it('should detect invalid vote count', async () => {
      zkResult.totalVotes = 0; // No votes processed
      const result = await verifyCountedAsRecorded(zkResult);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('No votes processed');
    });

    it('should fail when excludedSlots is not a finite number', async () => {
      zkResult.excludedSlots = Number.NaN;

      const result = await verifyCountedAsRecorded(zkResult);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('Invalid zkVM journal');
    });

    it('should fail when missingSlots > 0 (incomplete tally)', async () => {
      zkResult.missingSlots = 5; // 5 indices not presented to the guest
      zkResult.validVotes = 0;
      zkResult.seenIndicesCount = 59;
      zkResult.totalVotes = 59;
      zkResult.excludedSlots = zkResult.missingSlots + zkResult.invalidPresentedSlots;

      const result = await verifyCountedAsRecorded(zkResult);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Conservative exclusion signal detected');
      expect(result.error).toContain('5 unpresented indices');
      expect(result.details?.severity).toBe('critical');
    });

    it('should warn about totalExpected vs treeSize mismatch', async () => {
      zkResult.totalExpected = 100;
      zkResult.treeSize = 90; // 10 fewer than expected

      const result = await verifyCountedAsRecorded(zkResult);
      expect(result.passed).toBe(true); // Not a failure, just a warning
      expect(result.details?.warnings).toContainEqual(expect.stringContaining('Expected 100 votes but tree has 90'));
    });

    it('should fail when invalidPresentedSlots > 0 and update details', async () => {
      zkResult.invalidPresentedSlots = 3; // 3 presented records failed verification
      zkResult.rejectedRecords = 3;
      zkResult.excludedSlots = zkResult.missingSlots + zkResult.invalidPresentedSlots;
      zkResult.validVotes = 61; // Only 61 valid votes
      zkResult.invalidVotes = 3;
      // Update verifiedTally to match validVotes
      zkResult.verifiedTally = [12, 12, 12, 12, 13]; // Total = 61

      const result = await verifyCountedAsRecorded(zkResult);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Conservative exclusion signal detected');
      expect(result.error).toContain('3 presented slots failed counting');
      expect(result.details?.invalidPresentedSlots).toBe(3);
      expect(result.details?.excludedSlots).toBe(3);
    });

    it('should fail when invalidPresentedSlots > 0 even if missingSlots is 0', async () => {
      zkResult.missingSlots = 0;
      zkResult.invalidPresentedSlots = 2;
      zkResult.rejectedRecords = 2;
      zkResult.validVotes = 62;
      zkResult.invalidVotes = 2;
      zkResult.verifiedTally = [12, 12, 12, 12, 14]; // Sum = 62
      zkResult.excludedSlots = zkResult.missingSlots + zkResult.invalidPresentedSlots;

      const result = await verifyCountedAsRecorded(zkResult);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('Conservative exclusion signal detected');
      expect(result.error).toContain('2 presented slots failed counting');
      expect(result.details?.invalidPresentedSlots).toBe(2);
    });
  });

  describe('Full E2E Verification', () => {
    // Mock fetch for consistency proof tests
    beforeEach(() => {
      process.env.NEXT_PUBLIC_STH_SOURCES = 'https://auditor1.example/sth,https://auditor2.example/sth';
    });

    afterEach(() => {
      delete process.env.NEXT_PUBLIC_STH_SOURCES;
    });

    it('should pass all three stages', async () => {
      const stage1 = await verifyCastAsIntended(receipt, castContext);
      const stage2 = await verifyRecordedAsCast(receipt, bulletin);
      const stage3 = await verifyCountedAsRecorded(zkResult);

      expect(stage1.passed).toBe(true);
      expect(stage2.passed).toBe(true);
      expect(stage3.passed).toBe(true);
    });

    it('should detect tampering at any stage', async () => {
      // Tamper with bulletin
      bulletin.commitments = [];

      const stage1 = await verifyCastAsIntended(receipt, castContext);
      const stage2 = await verifyRecordedAsCast(receipt, bulletin);
      await verifyCountedAsRecorded(zkResult); // Stage 3 independent

      expect(stage1.passed).toBe(true); // Stage 1 still passes
      expect(stage2.passed).toBe(false); // Stage 2 fails
      // Stage 3 independent of stage 2 in this test
    });

    it('should perform comprehensive verification with consistency proof', async () => {
      // Mock successful consistency proof
      const consistencyProofResponse = {
        oldSize: 1,
        newSize: 64,
        rootAtOldSize: receipt.bulletinRootAtCast,
        rootAtNewSize: zkResult.bulletinRoot,
        proofNodes: ['0x111', '0x222'],
        timestamp: Date.now(),
      };
      const sthResponse = {
        sthDigest: zkResult.sthDigest,
        treeSize: zkResult.treeSize,
        bulletinRoot: zkResult.bulletinRoot,
      };

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(consistencyProofResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        });

      const result = await performFullVerification('test-session', receipt, bulletin, zkResult, castContext);

      expect(result.allPassed).toBe(true);
      expect(result.canShowVerified).toBe(true);
      expect(result.stages).toHaveLength(3);
      expect(result.displayStatus.status).toBe('verified');
      expect(result.displayStatus.color).toBe('green');
    });

    it('should not show verified when missingSlots > 0', async () => {
      // Mock successful consistency proof
      const consistencyProofResponse = {
        oldSize: 1,
        newSize: 64,
        rootAtOldSize: receipt.bulletinRootAtCast,
        rootAtNewSize: zkResult.bulletinRoot,
        proofNodes: ['0x111'],
        timestamp: Date.now(),
      };
      const sthResponse = {
        sthDigest: zkResult.sthDigest,
        treeSize: zkResult.treeSize,
        bulletinRoot: zkResult.bulletinRoot,
      };

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(consistencyProofResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        });

      // Set missingSlots > 0
      zkResult.missingSlots = 10;
      zkResult.validVotes = 0;
      zkResult.seenIndicesCount = 54;
      zkResult.excludedSlots = zkResult.missingSlots + zkResult.invalidPresentedSlots;

      const result = await performFullVerification('test-session', receipt, bulletin, zkResult, castContext);

      expect(result.allPassed).toBe(false);
      expect(result.canShowVerified).toBe(false);
      expect(result.displayStatus.status).toBe('failed');
      expect(result.displayStatus.color).toBe('red');
      expect(result.displayStatus.message).toContain('Conservative exclusion signal detected');
    });

    it('should not show verified when consistency proof fails', async () => {
      // Mock failed consistency proof
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      });

      const result = await performFullVerification('test-session', receipt, bulletin, zkResult, castContext);

      expect(result.allPassed).toBe(false);
      expect(result.canShowVerified).toBe(false);
      expect(result.integrityResult?.consistencyProofValid).toBe(false);
      expect(result.displayStatus.status).toBe('failed');
      expect(result.displayStatus.message).toContain('Consistency proof verification failed');
    });
  });
});
