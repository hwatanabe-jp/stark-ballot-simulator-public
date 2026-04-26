import type { ApiContext } from '@/server/api/context';
import { resolveSafeRedirectPath } from '@/lib/http/redirect';
import { verifyDebugLogToken } from '@/lib/security/debugLogToken';
import {
  DEBUG_LOG_LEGACY_QUERY_PARAM,
  DEBUG_LOG_QUERY_PARAM,
  DEBUG_LOG_REDIRECT_PARAM,
  DEBUG_LOG_TOKEN_PARAM,
} from '@/lib/security/debugLogParams';
import { buildClearDebugLogCookie, buildDebugLogCookie, resolveDebugLogSecret } from '@/server/http/debugLog';

const CLEAR_VALUES = new Set(['0', 'off', 'false']);

export function enableDebugLogHandler({ request }: ApiContext): Response {
  const url = new URL(request.url);
  const token =
    url.searchParams.get(DEBUG_LOG_TOKEN_PARAM) ??
    url.searchParams.get(DEBUG_LOG_QUERY_PARAM) ??
    url.searchParams.get(DEBUG_LOG_LEGACY_QUERY_PARAM);
  const redirectTarget = resolveSafeRedirectPath(url, url.searchParams.get(DEBUG_LOG_REDIRECT_PARAM));
  const secure = shouldUseSecureCookie(url);

  const normalizedToken = token?.trim() ?? '';
  if (!normalizedToken || CLEAR_VALUES.has(normalizedToken.toLowerCase())) {
    return buildRedirectResponse(redirectTarget, buildClearDebugLogCookie({ secure }));
  }

  const secret = resolveDebugLogSecret();
  if (!secret) {
    return buildRedirectResponse(redirectTarget, buildClearDebugLogCookie({ secure }));
  }

  const payload = verifyDebugLogToken(normalizedToken, secret);
  if (!payload) {
    return buildRedirectResponse(redirectTarget, buildClearDebugLogCookie({ secure }));
  }

  return buildRedirectResponse(redirectTarget, buildDebugLogCookie(normalizedToken, payload.expiresAt, { secure }));
}

function shouldUseSecureCookie(url: URL): boolean {
  if (process.env.DEBUG_LOG_COOKIE_SECURE?.trim() === '1') {
    return true;
  }
  return url.protocol === 'https:';
}

function buildRedirectResponse(target: string, cookie: string): Response {
  const headers = new Headers();
  headers.set('Location', target);
  headers.set('Cache-Control', 'no-store');
  headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}
