const TOKEN_PATTERN = /^v1\.(\d{10,})\.(debug|info|warn|error|silent)\.[0-9a-f]{64}$/;

/**
 * Lightweight format check for debug log tokens (no signature verification).
 */
export function isDebugLogTokenFormat(value: string): boolean {
  return TOKEN_PATTERN.test(value.trim());
}
