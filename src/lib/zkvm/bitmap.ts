/**
 * Bitmap processing utilities for includedBitmapRoot calculation
 * Following final_design.md §2.6 specifications
 *
 * LSB-first encoding with 32-byte chunks and CT-style Merkle tree
 */

import { createHash } from 'crypto';

export const BITMAP_CHUNK_BYTES = 32;
export const BITMAP_CHUNK_BITS = BITMAP_CHUNK_BYTES * 8;

/**
 * Pack boolean array into bytes using LSB-first encoding
 * @param bits Array of boolean values
 * @returns Buffer with packed bytes
 */
export function packBitsToBytes(bits: boolean[]): Buffer {
  const numBytes = Math.ceil(bits.length / 8);
  const bytes = Buffer.alloc(numBytes, 0);

  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      bytes[byteIndex] |= 1 << bitIndex; // LSB-first: bit 0 is LSB
    }
  }

  return bytes;
}

/**
 * Split bytes into 32-byte chunks for Merkle tree leaves
 * @param bytes Buffer to split
 * @returns Array of 32-byte buffers
 */
export function splitIntoChunks(bytes: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const chunkSize = BITMAP_CHUNK_BYTES;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    const chunk = Buffer.alloc(chunkSize, 0); // Zero-pad if needed
    bytes.copy(chunk, 0, i, end);
    chunks.push(chunk);
  }

  // If no data, return single zero chunk
  if (chunks.length === 0) {
    chunks.push(Buffer.alloc(chunkSize, 0));
  }

  return chunks;
}

/**
 * Hash a leaf chunk using CT-style with usage tag
 * SHA256(0x00 || "stark-ballot:leaf|v1" || chunk)
 */
export function hashLeafChunk(chunk: Buffer): Buffer {
  const hash = createHash('sha256');
  hash.update(Buffer.from([0x00])); // Domain separator for leaf
  hash.update(Buffer.from('stark-ballot:leaf|v1')); // Usage tag
  hash.update(chunk);
  return hash.digest();
}

/**
 * Hash internal node using CT-style
 * SHA256(0x01 || left || right)
 */
export function hashInternalNode(left: Buffer, right: Buffer): Buffer {
  const hash = createHash('sha256');
  hash.update(Buffer.from([0x01])); // Domain separator for internal node
  hash.update(left);
  hash.update(right);
  return hash.digest();
}

/**
 * Build Merkle tree from leaves and return root
 * @param leaves Array of leaf hashes
 * @returns Root hash
 */
export function computeMerkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) {
    return Buffer.alloc(32, 0);
  }

  if (leaves.length === 1) {
    return leaves[0];
  }

  // Build tree level by level
  let currentLevel = [...leaves];

  while (currentLevel.length > 1) {
    const nextLevel: Buffer[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        // Hash pair
        nextLevel.push(hashInternalNode(currentLevel[i], currentLevel[i + 1]));
      } else {
        // Odd node - promote to next level
        nextLevel.push(currentLevel[i]);
      }
    }

    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

/**
 * Compute includedBitmapRoot from bitmap
 * Following final_design.md §2.6 specification
 *
 * @param bitmap Boolean array where true = included, false = excluded
 * @returns Hex string of the Merkle root
 */
export function computeIncludedBitmapRoot(bitmap: boolean[]): string {
  // Step 1: Pack bits to bytes (LSB-first)
  const bytes = packBitsToBytes(bitmap);

  // Step 2: Split into 32-byte chunks
  const chunks = splitIntoChunks(bytes);

  // Step 3: Hash each chunk as a leaf
  const leaves = chunks.map((chunk) => hashLeafChunk(chunk));

  // Step 4: Build Merkle tree and get root
  const root = computeMerkleRoot(leaves);

  return '0x' + root.toString('hex');
}

export function calculateBitmapLeafIndex(bitIndex: number): number {
  return Math.floor(bitIndex / BITMAP_CHUNK_BITS);
}

export function calculateBitmapBitOffset(bitIndex: number): number {
  return bitIndex % BITMAP_CHUNK_BITS;
}

export function getBitmapLeafChunkBuffer(bitmap: boolean[], leafIndex: number): Buffer {
  const startBit = leafIndex * BITMAP_CHUNK_BITS;
  const endBit = Math.min(startBit + BITMAP_CHUNK_BITS, bitmap.length);

  const leafBits: boolean[] = [];
  for (let index = startBit; index < endBit; index++) {
    leafBits.push(bitmap[index] || false);
  }

  while (leafBits.length < BITMAP_CHUNK_BITS) {
    leafBits.push(false);
  }

  const bytes = packBitsToBytes(leafBits);
  const chunk = Buffer.alloc(BITMAP_CHUNK_BYTES, 0);
  bytes.copy(chunk, 0, 0, Math.min(bytes.length, BITMAP_CHUNK_BYTES));
  return chunk;
}

export function getBitmapLeafChunkHex(bitmap: boolean[], leafIndex: number): string {
  return getBitmapLeafChunkBuffer(bitmap, leafIndex).toString('hex');
}

export function isBitmapChunkHex(chunkHex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(chunkHex);
}

export function extractBitFromChunkBuffer(chunk: Buffer, bitOffset: number): boolean {
  if (bitOffset < 0 || bitOffset >= BITMAP_CHUNK_BITS) {
    throw new Error('Bit offset out of range: must be 0-255');
  }

  const byteIndex = Math.floor(bitOffset / 8);
  const bitInByte = bitOffset % 8;
  return (chunk[byteIndex] & (1 << bitInByte)) !== 0;
}

export function extractBitFromChunkHex(chunkHex: string, bitOffset: number): boolean {
  if (!isBitmapChunkHex(chunkHex)) {
    throw new Error('Invalid chunk format: must be 64 hex characters');
  }

  return extractBitFromChunkBuffer(Buffer.from(chunkHex, 'hex'), bitOffset);
}

export function buildMerkleTreeLevels(leaves: Buffer[]): Buffer[][] {
  if (leaves.length === 0) {
    return [[Buffer.alloc(BITMAP_CHUNK_BYTES, 0)]];
  }

  const levels: Buffer[][] = [[...leaves]];
  let currentLevel = [...leaves];

  while (currentLevel.length > 1) {
    const nextLevel: Buffer[] = [];

    for (let index = 0; index < currentLevel.length; index += 2) {
      if (index + 1 < currentLevel.length) {
        nextLevel.push(hashInternalNode(currentLevel[index], currentLevel[index + 1]));
      } else {
        nextLevel.push(currentLevel[index]);
      }
    }

    levels.push(nextLevel);
    currentLevel = nextLevel;
  }

  return levels;
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
