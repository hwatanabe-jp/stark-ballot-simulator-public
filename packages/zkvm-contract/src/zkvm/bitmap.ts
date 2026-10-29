/**
 * Bitmap processing utilities for includedBitmapRoot calculation
 * Following final-design.md §2.6 specifications
 *
 * LSB-first encoding with 32-byte chunks and CT-style Merkle tree
 */

import {
  computeIncludedBitmapRootHex,
  extractBitFromBitmapChunkBytes,
  getBitmapLeafChunkBytes,
  packBitmapBitsToBytes,
} from './bitmap-core';

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

export function getBitmapLeafChunkBuffer(bitmap: boolean[], leafIndex: number): Buffer {
  return Buffer.from(getBitmapLeafChunkBytes(bitmap, leafIndex));
}

export function extractBitFromChunkBuffer(chunk: Buffer, bitOffset: number): boolean {
  return extractBitFromBitmapChunkBytes(chunk, bitOffset);
}
