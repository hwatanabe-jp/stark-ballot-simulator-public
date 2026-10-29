import { hexToBytes } from '@noble/hashes/utils.js';

export function normalizeHexString(hex: string): string {
  if (!hex) return '';
  const withoutPrefix = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return withoutPrefix.toLowerCase();
}

export function addHexPrefix(hex: string): string {
  return '0x' + normalizeHexString(hex);
}

export function isValidHexString(hex: string, expectedLength?: number): boolean {
  if (!hex) return false;

  const withoutPrefix = normalizeHexString(hex);
  if (!/^[0-9a-f]*$/.test(withoutPrefix)) {
    return false;
  }

  return expectedLength === undefined || withoutPrefix.length === expectedLength * 2;
}

export function hexToBytesStrict(hex: string): Uint8Array {
  const normalized = normalizeHexString(hex);
  if (!normalized) {
    throw new Error('Invalid hex string: empty');
  }
  // Decode valid inputs once; retain the established diagnostics for malformed input.
  try {
    return hexToBytes(normalized);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    if (normalized.length % 2 !== 0) throw new Error('Invalid hex string: odd length');
    if (!isValidHexString(normalized)) throw new Error('Invalid hex string');
    throw error;
  }
}
