/**
 * Bitmap processing utilities for includedBitmapRoot calculation
 * Following final-design.md §2.6 specifications
 *
 * LSB-first encoding with 32-byte chunks and CT-style Merkle tree
 */

import {
  BITMAP_CHUNK_BITS,
  BITMAP_CHUNK_BYTES,
  calculateBitmapBitOffset as calculateBitmapBitOffsetCore,
  calculateBitmapLeafIndex as calculateBitmapLeafIndexCore,
  computeIncludedBitmapRootHex,
  extractBitFromBitmapChunkBytes,
  getBitmapLeafChunkBytes,
  getBitmapLeafChunkHex as getBitmapLeafChunkHexCore,
  isBitmapChunkHex as isBitmapChunkHexCore,
  packBitmapBitsToBytes,
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
