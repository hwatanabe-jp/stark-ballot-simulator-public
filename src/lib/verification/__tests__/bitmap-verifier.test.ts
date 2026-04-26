/**
 * Tests for client-side bitmap verification
 * Following final_design.md §2.6.1 specifications
 *
 * TDD RED phase: Writing tests before implementation
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
import type { BitmapProofResponse } from '@/lib/types/api/bitmap-proof';
import { computeIncludedBitmapRoot } from '@/lib/zkvm/bitmap';

// Mock fetch for API calls
global.fetch = vi.fn();

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

      const result = verifyBitmapProof(proofResponse, 10, '0x' + 'd'.repeat(64));

      expect(result.valid).toBe(false);
    });

    it('returns invalid instead of throwing for a negative bit index', () => {
      const proofResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };

      expect(() => verifyBitmapProof(proofResponse, -1, '0x' + 'd'.repeat(64))).not.toThrow();

      const result = verifyBitmapProof(proofResponse, -1, '0x' + 'd'.repeat(64));

      expect(result.valid).toBe(false);
      expect(result.included).toBe(false);
    });
  });

  describe('verifyMyVoteWasCounted', () => {
    it('should fetch proof and verify vote was counted', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: '02' + '00'.repeat(31), // Bit 1 set
        auditPath: [],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await verifyMyVoteWasCounted(
        1, // My vote index
        '0x' + 'e'.repeat(64), // includedBitmapRoot from receipt
        {}, // Options
      );

      expect(fetch).toHaveBeenCalledWith('/api/bitmap-proof?i=1&kind=included');
      expect(result.included).toBe(true);
      expect(result.valid).toBeDefined();
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not found', code: 'BITMAP_NOT_FOUND' }),
      } as Response);

      await expect(verifyMyVoteWasCounted(100, '0x' + 'f'.repeat(64), {})).rejects.toThrow(
        'Failed to fetch bitmap proof',
      );
    });

    it('should handle network errors', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

      await expect(verifyMyVoteWasCounted(50, '0x' + '1'.repeat(64), {})).rejects.toThrow('Network error');
    });

    it('should support custom API endpoint', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      await verifyMyVoteWasCounted(5, '0x' + '2'.repeat(64), { apiEndpoint: 'https://example.com/api/bitmap-proof' });

      expect(fetch).toHaveBeenCalledWith('https://example.com/api/bitmap-proof?i=5&kind=included');
    });

    it('should include session header when provided', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      await verifyMyVoteWasCounted(3, '0x' + '2'.repeat(64), {
        sessionId: 'session-123',
      });

      expect(fetch).toHaveBeenCalledWith('/api/bitmap-proof?i=3&kind=included', {
        headers: { 'X-Session-ID': 'session-123' },
      });
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

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(excludedResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(seenResponse),
        } as Response);

      const result = await explainVoteInclusionStatus(
        2,
        {
          includedBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
          seenBitmapRoot: computeIncludedBitmapRoot([false, false, true]),
        },
        {},
      );

      expect(fetch).toHaveBeenNthCalledWith(1, '/api/bitmap-proof?i=2&kind=included');
      expect(fetch).toHaveBeenNthCalledWith(2, '/api/bitmap-proof?i=2&kind=seen');
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

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(excludedResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(notSeenResponse),
        } as Response);

      const result = await explainVoteInclusionStatus(
        4,
        {
          includedBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
          seenBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
        },
        {},
      );

      expect(result.statusDetail).toBe('not_presented');
      expect(result.seen).toBe(false);
    });

    it('should fall back to included-only status when seen proof is unavailable', async () => {
      const excludedResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(32),
        auditPath: [],
      };

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(excludedResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: 'Not found', code: 'BITMAP_NOT_FOUND' }),
        } as Response);

      const result = await explainVoteInclusionStatus(
        4,
        {
          includedBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
          seenBitmapRoot: computeIncludedBitmapRoot(Array.from({ length: 256 }, () => false)),
        },
        {},
      );

      expect(fetch).toHaveBeenNthCalledWith(1, '/api/bitmap-proof?i=4&kind=included');
      expect(fetch).toHaveBeenNthCalledWith(2, '/api/bitmap-proof?i=4&kind=seen');
      expect(result.valid).toBe(true);
      expect(result.included).toBe(false);
      expect(result.statusDetail).toBe('unknown_excluded');
    });

    it('should always include privacy notice in result', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: 'ff'.repeat(32), // All bits set
        auditPath: [],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await verifyMyVoteWasCounted(100, '0x' + '3'.repeat(64), {});

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

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await verifyMyVoteWasCounted(0, '0x' + '4'.repeat(64), {});

      expect(result.included).toBe(true);
    });

    it('should handle maximum index (last bit)', async () => {
      const mockResponse: BitmapProofResponse = {
        leafChunk: '00'.repeat(31) + '80', // Last bit of chunk set
        auditPath: [{ hash: '5'.repeat(64), position: 'left' }],
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await verifyMyVoteWasCounted(
        255, // Last bit of first chunk
        '0x' + '6'.repeat(64),
        {},
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

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await verifyMyVoteWasCounted(
        512, // Should be in leaf 2
        '0x' + '7'.repeat(64),
        {},
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
