import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isUnresolvedAmplifySecret } from '@/lib/env/amplifySecrets';

const TOKEN_VERSION = 'v1';
const MIN_SECRET_LENGTH = 32;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

interface SessionCapabilityClaims {
  sid: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface SessionCapabilityPayload {
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export type SessionCapabilityVerifyFailureReason = 'invalid' | 'expired' | 'session_mismatch';

export type SessionCapabilityVerifyResult =
  | { ok: true; payload: SessionCapabilityPayload }
  | { ok: false; reason: SessionCapabilityVerifyFailureReason };

/**
 * Resolve the HMAC secret for session capability token signing.
 */
export function resolveSessionCapabilitySecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_CAPABILITY_SECRET?.trim();
  if (isUnresolvedAmplifySecret(secret)) {
    throw new Error('SESSION_CAPABILITY_SECRET was not resolved from Amplify Secrets');
  }
  if (secret && secret.length >= MIN_SECRET_LENGTH) {
    return secret;
  }

  throw new Error('SESSION_CAPABILITY_SECRET must be set to at least 32 characters');
}

/**
 * Resolve capability token TTL (seconds).
 */
export function resolveSessionCapabilityTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SESSION_CAPABILITY_TTL_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_TTL_SECONDS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_TTL_SECONDS;
  }

  return parsed;
}

/**
 * Create a signed capability token bound to a session ID.
 */
export function createSessionCapabilityToken(
  options: {
    sessionId: string;
    nowMs?: number;
    ttlSeconds?: number;
    nonce?: string;
  },
  secret: string,
): string {
  const sessionId = options.sessionId.trim();
  if (!sessionId) {
    throw new Error('sessionId is required to create capability token');
  }

  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const ttlSeconds =
    typeof options.ttlSeconds === 'number' && Number.isInteger(options.ttlSeconds) && options.ttlSeconds > 0
      ? options.ttlSeconds
      : resolveSessionCapabilityTtlSeconds();

  const claims: SessionCapabilityClaims = {
    sid: sessionId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    nonce: options.nonce ?? randomBytes(16).toString('hex'),
  };

  const payload = encodeBase64Url(JSON.stringify(claims));
  const message = `${TOKEN_VERSION}.${payload}`;
  const signature = sign(message, secret);

  return `${message}.${signature}`;
}

/**
 * Verify and decode a signed capability token.
 */
export function verifySessionCapabilityToken(
  token: string,
  secret: string,
  options: {
    sessionId: string;
    nowMs?: number;
    maxTtlSeconds?: number;
  },
): SessionCapabilityVerifyResult {
  const sessionId = options.sessionId.trim();
  if (!sessionId) {
    return { ok: false, reason: 'invalid' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'invalid' };
  }

  const [version, payload, signature] = parts;
  if (version !== TOKEN_VERSION) {
    return { ok: false, reason: 'invalid' };
  }

  const signed = `${version}.${payload}`;
  const expectedSignature = sign(signed, secret);
  if (!safeTimingEqualHex(expectedSignature, signature)) {
    return { ok: false, reason: 'invalid' };
  }

  const decoded = decodeBase64Url(payload);
  if (!decoded) {
    return { ok: false, reason: 'invalid' };
  }

  let claims: unknown;
  try {
    claims = JSON.parse(decoded) as unknown;
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (!isSessionCapabilityClaims(claims)) {
    return { ok: false, reason: 'invalid' };
  }

  if (claims.sid !== sessionId) {
    return { ok: false, reason: 'session_mismatch' };
  }

  const maxTtlSeconds =
    typeof options.maxTtlSeconds === 'number' && Number.isInteger(options.maxTtlSeconds) && options.maxTtlSeconds > 0
      ? options.maxTtlSeconds
      : resolveSessionCapabilityTtlSeconds();
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
      sessionId: claims.sid,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      nonce: claims.nonce,
    },
  };
}

function sign(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

function isSessionCapabilityClaims(value: unknown): value is SessionCapabilityClaims {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  const sid = record.sid;
  const iat = record.iat;
  const exp = record.exp;
  const nonce = record.nonce;

  return (
    typeof sid === 'string' &&
    sid.length > 0 &&
    typeof nonce === 'string' &&
    nonce.length > 0 &&
    Number.isInteger(iat) &&
    (iat as number) > 0 &&
    Number.isInteger(exp) &&
    (exp as number) > 0
  );
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
