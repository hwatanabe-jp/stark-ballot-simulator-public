import { describe, it, expect } from 'vitest';
import { buildRedirectPathFromUrl, resolveSafeRedirectPath } from './redirect';

describe('buildRedirectPathFromUrl', () => {
  it('removes specified query params', () => {
    const url = new URL('https://example.com/vote?foo=1&stark_ballot_debug=token#hash');
    const result = buildRedirectPathFromUrl(url, { stripParams: ['stark_ballot_debug'] });

    expect(result).toBe('/vote?foo=1#hash');
  });

  it('returns root path when no path is provided', () => {
    const url = new URL('https://example.com');
    const result = buildRedirectPathFromUrl(url);

    expect(result).toBe('/');
  });
});

describe('resolveSafeRedirectPath', () => {
  const baseUrl = new URL('https://example.com/path');

  it('accepts relative paths', () => {
    const result = resolveSafeRedirectPath(baseUrl, '/verify?x=1#y');

    expect(result).toBe('/verify?x=1#y');
  });

  it('accepts same-origin absolute URLs', () => {
    const result = resolveSafeRedirectPath(baseUrl, 'https://example.com/result?ok=1');

    expect(result).toBe('/result?ok=1');
  });

  it('rejects cross-origin URLs', () => {
    const result = resolveSafeRedirectPath(baseUrl, 'https://evil.example.com/phish');

    expect(result).toBe('/');
  });

  it('falls back on invalid URLs', () => {
    const result = resolveSafeRedirectPath(baseUrl, 'not a url', '/fallback');

    expect(result).toBe('/fallback');
  });
});
