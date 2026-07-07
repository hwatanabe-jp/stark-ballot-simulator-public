/**
 * Hex string utility functions for normalizing 0x prefix handling
 */

/**
 * Normalize hex string by removing 0x prefix if present
 *
 * This function ensures consistent hex string format for internal operations
 * like Merkle tree calculations and cryptographic comparisons.
 *
 * @param hex - Hex string with or without 0x prefix
 * @returns Hex string without prefix (lowercase)
 *
 * @example
 * normalizeHexString('0x1234abcd') // '1234abcd'
 * normalizeHexString('1234ABCD')   // '1234abcd'
 * normalizeHexString('')           // ''
 */
export function normalizeHexString(hex: string): string {
  if (!hex) return '';
  const withoutPrefix = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return withoutPrefix.toLowerCase();
}

/**
 * Add 0x prefix to hex string if not present
 *
 * This function ensures hex strings have the 0x prefix for user-facing
 * fields like zkVM journal outputs and API responses.
 *
 * @param hex - Hex string with or without 0x prefix
 * @returns Hex string with 0x prefix (lowercase)
 *
 * @example
 * addHexPrefix('1234abcd')   // '0x1234abcd'
 * addHexPrefix('0x1234ABCD') // '0x1234abcd'
 * addHexPrefix('')           // '0x'
 */
export function addHexPrefix(hex: string): string {
  if (!hex) return '0x';
  const withoutPrefix = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return '0x' + withoutPrefix.toLowerCase();
}

/**
 * Validate if a string is a valid hex string (with or without 0x prefix)
 *
 * @param hex - String to validate
 * @param expectedLength - Expected length in bytes (32 for SHA256 hashes)
 * @returns true if valid hex string
 *
 * @example
 * isValidHexString('0x1234abcd', 4)    // true
 * isValidHexString('1234abcd', 4)      // true
 * isValidHexString('0x1234', 4)        // false (wrong length)
 * isValidHexString('0x1234ghij', 4)    // false (invalid hex)
 */
export function isValidHexString(hex: string, expectedLength?: number): boolean {
  if (!hex) return false;

  const withoutPrefix = normalizeHexString(hex);

  // Check if it's valid hex
  if (!/^[0-9a-f]*$/.test(withoutPrefix)) {
    return false;
  }

  // Check length if specified (expectedLength is in bytes, so hex length is 2x)
  if (expectedLength !== undefined) {
    return withoutPrefix.length === expectedLength * 2;
  }

  return true;
}

export interface NormalizeHexOptions {
  /** Target length in hex characters (nibbles). */
  length?: number;
  /** Whether to include the 0x prefix in the output (default true). */
  prefix?: boolean;
  /** Whether empty input should be accepted and treated as zero (default false). */
  allowEmpty?: boolean;
  /** Whether odd-length input is allowed (default true). */
  allowOddLength?: boolean;
}

/**
 * Return a zero-filled hex string of the requested length.
 *
 * @param length - Length in hex characters (nibbles)
 * @param prefix - Whether to include the 0x prefix (default true)
 */
export function zeroHex(length: number = 64, prefix: boolean = true): string {
  const zeros = '0'.repeat(length);
  return prefix ? `0x${zeros}` : zeros;
}

/**
 * Normalize a hex string by validating characters, optional padding, and prefix handling.
 *
 * @param value - Hex string with or without 0x prefix
 * @param options - Normalization options
 * @returns Normalized hex string (lowercase)
 */
export function normalizeHex(value: string, options: NormalizeHexOptions = {}): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid hex value');
  }

  const length = options.length ?? 64;
  const prefix = options.prefix ?? true;
  const allowEmpty = options.allowEmpty ?? false;
  const allowOddLength = options.allowOddLength ?? true;

  const clean = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (clean.length === 0) {
    if (!allowEmpty) {
      throw new Error(`Invalid hex value: ${value}`);
    }
    return zeroHex(length, prefix);
  }

  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Invalid hex value: ${value}`);
  }

  if (!allowOddLength && clean.length % 2 !== 0) {
    throw new Error(`Invalid hex value: ${value}`);
  }

  const padded = clean.length >= length ? clean : clean.padStart(length, '0');
  const normalized = padded.toLowerCase();
  return prefix ? `0x${normalized}` : normalized;
}

/**
 * Normalize a hex string, returning a zero-filled value for undefined, null, or empty input.
 *
 * @param value - Hex string with or without 0x prefix
 * @param options - Normalization options
 * @returns Normalized hex string (lowercase)
 */
export function normalizeHexOrZero(value: string | null | undefined, options: NormalizeHexOptions = {}): string {
  if (value === undefined || value === null || value === '') {
    return zeroHex(options.length ?? 64, options.prefix ?? true);
  }
  return normalizeHex(value, options);
}
