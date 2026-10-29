import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { asCapabilityToken, type CapabilityToken, type SessionId } from '@stark-ballot/domain/types/identifiers';

const TOKEN_VERSION = 'v1';
export const DEFAULT_SESSION_CAPABILITY_TTL_SECONDS = 24 * 60 * 60;
export const MAX_SESSION_CAPABILITY_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SessionCapabilityClaims {
  sid: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface SessionCapabilityPayload {
  sessionId: SessionId;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export type SessionCapabilityVerifyFailureReason = 'invalid' | 'expired' | 'session_mismatch';

export type SessionCapabilityVerifyResult =
  | { ok: true; payload: SessionCapabilityPayload }
  | { ok: false; reason: SessionCapabilityVerifyFailureReason };

/**
 * Create a signed capability token bound to a session ID.
 */
export function createSessionCapabilityToken(
  options: {
    sessionId: SessionId;
    nowMs?: number;
    ttlSeconds?: number;
    nonce?: string;
  },
  secret: string,
): CapabilityToken {
  const sessionId = options.sessionId.trim();
  if (!sessionId) {
    throw new Error('sessionId is required to create capability token');
  }

  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const ttlSeconds =
    typeof options.ttlSeconds === 'number' && Number.isInteger(options.ttlSeconds) && options.ttlSeconds > 0
      ? options.ttlSeconds
      : DEFAULT_SESSION_CAPABILITY_TTL_SECONDS;

  const claims: SessionCapabilityClaims = {
    sid: sessionId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    nonce: options.nonce ?? randomBytes(16).toString('hex'),
  };

  const payload = encodeBase64Url(JSON.stringify(claims));
  const message = `${TOKEN_VERSION}.${payload}`;
  const signature = sign(message, secret);

  return asCapabilityToken(`${message}.${signature}`);
}

/**
 * Verify and decode a signed capability token.
 */
export function verifySessionCapabilityToken(
  token: CapabilityToken,
  secret: string,
  options: {
    sessionId: SessionId;
    nowMs?: number;
    maxTtlSeconds?: number;
  },
): SessionCapabilityVerifyResult {
  const sessionId = options.sessionId.trim();
  if (!sessionId) {
    return { ok: false, reason: 'invalid' };
  }

  const payload = authenticateCapabilityPayload(token, secret);
  if (!payload) return { ok: false, reason: 'invalid' };
  const claims = parseCapabilityClaims(payload);
  if (!claims) return { ok: false, reason: 'invalid' };

  if (claims.sid !== sessionId) {
    return { ok: false, reason: 'session_mismatch' };
  }

  const maxTtlSeconds = resolveCapabilityMaxTtl(options.maxTtlSeconds);
  if (claims.exp - claims.iat > maxTtlSeconds || claims.exp <= claims.iat) {
    return { ok: false, reason: 'invalid' };
  }

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (claims.exp <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  return {
    ok: true,
    payload: {
      sessionId: options.sessionId,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      nonce: claims.nonce,
    },
  };
}

function authenticateCapabilityPayload(token: CapabilityToken, secret: string): string | undefined {
  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return undefined;
  }

  const [version, payload, signature] = parts;
  if (!version || !payload || !signature) {
    return undefined;
  }
  if (version !== TOKEN_VERSION) {
    return undefined;
  }

  const signed = `${version}.${payload}`;
  const expectedSignature = sign(signed, secret);
  if (!safeTimingEqualHex(expectedSignature, signature)) {
    return undefined;
  }

  return payload;
}

function parseCapabilityClaims(payload: string): SessionCapabilityClaims | undefined {
  const decoded = decodeBase64Url(payload);
  if (!decoded) {
    return undefined;
  }

  let claims: unknown;
  try {
    claims = JSON.parse(decoded) as unknown;
  } catch {
    return undefined;
  }

  if (!isSessionCapabilityClaims(claims)) {
    return undefined;
  }
  return claims;
}

function resolveCapabilityMaxTtl(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : MAX_SESSION_CAPABILITY_TTL_SECONDS;
}

function sign(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

function isSessionCapabilityClaims(value: unknown): value is SessionCapabilityClaims {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  const sid = record['sid'];
  const iat = record['iat'];
  const exp = record['exp'];
  const nonce = record['nonce'];

  return (
    typeof sid === 'string' &&
    sid.length > 0 &&
    typeof nonce === 'string' &&
    nonce.length > 0 &&
    isPositiveClaimTimestamp(iat) &&
    isPositiveClaimTimestamp(exp)
  );
}

function isPositiveClaimTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9\-_]+$/.test(value)) {
    return null;
  }

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  try {
    return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function safeTimingEqualHex(expectedHex: string, providedHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) {
    return false;
  }

  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex.toLowerCase(), 'hex');
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
