/**
 * Bitmap Merkle tree proof generation and verification
 * Following final-design.md §2.6 specifications
 *
 * Generates and verifies Merkle proofs for bitmap inclusion
 * Uses CT-style hashing with domain separators (RFC 6962)
 */

import {
  BITMAP_CHUNK_BITS,
  buildBitmapMerkleTreeHexLevels,
  calculateBitmapBitOffset,
  calculateBitmapLeafIndex,
  extractBitFromBitmapChunkHex,
  getBitmapLeafChunkHex,
  hashBitmapInternalNodeHex,
  hashBitmapLeafChunkHex,
  isBitmapChunkHex,
} from '@stark-ballot/zkvm-contract/zkvm/bitmap-core';
import {
  asAuthenticatedBitmapTreeSize,
  asBitmapBitIndex,
  asBitmapBitOffset,
  asBitmapLeafIndex,
  asBitmapRoot,
  type AuthenticatedBitmapProofContext,
  type BitmapBitIndex,
  type BitmapBitOffset,
  type BitmapLeafIndex,
  type BitmapVerificationResult,
} from '@stark-ballot/verification/bitmap-proof-types';

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

  // Build the complete Merkle tree
  const levels = buildBitmapMerkleTreeHexLevels(bitmap);

  // Generate audit path
  const auditPath: Array<{ hash: string; position: 'left' | 'right' }> = [];
  let currentIndex = leafIndex;

  for (let level = 0; level < levels.length - 1; level++) {
    const levelNodes = levels[level];
    if (!levelNodes) {
      throw new Error('Merkle tree level is missing');
    }
    const isLeft = currentIndex % 2 === 0;
    const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

    const sibling = levelNodes[siblingIndex];
    if (sibling) {
      auditPath.push({
        hash: sibling,
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
  context: AuthenticatedBitmapProofContext,
): BitmapVerificationResult {
  const bitIndex = context.bitIndex;
  const leafIndex = calculateBrandedLeafIndex(bitIndex);
  const bitOffset = calculateBrandedBitOffset(bitIndex);
  if (!isValidAuthenticatedTreeShape(context.treeSize, bitIndex, leafIndex, auditPath)) {
    return invalidBitmapResult(leafIndex, bitOffset);
  }

  if (!isBitmapChunkHex(leafChunk)) {
    return invalidBitmapResult(leafIndex, bitOffset);
  }

  if (!hasZeroUnusedPadding(leafChunk, context.treeSize, leafIndex)) {
    return invalidBitmapResult(leafIndex, bitOffset);
  }

  const included = extractBitFromBitmapChunkHex(leafChunk, bitOffset);
  let currentHash = hashBitmapLeafChunkHex(leafChunk);

  for (const pathNode of auditPath) {
    if (!isBitmapChunkHex(pathNode.hash)) {
      return {
        valid: false,
        included,
        leafIndex,
        bitOffset,
      };
    }

    if (pathNode.position === 'left') {
      // Sibling is on the left, current is on the right
      currentHash = hashBitmapInternalNodeHex(pathNode.hash, currentHash);
    } else {
      // Sibling is on the right, current is on the left
      currentHash = hashBitmapInternalNodeHex(currentHash, pathNode.hash);
    }
  }

  const computedRoot = '0x' + currentHash;
  const normalizedExpected = context.expectedRoot.startsWith('0x') ? context.expectedRoot : '0x' + context.expectedRoot;
  const valid = computedRoot === normalizedExpected;

  return {
    valid,
    included,
    leafIndex,
    bitOffset,
  };
}

function invalidBitmapResult(leafIndex: BitmapLeafIndex, bitOffset: BitmapBitOffset): BitmapVerificationResult {
  return {
    valid: false,
    included: false,
    leafIndex,
    bitOffset,
  };
}

function calculateBrandedLeafIndex(bitIndex: BitmapBitIndex): BitmapLeafIndex {
  return asBitmapLeafIndex(calculateLeafIndex(bitIndex));
}

function calculateBrandedBitOffset(bitIndex: BitmapBitIndex): BitmapBitOffset {
  return asBitmapBitOffset(calculateBitOffset(bitIndex));
}

export function buildAuthenticatedBitmapProofContext(input: {
  bitIndex: number;
  treeSize: number;
  expectedRoot: string;
}): AuthenticatedBitmapProofContext {
  return {
    bitIndex: asBitmapBitIndex(input.bitIndex),
    treeSize: asAuthenticatedBitmapTreeSize(input.treeSize),
    expectedRoot: asBitmapRoot(input.expectedRoot),
  };
}

function hasZeroUnusedPadding(chunkHex: string, treeSize: number, leafIndex: number): boolean {
  const leafCount = Math.ceil(treeSize / BITMAP_CHUNK_BITS);
  if (leafIndex !== leafCount - 1) {
    return true;
  }

  const usedBitsInLeaf = treeSize % BITMAP_CHUNK_BITS;
  if (usedBitsInLeaf === 0) {
    return true;
  }

  for (let bitOffset = usedBitsInLeaf; bitOffset < BITMAP_CHUNK_BITS; bitOffset++) {
    if (extractBitFromBitmapChunkHex(chunkHex, bitOffset)) {
      return false;
    }
  }

  return true;
}

function isValidAuthenticatedTreeShape(
  treeSize: number,
  bitIndex: number,
  leafIndex: number,
  auditPath: Array<{ hash: string; position: 'left' | 'right' }>,
): boolean {
  if (!Number.isSafeInteger(treeSize) || treeSize <= 0) {
    return false;
  }
  if (bitIndex >= treeSize) {
    return false;
  }

  const leafCount = Math.ceil(treeSize / BITMAP_CHUNK_BITS);
  if (leafIndex >= leafCount) {
    return false;
  }

  const expectedPositions = deriveAuditPathPositions(leafIndex, leafCount);
  if (auditPath.length !== expectedPositions.length) {
    return false;
  }

  return auditPath.every((node, index) => node.position === expectedPositions[index]);
}

function deriveAuditPathPositions(leafIndex: number, leafCount: number): Array<'left' | 'right'> {
  const positions: Array<'left' | 'right'> = [];
  let currentIndex = leafIndex;
  let levelSize = leafCount;

  while (levelSize > 1) {
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
    if (siblingIndex < levelSize) {
      positions.push(currentIndex % 2 === 0 ? 'right' : 'left');
    }

    currentIndex = Math.floor(currentIndex / 2);
    levelSize = Math.ceil(levelSize / 2);
  }

  return positions;
}
