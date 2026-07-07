import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { normalizeHexString } from './hex';

export function hexToBytesStrict(hex: string): Uint8Array {
  const normalized = normalizeHexString(hex);
  if (!normalized) {
    throw new Error('Invalid hex string: empty');
  }
  if (normalized.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  if (!/^[0-9a-f]+$/.test(normalized)) {
    throw new Error('Invalid hex string');
  }
  return hexToBytes(normalized);
}

export function sha256Hex(...chunks: Uint8Array[]): string {
  const hash = sha256.create();
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  return bytesToHex(hash.digest());
}
