/**
 * Bitmap Merkle tree proof generation and verification
 * Following final_design.md §2.6 specifications
 *
 * Generates and verifies Merkle proofs for bitmap inclusion
 * Uses CT-style hashing with domain separators (RFC 6962)
 */

import {
  buildMerkleTreeLevels,
  calculateBitmapBitOffset,
  calculateBitmapLeafIndex,
  extractBitFromChunkBuffer,
  getBitmapLeafChunkHex,
  hashInternalNode,
  hashLeafChunk,
  isBitmapChunkHex,
} from '../zkvm/bitmap';
import type { BitmapVerificationResult } from '../types/api/bitmap-proof';

/**
 * Structure for bitmap Merkle proof
 */
export interface BitmapMerkleProof {
  /** The 32-byte chunk containing the requested bit */
  leafChunk: string;
  /** Merkle audit path from leaf to root */
  auditPath: Array<{
    hash: string;
    position: 'left' | 'right';
  }>;
  /** Index of the leaf in the tree */
  leafIndex: number;
  /** Original bit index requested */
  bitIndex: number;
}

/**
 * Calculate which leaf (32-byte chunk) contains a given bit index
 * Each leaf contains 256 bits (32 bytes * 8 bits/byte)
 *
 * @param bitIndex - The bit index (0-based)
 * @returns The leaf index in the Merkle tree
 */
export function calculateLeafIndex(bitIndex: number): number {
  return calculateBitmapLeafIndex(bitIndex);
}

/**
 * Calculate the bit offset within a leaf chunk
 * Uses LSB-first encoding
 *
 * @param bitIndex - The bit index (0-based)
 * @returns The bit offset within the 256-bit leaf
 */
export function calculateBitOffset(bitIndex: number): number {
  return calculateBitmapBitOffset(bitIndex);
}

/**
 * Extract a 32-byte chunk from the bitmap for a given leaf index
 *
 * @param bitmap - The boolean array bitmap
 * @param leafIndex - The leaf index to extract
 * @returns Hex string of the 32-byte chunk
 */
export function getLeafChunk(bitmap: boolean[], leafIndex: number): string {
  return getBitmapLeafChunkHex(bitmap, leafIndex);
}

/**
 * Generate a Merkle proof for a specific bit in the bitmap
 *
 * @param bitmap - The boolean array bitmap
 * @param bitIndex - The bit index to generate proof for
 * @returns The Merkle proof
 */
export function generateBitmapMerkleProof(bitmap: boolean[], bitIndex: number): BitmapMerkleProof {
  if (bitmap.length === 0) {
    throw new Error('Empty bitmap');
  }

  if (bitIndex < 0 || bitIndex >= bitmap.length) {
    throw new Error('Index out of range');
  }

  // Calculate leaf index and get the chunk
  const leafIndex = calculateLeafIndex(bitIndex);
  const leafChunk = getLeafChunk(bitmap, leafIndex);

  // Build complete bitmap chunks
  const numLeaves = Math.ceil(bitmap.length / 256);
  const chunks: Buffer[] = [];
  for (let i = 0; i < numLeaves; i++) {
    const chunkHex = getLeafChunk(bitmap, i);
    chunks.push(Buffer.from(chunkHex, 'hex'));
  }

  // Hash all leaf chunks
  const leaves = chunks.map((chunk) => hashLeafChunk(chunk));

  // Build the complete Merkle tree
  const levels = buildMerkleTreeLevels(leaves);

  // Generate audit path
  const auditPath: Array<{ hash: string; position: 'left' | 'right' }> = [];
  let currentIndex = leafIndex;

  for (let level = 0; level < levels.length - 1; level++) {
    const levelNodes = levels[level];
    const isLeft = currentIndex % 2 === 0;
    const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

    if (siblingIndex < levelNodes.length) {
      auditPath.push({
        hash: levelNodes[siblingIndex].toString('hex'),
        position: isLeft ? 'right' : 'left',
      });
    }

    currentIndex = Math.floor(currentIndex / 2);
  }

  return {
    leafChunk,
    auditPath,
    leafIndex,
    bitIndex,
  };
}

/**
 * Verify a bitmap Merkle proof
 *
 * @param leafChunk - The 32-byte chunk (hex string)
 * @param auditPath - The Merkle audit path
 * @param expectedRoot - The expected Merkle root (hex string)
 * @param bitIndex - The bit index being verified
 * @returns Verification result with bit value
 */
export function verifyBitmapMerkleProof(
  leafChunk: string,
  auditPath: Array<{ hash: string; position: 'left' | 'right' }>,
  expectedRoot: string,
  bitIndex: number,
): BitmapVerificationResult {
  if (!Number.isInteger(bitIndex) || bitIndex < 0) {
    return {
      valid: false,
      included: false,
      leafIndex: calculateLeafIndex(bitIndex),
      bitOffset: calculateBitOffset(bitIndex),
    };
  }

  const leafIndex = calculateLeafIndex(bitIndex);
  const bitOffset = calculateBitOffset(bitIndex);
  if (!isBitmapChunkHex(leafChunk)) {
    return {
      valid: false,
      included: false,
      leafIndex,
      bitOffset,
    };
  }

  const chunkBuffer = Buffer.from(leafChunk, 'hex');
  const included = extractBitFromChunkBuffer(chunkBuffer, bitOffset);
  let currentHash = hashLeafChunk(chunkBuffer);

  for (const pathNode of auditPath) {
    if (!isBitmapChunkHex(pathNode.hash)) {
      return {
        valid: false,
        included,
        leafIndex,
        bitOffset,
      };
    }

    const siblingHash = Buffer.from(pathNode.hash, 'hex');

    if (pathNode.position === 'left') {
      // Sibling is on the left, current is on the right
      currentHash = hashInternalNode(siblingHash, currentHash);
    } else {
      // Sibling is on the right, current is on the left
      currentHash = hashInternalNode(currentHash, siblingHash);
    }
  }

  const computedRoot = '0x' + currentHash.toString('hex');
  const normalizedExpected = expectedRoot.startsWith('0x') ? expectedRoot : '0x' + expectedRoot;
  const valid = computedRoot === normalizedExpected;

  return {
    valid,
    included,
    leafIndex,
    bitOffset,
  };
}
