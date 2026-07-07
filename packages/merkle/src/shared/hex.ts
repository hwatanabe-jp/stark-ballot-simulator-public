export function normalizeHexString(hex: string): string {
  if (!hex) return '';
  const withoutPrefix = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return withoutPrefix.toLowerCase();
}

export function addHexPrefix(hex: string): string {
  if (!hex) return '0x';
  const withoutPrefix = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return '0x' + withoutPrefix.toLowerCase();
}

export function isValidHexString(hex: string, expectedLength?: number): boolean {
  if (!hex) return false;

  const withoutPrefix = normalizeHexString(hex);
  if (!/^[0-9a-f]*$/.test(withoutPrefix)) {
    return false;
  }

  return expectedLength === undefined || withoutPrefix.length === expectedLength * 2;
}
