import { getCookieValue } from '@/lib/http/cookies';
import {
  resolveDebugLogMaxTtlSeconds,
  verifyDebugLogToken,
  type DebugLogTokenPayload,
} from '@/lib/security/debugLogToken';

export const DEBUG_LOG_COOKIE_NAME = 'stark_ballot_debug';
export const DEBUG_LOG_HEADER_NAME = 'x-debug-log';

const MIN_SECRET_LENGTH = 32;

export function resolveDebugLogSecret(): string | null {
  const secret = process.env.DEBUG_LOG_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return null;
  }
  return secret;
}

export function resolveDebugLogTokenFromRequest(request: Request): string | null {
  const headerToken = request.headers.get(DEBUG_LOG_HEADER_NAME);
  if (headerToken && headerToken.trim().length > 0) {
    return headerToken.trim();
  }

  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  return getCookieValue(cookieHeader, DEBUG_LOG_COOKIE_NAME);
}

export function resolveDebugLogPayloadFromRequest(request: Request): DebugLogTokenPayload | null {
  const secret = resolveDebugLogSecret();
  if (!secret) {
    return null;
  }

  const token = resolveDebugLogTokenFromRequest(request);
  if (!token) {
    return null;
  }

  return verifyDebugLogToken(token, secret);
}

export function buildDebugLogCookie(token: string, expiresAt: number, options: { secure: boolean }): string {
  const maxAge = resolveDebugLogMaxAgeSeconds(expiresAt);
  const parts = [`${DEBUG_LOG_COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function buildClearDebugLogCookie(options: { secure: boolean }): string {
  const parts = [`${DEBUG_LOG_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function resolveDebugLogMaxAgeSeconds(expiresAt: number): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, Math.floor(expiresAt) - nowSeconds);
  const maxTtl = resolveDebugLogMaxTtlSeconds();
  return Math.min(remaining, maxTtl);
}
