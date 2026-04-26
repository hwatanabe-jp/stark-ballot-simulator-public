import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiBaseUrl, resolveApiUrl } from './apiBaseUrl';

const originalEnv = process.env.NEXT_PUBLIC_API_BASE_URL;

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalEnv === undefined) {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
  } else {
    process.env.NEXT_PUBLIC_API_BASE_URL = originalEnv;
  }
});

describe('apiBaseUrl', () => {
  it('returns null when NEXT_PUBLIC_API_BASE_URL is not set', () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;

    expect(getApiBaseUrl()).toBeNull();
    expect(resolveApiUrl('/api/session')).toBe('/api/session');
  });

  it('normalizes the configured base URL', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://example.com/');

    expect(getApiBaseUrl()).toBe('https://example.com');
    expect(resolveApiUrl('/api/session')).toBe('https://example.com/api/session');
  });

  it('returns the input when the path is already absolute', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://example.com');

    expect(resolveApiUrl('https://other.example/api/verify')).toBe('https://other.example/api/verify');
  });
});
