import { Buffer } from 'buffer';
import { addHexPrefix, normalizeHexString } from '@/lib/utils/hex';

/**
 * Normalize bitmap root values to a 0x-prefixed hex string.
 */
export function normalizeBitmapRoot(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = normalizeHexString(value);
    return addHexPrefix(normalized);
  }

  if (value instanceof Uint8Array) {
    return addHexPrefix(Buffer.from(value).toString('hex'));
  }

  if (Array.isArray(value)) {
    return addHexPrefix(Buffer.from(value).toString('hex'));
  }

  return '0x' + '0'.repeat(64);
}
