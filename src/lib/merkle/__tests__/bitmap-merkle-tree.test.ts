/**
 * Tests for bitmap Merkle tree proof generation
 * Following final_design.md §2.6 specifications
 *
 * TDD RED phase: Writing tests before implementation
 */

import { describe, expect, it } from 'vitest';
import {
  generateBitmapMerkleProof,
  verifyBitmapMerkleProof,
  calculateLeafIndex,
  calculateBitOffset,
  getLeafChunk,
} from '../bitmap-merkle-tree';
import { computeIncludedBitmapRoot } from '../../zkvm/bitmap';

describe('Bitmap Merkle Tree Proof Generation', () => {
  describe('calculateLeafIndex', () => {
    it('should calculate correct leaf index for bit positions', () => {
      // Each leaf contains 256 bits (32 bytes)
      expect(calculateLeafIndex(0)).toBe(0); // First bit in first leaf
      expect(calculateLeafIndex(255)).toBe(0); // Last bit in first leaf
      expect(calculateLeafIndex(256)).toBe(1); // First bit in second leaf
      expect(calculateLeafIndex(512)).toBe(2); // First bit in third leaf
      expect(calculateLeafIndex(1023)).toBe(3); // Last bit in fourth leaf
    });
  });

  describe('calculateBitOffset', () => {
    it('should calculate correct bit offset within a leaf (LSB-first)', () => {
      // LSB-first encoding: bit 0 is the least significant bit of byte 0
      expect(calculateBitOffset(0)).toBe(0); // Bit 0 in byte 0
      expect(calculateBitOffset(7)).toBe(7); // Bit 7 in byte 0
      expect(calculateBitOffset(8)).toBe(8); // Bit 0 in byte 1
      expect(calculateBitOffset(255)).toBe(255); // Bit 7 in byte 31
      expect(calculateBitOffset(256)).toBe(0); // Bit 0 in byte 0 of next leaf
    });
  });

  describe('getLeafChunk', () => {
    it('should extract correct 32-byte chunk for a leaf index', () => {
      // Create a bitmap with specific pattern
      const bitmap = Array.from({ length: 512 }, () => false);
      bitmap[0] = true; // First bit
      bitmap[7] = true; // 8th bit (same byte)
      bitmap[8] = true; // 9th bit (next byte)
      bitmap[256] = true; // First bit of second leaf

      // Get chunk for first leaf
      const chunk0 = getLeafChunk(bitmap, 0);
      expect(chunk0).toHaveLength(64); // 32 bytes in hex

      // First byte should be 0x81 (10000001 in binary, LSB-first)
      expect(chunk0.substring(0, 2)).toBe('81');
      // Second byte should be 0x01 (00000001 in binary)
      expect(chunk0.substring(2, 4)).toBe('01');

      // Get chunk for second leaf
      const chunk1 = getLeafChunk(bitmap, 1);
      expect(chunk1).toHaveLength(64);
      // First byte of second chunk should be 0x01
      expect(chunk1.substring(0, 2)).toBe('01');
    });

    it('should pad with zeros for incomplete chunks', () => {
      // Small bitmap (less than 256 bits)
      const bitmap = Array.from({ length: 100 }, () => false);
      bitmap[0] = true;

      const chunk = getLeafChunk(bitmap, 0);
      expect(chunk).toHaveLength(64); // Still 32 bytes

      // First byte is 0x01, rest should be zeros
      expect(chunk.substring(0, 2)).toBe('01');
      expect(chunk.substring(26, 64)).toBe('0'.repeat(38)); // Padding zeros
    });
  });

  describe('generateBitmapMerkleProof', () => {
    it('should generate valid proof for single-leaf tree', () => {
      const bitmap = Array.from({ length: 256 }, () => false);
      bitmap[42] = true; // Set one bit

      const proof = generateBitmapMerkleProof(bitmap, 42);

      expect(proof).toBeDefined();
      expect(proof.leafChunk).toHaveLength(64);
      expect(proof.auditPath).toHaveLength(0); // Single leaf = no siblings
      expect(proof.leafIndex).toBe(0);
      expect(proof.bitIndex).toBe(42);
    });

    it('should generate valid proof for multi-leaf tree', () => {
      const bitmap = Array.from({ length: 512 }, () => false);
      // Set bits in different leaves
      bitmap[100] = true; // Leaf 0
      bitmap[300] = true; // Leaf 1

      const proof0 = generateBitmapMerkleProof(bitmap, 100);
      expect(proof0.leafIndex).toBe(0);
      expect(proof0.bitIndex).toBe(100);
      expect(proof0.auditPath.length).toBeGreaterThan(0);

      const proof1 = generateBitmapMerkleProof(bitmap, 300);
      expect(proof1.leafIndex).toBe(1);
      expect(proof1.bitIndex).toBe(300);
      expect(proof1.auditPath.length).toBeGreaterThan(0);
    });

    it('should include correct sibling positions in audit path', () => {
      const bitmap = Array.from({ length: 1024 }, () => false); // 4 leaves
      bitmap[0] = true;

      const proof = generateBitmapMerkleProof(bitmap, 0);

      // For a 4-leaf tree, we expect 2 levels in the audit path
      expect(proof.auditPath).toHaveLength(2);

      // First sibling should be from leaf 1 (right)
      expect(proof.auditPath[0].position).toBe('right');

      // Second sibling should be from the other subtree (right)
      expect(proof.auditPath[1].position).toBe('right');
    });

    it('should throw error for out-of-range index', () => {
      const bitmap = Array.from({ length: 100 }, () => false);

      expect(() => generateBitmapMerkleProof(bitmap, 100)).toThrow('Index out of range');
      expect(() => generateBitmapMerkleProof(bitmap, -1)).toThrow('Index out of range');
    });
  });

  describe('verifyBitmapMerkleProof', () => {
    it('should verify valid proof', () => {
      const bitmap = Array.from({ length: 512 }, () => false);
      bitmap[123] = true;
      bitmap[456] = true;

      // Generate proof
      const proof = generateBitmapMerkleProof(bitmap, 123);
      const includedBitmapRoot = computeIncludedBitmapRoot(bitmap);

      // Verify proof
      const result = verifyBitmapMerkleProof(proof.leafChunk, proof.auditPath, includedBitmapRoot, 123);

      expect(result.valid).toBe(true);
      expect(result.included).toBe(true);
      expect(result.leafIndex).toBe(0);
      expect(result.bitOffset).toBe(123);
    });

    it('should detect tampered proof', () => {
      const bitmap = Array.from({ length: 256 }, () => false);
      bitmap[0] = true; // Set bit 0 (byte 0, bit 0)
      bitmap[50] = true;

      const proof = generateBitmapMerkleProof(bitmap, 50);
      const includedBitmapRoot = computeIncludedBitmapRoot(bitmap);

      // Tamper with the leaf chunk - flip byte 0 from 0x01 to 0x00
      const tamperedChunk = '00' + proof.leafChunk.substring(2);

      const result = verifyBitmapMerkleProof(tamperedChunk, proof.auditPath, includedBitmapRoot, 50);

      expect(result.valid).toBe(false);
    });

    it('should correctly extract bit value from chunk', () => {
      const bitmap = Array.from({ length: 300 }, () => false);
      bitmap[255] = true; // Last bit of first leaf
      bitmap[256] = true; // First bit of second leaf

      const proof0 = generateBitmapMerkleProof(bitmap, 255);
      const proof1 = generateBitmapMerkleProof(bitmap, 256);
      const root = computeIncludedBitmapRoot(bitmap);

      const result0 = verifyBitmapMerkleProof(proof0.leafChunk, proof0.auditPath, root, 255);
      expect(result0.included).toBe(true);

      const result1 = verifyBitmapMerkleProof(proof1.leafChunk, proof1.auditPath, root, 256);
      expect(result1.included).toBe(true);

      // Check unset bit
      const proof2 = generateBitmapMerkleProof(bitmap, 100);
      const result2 = verifyBitmapMerkleProof(proof2.leafChunk, proof2.auditPath, root, 100);
      expect(result2.included).toBe(false);
    });

    it('returns invalid instead of throwing for a negative bit index', () => {
      expect(() => verifyBitmapMerkleProof('00'.repeat(32), [], '0x' + '1'.repeat(64), -1)).not.toThrow();

      const result = verifyBitmapMerkleProof('00'.repeat(32), [], '0x' + '1'.repeat(64), -1);

      expect(result.valid).toBe(false);
      expect(result.included).toBe(false);
    });
  });

  describe('Integration with existing bitmap functions', () => {
    it('should work with computeIncludedBitmapRoot from bitmap.ts', async () => {
      // Import the existing function
      const { computeIncludedBitmapRoot } = await import('../../zkvm/bitmap');

      const bitmap = Array.from({ length: 64 }, () => false);
      bitmap[0] = true;
      bitmap[63] = true;

      const root = computeIncludedBitmapRoot(bitmap);
      const proof = generateBitmapMerkleProof(bitmap, 0);

      const result = verifyBitmapMerkleProof(proof.leafChunk, proof.auditPath, root, 0);

      expect(result.valid).toBe(true);
      expect(result.included).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty bitmap', () => {
      const bitmap: boolean[] = [];

      expect(() => generateBitmapMerkleProof(bitmap, 0)).toThrow();
    });

    it('should handle single-bit bitmap', () => {
      const bitmap = [true];

      const proof = generateBitmapMerkleProof(bitmap, 0);
      const root = computeIncludedBitmapRoot(bitmap);

      const result = verifyBitmapMerkleProof(proof.leafChunk, proof.auditPath, root, 0);

      expect(result.valid).toBe(true);
      expect(result.included).toBe(true);
    });

    it('should handle maximum-size bitmap (1025 bits = 5 chunks)', () => {
      const bitmap = Array.from({ length: 1025 }, () => false);
      bitmap[1024] = true; // Last bit

      const proof = generateBitmapMerkleProof(bitmap, 1024);
      expect(proof.leafIndex).toBe(4); // Fifth chunk (index 4)

      const root = computeIncludedBitmapRoot(bitmap);
      const result = verifyBitmapMerkleProof(proof.leafChunk, proof.auditPath, root, 1024);

      expect(result.valid).toBe(true);
      expect(result.included).toBe(true);
    });
  });
});

// Helper function - no longer needed as we import directly at the top
// The import at line 193 already handles this
