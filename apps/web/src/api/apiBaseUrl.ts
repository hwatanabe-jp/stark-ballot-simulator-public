import { readPublicRuntimeEnv } from '@stark-ballot/runtime-config/env/public-runtime-config';

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function parseOriginOnlyUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return null;
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return null;
  }

  return parsed.origin;
}

/**
 * Resolve an optional origin-only API base URL from browser-public configuration.
 * Invalid configured values are ignored so callers fail closed to same-origin /api paths.
 */
export function getApiBaseUrl(): string | null {
  const raw = readPublicRuntimeEnv('VITE_API_BASE_URL');
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed || !isAbsoluteUrl(trimmed)) {
    return null;
  }

  return parseOriginOnlyUrl(trimmed);
}

/**
 * Build an API URL using VITE_API_BASE_URL when configured.
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
