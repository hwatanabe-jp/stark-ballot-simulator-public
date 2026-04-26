export interface BuildRedirectPathOptions {
  stripParams?: string[];
  fallback?: string;
}

/**
 * Build a safe redirect path from a URL, optionally removing query params.
 */
export function buildRedirectPathFromUrl(url: URL, options: BuildRedirectPathOptions = {}): string {
  const { stripParams = [], fallback = '/' } = options;
  const cloned = new URL(url.toString());

  for (const param of stripParams) {
    cloned.searchParams.delete(param);
  }

  const path = `${cloned.pathname}${cloned.search}${cloned.hash}`;
  return path.length > 0 ? path : fallback;
}

/**
 * Resolve a redirect target while blocking cross-origin URLs.
 */
export function resolveSafeRedirectPath(baseUrl: URL, rawTarget?: string | null, fallback = '/'): string {
  if (!rawTarget) {
    return fallback;
  }

  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return fallback;
  }

  const isAbsolute = trimmed.startsWith('http://') || trimmed.startsWith('https://');
  if (!isAbsolute && !trimmed.startsWith('/')) {
    return fallback;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.origin !== baseUrl.origin) {
      return fallback;
    }

    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return path.length > 0 ? path : fallback;
  } catch {
    return fallback;
  }
}
