const ABSOLUTE_URL_REGEX = /^https?:\/\//i;

function isAbsoluteUrl(value: string): boolean {
  return ABSOLUTE_URL_REGEX.test(value);
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Resolve the API base URL from NEXT_PUBLIC_API_BASE_URL.
 * Note: Must use static access for Next.js build-time replacement.
 */
export function getApiBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed || !isAbsoluteUrl(trimmed)) {
    return null;
  }

  return normalizeBaseUrl(trimmed);
}

/**
 * Build an API URL using NEXT_PUBLIC_API_BASE_URL when configured.
 */
export function resolveApiUrl(path: string): string {
  if (!path) {
    return path;
  }

  if (isAbsoluteUrl(path)) {
    return path;
  }

  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    return path;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalizedPath, baseUrl).toString();
}
