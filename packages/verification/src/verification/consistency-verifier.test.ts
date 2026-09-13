/**
 * Tests for consistency proof verification
 * Following RFC 6962 Certificate Transparency specification
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyConsistencyProof } from './consistency-verifier';
import type { AdmittedConsistencyProof } from './consistency-proof-types';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';

const verifyConsistencyProofMock = vi
  .spyOn(RFC6962MerkleTree.prototype, 'verifyConsistencyProof')
  .mockReturnValue(true);

describe('consistency-verifier', () => {
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
});
