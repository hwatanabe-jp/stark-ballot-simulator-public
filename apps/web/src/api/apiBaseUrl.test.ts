import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiBaseUrl, resolveApiUrl } from './apiBaseUrl';
import {
  clearBrowserPublicEnvForTests,
  setBrowserPublicEnvForTests,
} from '@stark-ballot/runtime-config/env/browserPublic';

const originalViteEnv = process.env['VITE_API_BASE_URL'];

afterEach(() => {
  clearBrowserPublicEnvForTests();
  vi.unstubAllEnvs();
  if (originalViteEnv === undefined) {
    delete process.env['VITE_API_BASE_URL'];
  } else {
    process.env['VITE_API_BASE_URL'] = originalViteEnv;
  }
});

describe('apiBaseUrl', () => {
  it('returns null when no browser API base URL is set', () => {
    delete process.env['VITE_API_BASE_URL'];

    expect(getApiBaseUrl()).toBeNull();
    expect(resolveApiUrl('/api/session')).toBe('/api/session');
  });

  it('normalizes the configured Vite origin', () => {
    setBrowserPublicEnvForTests('VITE_API_BASE_URL', 'https://example.com/');

    expect(getApiBaseUrl()).toBe('https://example.com');
    expect(resolveApiUrl('/api/session')).toBe('https://example.com/api/session');
  });

  it.each([
    ['path prefix', 'https://example.com/stage'],
    ['query', 'https://example.com?stage=prod'],
    ['fragment', 'https://example.com#prod'],
    ['malformed URL', 'https://'],
    ['unsupported protocol', 'ftp://example.com'],
    ['protocol-relative URL', '//example.com'],
  ])('ignores invalid API base URLs with %s', (_label, value) => {
    setBrowserPublicEnvForTests('VITE_API_BASE_URL', value);

    expect(getApiBaseUrl()).toBeNull();
    expect(resolveApiUrl('/api/session')).toBe('/api/session');
  });

  it('returns the input when the path is already absolute', () => {
    setBrowserPublicEnvForTests('VITE_API_BASE_URL', 'https://example.com');

    expect(resolveApiUrl('https://other.example/api/verify')).toBe('https://other.example/api/verify');
  });
});
