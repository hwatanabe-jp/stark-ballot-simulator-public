import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildContentSecurityPolicy } from '@/lib/security/csp';
import { buildRedirectPathFromUrl } from '@/lib/http/redirect';
import { isDebugLogTokenFormat } from '@/lib/security/debugLogTokenFormat';
import {
  DEBUG_LOG_LEGACY_QUERY_PARAM,
  DEBUG_LOG_QUERY_PARAM,
  DEBUG_LOG_REDIRECT_PARAM,
  DEBUG_LOG_TOKEN_PARAM,
} from '@/lib/security/debugLogParams';

const createNonce = (): string => {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }
  throw new Error('WebCrypto is required to generate CSP nonces.');
};

export function proxy(request: NextRequest): NextResponse {
  const debugToken = resolveDebugToken(request.nextUrl);
  if (debugToken) {
    const targetPath = buildRedirectPathFromUrl(request.nextUrl, {
      stripParams: [DEBUG_LOG_QUERY_PARAM, DEBUG_LOG_LEGACY_QUERY_PARAM],
    });

    const enableUrl = new URL('/api/debug/enable', request.url);
    enableUrl.searchParams.set(DEBUG_LOG_TOKEN_PARAM, debugToken);
    enableUrl.searchParams.set(DEBUG_LOG_REDIRECT_PARAM, targetPath);
    return NextResponse.redirect(enableUrl, 302);
  }

  const nonce = createNonce();
  const disableStrict = process.env.DISABLE_STRICT_CSP === '1';
  const isDev = process.env.NODE_ENV !== 'production';
  const csp = buildContentSecurityPolicy({ nonce, isDev, disableStrict });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);

  return response;
}

function resolveDebugToken(url: URL): string | null {
  const token = url.searchParams.get(DEBUG_LOG_QUERY_PARAM);
  if (token) {
    return token;
  }

  const legacy = url.searchParams.get(DEBUG_LOG_LEGACY_QUERY_PARAM);
  if (legacy && isDebugLogTokenFormat(legacy)) {
    return legacy;
  }

  return null;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
