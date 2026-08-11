/**
 * Bitmap processing utilities for includedBitmapRoot calculation
 * Following final-design.md §2.6 specifications
 *
 * LSB-first encoding with 32-byte chunks and CT-style Merkle tree
 */

import {
  BITMAP_CHUNK_BITS,
  BITMAP_CHUNK_BYTES,
  buildBitmapMerkleTreeByteLevels,
  calculateBitmapBitOffset as calculateBitmapBitOffsetCore,
  calculateBitmapLeafIndex as calculateBitmapLeafIndexCore,
  computeBitmapMerkleRootBytes,
  computeIncludedBitmapRootHex,
  extractBitFromBitmapChunkBytes,
  extractBitFromBitmapChunkHex,
  getBitmapLeafChunkBytes,
  getBitmapLeafChunkHex as getBitmapLeafChunkHexCore,
  hashBitmapInternalNode,
  hashBitmapLeafChunk,
  isBitmapChunkHex as isBitmapChunkHexCore,
  packBitmapBitsToBytes,
  splitBitmapBytesIntoChunks,
} from './bitmap-core';

export { BITMAP_CHUNK_BITS, BITMAP_CHUNK_BYTES };

/**
 * Pack boolean array into bytes using LSB-first encoding
 * @param bits Array of boolean values
 * @returns Buffer with packed bytes
 */
export function packBitsToBytes(bits: boolean[]): Buffer {
  return Buffer.from(packBitmapBitsToBytes(bits));
}

/**
 * Split bytes into 32-byte chunks for Merkle tree leaves
 * @param bytes Buffer to split
 * @returns Array of 32-byte buffers
 */
export function splitIntoChunks(bytes: Buffer): Buffer[] {
  return splitBitmapBytesIntoChunks(bytes).map((chunk) => Buffer.from(chunk));
}

/**
 * Hash a leaf chunk using CT-style with usage tag
 * SHA256(0x00 || "stark-ballot:leaf|v1" || chunk)
 */
export function hashLeafChunk(chunk: Buffer): Buffer {
  return Buffer.from(hashBitmapLeafChunk(chunk));
}

/**
 * Hash internal node using CT-style
 * SHA256(0x01 || left || right)
 */
export function hashInternalNode(left: Buffer, right: Buffer): Buffer {
  return Buffer.from(hashBitmapInternalNode(left, right));
}

/**
 * Build Merkle tree from leaves and return root
 * @param leaves Array of leaf hashes
 * @returns Root hash
 */
export function computeMerkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 1) {
    const leaf = leaves[0];
    if (leaf === undefined) {
      throw new Error('Merkle tree leaf is missing');
    }
    return leaf;
  }
  return Buffer.from(computeBitmapMerkleRootBytes(leaves));
}

/**
 * Compute includedBitmapRoot from bitmap
 * Following final-design.md §2.6 specification
 *
 * @param bitmap Boolean array where true = included, false = excluded
 * @returns Hex string of the Merkle root
 */
export function computeIncludedBitmapRoot(bitmap: boolean[]): string {
  return computeIncludedBitmapRootHex(bitmap);
}

export function calculateBitmapLeafIndex(bitIndex: number): number {
  return calculateBitmapLeafIndexCore(bitIndex);
}

export function calculateBitmapBitOffset(bitIndex: number): number {
  return calculateBitmapBitOffsetCore(bitIndex);
}

export function getBitmapLeafChunkBuffer(bitmap: boolean[], leafIndex: number): Buffer {
  return Buffer.from(getBitmapLeafChunkBytes(bitmap, leafIndex));
}

export function getBitmapLeafChunkHex(bitmap: boolean[], leafIndex: number): string {
  return getBitmapLeafChunkHexCore(bitmap, leafIndex);
}

export function isBitmapChunkHex(chunkHex: string): boolean {
  return isBitmapChunkHexCore(chunkHex);
}

export function extractBitFromChunkBuffer(chunk: Buffer, bitOffset: number): boolean {
  return extractBitFromBitmapChunkBytes(chunk, bitOffset);
}

export function extractBitFromChunkHex(chunkHex: string, bitOffset: number): boolean {
  return extractBitFromBitmapChunkHex(chunkHex, bitOffset);
}

export function buildMerkleTreeLevels(leaves: Buffer[]): Buffer[][] {
  return buildBitmapMerkleTreeByteLevels(leaves).map((level) =>
    level.map((node) => (Buffer.isBuffer(node) ? node : Buffer.from(node))),
  );
}

/**
 * Create a bitmap for testing with all bits set to a value
 * @param size Number of bits
 * @param value Value for all bits
 */
export function createTestBitmap(size: number, value: boolean = true): boolean[] {
  return Array.from({ length: size }, () => value);
}

/**
 * Create a bitmap with specific indices set to true
 * @param size Total size of bitmap
 * @param includedIndices Indices to set to true
 */
export function createBitmapWithIndices(size: number, includedIndices: number[]): boolean[] {
  const bitmap = Array.from({ length: size }, () => false);
  for (const index of includedIndices) {
    if (index < size) {
      bitmap[index] = true;
    }
  }
  return bitmap;
}
