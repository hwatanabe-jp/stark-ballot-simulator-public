/**
 * Tests for consistency proof verification
 * Following RFC 6962 Certificate Transparency specification
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyConsistencyProof, checkCompleteness } from '../consistency-verifier';
import type { AdmittedConsistencyProof } from '../consistency-proof-types';
import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import { createTestJournal } from './test-helpers';

const verifyConsistencyProofMock = vi
  .spyOn(RFC6962MerkleTree.prototype, 'verifyConsistencyProof')
  .mockReturnValue(true);

describe('consistency-verifier', () => {
  type JournalOverrides = Partial<ZkVMJournal>;

  const createJournal = (overrides: JournalOverrides = {}): ZkVMJournal => ({
    ...(() => {
      const baseJournal: ZkVMJournal = {
        ...createTestJournal({
          totalExpected: 100,
          validVotes: 100,
          missingSlots: 0,
          invalidPresentedSlots: 0,
          seenIndicesCount: 100,
        }),
        electionId: 'test-election',
        electionConfigHash: '0xhash',
        bulletinRoot: '0xroot',
        treeSize: 100,
        totalExpected: 100,
        sthDigest: '0xsth',
        verifiedTally: [20, 20, 20, 20, 20],
        totalVotes: 100,
        validVotes: 100,
        invalidVotes: 0,
        seenIndicesCount: 100,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        includedBitmapRoot: '0xbitmap',
        excludedSlots: 0,
        inputCommitment: '0xinput',
        methodVersion: CURRENT_METHOD_VERSION,
        ...overrides,
      };

      const validVotes = typeof overrides.validVotes === 'number' ? overrides.validVotes : baseJournal.validVotes;
      const invalidVotes =
        typeof overrides.invalidVotes === 'number' ? overrides.invalidVotes : baseJournal.invalidVotes;
      const missingSlots =
        typeof overrides.missingSlots === 'number' ? overrides.missingSlots : baseJournal.missingSlots;
      const invalidPresentedSlots =
        typeof overrides.invalidPresentedSlots === 'number'
          ? overrides.invalidPresentedSlots
          : baseJournal.invalidPresentedSlots;
      const rejectedRecords =
        typeof overrides.rejectedRecords === 'number' ? overrides.rejectedRecords : baseJournal.rejectedRecords;
      const excludedSlots =
        typeof overrides.excludedSlots === 'number' ? overrides.excludedSlots : missingSlots + invalidPresentedSlots;
      const seenIndicesCount =
        typeof overrides.seenIndicesCount === 'number'
          ? overrides.seenIndicesCount
          : validVotes + invalidPresentedSlots;
      const totalVotes = typeof overrides.totalVotes === 'number' ? overrides.totalVotes : validVotes + rejectedRecords;

      const normalizedJournal: ZkVMJournal = {
        ...baseJournal,
        validVotes,
        invalidVotes,
        missingSlots,
        invalidPresentedSlots,
        rejectedRecords,
        excludedSlots,
        seenIndicesCount,
        totalVotes,
      };

      return normalizedJournal;
    })(),
  });

  afterEach(() => {
    vi.clearAllMocks();
    verifyConsistencyProofMock.mockReset();
    verifyConsistencyProofMock.mockReturnValue(true);
  });

  describe('verifyConsistencyProof', () => {
    const mockOldSize = 10;
    const mockNewSize = 20;

    it('should verify valid consistency proof', () => {
      // Arrange
      const mockResponse: AdmittedConsistencyProof = {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: '0xabc123',
        rootAtToTreeSize: '0xdef456',
        proofNodes: ['0x111', '0x222', '0x333'],
        generatedAtMs: Date.now(),
      };

      // Act
      const result = verifyConsistencyProof(mockResponse, {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: mockResponse.rootAtFromTreeSize,
        rootAtToTreeSize: mockResponse.rootAtToTreeSize,
      });

      // Assert
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(verifyConsistencyProofMock).toHaveBeenCalledWith('abc123', 'def456', {
        oldSize: mockOldSize,
        newSize: mockNewSize,
        proofNodes: ['111', '222', '333'],
      });
    });

    it('passes the admitted tree sizes to the RFC 6962 verifier', () => {
      const mockResponse: AdmittedConsistencyProof = {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: '0xabc123',
        rootAtToTreeSize: '0xdef456',
        proofNodes: ['0x111'],
        generatedAtMs: Date.now(),
      };

      verifyConsistencyProof(mockResponse, {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: mockResponse.rootAtFromTreeSize,
        rootAtToTreeSize: mockResponse.rootAtToTreeSize,
      });

      expect(verifyConsistencyProofMock).toHaveBeenCalledWith('abc123', 'def456', {
        oldSize: mockOldSize,
        newSize: mockNewSize,
        proofNodes: ['111'],
      });
    });

    it('should detect root mismatch (split-view attack)', () => {
      // Arrange
      const mockResponse: AdmittedConsistencyProof = {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: '0xabc123',
        rootAtToTreeSize: '0xdef456',
        proofNodes: ['0x111', '0x222'],
        generatedAtMs: Date.now(),
      };

      // Act - providing different expected roots
      const result = verifyConsistencyProof(mockResponse, {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: '0xwrong123',
        rootAtToTreeSize: mockResponse.rootAtToTreeSize,
      });

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Root mismatch');
      expect(result.details?.type).toBe('split-view-attack');
    });

    it('rejects a proof response whose tree-size range differs from the expected range', () => {
      const mockResponse: AdmittedConsistencyProof = {
        fromTreeSize: mockOldSize - 1,
        toTreeSize: mockNewSize + 1,
        rootAtFromTreeSize: '0xabc123',
        rootAtToTreeSize: '0xdef456',
        proofNodes: ['0x111', '0x222'],
        generatedAtMs: Date.now(),
      };

      const result = verifyConsistencyProof(mockResponse, {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: mockResponse.rootAtFromTreeSize,
        rootAtToTreeSize: mockResponse.rootAtToTreeSize,
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('tree-size range');
      expect(result.details?.type).toBe('proof-invalid');
    });

    it('should handle RFC 6962 verifier errors gracefully', () => {
      verifyConsistencyProofMock.mockImplementationOnce(() => {
        throw new Error('verifier unavailable');
      });

      const proof: AdmittedConsistencyProof = {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: '0xabc123',
        rootAtToTreeSize: '0xdef456',
        proofNodes: ['0x111'],
        generatedAtMs: Date.now(),
      };

      const result = verifyConsistencyProof(proof, {
        fromTreeSize: mockOldSize,
        toTreeSize: mockNewSize,
        rootAtFromTreeSize: proof.rootAtFromTreeSize,
        rootAtToTreeSize: proof.rootAtToTreeSize,
      });

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('verifier unavailable');
    });
  });

  describe('checkCompleteness', () => {
    it('should pass when missingSlots is 0', () => {
      // Arrange
      const journal = createJournal();

      // Act
      const result = checkCompleteness(journal);

      // Assert
      expect(result.isComplete).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should fail when missingSlots > 0', () => {
      // Arrange
      const journal = createJournal({
        verifiedTally: [18, 19, 20, 20, 18],
        totalVotes: 95,
        validVotes: 95,
        seenIndicesCount: 95,
        missingSlots: 5,
        excludedSlots: 5,
      });

      // Act
      const result = checkCompleteness(journal);

      // Assert
      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('Conservative exclusion signal detected');
      expect(result.error).toContain('5 unpresented slots');
      expect(result.severity).toBe('critical');
    });

    it('should fail when excludedSlots is not a finite number', () => {
      const journal = createJournal({ excludedSlots: Number.NaN });

      const result = checkCompleteness(journal);

      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('Invalid zkVM journal');
      expect(result.severity).toBe('critical');
    });

    it('should fail when totalExpected is missing', () => {
      const journal = createJournal({ totalExpected: undefined as unknown as number });

      const result = checkCompleteness(journal);

      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('totalExpected');
      expect(result.severity).toBe('critical');
    });

    it('should fail when treeSize is invalid', () => {
      const journal = createJournal({ treeSize: -1 });

      const result = checkCompleteness(journal);

      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('treeSize');
      expect(result.severity).toBe('critical');
    });

    it('should fail closed when totalExpected differs from treeSize', () => {
      // Arrange
      const journal = createJournal({
        treeSize: 90,
        totalExpected: 100,
        verifiedTally: [18, 18, 18, 18, 18],
        totalVotes: 90,
        validVotes: 90,
        seenIndicesCount: 90,
      });

      // Act
      const result = checkCompleteness(journal);

      // Assert
      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('Expected 100 votes but tree only has 90');
      expect(result.severity).toBe('critical');
    });
  });
});
