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
