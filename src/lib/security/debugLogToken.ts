import { createHmac, timingSafeEqual } from 'crypto';
import { isLogLevel, type LogLevel } from '@/lib/utils/loggerTypes';

export interface DebugLogTokenPayload {
  expiresAt: number;
  level: LogLevel;
}

export interface VerifyDebugLogTokenOptions {
  now?: number;
  maxTtlSeconds?: number;
}

const TOKEN_VERSION = 'v1';
const DEFAULT_MAX_TTL_SECONDS = 15 * 60;

/**
 * Create an HMAC-signed debug log token.
 */
export function createDebugLogToken(payload: DebugLogTokenPayload, secret: string): string {
  if (!secret) {
    throw new Error('Debug log secret is required');
  }

  const expiresAt = normalizeExpiresAt(payload.expiresAt);
  const level = payload.level;
  const message = `${TOKEN_VERSION}.${expiresAt}.${level}`;
  const signature = createHmac('sha256', secret).update(message).digest('hex');

  return `${message}.${signature}`;
}

/**
 * Verify a debug log token and return its payload when valid.
 */
export function verifyDebugLogToken(
  token: string,
  secret: string,
  options: VerifyDebugLogTokenOptions = {},
): DebugLogTokenPayload | null {
  if (!secret) {
    return null;
  }

  const parts = token.trim().split('.');
  if (parts.length !== 4) {
    return null;
  }

  const [version, expiresAtRaw, levelRaw, signature] = parts;
  if (version !== TOKEN_VERSION) {
    return null;
  }

  if (!isLogLevel(levelRaw)) {
    return null;
  }

  const expiresAt = parseExpiresAt(expiresAtRaw);
  if (!expiresAt) {
    return null;
  }

  const nowMs = options.now ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  if (expiresAt < nowSeconds) {
    return null;
  }

  const maxTtlSeconds = resolveDebugLogMaxTtlSeconds(options.maxTtlSeconds);
  if (expiresAt - nowSeconds > maxTtlSeconds) {
    return null;
  }

  const message = `${version}.${expiresAt}.${levelRaw}`;
  const expectedSignature = createHmac('sha256', secret).update(message).digest('hex');
  if (!safeTimingEqual(expectedSignature, signature)) {
    return null;
  }

  return { expiresAt, level: levelRaw };
}

function parseExpiresAt(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const floored = Math.floor(parsed);
  if (floored <= 0) {
    return null;
  }
  return floored;
}

function normalizeExpiresAt(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Invalid expiresAt value for debug log token');
  }
  const floored = Math.floor(value);
  if (floored <= 0) {
    throw new Error('expiresAt must be a positive unix timestamp');
  }
  return floored;
}

/**
 * Resolve the maximum allowed token TTL in seconds.
 */
export function resolveDebugLogMaxTtlSeconds(override?: number): number {
  if (override !== undefined) {
    const floored = Math.floor(override);
    return floored > 0 ? floored : DEFAULT_MAX_TTL_SECONDS;
  }

  const raw = process.env.DEBUG_LOG_MAX_TTL_SECONDS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return DEFAULT_MAX_TTL_SECONDS;
}

function safeTimingEqual(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex, 'hex');
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
