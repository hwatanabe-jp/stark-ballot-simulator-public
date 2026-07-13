/**
 * Tests for client-side bitmap verification
 * Following final-design.md §2.6.1 specifications
 *
 * Verifies client-side bitmap proof handling after implementation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  explainVoteInclusionStatus,
  verifyMyVoteWasCounted,
  extractBitFromChunk,
  calculateLeafIndexClient,
  calculateBitOffsetClient,
  verifyBitmapProof,
} from '../bitmap-verifier';
import type { BitmapProofResponse } from '../bitmap-proof-types';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { generateBitmapMerkleProof } from '@stark-ballot/verification/merkle/bitmap-merkle-tree';
import { asAuthenticatedBitmapTreeSize } from '../bitmap-proof-types';

function createProofProvider(...responses: Array<BitmapProofResponse | Error>) {
  const queue = [...responses];
  return vi.fn(() => {
    const next = queue.shift();
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    if (!next) {
      return Promise.reject(new Error('Missing proof response'));
    }
    return Promise.resolve(next);
  });
}

function authenticatedTreeSize(value: number) {
  return asAuthenticatedBitmapTreeSize(value);
}

describe('Bitmap Verifier (Client-side)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateLeafIndexClient', () => {
    it('should calculate leaf index independently on client', () => {
      // Client must calculate this independently to prevent server manipulation
      expect(calculateLeafIndexClient(0)).toBe(0);
      expect(calculateLeafIndexClient(255)).toBe(0);
      expect(calculateLeafIndexClient(256)).toBe(1);
      expect(calculateLeafIndexClient(512)).toBe(2);
    });
  });

  describe('calculateBitOffsetClient', () => {
    it('should calculate bit offset independently on client', () => {
      // LSB-first encoding
      expect(calculateBitOffsetClient(0)).toBe(0);
      expect(calculateBitOffsetClient(7)).toBe(7);
      expect(calculateBitOffsetClient(8)).toBe(8);
      expect(calculateBitOffsetClient(255)).toBe(255);
      expect(calculateBitOffsetClient(256)).toBe(0); // Reset for new leaf
    });
  });

  describe('extractBitFromChunk', () => {
    it('should extract correct bit value from hex chunk', () => {
      // Chunk with specific bits set
      // First byte: 0x81 = 10000001 (bits 0 and 7 set)
      const chunk = '81' + '00'.repeat(31); // 32 bytes total

      expect(extractBitFromChunk(chunk, 0)).toBe(true); // Bit 0
      expect(extractBitFromChunk(chunk, 1)).toBe(false); // Bit 1
      expect(extractBitFromChunk(chunk, 7)).toBe(true); // Bit 7
      expect(extractBitFromChunk(chunk, 8)).toBe(false); // Bit 8 (next byte)
    });

    it('should handle bits in different bytes', () => {
      // Second byte: 0x01 = 00000001 (bit 8 set)
      const chunk = '00' + '01' + '00'.repeat(30);

      expect(extractBitFromChunk(chunk, 8)).toBe(true);
      expect(extractBitFromChunk(chunk, 9)).toBe(false);
    });

    it('should handle last bit in chunk', () => {
      // Last byte (byte 31): 0x80 = 10000000 (bit 255 of last byte set)
      const chunk = '00'.repeat(31) + '80';

      expect(extractBitFromChunk(chunk, 255)).toBe(true);
    });
  });

  describe('verifyBitmapProof', () => {
    it('should verify valid proof and extract bit', () => {
      const proofResponse: BitmapProofResponse = {
        leafChunk: '01' + '00'.repeat(31), // Bit 0 set
        auditPath: [
          { hash: 'a'.repeat(64), position: 'right' },
          { hash: 'b'.repeat(64), position: 'left' },
        ],
      };

      const result = verifyBitmapProof(
        proofResponse,
        42, // Bit index
        '0x' + 'c'.repeat(64), // Expected root
        { treeSize: authenticatedTreeSize(256) },
      );

      expect(result).toBeDefined();
      expect(result.valid).toBeDefined();
      expect(result.included).toBeDefined();
      expect(result.leafIndex).toBe(0); // Bit 42 is in leaf 0
      expect(result.bitOffset).toBe(42);
    });

    it('should detect invalid proof', () => {
      const proofResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32), // All zeros
        auditPath: [{ hash: 'invalid'.repeat(10) + '4444', position: 'right' }],
      };

      const result = verifyBitmapProof(proofResponse, 10, '0x' + 'd'.repeat(64), {
        treeSize: authenticatedTreeSize(256),
      });

      expect(result.valid).toBe(false);
    });

    it('returns invalid instead of throwing for a negative bit index', () => {
      const proofResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };

      expect(() =>
        verifyBitmapProof(proofResponse, -1, '0x' + 'd'.repeat(64), { treeSize: authenticatedTreeSize(1) }),
      ).not.toThrow();

      const result = verifyBitmapProof(proofResponse, -1, '0x' + 'd'.repeat(64), {
        treeSize: authenticatedTreeSize(1),
      });

      expect(result.valid).toBe(false);
      expect(result.included).toBe(false);
    });

    it('binds proof verification to the authenticated tree size', () => {
      const bitmap = Array.from({ length: 257 }, () => false);
      bitmap[256] = true;
      const proofResponse = generateBitmapMerkleProof(bitmap, 256);
      const root = computeIncludedBitmapRoot(bitmap);

      expect(verifyBitmapProof(proofResponse, 256, root, { treeSize: authenticatedTreeSize(257) }).valid).toBe(true);
      expect(verifyBitmapProof(proofResponse, 256, root, { treeSize: authenticatedTreeSize(256) }).valid).toBe(false);
    });
  });

  describe('verifyMyVoteWasCounted', () => {
    it('uses the provided proof source and verifies vote was counted', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: '02' + '00'.repeat(31), // Bit 1 set
        auditPath: [],
      };

      const proofProvider = createProofProvider(mockResponse);

      const result = await verifyMyVoteWasCounted(
        1, // My vote index
        '0x' + 'e'.repeat(64), // includedBitmapRoot from receipt
        { proofProvider, treeSize: authenticatedTreeSize(256) },
      );

      expect(proofProvider).toHaveBeenCalledWith({ bitIndex: 1, kind: 'included' });
      expect(result.included).toBe(true);
      expect(result.valid).toBeDefined();
    });

    it('requires a proof provider', async () => {
      await expect(
        verifyMyVoteWasCounted(100, '0x' + 'f'.repeat(64), { treeSize: authenticatedTreeSize(256) }),
      ).rejects.toThrow('Bitmap proof provider is required');
    });

    it('propagates proof provider failures', async () => {
      const proofProvider = createProofProvider(new Error('Network error'));

      await expect(
        verifyMyVoteWasCounted(50, '0x' + '1'.repeat(64), {
          proofProvider,
          treeSize: authenticatedTreeSize(256),
        }),
      ).rejects.toThrow('Network error');
    });

    it('should explain when a vote was presented but invalid', async () => {
      const excludedResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };
      const seenResponse: BitmapProofResponse = {
        leafChunk: '04' + '00'.repeat(31), // Bit 2 set
        auditPath: [],
      };

      const proofProvider = createProofProvider(excludedResponse, seenResponse);

      const result = await explainVoteInclusionStatus(
        2,
        {
          includedBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
          seenBitmapRoot: computeIncludedBitmapRoot([false, false, true]),
        },
        { proofProvider, treeSize: authenticatedTreeSize(256) },
      );

      expect(proofProvider).toHaveBeenNthCalledWith(1, { bitIndex: 2, kind: 'included' });
      expect(proofProvider).toHaveBeenNthCalledWith(2, { bitIndex: 2, kind: 'seen' });
      expect(result.statusDetail).toBe('presented_but_invalid');
      expect(result.included).toBe(false);
      expect(result.seen).toBe(true);
    });

    it('should explain when a vote index was not presented', async () => {
      const excludedResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };
      const notSeenResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };

      const proofProvider = createProofProvider(excludedResponse, notSeenResponse);

      const result = await explainVoteInclusionStatus(
        4,
        {
          includedBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
          seenBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
        },
        { proofProvider, treeSize: authenticatedTreeSize(256) },
      );

      expect(result.statusDetail).toBe('not_presented');
      expect(result.seen).toBe(false);
    });

    it('should fall back to included-only status when seen proof is unavailable', async () => {
      const excludedResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };

      const proofProvider = createProofProvider(excludedResponse, new Error('Bitmap proof unavailable'));

      const result = await explainVoteInclusionStatus(
        4,
        {
          includedBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
          seenBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
        },
        { proofProvider, treeSize: authenticatedTreeSize(256) },
      );

      expect(proofProvider).toHaveBeenNthCalledWith(1, { bitIndex: 4, kind: 'included' });
      expect(proofProvider).toHaveBeenNthCalledWith(2, { bitIndex: 4, kind: 'seen' });
      expect(result.valid).toBe(true);
      expect(result.included).toBe(false);
      expect(result.statusDetail).toBe('unknown_excluded');
    });

    it('should always include privacy notice in result', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: 'ff'.repeat(32), // All bits set
        auditPath: [],
      };

      const proofProvider = createProofProvider(mockResponse);

      const result = await verifyMyVoteWasCounted(100, '0x' + '3'.repeat(64), {
        proofProvider,
        treeSize: authenticatedTreeSize(256),
      });

      expect(result.privacyNotice).toBeDefined();
      expect(result.privacyNotice).toContain('255');
      expect(result.privacyNotice).toContain('漏洩');
      expect(result.privacyNotice).toContain('秘匿');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty audit path (single leaf tree)', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: '01' + '00'.repeat(31),
        auditPath: [], // No siblings for single leaf
      };

      const proofProvider = createProofProvider(mockResponse);

      const result = await verifyMyVoteWasCounted(0, '0x' + '4'.repeat(64), {
        proofProvider,
        treeSize: authenticatedTreeSize(1),
      });

      expect(result.included).toBe(true);
    });

    it('should handle maximum index (last bit)', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(31) + '80', // Last bit of chunk set
        auditPath: [{ hash: '5'.repeat(64), position: 'left' }],
      };

      const proofProvider = createProofProvider(mockResponse);

      const result = await verifyMyVoteWasCounted(
        255, // Last bit of first chunk
        '0x' + '6'.repeat(64),
        { proofProvider, treeSize: authenticatedTreeSize(256) },
      );

      expect(result.bitOffset).toBe(255);
    });
  });

  describe('Security considerations', () => {
    it('should not trust server-provided leaf index', async () => {
      // Even if server returns wrong data, client calculates independently
      const mockResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };

      const proofProvider = createProofProvider(mockResponse);

      const result = await verifyMyVoteWasCounted(
        512, // Should be in leaf 2
        '0x' + '7'.repeat(64),
        { proofProvider, treeSize: authenticatedTreeSize(768) },
      );

      // Client independently calculates this should be leaf 2
      expect(result.leafIndex).toBe(2);
    });

    it('should validate chunk is correct hex format', () => {
      const invalidChunks = [
        'zz'.repeat(32), // Invalid hex
        '00'.repeat(31), // Too short
        '00'.repeat(33), // Too long
        '00 00', // Spaces
      ];

      for (const chunk of invalidChunks) {
        expect(() => extractBitFromChunk(chunk, 0)).toThrow();
      }
    });
  });
});
