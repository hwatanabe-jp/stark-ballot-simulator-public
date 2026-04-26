export type PublicBaseUrlResult = { ok: true; baseUrl: string } | { ok: false; details: string };

const PROD_REQUIRED_MESSAGE = 'VERIFIER_PUBLIC_BASE_URL is required in production.';
const INVALID_BASE_URL_MESSAGE = 'VERIFIER_PUBLIC_BASE_URL must be a valid http(s) URL.';
const REQUEST_BASE_URL_MESSAGE = 'Unable to resolve public base URL from request.';

function normalizePublicBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, trimmed.endsWith('/') ? '/' : '');
  } catch {
    return null;
  }
}

function resolveForwardedBaseUrl(headers: Headers): string | null {
  const forwardedHost = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!forwardedHost) {
    return null;
  }

  const host = forwardedHost.split(',')[0]?.trim();
  if (!host || /[\s/]/.test(host)) {
    return null;
  }

  const forwardedProto = headers.get('x-forwarded-proto');
  const proto = forwardedProto ? forwardedProto.split(',')[0]?.trim().toLowerCase() : '';
  const protocol = proto === 'http' || proto === 'https' ? proto : 'https';

  return `${protocol}://${host}`;
}

export function resolvePublicBaseUrl(request: Request): PublicBaseUrlResult {
  const base = process.env.VERIFIER_PUBLIC_BASE_URL;
  if (base) {
    const normalized = normalizePublicBaseUrl(base);
    if (!normalized) {
      return { ok: false, details: INVALID_BASE_URL_MESSAGE };
    }
    return { ok: true, baseUrl: normalized };
  }

  if (process.env.NODE_ENV === 'production') {
    return { ok: false, details: PROD_REQUIRED_MESSAGE };
  }

  const forwarded = resolveForwardedBaseUrl(request.headers);
  if (forwarded) {
    return { ok: true, baseUrl: forwarded };
  }

  try {
    return { ok: true, baseUrl: new URL(request.url).origin };
  } catch {
    return { ok: false, details: REQUEST_BASE_URL_MESSAGE };
  }
}
