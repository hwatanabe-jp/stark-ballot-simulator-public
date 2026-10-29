import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const BITMAP_CHUNK_BYTES = 32;
export const BITMAP_CHUNK_BITS = BITMAP_CHUNK_BYTES * 8;

const BITMAP_LEAF_USAGE_TAG = utf8ToBytes('stark-ballot:leaf|v1');

export function packBitmapBitsToBytes(bits: readonly boolean[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));

  for (let index = 0; index < bits.length; index += 1) {
    if (!bits[index]) {
      continue;
    }
    const byteIndex = Math.floor(index / 8);
    const currentByte = bytes[byteIndex];
    if (currentByte === undefined) {
      throw new Error('Bitmap byte index out of range');
    }
    bytes[byteIndex] = currentByte | (1 << (index % 8));
  }

  return bytes;
}

function splitBitmapBytesIntoChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < bytes.length; offset += BITMAP_CHUNK_BYTES) {
    const chunk = new Uint8Array(BITMAP_CHUNK_BYTES);
    chunk.set(bytes.subarray(offset, Math.min(offset + BITMAP_CHUNK_BYTES, bytes.length)));
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    chunks.push(new Uint8Array(BITMAP_CHUNK_BYTES));
  }

  return chunks;
}

function hashBitmapLeafChunk(chunk: Uint8Array): Uint8Array {
  const hash = sha256.create();
  hash.update(Uint8Array.of(0));
  hash.update(BITMAP_LEAF_USAGE_TAG);
  hash.update(chunk);
  return hash.digest();
}

function hashBitmapInternalNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const hash = sha256.create();
  hash.update(Uint8Array.of(1));
  hash.update(left);
  hash.update(right);
  return hash.digest();
}

function computeBitmapMerkleRootBytes(leaves: readonly Uint8Array[]): Uint8Array {
  const root = buildBitmapMerkleTreeByteLevels(leaves).at(-1)?.[0];
  if (root === undefined) {
    throw new Error('Merkle tree root is missing');
  }
  return root;
}

function buildBitmapMerkleTreeByteLevels(leaves: readonly Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) {
    return [[new Uint8Array(BITMAP_CHUNK_BYTES)]];
  }

  const levels: Uint8Array[][] = [[...leaves]];
  let currentLevel = [...leaves];
  while (currentLevel.length > 1) {
    const nextLevel: Uint8Array[] = [];
    for (let index = 0; index < currentLevel.length; index += 2) {
      const left = currentLevel[index];
      if (left === undefined) {
        throw new Error('Merkle tree node is missing');
      }
      const right = currentLevel[index + 1];
      nextLevel.push(right === undefined ? left : hashBitmapInternalNode(left, right));
    }
    levels.push(nextLevel);
    currentLevel = nextLevel;
  }
  return levels;
}

export function computeIncludedBitmapRootHex(bitmap: readonly boolean[]): string {
  const chunks = splitBitmapBytesIntoChunks(packBitmapBitsToBytes(bitmap));
  const root = computeBitmapMerkleRootBytes(chunks.map(hashBitmapLeafChunk));
  return `0x${bytesToHex(root)}`;
}

export function calculateBitmapLeafIndex(bitIndex: number): number {
  return Math.floor(bitIndex / BITMAP_CHUNK_BITS);
}

export function calculateBitmapBitOffset(bitIndex: number): number {
  return bitIndex % BITMAP_CHUNK_BITS;
}

export function getBitmapLeafChunkBytes(bitmap: readonly boolean[], leafIndex: number): Uint8Array {
  const chunk = new Uint8Array(BITMAP_CHUNK_BYTES);
  const startBit = leafIndex * BITMAP_CHUNK_BITS;
  const endBit = Math.min(startBit + BITMAP_CHUNK_BITS, bitmap.length);

  for (let index = startBit; index < endBit; index += 1) {
    if (!bitmap[index]) {
      continue;
    }
    const bitOffset = index - startBit;
    const byteIndex = Math.floor(bitOffset / 8);
    const currentByte = chunk[byteIndex];
    if (currentByte === undefined) {
      throw new Error('Bitmap byte index out of range');
    }
    chunk[byteIndex] = currentByte | (1 << (bitOffset % 8));
  }

  return chunk;
}

export function getBitmapLeafChunkHex(bitmap: readonly boolean[], leafIndex: number): string {
  return bytesToHex(getBitmapLeafChunkBytes(bitmap, leafIndex));
}

export function isBitmapChunkHex(chunkHex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(chunkHex);
}

export function extractBitFromBitmapChunkBytes(chunk: Uint8Array, bitOffset: number): boolean {
  if (bitOffset < 0 || bitOffset >= BITMAP_CHUNK_BITS) {
    throw new Error('Bit offset out of range: must be 0-255');
  }
  const byte = chunk[Math.floor(bitOffset / 8)];
  if (byte === undefined) {
    throw new Error('Bit offset out of range: byte is missing');
  }
  return (byte & (1 << (bitOffset % 8))) !== 0;
}

export function extractBitFromBitmapChunkHex(chunkHex: string, bitOffset: number): boolean {
  if (!isBitmapChunkHex(chunkHex)) {
    throw new Error('Invalid chunk format: must be 64 hex characters');
  }
  return extractBitFromBitmapChunkBytes(hexToBytes(chunkHex), bitOffset);
}

export function hashBitmapLeafChunkHex(chunkHex: string): string {
  if (!isBitmapChunkHex(chunkHex)) {
    throw new Error('Invalid chunk format: must be 64 hex characters');
  }
  return bytesToHex(hashBitmapLeafChunk(hexToBytes(chunkHex)));
}

export function hashBitmapInternalNodeHex(leftHex: string, rightHex: string): string {
  if (!isBitmapChunkHex(leftHex) || !isBitmapChunkHex(rightHex)) {
    throw new Error('Invalid bitmap node format: must be 64 hex characters');
  }
  return bytesToHex(hashBitmapInternalNode(hexToBytes(leftHex), hexToBytes(rightHex)));
}

export function buildBitmapMerkleTreeHexLevels(bitmap: readonly boolean[]): string[][] {
  const chunks = splitBitmapBytesIntoChunks(packBitmapBitsToBytes(bitmap));
  const leaves = chunks.map(hashBitmapLeafChunk);
  return buildBitmapMerkleTreeByteLevels(leaves).map((level) => level.map(bytesToHex));
}
